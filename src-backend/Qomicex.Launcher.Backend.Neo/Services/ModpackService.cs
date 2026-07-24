using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Models.Expansion.Modrinth;
using Qomicex.Core.AOT.Public.Expansion;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class ModpackService
{
    private readonly ILogger<ModpackService> _logger;
    private readonly DefaultGameCore _core;
    private readonly InstallTracker _installTracker;
    private readonly InstanceService _instanceService;
    private readonly string _curseForgeApiKey;

    public ModpackService(
        ILogger<ModpackService> logger,
        DefaultGameCore core,
        InstallTracker installTracker,
        InstanceService instanceService,
        string curseForgeApiKey)
    {
        _logger = logger;
        _core = core;
        _installTracker = installTracker;
        _instanceService = instanceService;
        _curseForgeApiKey = curseForgeApiKey;
    }

    public async Task<ModpackParseResult> ParseFileAsync(Stream fileStream, string fileName)
    {
        var tempPath = Path.Combine(Path.GetTempPath(), $"qml_modpack_{Guid.NewGuid():N}.zip");
        try
        {
            using (var fs = new FileStream(tempPath, FileMode.Create))
                await fileStream.CopyToAsync(fs);

            using var archive = ZipFile.OpenRead(tempPath);
            var hasManifest = archive.GetEntry("manifest.json") != null;
            var hasModrinthIndex = archive.GetEntry("modrinth.index.json") != null;

            if (!hasManifest && !hasModrinthIndex)
                throw new InvalidOperationException("不支持的整合包格式");

            var result = hasManifest
                ? await ParseCurseForgeAsync(tempPath)
                : await ParseModrinthAsync(tempPath);

            return result;
        }
        finally
        {
            try { File.Delete(tempPath); } catch { }
        }
    }

    public async Task<ModpackParseResult> ResolveOnlineAsync(string source, string projectId, string versionId)
    {
        return source.ToLowerInvariant() switch
        {
            "modrinth" => await ResolveModrinthAsync(projectId, versionId),
            "curseforge" => await ResolveCurseForgeOnlineAsync(projectId, versionId),
            _ => throw new InvalidOperationException($"不支持的整合包来源: {source}")
        };
    }

    public async Task<string> InstallAsync(ModpackInstallRequest request, int downloadThreads = 64, int downloadSourceId = 0)
    {
        var versionDirName = string.IsNullOrEmpty(request.Loader)
            ? request.GameVersion
            : $"{request.GameVersion}-{request.Loader}-{request.LoaderVersion}";

        var instance = new GameInstance
        {
            Name = request.Name,
            GameVersion = request.GameVersion,
            Loader = request.Loader,
            LoaderVersion = request.LoaderVersion,
            GameDir = request.GameDir,
            MaxMemory = request.MaxMemory ?? 4096,
            VersionDirName = versionDirName,
            VersionIsolation = request.VersionIsolation,
            ModpackName = request.ModpackName,
            ModpackVersion = request.ModpackVersion,
            ModpackAuthor = request.ModpackAuthor,
            ModpackSummary = request.ModpackSummary,
            IconData = request.IconData,
        };
        _instanceService.Create(instance);

        _logger.LogInformation("开始安装整合包 {Name}，实例 {Id}", request.Name, instance.Id);

        _installTracker.Start(instance.Id, request.GameVersion, request.GameDir,
            request.Loader, request.LoaderVersion, null, downloadThreads,
            request.VersionIsolation, downloadSourceId);

        while (true)
        {
            var state = _installTracker.GetState(instance.Id);
            if (state == null) break;
            if (state.Status is "completed" or "failed" or "cancelled")
            {
                if (state.Status != "completed")
                    throw new InvalidOperationException(state.Error ?? "基础安装失败");
                break;
            }
            await Task.Delay(200);
        }

        _logger.LogInformation("基础安装完成，开始下载整合包文件");

        var state2 = _installTracker.GetState(instance.Id)!;
        state2.Status = "downloading";
        state2.Stage = "modpack-files";
        state2.Progress = 92;
        state2.CurrentFile = "准备下载整合包文件...";

        if (request.ModpackFiles is { Length: > 0 })
        {
            var modsDir = request.VersionIsolation
                ? Path.Combine(request.GameDir, "versions", versionDirName, "mods")
                : Path.Combine(request.GameDir, "mods");
            Directory.CreateDirectory(modsDir);

            state2.TotalFiles = request.ModpackFiles.Length;
            state2.CompletedFiles = 0;
            state2.FailedFiles = 0;

            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            for (var i = 0; i < request.ModpackFiles.Length; i++)
            {
                var file = request.ModpackFiles[i];
                if (string.IsNullOrWhiteSpace(file.DownloadUrl))
                {
                    state2.CompletedFiles++;
                    continue;
                }

                var destPath = Path.Combine(modsDir, file.Path.Replace('/', Path.DirectorySeparatorChar));
                var destDir = Path.GetDirectoryName(destPath);
                if (destDir != null) Directory.CreateDirectory(destDir);

                state2.CurrentFile = file.Path;
                try
                {
                    var resp = await http.GetAsync(file.DownloadUrl);
                    resp.EnsureSuccessStatusCode();
                    await using var content = await resp.Content.ReadAsStreamAsync();
                    await using var outFs = new FileStream(destPath, FileMode.Create);
                    await content.CopyToAsync(outFs);
                    state2.CompletedFiles++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "下载整合包文件失败: {Path}", file.Path);
                    state2.FailedFiles++;
                }

                state2.Progress = 92 + (5.0 * (i + 1) / request.ModpackFiles.Length);
            }

            if (state2.FailedFiles > 0)
                _logger.LogWarning("整合包文件下载完成，{Completed}/{Total} 成功，{Failed} 失败",
                    state2.CompletedFiles, request.ModpackFiles.Length, state2.FailedFiles);
        }
        else
        {
            state2.Progress = 97;
        }

        if (!string.IsNullOrWhiteSpace(request.OverridesZip))
        {
            state2.Stage = "modpack-overrides";
            state2.CurrentFile = "解压覆盖文件...";
            state2.Progress = 97;

            await ExtractOverridesAsync(request.OverridesZip, request.GameDir, versionDirName, request.VersionIsolation);

            state2.Progress = 99;
        }

        state2.Status = "completed";
        state2.Stage = "completed";
        state2.Progress = 100;
        state2.CurrentFile = "";

        _logger.LogInformation("整合包安装完成: {Name}", request.Name);
        return instance.Id;
    }

    private async Task ExtractOverridesAsync(string overridesBase64, string gameDir, string versionDirName, bool versionIsolation)
    {
        var targetDir = versionIsolation
            ? Path.Combine(gameDir, "versions", versionDirName)
            : gameDir;

        var overridesBytes = Convert.FromBase64String(overridesBase64);
        var tempZip = Path.Combine(Path.GetTempPath(), $"qml_overrides_{Guid.NewGuid():N}.zip");
        try
        {
            await File.WriteAllBytesAsync(tempZip, overridesBytes);
            using var archive = ZipFile.OpenRead(tempZip);
            foreach (var entry in archive.Entries)
            {
                if (string.IsNullOrEmpty(entry.Name)) continue;
                var destPath = Path.Combine(targetDir, entry.FullName);
                var destDir = Path.GetDirectoryName(destPath);
                if (destDir != null) Directory.CreateDirectory(destDir);
                entry.ExtractToFile(destPath, overwrite: true);
            }
        }
        finally
        {
            try { File.Delete(tempZip); } catch { }
        }
    }

    private async Task<ModpackParseResult> ParseCurseForgeAsync(string zipPath)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var manifestEntry = archive.GetEntry("manifest.json")
            ?? throw new InvalidOperationException("整合包缺少 manifest.json");

        using var stream = manifestEntry.Open();
        var jsonData = await JsonNode.ParseAsync(stream);
        var json = jsonData?.AsObject()
            ?? throw new InvalidOperationException("manifest.json 格式无效");

        var manifestType = (string?)json["manifestType"];
        if (manifestType != "minecraftModpack")
            throw new InvalidOperationException("仅支持 Minecraft 整合包");

        var name = (string?)json["name"] ?? "未知整合包";
        var version = (string?)json["version"];
        var gameVersion = (string?)json["minecraft"]?["version"] ?? "";
        var author = (string?)json["author"];

        var (loader, loaderVersion) = ParseCurseForgeLoader(json["minecraft"]?["modLoaders"]?.AsArray());

        var files = new List<ModpackFileEntry>();
        var filesArray = json["files"]?.AsArray();
        if (filesArray != null)
        {
            var cf = _core.CreateCurseForgeSource(_curseForgeApiKey);
            foreach (var file in filesArray.OfType<JsonObject>())
            {
                if (file["required"] is JsonValue req && req.GetValueKind() == JsonValueKind.False) continue;

                var projectId = (int?)file["projectID"] ?? 0;
                var fileId = (int?)file["fileID"] ?? 0;
                if (projectId <= 0 || fileId <= 0) continue;

                try
                {
                    var dlUrl = await cf.GetDownloadUrlAsync(projectId.ToString(), fileId.ToString());
                    var fileInfo = await cf.GetFileInfoAsync(projectId.ToString(), fileId.ToString());
                    files.Add(new ModpackFileEntry(
                        Path: fileInfo?.FileName ?? $"{projectId}-{fileId}.jar",
                        DownloadUrl: dlUrl,
                        Size: null
                    ));
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "解析 CurseForge 文件失败: project={ProjectId} file={FileId}", projectId, fileId);
                }
            }
        }

        var overridesFolder = (string?)json["overrides"] ?? "overrides";
        var overridesZip = ExtractOverridesToBase64(archive, overridesFolder);
        var hasOverrides = archive.Entries.Any(e =>
            e.FullName.StartsWith($"{overridesFolder}/", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(e.Name));

        return new ModpackParseResult(
            Name: name,
            Summary: null,
            Author: author,
            Version: version,
            GameVersion: gameVersion,
            Loader: loader,
            LoaderVersion: loaderVersion,
            Source: "curseforge",
            Files: files.ToArray(),
            HasOverrides: hasOverrides,
            FileCount: files.Count,
            OverridesZip: overridesZip,
            IconData: null
        );
    }

    private async Task<ModpackParseResult> ParseModrinthAsync(string zipPath)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var indexEntry = archive.GetEntry("modrinth.index.json")
            ?? throw new InvalidOperationException("整合包缺少 modrinth.index.json");

        using var stream = indexEntry.Open();
        var jsonData = await JsonNode.ParseAsync(stream);
        var json = jsonData?.AsObject()
            ?? throw new InvalidOperationException("modrinth.index.json 格式无效");

        var game = (string?)json["game"];
        if (game != "minecraft")
            throw new InvalidOperationException("仅支持 Minecraft 整合包");

        var name = (string?)json["name"] ?? "未知整合包";
        var versionId = (string?)json["versionId"];
        var summary = (string?)json["summary"];

        var (gameVersion, loader, loaderVersion) = ParseModrinthDependencies(json["dependencies"]?.AsObject());

        var files = new List<ModpackFileEntry>();
        var filesArray = json["files"]?.AsArray();
        if (filesArray != null)
        {
            foreach (var file in filesArray.OfType<JsonObject>())
            {
                var clientEnv = (string?)file["env"]?["client"] ?? "required";
                if (clientEnv != "required") continue;

                var downloads = file["downloads"]?.AsArray();
                var url = downloads is { Count: > 0 } ? (string?)downloads[0] : null;
                var path = (string?)file["path"] ?? "";
                var size = (long?)file["fileSize"];

                files.Add(new ModpackFileEntry(Path: path, DownloadUrl: url, Size: size));
            }
        }

        var overridesZip = ExtractOverridesToBase64(archive, "overrides");
        var hasOverrides = archive.Entries.Any(e =>
            e.FullName.StartsWith("overrides/", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(e.Name));

        return new ModpackParseResult(
            Name: name,
            Summary: summary,
            Author: null,
            Version: versionId,
            GameVersion: gameVersion,
            Loader: loader,
            LoaderVersion: loaderVersion,
            Source: "modrinth",
            Files: files.ToArray(),
            HasOverrides: hasOverrides,
            FileCount: files.Count,
            OverridesZip: overridesZip,
            IconData: null
        );
    }

    private async Task<ModpackParseResult> ResolveModrinthAsync(string projectId, string versionId)
    {
        var mr = _core.CreateModrinthSource();
        var project = await mr.GetProjectInfoAsync(projectId);
        var version = await mr.GetVersionInfoAsync(versionId);

        var gameVersion = version.GameVersionIds?.FirstOrDefault() ?? "";
        var loader = version.Loaders?.FirstOrDefault() ?? "";
        var loaderVersion = "";

        var files = new List<ModpackFileEntry>();
        if (version.Files != null)
        {
            foreach (var f in version.Files)
            {
                files.Add(new ModpackFileEntry(
                    Path: f.Filename,
                    DownloadUrl: f.DownloadUrl,
                    Size: f.Size
                ));
            }
        }

        return new ModpackParseResult(
            Name: project.Name,
            Summary: project.Description,
            Author: project.Team,
            Version: version.VersionNumber ?? version.Name,
            GameVersion: gameVersion,
            Loader: NormalizeLoader(loader),
            LoaderVersion: loaderVersion,
            Source: "modrinth",
            Files: files.ToArray(),
            HasOverrides: false,
            FileCount: files.Count,
            OverridesZip: null,
            IconData: project.IconUrl
        );
    }

    private async Task<ModpackParseResult> ResolveCurseForgeOnlineAsync(string projectId, string versionId)
    {
        var cf = _core.CreateCurseForgeSource(_curseForgeApiKey);
        var modInfo = await cf.GetModInfoAsync(projectId);
        var fileInfo = await cf.GetFileInfoAsync(projectId, versionId);

        var downloadUrl = await cf.GetDownloadUrlAsync(projectId, versionId);

        var tempPath = Path.Combine(Path.GetTempPath(), $"qml_cf_resolve_{Guid.NewGuid():N}.zip");
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
            var resp = await http.GetAsync(downloadUrl);
            resp.EnsureSuccessStatusCode();
            await using var content = await resp.Content.ReadAsStreamAsync();
            await using var fs = new FileStream(tempPath, FileMode.Create);
            await content.CopyToAsync(fs);

            var parseResult = await ParseCurseForgeAsync(tempPath);
            return parseResult with
            {
                Name = modInfo.Name,
                Summary = modInfo.Summary,
                Author = modInfo.Authors?.FirstOrDefault()?.Name
            };
        }
        finally
        {
            try { File.Delete(tempPath); } catch { }
        }
    }

    private static (string loader, string loaderVersion) ParseCurseForgeLoader(JsonArray? loaders)
    {
        if (loaders == null) return ("", "");
        foreach (var loader in loaders.OfType<JsonObject>())
        {
            if (loader["primary"] is JsonValue p && p.GetValueKind() == JsonValueKind.True)
            {
                var rawId = (string?)loader["id"];
                if (string.IsNullOrEmpty(rawId)) continue;
                var idx = rawId.IndexOf('-');
                if (idx >= 0 && idx < rawId.Length - 1)
                    return (NormalizeLoader(rawId[..idx]), rawId[(idx + 1)..]);
                return (NormalizeLoader(rawId), "");
            }
        }
        return ("", "");
    }

    private static (string gameVersion, string loader, string loaderVersion) ParseModrinthDependencies(JsonObject? deps)
    {
        var gameVersion = "";
        var loader = "";
        var loaderVersion = "";

        if (deps == null) return (gameVersion, loader, loaderVersion);

        foreach (var (key, value) in deps)
        {
            var ver = (string?)value ?? "";
            if (key == "minecraft")
                gameVersion = ver;
            else if (key is "quilt-loader" or "fabric-loader" or "forge" or "neoforge")
            {
                loader = NormalizeLoader(key == "quilt-loader" ? "quilt" : key == "fabric-loader" ? "fabric" : key);
                loaderVersion = ver;
            }
        }

        return (gameVersion, loader, loaderVersion);
    }

    private static string NormalizeLoader(string loader) => loader.ToLowerInvariant() switch
    {
        "fabric-loader" => "fabric",
        "quilt-loader" => "quilt",
        _ => loader.ToLowerInvariant()
    };

    private static string? ExtractOverridesToBase64(ZipArchive archive, string overridesFolder)
    {
        var overridesEntries = archive.Entries
            .Where(e => e.FullName.StartsWith($"{overridesFolder}/", StringComparison.OrdinalIgnoreCase)
                        && !string.IsNullOrEmpty(e.Name))
            .ToList();

        if (overridesEntries.Count == 0) return null;

        using var ms = new MemoryStream();
        using (var outArchive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var entry in overridesEntries)
            {
                var relativePath = entry.FullName.Substring(overridesFolder.Length + 1);
                var newEntry = outArchive.CreateEntry(relativePath, CompressionLevel.Optimal);
                using var srcStream = entry.Open();
                using var dstStream = newEntry.Open();
                srcStream.CopyTo(dstStream);
            }
        }

        return Convert.ToBase64String(ms.ToArray());
    }
}
