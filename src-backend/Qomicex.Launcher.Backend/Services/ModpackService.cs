using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Qomicex.Downloader;
using Qomicex.Launcher.Backend;
using DownloadCore = Qomicex.Downloader.Core;

namespace Qomicex.Launcher.Backend.Services;

public enum ModpackSource { Mrpack, CurseForge, Ftb, Local }
public enum ModpackLoader { Forge, Fabric, NeoForge, Quilt }

public class ModpackFileEntry
{
    public string Path { get; set; } = "";
    public string? DownloadUrl { get; set; }
    public long? Size { get; set; }
}

public class ModpackParseResult
{
    public string Name { get; set; } = "";
    public string? Summary { get; set; }
    public string GameVersion { get; set; } = "";
    public ModpackLoader Loader { get; set; }
    public string? LoaderVersion { get; set; }
    public ModpackSource Source { get; set; }
    public List<ModpackFileEntry> Files { get; set; } = [];
    public bool HasOverrides { get; set; }
    public byte[]? OverridesBytes { get; set; }
    public byte[]? IconBytes { get; set; }
    public string? Author { get; set; }
    public string? Version { get; set; }
}

public class ModpackService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly FtbService _ftbService;
    private readonly IConfiguration _configuration;

    public ModpackService(IHttpClientFactory httpClientFactory, FtbService ftbService, IConfiguration configuration)
    {
        _httpClientFactory = httpClientFactory;
        _ftbService = ftbService;
        _configuration = configuration;
    }

    public async Task<ModpackParseResult> ParseModpackFileAsync(string filePath)
    {
        var ext = Path.GetExtension(filePath).ToLowerInvariant();
        return ext switch
        {
            ".mrpack" => await ParseMrpackAsync(filePath),
            ".zip" => await ParseZipWithDetectionAsync(filePath),
            _ => throw new ArgumentException($"Unsupported modpack format: {ext}")
        };
    }

    private async Task<ModpackParseResult> ParseZipWithDetectionAsync(string filePath)
    {
        using (var probe = ZipFile.OpenRead(filePath))
        {
            if (probe.GetEntry("modrinth.index.json") != null)
                return await ParseMrpackAsync(filePath);
        }
        return await ParseCurseForgeZipAsync(filePath);
    }

    public async Task<ModpackParseResult> ResolveOnlineAsync(string source, string projectId, string versionId)
    {
        return source.ToLowerInvariant() switch
        {
            "modrinth" => await ResolveModrinthAsync(projectId, versionId),
            "curseforge" => await ResolveCurseForgeAsync(projectId, versionId),
            "ftb" => await ResolveFtbAsync(projectId, versionId),
            _ => throw new ArgumentException($"Unsupported source: {source}")
        };
    }

    private async Task<ModpackParseResult> ParseMrpackAsync(string filePath)
    {
        using var archive = ZipFile.OpenRead(filePath);
        var indexEntry = archive.GetEntry("modrinth.index.json")
            ?? throw new Exception("Missing modrinth.index.json");

        using var reader = new StreamReader(indexEntry.Open());
        var json = await reader.ReadToEndAsync();
        var doc = JsonNode.Parse(json)!;

        var deps = doc["dependencies"]?.AsObject();
        var gameVersion = deps?["minecraft"]?.GetValue<string>() ?? "";
        var loaderStr = deps?.FirstOrDefault(kv =>
            kv.Key is "fabric-loader" or "forge" or "neoforge" or "quilt").Key;
        var loaderVersion = loaderStr != null ? deps?[loaderStr]?.GetValue<string>() : null;

        var files = new List<ModpackFileEntry>();
        if (doc["files"] is JsonArray fileArray)
        {
            foreach (var f in fileArray.OfType<JsonObject>())
            {
                var downloads = f["downloads"]?.AsArray();
                files.Add(new ModpackFileEntry
                {
                    Path = f["path"]?.GetValue<string>() ?? "",
                    DownloadUrl = downloads?.Count > 0 ? downloads[0]?.GetValue<string>() : null,
                    Size = f["fileSize"]?.GetValue<long>(),
                });
            }
        }

        byte[]? iconBytes = null;
        var iconEntry = archive.GetEntry("overrides/icon.png");
        if (iconEntry != null)
        {
            using var iconStream = iconEntry.Open();
            using var iconMs = new MemoryStream();
            await iconStream.CopyToAsync(iconMs);
            iconBytes = iconMs.ToArray();
        }

        return new ModpackParseResult
        {
            Name = doc["name"]?.GetValue<string>() ?? Path.GetFileNameWithoutExtension(filePath),
            Summary = doc["summary"]?.GetValue<string>(),
            GameVersion = gameVersion,
            Loader = loaderStr?.ToLowerInvariant() switch
            {
                "fabric-loader" => ModpackLoader.Fabric,
                "forge" => ModpackLoader.Forge,
                "neoforge" => ModpackLoader.NeoForge,
                "quilt" => ModpackLoader.Quilt,
                _ => ModpackLoader.Fabric,
            },
            LoaderVersion = loaderVersion,
            Version = doc["versionId"]?.GetValue<string>(),
            IconBytes = iconBytes,
            Source = ModpackSource.Mrpack,
            Files = files,
            HasOverrides = archive.Entries.Any(e => e.FullName.StartsWith("overrides/") && e.Length > 0),
        };
    }

    private async Task<ModpackParseResult> ParseCurseForgeZipAsync(string filePath)
    {
        using var archive = ZipFile.OpenRead(filePath);
        var manifestEntry = archive.GetEntry("manifest.json")
            ?? throw new Exception("Missing manifest.json");

        using var reader = new StreamReader(manifestEntry.Open());
        var json = await reader.ReadToEndAsync();
        var doc = JsonNode.Parse(json)!;

        var mcVersion = doc["minecraft"]?["version"]?.GetValue<string>() ?? "";
        var loaders = doc["minecraft"]?["modLoaders"]?.AsArray();
        var loaderStr = "";
        var loaderVer = "";
        if (loaders != null && loaders.Count > 0)
        {
            var first = loaders[0]?.AsObject();
            var id = first?["id"]?.GetValue<string>() ?? "";
            var parts = id.Split('-', 2);
            loaderStr = parts.Length > 0 ? parts[0].ToLowerInvariant() : "";
            loaderVer = parts.Length > 1 ? parts[1] : "";
        }

        var files = new List<ModpackFileEntry>();
        var fileEntries = doc["files"]?.AsArray();
        if (fileEntries != null && fileEntries.Count > 0)
        {
            var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
            if (string.IsNullOrEmpty(apiKey))
                throw new Exception("CurseForge API key not configured");

            // 过滤加载器安装器（由专用 Forge/Fabric 安装流程处理，不下载为模组）
            var loaderProjectIds = new HashSet<int> { 238222, 634908, 683900 };
            var modEntries = fileEntries.Where(e =>
            {
                var entry = e as JsonObject;
                if (entry == null) return false;
                int projectId = entry.TryGetPropertyValue("projectID", out var pid) == true ? pid!.GetValue<int>() : 0;
                if (loaderProjectIds.Contains(projectId)) return false;
                var fileName = entry["fileName"]?.GetValue<string>() ?? "";
                if (fileName.StartsWith("forge-", StringComparison.OrdinalIgnoreCase) &&
                    (fileName.Contains("-installer") || fileName.Contains("-universal")))
                    return false;
                return true;
            }).ToList();

            var client = _httpClientFactory.CreateClient("CurseForge");
            for (int i = 0; i < modEntries.Count; i += 50)
            {
                var batch = modEntries.Skip(i).Take(50).ToList();
                var body = new { fileIds = batch.Select(f =>
                {
                    var entry = f as JsonObject;
                    int id = entry?.TryGetPropertyValue("fileID", out var node) == true ? node!.GetValue<int>() : 0;
                    return id;
                }).Where(id => id > 0).ToList() };
                var jsonBody = JsonContent.Create(body);
                jsonBody.Headers.ContentType = new MediaTypeHeaderValue("application/json");

                var request = new HttpRequestMessage(HttpMethod.Post, "/v1/mods/files")
                {
                    Content = jsonBody
                };
                request.Headers.Add("x-api-key", apiKey);

                var response = await client.SendAsync(request);
                if (!response.IsSuccessStatusCode)
                {
                    Trace.WriteLine($"CurseForge batch file request failed: {(int)response.StatusCode} on batch starting at index {i}");
                    continue;
                }
                response.EnsureSuccessStatusCode();
                var resultJson = await response.Content.ReadAsStringAsync();
                var resultDoc = JsonNode.Parse(resultJson)!;
                var data = resultDoc["data"]?.AsArray();

                if (data != null)
                {
                    foreach (var entry in data.OfType<JsonObject>())
                    {
                        var fileName = entry["fileName"]?.GetValue<string>() ?? "";
                        var folder = fileName.ToLowerInvariant().EndsWith(".jar") ? "mods" : "";
                        files.Add(new ModpackFileEntry
                        {
                            Path = string.IsNullOrEmpty(folder) ? fileName : $"{folder}/{fileName}",
                            DownloadUrl = entry["downloadUrl"]?.GetValue<string>(),
                            Size = entry["fileLength"]?.GetValue<long>(),
                        });
                    }
                }
            }
        }

        byte[]? iconBytes = null;
        var iconEntry = archive.GetEntry("overrides/icon.png");
        if (iconEntry != null)
        {
            using var iconStream = iconEntry.Open();
            using var iconMs = new MemoryStream();
            await iconStream.CopyToAsync(iconMs);
            iconBytes = iconMs.ToArray();
        }

        return new ModpackParseResult
        {
            Name = doc["name"]?.GetValue<string>() ?? Path.GetFileNameWithoutExtension(filePath),
            Summary = doc["overrides"]?.GetValue<string>(),
            GameVersion = mcVersion,
            Loader = loaderStr switch
            {
                "fabric" => ModpackLoader.Fabric,
                "forge" => ModpackLoader.Forge,
                "neoforge" => ModpackLoader.NeoForge,
                "quilt" => ModpackLoader.Quilt,
                _ => ModpackLoader.Forge,
            },
            LoaderVersion = loaderVer,
            Version = doc["version"]?.GetValue<string>(),
            IconBytes = iconBytes,
            Source = ModpackSource.CurseForge,
            Files = files,
            HasOverrides = archive.Entries.Any(e => e.FullName.StartsWith("overrides/") && e.Length > 0),
        };
    }

    private async Task<ModpackParseResult> ResolveModrinthAsync(string projectId, string versionId)
    {
        var client = _httpClientFactory.CreateClient("Modrinth");

        var url = ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{projectId}/version/{versionId}");
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync();
        var doc = JsonNode.Parse(json)!;

        // Find the primary .mrpack file from the version
        var mrpackFile = doc["files"]?.AsArray()?
            .OfType<JsonObject>()
            .FirstOrDefault(f => f["primary"]?.GetValue<bool>() == true);
        mrpackFile ??= doc["files"]?.AsArray()?
            .OfType<JsonObject>()
            .FirstOrDefault(f => f["filename"]?.GetValue<string>()?.EndsWith(".mrpack") == true);
        if (mrpackFile == null)
            throw new Exception("Modrinth 版本中没有找到 .mrpack 文件");

        var mrpackUrl = mrpackFile["url"]?.GetValue<string>();
        if (string.IsNullOrEmpty(mrpackUrl))
            throw new Exception("Modrinth 版本文件缺少下载地址");

        // Download .mrpack to temp and parse it
        var tempPath = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName() + ".mrpack");
        try
        {
            using (var httpStream = await client.GetStreamAsync(mrpackUrl))
            using (var fileStream = new FileStream(tempPath, FileMode.CreateNew))
            {
                await httpStream.CopyToAsync(fileStream);
            }

            var result = await ParseMrpackAsync(tempPath);
            result.Name = doc["name"]?.GetValue<string>() ?? projectId;
            result.Version = doc["version_number"]?.GetValue<string>();
            result.OverridesBytes = ExtractOverridesZip(tempPath);

            // Fetch project info for author and fallback icon
            try
            {
                var projectUrl = ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{projectId}");
                var projectResponse = await client.GetAsync(projectUrl);
                if (projectResponse.IsSuccessStatusCode)
                {
                    var projectJson = await projectResponse.Content.ReadAsStringAsync();
                    var projectDoc = JsonNode.Parse(projectJson)!;
                    result.Author = projectDoc["author"]?.GetValue<string>();
                    // 如果 .mrpack 中没有图标，使用项目图标
                    if (result.IconBytes == null)
                    {
                        var iconUrl = projectDoc["icon_url"]?.GetValue<string>();
                        if (!string.IsNullOrEmpty(iconUrl))
                        {
                            try
                            {
                                using var iconStream = await client.GetStreamAsync(iconUrl);
                                using var iconMs = new MemoryStream();
                                await iconStream.CopyToAsync(iconMs);
                                result.IconBytes = iconMs.ToArray();
                            }
                            catch { }
                        }
                    }
                }
            }
            catch { }

            return result;
        }
        finally
        {
            if (File.Exists(tempPath))
                File.Delete(tempPath);
        }
    }

    private async Task<ModpackParseResult> ResolveCurseForgeAsync(string projectId, string fileId)
    {
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        if (string.IsNullOrEmpty(apiKey))
            throw new Exception("CurseForge API key not configured");

        var client = _httpClientFactory.CreateClient("CurseForge");

        // Get mod name for display
        var modRequest = new HttpRequestMessage(HttpMethod.Get, $"/v1/mods/{projectId}");
        modRequest.Headers.Add("x-api-key", apiKey);
        var modResponse = await client.SendAsync(modRequest);
        modResponse.EnsureSuccessStatusCode();
        var modJson = await modResponse.Content.ReadAsStringAsync();
        var modData = JsonNode.Parse(modJson)!["data"];
        var modName = modData?["name"]?.GetValue<string>() ?? projectId;
        var modAuthor = modData?["authors"]?.AsArray()?.FirstOrDefault()?["name"]?.GetValue<string>();
        var modLogoUrl = modData?["logo"]?["url"]?.GetValue<string>();

        // Get file info and download URL
        var request = new HttpRequestMessage(HttpMethod.Get, $"/v1/mods/{projectId}/files/{fileId}");
        request.Headers.Add("x-api-key", apiKey);
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync();
        var doc = JsonNode.Parse(json)!;
        var data = doc["data"];

        var fileName = data?["fileName"]?.GetValue<string>() ?? "";
        var downloadUrl = data?["downloadUrl"]?.GetValue<string>();

        // CurseForge removed downloadUrl from API responses for some mods;
        // fall back to constructing a CDN URL from file ID
        if (string.IsNullOrEmpty(downloadUrl) && int.TryParse(fileId, out var fidNum) && !string.IsNullOrEmpty(fileName))
        {
            var prefix = fidNum.ToString().PadLeft(7, '0');
            downloadUrl = $"https://edge.forgecdn.net/files/{prefix[..4]}/{prefix[4..]}/{Uri.EscapeDataString(fileName)}";
        }

        if (string.IsNullOrEmpty(downloadUrl))
            throw new Exception("CurseForge 文件下载地址不可用，请使用 .zip 文件导入");

        // Download the zip to temp and parse via the same path as .zip import
        var tempPath = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName() + ".zip");
        try
        {
            var core = new DownloadCore(threadCount: 0, maxRetries: 3);
            await core.DownloadFileAsync(downloadUrl, tempPath, null, CancellationToken.None,
                headers: new Dictionary<string, string> { ["x-api-key"] = apiKey });

            var result = await ParseCurseForgeZipAsync(tempPath);
            result.Name = modName;
            result.Author = modAuthor;
            // 如果 zip 中没有图标，使用 CurseForge API 的项目 logo
            if (result.IconBytes == null && !string.IsNullOrEmpty(modLogoUrl))
            {
                try
                {
                    using var iconStream = await client.GetStreamAsync(modLogoUrl);
                    using var iconMs = new MemoryStream();
                    await iconStream.CopyToAsync(iconMs);
                    result.IconBytes = iconMs.ToArray();
                }
                catch { }
            }
            result.OverridesBytes = ExtractOverridesZip(tempPath);
            return result;
        }
        finally
        {
            if (File.Exists(tempPath))
                File.Delete(tempPath);
        }
    }

    private async Task<ModpackParseResult> ResolveFtbAsync(string projectId, string versionId)
    {
        var packId = int.Parse(projectId);
        var vId = int.Parse(versionId);
        var detail = await _ftbService.GetVersionDetailAsync(packId, vId);
        if (detail == null) throw new Exception("FTB modpack not found");

        var targets = detail.Targets;
        var mcVersion = targets.FirstOrDefault(t => t.Type == "game")?.Version ?? "";
        var loaderTarget = targets.FirstOrDefault(t => t.Type == "loader");
        var loaderStr = loaderTarget?.Name?.ToLowerInvariant() ?? "";

        return new ModpackParseResult
        {
            Name = detail.Name,
            GameVersion = mcVersion,
            Loader = loaderStr switch
            {
                "fabric" => ModpackLoader.Fabric,
                "forge" => ModpackLoader.Forge,
                "neoforge" => ModpackLoader.NeoForge,
                "quilt" => ModpackLoader.Quilt,
                _ => ModpackLoader.Forge,
            },
            LoaderVersion = loaderTarget?.Version,
            Source = ModpackSource.Ftb,
            Files = detail.Files.Select(f => new ModpackFileEntry
            {
                Path = f.Name,
                DownloadUrl = f.Url,
                Size = f.Size,
            }).ToList(),
            HasOverrides = false,
        };
    }

    public byte[]? ExtractOverridesZip(string filePath)
    {
        using var archive = ZipFile.OpenRead(filePath);
        var overridesEntries = archive.Entries
            .Where(e => e.FullName.StartsWith("overrides/") && e.Length > 0)
            .ToList();

        if (overridesEntries.Count == 0) return null;

        using var ms = new MemoryStream();
        using (var outArchive = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            foreach (var entry in overridesEntries)
            {
                var relativePath = entry.FullName["overrides/".Length..];
                if (string.IsNullOrEmpty(relativePath)) continue;
                var newEntry = outArchive.CreateEntry(relativePath, CompressionLevel.Optimal);
                using var srcStream = entry.Open();
                using var dstStream = newEntry.Open();
                srcStream.CopyTo(dstStream);
            }
        }
        return ms.ToArray();
    }
}
