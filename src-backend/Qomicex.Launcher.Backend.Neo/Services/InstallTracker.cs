using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Core.AOT.Public.Services;
using Qomicex.Core.AOT.Services.Installers;
using Qomicex.Downloader.Refactor.Core;
using Qomicex.Downloader.Refactor.Model;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class InstallTracker
{
    private readonly ConcurrentDictionary<string, InstallState> _states = new();
    private readonly JavaRuntimeStore _javaStore;
    private readonly DownloadSessionManager _sessionManager;
    private readonly string _curseForgeApiKey;

    private static readonly HashSet<string> CfDomains = new(StringComparer.OrdinalIgnoreCase)
    {
        "forgecdn.net", "curseforge.com", "cursecdn.com", "edge.forgecdn.net",
        "media.forgecdn.net", "mediafilez.forgecdn.net"
    };

    public InstallTracker(JavaRuntimeStore javaStore, DownloadSessionManager sessionManager, string curseForgeApiKey)
    {
        _javaStore = javaStore;
        _sessionManager = sessionManager;
        _curseForgeApiKey = curseForgeApiKey;
    }

    public void Start(string instanceId, string gameVersion, string gameDir,
        string? loader, string? loaderVersion, string[]? addons,
        int downloadThreads, bool versionIsolation, int? downloadSourceId, string? instanceName = null,
        Func<InstallState, CancellationToken, Task>? postInstall = null)
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
                    versionIsolation, downloadSourceId ?? 0, state, cts.Token, instanceName);
                if (postInstall is null) return;
                state.Status = "downloading";
                state.Stage = "modpack-files";
                state.Progress = 92;
                state.CurrentFile = "准备下载整合包文件...";
                await postInstall(state, cts.Token);
                state.Status = "completed";
                state.Stage = "completed";
                state.Progress = 100;
                state.CurrentFile = "";
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
        InstallState state, CancellationToken ct, string? instanceName = null)
    {
        var mirror = downloadSourceId == 1 ? DownloadMirror.BMCLAPI : DownloadMirror.Official;
        Trace.WriteLine($"[Install] [{instanceId}] 开始安装: 版本={gameVersion}, 加载器={loader ?? "无"}, 镜像={mirror}, 线程={downloadThreads}");
        using var core = new GameCoreBuilder()
            .Configure(o =>
            {
                o.LauncherName = "QML";
                o.GameRoot = gameDir;
                o.UserAgent = "QomicexLauncher/1.0";
                o.CacheExpiry = TimeSpan.FromMinutes(30);
            })
            .UseDownloadMirror(mirror)
            .Build();
        var versionDirName = instanceName ?? (string.IsNullOrEmpty(loader)
            ? gameVersion
            : $"{gameVersion}-{loader}-{loaderVersion}");

        using var session = _sessionManager.CreateSession($"install-{instanceId}", "install", instanceId);

        var cfHeaders = new Dictionary<string, string> { ["x-api-key"] = _curseForgeApiKey };

        ct.ThrowIfCancellationRequested();
        session.SetStage("fetching-json", 0, "获取版本信息...");
        state.Status = "downloading";

        var manifest = await core.Version.GetManifestAsync();
        var versionInfo = manifest.Versions.FirstOrDefault(v => v.Id == gameVersion)
            ?? throw new Exception($"未找到版本 {gameVersion}");

        var jsonContent = await core.HttpClient.GetStringAsync(versionInfo.Url);
        Trace.WriteLine($"[Install] [{instanceId}] Phase 1 完成: 获取版本 JSON");
        session.SetStage("fetching-json", 3);

        ct.ThrowIfCancellationRequested();
        string? installerPath = null;
        string? loaderDownloadUrl = null;
        Task? loaderJarTask = null;

        var isForge = string.Equals(loader, "forge", StringComparison.OrdinalIgnoreCase);
        var isNeoForge = string.Equals(loader, "neoforge", StringComparison.OrdinalIgnoreCase);
        var isCleanroom = string.Equals(loader, "cleanroom", StringComparison.OrdinalIgnoreCase);

        if (isForge || isNeoForge || isCleanroom)
        {
            session.SetStage("downloading-installer", 4, "下载加载器安装包...");

            var loaderType = isForge
                ? ModLoaderType.Forge
                : isNeoForge ? ModLoaderType.NeoForge : ModLoaderType.Cleanroom;

            var loaders = await core.InstallerProvider.GetAvailableModLoaders(gameVersion, loaderType);
            var match = loaders.FirstOrDefault(l =>
                string.Equals(l.Version, loaderVersion, StringComparison.OrdinalIgnoreCase));

            if (match?.Url == null)
                throw new Exception($"找不到 {loader} {loaderVersion} 的下载链接");

            loaderDownloadUrl = match.Url;

            var tempDir = Path.Combine(gameDir, "temp");
            Directory.CreateDirectory(tempDir);
            installerPath = Path.Combine(tempDir, $"{loader}-{loaderVersion}-installer.jar");

            loaderJarTask = DownloadLoaderJar(installerPath, loaderDownloadUrl, session, cfHeaders, ct);
        }

        async Task DownloadLoaderJar(string path, string url, DownloadSession downloadSession, Dictionary<string, string> headers, CancellationToken cancellationToken)
        {
            if (File.Exists(path))
            {
                var info = new FileInfo(path);
                Trace.WriteLine($"[Install] [{instanceId}] 安装包已存在: {path} ({info.Length} bytes), 验证完整性...");
                try
                {
                    using var fs = File.OpenRead(path);
                    using var zip = new System.IO.Compression.ZipArchive(fs, System.IO.Compression.ZipArchiveMode.Read);
                    if (zip.Entries.Count > 0)
                    {
                        Trace.WriteLine($"[Install] [{instanceId}] 安装包验证通过 ({zip.Entries.Count} 条目)");
                        return;
                    }
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"[Install] [{instanceId}] 安装包损坏: {ex.Message}, 删除后重新下载");
                }
                try { File.Delete(path); } catch { }
            }

            Trace.WriteLine($"[Install] [{instanceId}] 开始下载加载器安装包: {url}");
            var task = new DownloadTask { Url = url, SavePath = path };
            var taskHeaders = IsCfDomain(url) ? headers : null;
            await downloadSession.RunSingleAsync(task, cancellationToken, 4, 5, taskHeaders);
        }

        session.SetStage("scanning-base", 5, "扫描基础文件...");

        var missFiles = await core.Locator.GetMissFilesAsync(jsonContent);
        Trace.WriteLine($"[Install] [{instanceId}] Phase 3 扫描: 缺失 {missFiles.Count} 个基础文件");

        Task<BatchResult>? baseDownloadTask = null;
        if (missFiles.Count > 0)
        {
            Trace.WriteLine($"[Install] [{instanceId}] Phase 3 开始下载基础文件 ({missFiles.Count} 个, {downloadThreads} 线程)");
            session.SetStage("downloading-base", 5);
            var baseTasks = missFiles.Select(f =>
            {
                var headers = IsCfDomain(f.Url) ? cfHeaders : null;
                return new DownloadTask { Url = f.Url, SavePath = f.Path, Headers = headers };
            }).ToList();
            baseDownloadTask = session.RunBatchAsync(baseTasks, ct, 5, 35, maxConcurrency: downloadThreads);
        }
        else
        {
            session.SetStage("downloading-base", 35);
        }

        ct.ThrowIfCancellationRequested();
        Task<BatchResult>? loaderLibTask = null;

        if (!string.IsNullOrEmpty(loader) && !string.IsNullOrEmpty(loaderVersion))
        {
            if (loaderJarTask is not null)
            {
                Trace.WriteLine($"[Install] [{instanceId}] 等待加载器安装包下载完成...");
                await loaderJarTask;
                Trace.WriteLine($"[Install] [{instanceId}] 加载器安装包下载完成");
            }

            session.SetStage("scanning-loader-libs", 35, "扫描加载器库文件...");
            Trace.WriteLine($"[Install] [{instanceId}] Phase 4 开始扫描加载器库文件");

            var missLibs = await GetMissLoaderLibraries(core.Installer,
                loader, loaderVersion, gameVersion, gameDir,
                versionDirName, installerPath, downloadSourceId);
            Trace.WriteLine($"[Install] [{instanceId}] Phase 4 扫描完成: 缺失 {missLibs.Count} 个加载器库文件");

            if (missLibs.Count > 0)
            {
                Trace.WriteLine($"[Install] [{instanceId}] Phase 4 开始下载加载器库文件 ({missLibs.Count} 个)");
                session.SetStage("downloading-loader-libs", 35);
                var libTasks = missLibs.Select(f =>
                {
                    var headers = IsCfDomain(f.Url) ? cfHeaders : null;
                    return new DownloadTask { Url = f.Url, SavePath = f.Path, Headers = headers };
                }).ToList();
                loaderLibTask = session.RunBatchAsync(libTasks, ct, 35, 55, maxConcurrency: 32);
            }
        }
        else if (string.IsNullOrEmpty(loader))
        {
            var jsonPath = Path.Combine(gameDir, "versions", versionDirName, $"{versionDirName}.json");
            JsonNode root = JsonNode.Parse(jsonContent)!;
            root["id"] = versionDirName;
            string updatedJson = root.ToJsonString();
            await File.WriteAllTextAsync(jsonPath, updatedJson);
        }

        ct.ThrowIfCancellationRequested();
        Task? addonTask = null;

        if (addons != null && addons.Length > 0)
        {
            Trace.WriteLine($"[Install] [{instanceId}] Phase 6 开始下载附加 Mod ({addons.Length} 个)");
            addonTask = DownloadAddons(addons, gameVersion, gameDir, cfHeaders, ct);
        }

        Exception? downloadError = null;
        async Task WaitSafe(Task? t)
        {
            if (t == null) return;
            try { await t; } catch (Exception ex) { downloadError ??= ex; }
        }
        await WaitSafe(loaderJarTask);
        if (baseDownloadTask is not null)
        {
            try
            {
                var baseResult = await baseDownloadTask;
                if (baseResult.FailedTasks > 0)
                {
                    var retried = await RetryFailedFiles(baseResult.FailedTaskList, downloadThreads, session, ct, 5, 35);
                    if (retried.FailedTasks > 0)
                        throw new Exception($"基础文件下载失败 ({retried.FailedTasks} 个)");
                }
            }
            catch (Exception ex) { downloadError ??= ex; }
        }
        await WaitSafe(loaderLibTask);

        if (loaderLibTask is not null)
        {
            try
            {
                var libResult = await loaderLibTask;
                if (libResult.FailedTasks > 0)
                {
                    var retried = await RetryFailedFiles(libResult.FailedTaskList, 32, session, ct, 35, 55);
                    if (retried.FailedTasks > 0)
                        throw new Exception($"加载器库文件下载失败 ({retried.FailedTasks} 个)");
                }
            }
            catch (Exception ex) { downloadError ??= ex; }
        }

        await WaitSafe(addonTask);
        if (downloadError != null) throw downloadError;

        session.SetStage("post-download", 85);

        ct.ThrowIfCancellationRequested();
        if (!string.IsNullOrEmpty(loader) && !string.IsNullOrEmpty(loaderVersion))
        {
            session.SetStage("installing-loader", 88, $"安装 {loader}...");
            await InstallLoader(core.Installer, versionDirName, jsonContent, gameDir,
                loader, loaderVersion, gameVersion, installerPath, downloadSourceId, session, ct);
            session.SetStage("installing-loader", 92);
        }

        ct.ThrowIfCancellationRequested();
        session.SetStage("verifying-jar", 92, "校验主 Jar 文件...");

        var missJar = await core.Locator.GetMissMainJarAsync(jsonContent);
        if (missJar != null)
        {
            Trace.WriteLine($"[Install] [{instanceId}] Phase 5 缺失主 Jar: 开始下载");
            var jarTask = new DownloadTask { Url = missJar.Url, SavePath = missJar.Path };
            var jarHeaders = IsCfDomain(missJar.Url) ? cfHeaders : null;
            await session.RunSingleAsync(jarTask, ct, 92, 98, jarHeaders);
        }
        else
        {
            session.SetStage("verifying-jar", 98);
        }

        ct.ThrowIfCancellationRequested();
        session.SetStage("finishing", 98, "完成安装...");

        if (versionIsolation && !string.IsNullOrEmpty(loader))
        {
            var isoDir = Path.Combine(gameDir, "versions", versionDirName);
            foreach (var sub in new[] { "mods", "saves", "resourcepacks", "shaderpacks", "screenshots", "datapacks", "crash-reports" })
                Directory.CreateDirectory(Path.Combine(isoDir, sub));
        }

        state.Status = "completed";
        session.ReportCompleted();
        Trace.WriteLine($"[Install] [{instanceId}] 安装完成");

        CleanupTempFiles(installerPath);
        SyncStateFromSession(state, session);
    }

    private async Task<BatchResult> RetryFailedFiles(
        IReadOnlyList<DownloadTask> failedTasks, int maxConcurrency,
        DownloadSession session, CancellationToken ct, double startPct, double endPct)
    {
        Trace.WriteLine($"[Install] 重试 {failedTasks.Count} 个失败文件");
        return await session.RunBatchAsync(failedTasks, ct, startPct, endPct, maxConcurrency: maxConcurrency);
    }

    private async Task<List<MissFileData>> GetMissLoaderLibraries(IInstallerFactory installerFactory,
        string loader, string loaderVersion, string gameVersion, string gameDir,
        string versionDirName, string? installerPath, int downloadSourceId)
    {
        var lower = loader.ToLowerInvariant();
        if (lower == "forge" && installerPath != null)
        {
            var inst = installerFactory.CreateForge(downloadSourceId, gameDir, gameVersion);
            return await inst.GetMissLibrariesAsync(installerPath, versionDirName, null);
        }
        if (lower == "neoforge" && installerPath != null)
        {
            var inst = installerFactory.CreateNeoForge(downloadSourceId, gameDir, gameVersion);
            return await inst.GetMissLibrariesAsync(installerPath, versionDirName, null);
        }
        if (lower == "fabric")
        {
            var inst = installerFactory.CreateFabric(downloadSourceId, gameDir);
            return await inst.GetMissLibrariesAsync(loaderVersion, gameVersion, gameDir);
        }
        if (lower == "legacyfabric")
        {
            var inst = installerFactory.CreateLegacyFabric(downloadSourceId, gameDir);
            return await inst.GetMissLibrariesAsync(loaderVersion, gameVersion, gameDir);
        }
        if (lower == "quilt")
        {
            var inst = installerFactory.CreateQuilt(downloadSourceId, gameDir);
            return await inst.GetMissLibrariesAsync(loaderVersion, gameVersion, gameDir);
        }
        if (lower == "babric")
        {
            var inst = installerFactory.CreateBabric(downloadSourceId, gameDir);
            return await inst.GetMissLibrariesAsync(loaderVersion, gameVersion, gameDir);
        }
        if (lower == "cleanroom" && installerPath != null)
        {
            var inst = installerFactory.CreateCleanroom(downloadSourceId, gameDir);
            return await inst.GetMissLibrariesAsync(installerPath, versionDirName, null);
        }
        return [];
    }

    private async Task InstallLoader(IInstallerFactory installerFactory,
        string versionId, string inheritsFromJson,
        string gameDir, string loader, string loaderVersion, string gameVersion,
        string? installerPath, int downloadSourceId,
        DownloadSession? session = null, CancellationToken ct = default)
    {
        var lower = loader.ToLowerInvariant();

        if (lower is "forge" or "neoforge")
        {
            if (installerPath == null)
                throw new FileNotFoundException("找不到加载器安装包");

            var javaPath = await ResolveJavaPath();

            IInstaller installer = lower == "forge"
                ? installerFactory.CreateForge(downloadSourceId, gameDir, gameVersion)
                : installerFactory.CreateNeoForge(downloadSourceId, gameDir, gameVersion);

            await installer.InstallAsync(versionId, inheritsFromJson,
                javaPath, installerPath, null, null);
            return;
        }

        if (lower == "fabric")
        {
            var inst = installerFactory.CreateFabric(downloadSourceId, gameDir);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        if (lower == "legacyfabric")
        {
            var inst = installerFactory.CreateLegacyFabric(downloadSourceId, gameDir);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        if (lower == "quilt")
        {
            var inst = installerFactory.CreateQuilt(downloadSourceId, gameDir);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        if (lower == "liteloader")
        {
            var inst = installerFactory.CreateLiteLoader(downloadSourceId, gameDir, gameVersion);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        if (lower == "babric")
        {
            session?.SetStage("installing-loader", 88, "获取 Babric Meta...");
            var inst = installerFactory.CreateBabric(downloadSourceId, gameDir);
            await inst.InstallAsync(versionId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        if (lower == "cleanroom")
        {
            if (installerPath == null)
                throw new FileNotFoundException("找不到加载器安装包");

            var inst = installerFactory.CreateCleanroom(downloadSourceId, gameDir);
            await inst.InstallAsync(versionId, inheritsFromJson,
                null, installerPath, null, null);
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
        string gameDir, Dictionary<string, string> cfHeaders, CancellationToken ct)
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
                        var downloader = new Qomicex.Downloader.Refactor.Downloader(builder => builder
                            .WithMaxConcurrency(1)
                            .WithRetry(3, TimeSpan.FromSeconds(1))
                            .WithProgress(null, null, Common.DownloaderTrace.CreateLogProgress()));
                        var task = new DownloadTask { Url = file.Url, SavePath = destPath };
                        await downloader.DownloadAsync(task, ct);
                    }
                }
            }
            catch { }
            finally { semaphore.Release(); }
        });

        await Task.WhenAll(tasks);
    }

    private static bool IsCfDomain(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        return CfDomains.Any(d => uri.Host.EndsWith(d, StringComparison.OrdinalIgnoreCase));
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

    private static void SyncStateFromSession(InstallState state, DownloadSession session)
    {
        var snap = session.GetSnapshot();
        state.Progress = snap.Progress;
        state.Stage = snap.Stage;
        state.CurrentFile = snap.CurrentFile ?? "";
        state.TotalFiles = snap.TotalFiles;
        state.CompletedFiles = snap.CompletedFiles;
        state.FailedFiles = snap.FailedFiles;
        state.Speed = snap.Speed;
    }

    public InstallState? GetState(string instanceId)
    {
        _states.TryGetValue(instanceId, out var state);
        if (state is not null)
        {
            var session = _sessionManager.GetSession($"install-{instanceId}");
            if (session is not null)
            {
                var snap = session.GetSnapshot();
                if (snap.Status == "downloading")
                    SyncStateFromSession(state, session);
            }
        }
        return state;
    }

    public List<InstallProgressResponse> GetAllActiveStates()
    {
        var list = new List<InstallProgressResponse>();
        var seenSessionIds = new HashSet<string>();

        foreach (var s in _sessionManager.GetActiveSnapshots().Where(s => s.Type == "install"))
        {
            list.Add(new InstallProgressResponse(
                InstanceId: s.InstanceId ?? s.SessionId,
                Status: s.Status,
                Progress: s.Progress,
                Error: s.Error,
                TotalFiles: s.TotalFiles,
                CompletedFiles: s.CompletedFiles,
                FailedFiles: s.FailedFiles,
                CurrentFile: s.CurrentFile ?? "",
                Speed: s.Speed,
                IsPaused: s.IsPaused,
                Stage: s.Stage
            ));
            if (s.InstanceId is not null)
                seenSessionIds.Add(s.InstanceId);
        }

        foreach (var (id, state) in _states)
        {
            if (seenSessionIds.Contains(id)) continue;
            if (state.Status is "completed" or "failed" or "cancelled" or "not-started") continue;
            var snap = _sessionManager.GetSession($"install-{id}")?.GetSnapshot();
            list.Add(new InstallProgressResponse(
                InstanceId: id,
                Status: state.Status,
                Progress: state.Progress,
                Error: state.Error,
                TotalFiles: state.TotalFiles,
                CompletedFiles: state.CompletedFiles,
                FailedFiles: state.FailedFiles,
                CurrentFile: state.CurrentFile,
                Speed: state.Speed,
                IsPaused: state.Paused,
                Stage: state.Stage
            ));
        }

        return list;
    }

    public void Cancel(string instanceId)
    {
        if (_states.TryRemove(instanceId, out var state))
            state.Cancel();
        _sessionManager.CancelSession($"install-{instanceId}");
    }

    public void Pause(string instanceId)
    {
        if (_states.TryGetValue(instanceId, out var state))
            state.Pause();
    }

    public void Resume(string instanceId)
    {
        if (_states.TryGetValue(instanceId, out var state))
            state.Resume();
    }
}

public sealed class InstallState(CancellationTokenSource cts)
{
    private volatile bool _paused;

    public CancellationToken Token => cts.Token;
    public bool Paused => _paused;
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
    public void Pause() => _paused = true;
    public void Resume() => _paused = false;
}

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
