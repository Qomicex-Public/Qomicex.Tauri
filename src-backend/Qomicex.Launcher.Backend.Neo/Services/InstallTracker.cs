using System.Collections.Concurrent;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Models.VersionMetadata;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Core.AOT.Public.Services;
using Qomicex.Core.AOT.Services.Installers;
using Qomicex.Downloader;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class InstallTracker
{
    private readonly ConcurrentDictionary<string, InstallState> _states = new();
    private readonly JavaRuntimeStore _javaStore;
    private readonly string _userAgent;

    public InstallTracker(JavaRuntimeStore javaStore, string userAgent)
    {
        _javaStore = javaStore;
        _userAgent = userAgent;
    }

    public void Start(string instanceId, string gameVersion, string gameDir,
        string? loader, string? loaderVersion, string[]? addons,
        int downloadThreads, bool versionIsolation, int? downloadSourceId)
    {
        var cts = new CancellationTokenSource();
        var state = new InstallState(cts);
        _states[instanceId] = state;

        Task.Run(async () =>
        {
            try
            {
                await RunInstallAsync(instanceId, gameVersion, gameDir,
                    loader, loaderVersion, addons, downloadThreads,
                    versionIsolation, downloadSourceId ?? 0, state, cts.Token);
            }
            catch (OperationCanceledException)
            {
                state.Status = "failed";
                state.Error = "安装已取消";
            }
            catch (Exception ex)
            {
                state.Status = "failed";
                state.Error = ex.Message;
            }
        });
    }

    private async Task RunInstallAsync(string instanceId, string gameVersion,
        string gameDir, string? loader, string? loaderVersion, string[]? addons,
        int downloadThreads, bool versionIsolation, int downloadSourceId,
        InstallState state, CancellationToken ct)
    {
        var mirror = downloadSourceId == 1 ? DownloadMirror.BMCLAPI : DownloadMirror.Official;
        using var core = new GameCoreBuilder()
            .Configure(o =>
            {
                o.LauncherName = "QML";
                o.GameRoot = gameDir;
                o.UserAgent = _userAgent;
                o.CacheExpiry = TimeSpan.FromMinutes(30);
            })
            .UseDownloadMirror(mirror)
            .Build();
        var versionDirName = string.IsNullOrEmpty(loader)
            ? gameVersion
            : $"{gameVersion}-{loader}-{loaderVersion}";

        // Phase 1: 版本 JSON 获取 (0% → 3%)
        ct.ThrowIfCancellationRequested();
        state.Stage = "fetching-json";
        state.Status = "downloading";
        state.CurrentFile = "获取版本信息...";
        state.Progress = 0;

        var manifest = await core.Version.GetManifestAsync();
        var versionInfo = manifest.Versions.FirstOrDefault(v => v.Id == gameVersion)
            ?? throw new Exception($"未找到版本 {gameVersion}");

        var jsonContent = await core.HttpClient.GetStringAsync(versionInfo.Url);
        state.Progress = 3;

        // Phase 2: Loader 预下载 (并行)
        ct.ThrowIfCancellationRequested();
        string? installerPath = null;
        Task? loaderJarTask = null;

        var isForge = string.Equals(loader, "forge", StringComparison.OrdinalIgnoreCase);
        var isNeoForge = string.Equals(loader, "neoforge", StringComparison.OrdinalIgnoreCase);

        if (isForge || isNeoForge)
        {
            state.Stage = "downloading-installer";
            state.CurrentFile = "下载加载器安装包...";

            var loaderType = isForge
                ? ModLoaderType.Forge
                : ModLoaderType.NeoForge;

            var loaders = await core.InstallerProvider.GetAvailableModLoaders(gameVersion, loaderType);
            var match = loaders.FirstOrDefault(l =>
                string.Equals(l.Version, loaderVersion, StringComparison.OrdinalIgnoreCase));

            if (match?.Url == null)
                throw new Exception($"找不到 {loader} {loaderVersion} 的下载链接");

            var tempDir = Path.Combine(gameDir, "temp");
            Directory.CreateDirectory(tempDir);
            installerPath = Path.Combine(tempDir,
                isForge ? $"forge-{loaderVersion}-installer.jar" : $"neoforge-{loaderVersion}-installer.jar");

            if (!File.Exists(installerPath))
            {
                loaderJarTask = Task.Run(async () =>
                {
                    using var resp = await core.HttpClient.GetAsync(match.Url, ct);
                    resp.EnsureSuccessStatusCode();
                    var dir = Path.GetDirectoryName(installerPath)!;
                    Directory.CreateDirectory(dir);
                    using var fs = new FileStream(installerPath, FileMode.Create, FileAccess.Write);
                    await resp.Content.CopyToAsync(fs, ct);
                }, ct);
            }
        }

        state.Progress = 5;

        // Phase 3: 基础文件扫描与下载
        ct.ThrowIfCancellationRequested();
        state.Stage = "scanning-base";
        state.CurrentFile = "扫描基础文件...";

        var missFiles = await core.Locator.GetMissFilesAsync(jsonContent);

        Task? baseDownloadTask = null;
        DownloadManager? baseDm = null;
        if (missFiles.Count > 0)
        {
            state.Stage = "downloading-base";
            state.TotalFiles = missFiles.Count;
            baseDm = new DownloadManager(intervalMs: 500);
            var tid = baseDm.CreateTask(maxConcurrentFiles: downloadThreads, maxRetries: 3);
            foreach (var f in missFiles)
                baseDm.AddFileToTask(tid, f.Url, f.Path);
            baseDownloadTask = DownloadWithProgress(baseDm, tid, state, 5, 35, ct);
        }
        else
        {
            state.Progress = 35;
        }

        // Phase 4: Loader 库文件扫描与下载 (并行)
        ct.ThrowIfCancellationRequested();
        Task? loaderLibTask = null;
        DownloadManager? loaderDm = null;

        if (!string.IsNullOrEmpty(loader) && !string.IsNullOrEmpty(loaderVersion))
        {
            state.CurrentFile = "扫描加载器库文件...";

            var missLibs = await GetMissLoaderLibraries(
                loader, loaderVersion, gameVersion, gameDir,
                versionDirName, installerPath, downloadSourceId);

            if (missLibs.Count > 0)
            {
                loaderDm = new DownloadManager(intervalMs: 500);
                var tid = loaderDm.CreateTask(maxConcurrentFiles: 32, maxRetries: 3);
                foreach (var f in missLibs)
                    loaderDm.AddFileToTask(tid, f.Url, f.Path);
                loaderLibTask = DownloadWithProgress(loaderDm, tid, state, 35, 55, ct);
            }
        }
        else if(string.IsNullOrEmpty(loader))
        {
            var jsonPath = Path.Combine(gameDir, "versions", versionDirName, $"{versionDirName}.json");

            JsonNode root = JsonNode.Parse(jsonContent)!;
            root["id"] = versionDirName;
            string updatedJson = root.ToJsonString();

            await File.WriteAllTextAsync(jsonPath,updatedJson);
        }

        // Phase 6: 附加 Mod 下载 (并行)
        ct.ThrowIfCancellationRequested();
        Task? addonTask = null;

        if (addons != null && addons.Length > 0)
        {
            addonTask = DownloadAddons(addons, gameVersion, gameDir, downloadSourceId, state, ct);
        }

        // 等待并行下载完成
        if (loaderJarTask != null) await loaderJarTask;
        if (baseDownloadTask != null) await baseDownloadTask;
        if (loaderLibTask != null) await loaderLibTask;
        if (addonTask != null) await addonTask;

        state.Progress = 85;

        // Phase 4b: Loader 安装
        ct.ThrowIfCancellationRequested();
        if (!string.IsNullOrEmpty(loader) && !string.IsNullOrEmpty(loaderVersion))
        {
            state.Stage = "installing-loader";
            state.CurrentFile = $"安装 {loader}...";
            state.Progress = 88;

            await InstallLoader(versionDirName, jsonContent, gameDir,
                loader, loaderVersion, gameVersion, installerPath, downloadSourceId, ct);

            state.Progress = 92;
        }

        // Phase 5: 主 JAR 校验
        ct.ThrowIfCancellationRequested();
        state.Stage = "verifying-jar";
        state.CurrentFile = "校验主 Jar 文件...";

        var missJar = await core.Locator.GetMissMainJarAsync(jsonContent);
        if (missJar != null)
        {
            state.Stage = "downloading-jar";
            var dm = new DownloadManager(intervalMs: 500);
            var tid = dm.CreateTask(maxConcurrentFiles: 1, maxRetries: 3);
            dm.AddFileToTask(tid, missJar.Url, missJar.Path);
            await DownloadWithProgress(dm, tid, state, 92, 98, ct);
        }
        else
        {
            state.Progress = 98;
        }

        // 收尾
        ct.ThrowIfCancellationRequested();
        state.Stage = "finishing";
        state.CurrentFile = "完成安装...";

        if (versionIsolation && !string.IsNullOrEmpty(loader))
        {
            var isoDir = Path.Combine(gameDir, "versions", versionDirName);
            foreach (var sub in new[] { "mods", "saves", "resourcepacks", "shaderpacks", "screenshots", "datapacks", "crash-reports" })
                Directory.CreateDirectory(Path.Combine(isoDir, sub));
        }

        state.Status = "completed";
        state.Stage = "completed";
        state.Progress = 100;
        state.CurrentFile = "";

        // 清理
        if (baseDm != null) baseDm.StopTask(-1);
        if (loaderDm != null) loaderDm.StopTask(-1);
        CleanupTempFiles(installerPath);
    }

    private async Task DownloadWithProgress(DownloadManager dm, int tid,
        InstallState state, double startPct, double endPct, CancellationToken ct)
    {
        var downloadTask = dm.StartTaskAsync(tid, ct);
        while (!ct.IsCancellationRequested)
        {
            var infos = dm.GetAllTaskInfos();
            if (infos.TryGetValue(tid, out var info))
            {
                state.CompletedFiles = info.CompletedFiles;
                state.FailedFiles = info.FailedFiles;
                state.Speed = info.Speed;

                var statuses = dm.GetTaskFileStatuses(tid);
                var downloading = statuses.FirstOrDefault(s => s.Status == DownloadTask.FileStatus.Downloading);
                state.CurrentFile = downloading.Name ?? "";

                if (info.TotalFiles > 0)
                    state.Progress = startPct + (endPct - startPct) * info.Progress / 100.0;

                if (info.CompletedFiles + info.FailedFiles + info.CanceledFiles >= info.TotalFiles)
                {
                    if (info.FailedFiles > 0)
                        throw new Exception($"下载失败: {info.FailedFiles} 个文件下载失败");
                    break;
                }
            }
            await Task.Delay(500, ct);
        }
        await downloadTask;
    }

    private async Task<List<MissFileDto>> GetMissLoaderLibraries(string loader,
        string loaderVersion, string gameVersion, string gameDir,
        string versionDirName, string? installerPath, int downloadSourceId)
    {
        var lower = loader.ToLowerInvariant();
        if (lower == "forge" && installerPath != null)
        {
            var inst = new ForgeInstaller(downloadSourceId, gameDir, gameVersion);
            var sources = inst.GetMissForgeLibraries(installerPath, versionDirName);
            var result = new List<MissFileDto>(sources.Count);
            foreach (var f in sources)
                result.Add(new MissFileDto(f.Name, f.Path, f.Url, f.Sha1));
            return result;
        }
        if (lower == "neoforge" && installerPath != null)
        {
            var inst = new NeoForgeInstaller(downloadSourceId, gameDir, gameVersion);
            var sources = inst.GetMissNeoForgeLibraries(installerPath, versionDirName);
            var result = new List<MissFileDto>(sources.Count);
            foreach (var f in sources)
                result.Add(new MissFileDto(f.Name, f.Path, f.Url, f.Sha1));
            return result;
        }
        if (lower == "fabric")
        {
            var inst = new FabricInstaller(downloadSourceId, gameDir);
            var sources = await inst.GetMissFabricLibraries(loaderVersion, gameVersion, gameDir);
            var result = new List<MissFileDto>(sources.Count);
            foreach (var f in sources)
                result.Add(new MissFileDto(f.Name, f.Path, f.Url, f.Sha1));
            return result;
        }
        if (lower == "quilt")
        {
            var inst = new QuiltInstaller(downloadSourceId, gameDir);
            var sources = await inst.GetMissQuiltLibraries(loaderVersion, gameVersion, gameDir);
            var result = new List<MissFileDto>(sources.Count);
            foreach (var f in sources)
                result.Add(new MissFileDto(f.Name, f.Path, f.Url, f.Sha1));
            return result;
        }
        return [];
    }

    private async Task InstallLoader(string versionId, string inheritsFromJson,
        string gameDir, string loader, string loaderVersion, string gameVersion,
        string? installerPath, int downloadSourceId, CancellationToken ct)
    {
        var lower = loader.ToLowerInvariant();

        if (lower is "forge" or "neoforge")
        {
            if (installerPath == null)
                throw new FileNotFoundException("找不到加载器安装包");

            var javaPath = await ResolveJavaPath();

            IInstaller installer = lower == "forge"
                ? new ForgeInstaller(downloadSourceId, gameDir, gameVersion)
                : new NeoForgeInstaller(downloadSourceId, gameDir, gameVersion);

            await installer.InstallAsync(versionId, inheritsFromJson,
                javaPath, installerPath, null, null);
            return;
        }

        if (lower == "fabric")
        {
            var inst = new FabricInstaller(downloadSourceId, gameDir);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        if (lower == "quilt")
        {
            var inst = new QuiltInstaller(downloadSourceId, gameDir);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        if (lower == "liteloader")
        {
            var inst = new LiteloaderInstaller(downloadSourceId, gameDir, gameVersion);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        throw new NotSupportedException($"不支持的加载器: {loader}");
    }

    private async Task<string> ResolveJavaPath()
    {
        var javas = await _javaStore.GetMergedAsync(JavaSearchMode.Deep);
        var java = javas.FirstOrDefault(j => j.State == JavaState.Valid);
        if (java == null)
            throw new InvalidOperationException("未配置 Java 运行环境，请先下载 Java");
        return java.Path;
    }

    private async Task DownloadAddons(string[] addonIds, string gameVersion,
        string gameDir, int downloadSourceId, InstallState state, CancellationToken ct)
    {
        using var semaphore = new SemaphoreSlim(12);
        var tasks = addonIds.Select(async addonId =>
        {
            await semaphore.WaitAsync(ct);
            try
            {
                using var client = new HttpClient();
                var url = $"https://api.modrinth.com/v2/project/{addonId}/version";
                var json = await client.GetStringAsync(url);
                var versions = JsonSerializer.Deserialize(json, ApiJsonContext.Default.ListModrinthVersion);
                var match = versions?.FirstOrDefault(v =>
                    v.GameVersions.Contains(gameVersion) && v.Files.Count > 0);

                if (match?.Files.FirstOrDefault() is { } file)
                {
                    var modsDir = Path.Combine(gameDir, "mods");
                    Directory.CreateDirectory(modsDir);
                    var destPath = Path.Combine(modsDir, file.Filename);
                    if (!File.Exists(destPath))
                    {
                        using var dm = new DownloadManager(intervalMs: 500);
                        var tid = dm.CreateTask(maxConcurrentFiles: 1, maxRetries: 3);
                        dm.AddFileToTask(tid, file.Url, destPath);
                        await dm.StartTaskAsync(tid, ct);
                    }
                }
            }
            catch { /* skip failed addon */ }
            finally { semaphore.Release(); }
        });

        await Task.WhenAll(tasks);
    }

    private static void CleanupTempFiles(string? installerPath)
    {
        try
        {
            if (!string.IsNullOrEmpty(installerPath) && File.Exists(installerPath))
                File.Delete(installerPath);
        }
        catch { }
    }

    public InstallState? GetState(string instanceId)
    {
        _states.TryGetValue(instanceId, out var state);
        return state;
    }

    public List<InstallProgressResponse> GetAllActiveStates()
    {
        return _states
            .Where(kv => kv.Value.Status != "completed" && kv.Value.Status != "failed")
            .Select(kv => kv.Value.ToResponse(kv.Key))
            .ToList();
    }

    public void Cancel(string instanceId)
    {
        if (_states.TryRemove(instanceId, out var state))
            state.Cancel();
    }
}

public sealed class InstallState(CancellationTokenSource cts)
{
    public string Status { get; set; } = "not-started";
    public double Progress { get; set; }
    public string? Error { get; set; }
    public string CurrentFile { get; set; } = "";
    public string Stage { get; set; } = "";
    public int TotalFiles { get; set; }
    public int CompletedFiles { get; set; }
    public int FailedFiles { get; set; }
    public double Speed { get; set; }

    public InstallProgressResponse ToResponse(string instanceId) => new(
        InstanceId: instanceId,
        Status: Status,
        Progress: Progress,
        Error: Error,
        CurrentFile: CurrentFile,
        Stage: Stage,
        TotalFiles: TotalFiles,
        CompletedFiles: CompletedFiles,
        FailedFiles: FailedFiles,
        Speed: Speed
    );

    public void Cancel() => cts.Cancel();
}

internal sealed record MissFileDto(string Name, string Path, string Url, string Sha1);

public sealed class ModrinthVersion
{
    public List<string> GameVersions { get; set; } = [];
    public List<ModrinthFile> Files { get; set; } = [];

    public sealed class ModrinthFile
    {
        public string Url { get; set; } = "";
        public string Filename { get; set; } = "";
    }
}
