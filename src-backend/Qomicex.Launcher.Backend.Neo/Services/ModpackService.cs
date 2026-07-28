using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Models.Expansion.FeedTheBeast;
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
            "ftb" => await ResolveFtbOnlineAsync(projectId, versionId),
            _ => throw new InvalidOperationException($"不支持的整合包来源: {source}")
        };
    }

    public async Task<string> InstallAsync(ModpackInstallRequest request, int downloadThreads = 64, int downloadSourceId = 0)
    {
        var instance = new GameInstance
        {
            Name = request.Name,
            GameVersion = request.GameVersion,
            Loader = request.Loader,
            LoaderVersion = request.LoaderVersion,
            GameDir = request.GameDir,
            MaxMemory = request.MaxMemory ?? 4096,
            VersionIsolation = request.VersionIsolation,
            ModpackName = request.ModpackName,
            ModpackVersion = request.ModpackVersion,
            ModpackAuthor = request.ModpackAuthor,
            ModpackSummary = request.ModpackSummary,
            IconData = request.IconData,
        };
        _instanceService.Create(instance);

        _logger.LogInformation("开始安装整合包 {Name}，实例 {Id}", request.Name, instance.Id);

        var isFtb = string.Equals(request.Source, "ftb", StringComparison.OrdinalIgnoreCase);

        // 非 FTB 的 modpack files 转成 AdditionalFile（轻量操作，可同步完成）
        List<AdditionalFile>? genericFiles = null;
        if (!isFtb && request.ModpackFiles is { Length: > 0 })
        {
            genericFiles = BuildGenericAdditionalFiles(request, request.Name);
        }

        // === Goal 5: FTB 走延迟解析，不阻塞 Start() 返回 ===
        Func<CancellationToken, Task<List<AdditionalFile>>>? resolveFtbFiles = null;
        if (isFtb && !string.IsNullOrWhiteSpace(request.ProjectId) && !string.IsNullOrWhiteSpace(request.VersionId))
        {
            resolveFtbFiles = ct => BuildFtbAdditionalFilesAsync(request, request.Name);
        }

        _installTracker.Start(instance.Id, request.GameVersion, request.GameDir,
            request.Loader, request.LoaderVersion, null, downloadThreads,
            request.VersionIsolation, downloadSourceId,
            instanceName: request.Name,
            additionalFiles: genericFiles is { Count: > 0 } ? genericFiles : null,
            resolveAdditionalFiles: resolveFtbFiles,
            optifineVersion: request.OptifineVersion,
            postInstall: async (state, ct) =>
            {
                if (!string.IsNullOrWhiteSpace(request.OverridesZip))
                {
                    state.Stage = "modpack-overrides";
                    state.CurrentFile = "解压覆盖文件...";
                    state.Progress = 97;
                    await ExtractOverridesAsync(request.OverridesZip, request.GameDir, request.Name, request.VersionIsolation);
                    state.Progress = 99;
                }
            });

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

    /// <summary>将 FTB 整合包的 mods + configs 清单转为 AdditionalFile 列表。</summary>
    private async Task<List<AdditionalFile>> BuildFtbAdditionalFilesAsync(ModpackInstallRequest request, string versionDirName)
    {
        _logger.LogInformation("[FTB] BuildFtbAdditionalFiles 开始，packId={PackId}, packVersionId={VersionId}", request.ProjectId, request.VersionId);

        var ftbInstaller = _core.Installer.CreateFtbModpack(
            request.GameDir, request.VersionIsolation, _core.HttpClient, _curseForgeApiKey);
        _logger.LogInformation("[FTB] 调用 GetMissLibrariesAsync...");
        var missFiles = await ftbInstaller.GetMissLibrariesAsync(
            versionDirName, request.ProjectId, request.VersionId);
        _logger.LogInformation("[FTB] GetMissLibrariesAsync 返回 {Count} 条记录", missFiles.Count);

        if (missFiles.Count == 0)
            return [];

        var result = new List<AdditionalFile>();
        foreach (var file in missFiles)
        {
            if (string.IsNullOrWhiteSpace(file.Url) || string.IsNullOrWhiteSpace(file.Path))
                continue;
            var relPath = Path.GetRelativePath(request.GameDir, file.Path);
            result.Add(new AdditionalFile(
                Source: "url",
                Identifier: file.Url,
                RelativePath: relPath.Replace(Path.DirectorySeparatorChar, '/')
            ));
        }

        _logger.LogInformation("[FTB] AdditionalFile 列表构建完成，共 {Count} 个文件", result.Count);
        _logger.LogInformation("FTB 整合包解析出 {Count} 个附加文件", result.Count);
        return result;
    }

    /// <summary>将 ModpackFileEntry 数组转为 AdditionalFile 列表（用于 CurseForge/Modrinth 整合包）。</summary>
    private List<AdditionalFile> BuildGenericAdditionalFiles(ModpackInstallRequest request, string versionDirName)
    {
        var result = new List<AdditionalFile>();
        if (request.ModpackFiles is not { Length: > 0 }) return result;

        var modsDir = request.VersionIsolation
            ? Path.Combine("versions", versionDirName, "mods")
            : "mods";

        foreach (var file in request.ModpackFiles)
        {
            if (string.IsNullOrWhiteSpace(file.DownloadUrl) || string.IsNullOrWhiteSpace(file.Path))
                continue;
            var relPath = Path.Combine(modsDir, file.Path.Replace('/', Path.DirectorySeparatorChar)).Replace(Path.DirectorySeparatorChar, '/');
            result.Add(new AdditionalFile(
                Source: "url",
                Identifier: file.DownloadUrl,
                RelativePath: relPath,
                Size: file.Size
            ));
        }

        return result;
    }

    private static async Task WaitPauseAsync(InstallState state, CancellationToken ct)
    {
        while (state.Paused)
        {
            ct.ThrowIfCancellationRequested();
            await Task.Delay(200, ct);
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

    private async Task<ModpackParseResult> ResolveFtbOnlineAsync(string projectId, string versionId)
    {
        if (!int.TryParse(projectId, out int packId) || !int.TryParse(versionId, out int packVersionId))
            throw new InvalidOperationException("无效的 FTB 整合包 ID");

        var ftb = _core.CreateFTBSource();
        var versionDetail = await ftb.GetVersionDetailAsync(packId, packVersionId);

        if (versionDetail is null)
            throw new InvalidOperationException("无法获取 FTB 整合包版本信息");

        var gameVersion = "";
        var loader = "";
        var loaderVersion = "";

        if (versionDetail.Targets != null)
        {
            foreach (var target in versionDetail.Targets)
            {
                if (string.Equals(target.Type, "game", StringComparison.OrdinalIgnoreCase))
                    gameVersion = target.Version ?? "";
                else if (string.Equals(target.Type, "modloader", StringComparison.OrdinalIgnoreCase))
                {
                    loader = NormalizeLoader(target.Name ?? "");
                    loaderVersion = target.Version ?? "";
                }
            }
        }

        if (string.IsNullOrEmpty(gameVersion))
            throw new InvalidOperationException("无法解析 FTB 整合包的游戏版本");

        var pack = await ftb.GetPackDetailAsync(packId);
        var iconUrl = pack?.Art?.FirstOrDefault()?.Url;

        return new ModpackParseResult(
            Name: pack?.Name ?? "",
            Summary: pack?.Synopsis,
            Author: pack?.Authors?.FirstOrDefault()?.Name,
            Version: versionDetail.Name,
            GameVersion: gameVersion,
            Loader: loader,
            LoaderVersion: loaderVersion,
            Source: "ftb",
            Files: [],
            HasOverrides: false,
            FileCount: 0,
            OverridesZip: null,
            IconData: iconUrl
        );
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
