using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Qomicex.Launcher.Backend;

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

            var client = _httpClientFactory.CreateClient("CurseForge");
            for (int i = 0; i < fileEntries.Count; i += 50)
            {
                var batch = fileEntries.Skip(i).Take(50).ToList();
                var body = new { fileIds = batch.Select(f => f["fileId"]?.GetValue<int>() ?? 0).ToList() };
                var jsonBody = JsonContent.Create(body);
                jsonBody.Headers.ContentType = new MediaTypeHeaderValue("application/json");

                var request = new HttpRequestMessage(HttpMethod.Post, "/v1/mods/files")
                {
                    Content = jsonBody
                };
                request.Headers.Add("x-api-key", apiKey);

                var response = await client.SendAsync(request);
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

        var gameVersions = doc["game_versions"]?.AsArray();
        var loaders = doc["loaders"]?.AsArray();

        var files = new List<ModpackFileEntry>();
        if (doc["files"] is JsonArray fileArray)
        {
            foreach (var f in fileArray.OfType<JsonObject>())
            {
                var downloads = f["downloads"]?.AsArray();
                files.Add(new ModpackFileEntry
                {
                    Path = f["filename"]?.GetValue<string>() ?? "",
                    DownloadUrl = downloads?.Count > 0 ? downloads[0]?.GetValue<string>() : null,
                    Size = f["size"]?.GetValue<long>(),
                });
            }
        }

        return new ModpackParseResult
        {
            Name = projectId,
            Summary = null,
            GameVersion = gameVersions?.LastOrDefault()?.GetValue<string>() ?? "",
            Loader = loaders?.FirstOrDefault()?.GetValue<string>()?.ToLowerInvariant() switch
            {
                "fabric" => ModpackLoader.Fabric,
                "forge" => ModpackLoader.Forge,
                "neoforge" => ModpackLoader.NeoForge,
                "quilt" => ModpackLoader.Quilt,
                _ => ModpackLoader.Fabric,
            },
            LoaderVersion = null,
            Source = ModpackSource.Local,
            Files = files,
            HasOverrides = false,
        };
    }

    private async Task<ModpackParseResult> ResolveCurseForgeAsync(string projectId, string fileId)
    {
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        if (string.IsNullOrEmpty(apiKey))
            throw new Exception("CurseForge API key not configured");

        var client = _httpClientFactory.CreateClient("CurseForge");
        var request = new HttpRequestMessage(HttpMethod.Get, $"/v1/mods/{projectId}/files/{fileId}");
        request.Headers.Add("x-api-key", apiKey);

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync();
        var doc = JsonNode.Parse(json)!;
        var data = doc["data"];

        return new ModpackParseResult
        {
            Name = projectId,
            GameVersion = "",
            Source = ModpackSource.CurseForge,
            Files = new List<ModpackFileEntry>
            {
                new()
                {
                    Path = data?["fileName"]?.GetValue<string>() ?? "",
                    DownloadUrl = data?["downloadUrl"]?.GetValue<string>(),
                    Size = data?["fileLength"]?.GetValue<long>(),
                }
            },
        };
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
