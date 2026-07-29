using System.Collections.Concurrent;
using System.Diagnostics;
using System.Linq;
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
using Qomicex.Launcher.Backend.Neo.Models;

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

    /// <summary>加载器默认必装 addon，合并前端传参与后端清单后用。</summary>
    private static readonly Dictionary<string, string[]> DefaultLoaderAddons = new(StringComparer.OrdinalIgnoreCase)
    {
        ["fabric"] = ["fabric-api"],
        ["quilt"] = ["qsl"],
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
        string? optifineVersion = null, IReadOnlyList<AdditionalFile>? additionalFiles = null,
        Func<CancellationToken, Task<List<AdditionalFile>>>? resolveAdditionalFiles = null,
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
                    versionIsolation, downloadSourceId ?? 0, state, cts.Token,
                    instanceName, optifineVersion, additionalFiles,
                    resolveAdditionalFiles);
                if (postInstall is null)
                {
                    state.Status = "completed";
                    state.Stage = "completed";
                    state.Progress = 100;
                    return;
                }
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
                System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 安装被取消");
            }
            catch (Exception ex)
            {
                state.Status = "failed";
                state.Error = ex.Message;
                System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 安装异常: {ex.GetType().Name}: {ex.Message}\n{ex.StackTrace}");
                _sessionManager.GetSession($"install-{instanceId}")?.ReportFailed(ex.Message);
            }
        });
    }

    private async Task RunInstallAsync(string instanceId, string gameVersion,
        string gameDir, string? loader, string? loaderVersion, string[]? addons,
        int downloadThreads, bool versionIsolation, int downloadSourceId,
        InstallState state, CancellationToken ct, string? instanceName = null,
        string? optifineVersion = null, IReadOnlyList<AdditionalFile>? additionalFiles = null,
        Func<CancellationToken, Task<List<AdditionalFile>>>? resolveAdditionalFiles = null)
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

        // 修改 version id 以匹配实际版本目录名，确保扫描路径一致
        var versionJsonNode = JsonNode.Parse(jsonContent)!;
        versionJsonNode["id"] = versionDirName;
        jsonContent = versionJsonNode.ToJsonString();

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
            var versionDir = Path.Combine(gameDir, "versions", versionDirName);
            Directory.CreateDirectory(versionDir);
            var jsonPath = Path.Combine(versionDir, $"{versionDirName}.json");
            await File.WriteAllTextAsync(jsonPath, jsonContent);
        }

        // === 等待基础下载和加载器库下载完成 ===
        ct.ThrowIfCancellationRequested();
        Exception? downloadError = null;
        if (baseDownloadTask is not null)
        {
            try
            {
                var baseResult = await baseDownloadTask;
                System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 基础文件下载结果: {baseResult.CompletedTasks} OK, {baseResult.FailedTasks} 失败");
                if (baseResult.FailedTasks > 0)
                {
                    var retried = await RetryFailedFiles(baseResult.FailedTaskList, downloadThreads, session, ct, 5, 35);
                    System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 重试结果: {retried.CompletedTasks} OK, {retried.FailedTasks} 失败");
                    if (retried.FailedTasks > 0)
                        throw new Exception($"基础文件下载失败 ({retried.FailedTasks} 个)");
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 基础文件下载异常: {ex.GetType().Name}: {ex.Message}");
                downloadError ??= ex;
            }
        }
        if (loaderLibTask is not null)
        {
            try
            {
                var libResult = await loaderLibTask;
                System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 加载器库下载结果: {libResult.CompletedTasks} OK, {libResult.FailedTasks} 失败");
                if (libResult.FailedTasks > 0)
                {
                    var retried = await RetryFailedFiles(libResult.FailedTaskList, 32, session, ct, 35, 55);
                    System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 重试结果: {retried.CompletedTasks} OK, {retried.FailedTasks} 失败");
                    if (retried.FailedTasks > 0)
                        throw new Exception($"加载器库文件下载失败 ({retried.FailedTasks} 个)");
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine($"[Install] [{instanceId}] 加载器库下载异常: {ex.GetType().Name}: {ex.Message}");
                downloadError ??= ex;
            }
        }
        if (downloadError != null) throw downloadError;

        // === Goal 2: 合并前端传参与后端默认清单 ===
        var resolvedAddons = MergeAddons(addons, loader);

        // === Goal 3: OptiFine 智能路由 ===
        if (!string.IsNullOrWhiteSpace(optifineVersion))
        {
            var isForgeLike = string.Equals(loader, "forge", StringComparison.OrdinalIgnoreCase)
                           || string.Equals(loader, "neoforge", StringComparison.OrdinalIgnoreCase);
            if (isForgeLike)
            {
                Trace.WriteLine($"[Install] [{instanceId}] OptiFine {optifineVersion} 将以 mod 形式注入 forge/neoforge");
                var optiFinePath = Path.Combine("mods", $"OptiFine-{gameVersion}-{optifineVersion}.jar");
                resolvedAddons.Add($"optifine:{gameVersion}:{optifineVersion}");
            }
            else if (string.IsNullOrEmpty(loader))
            {
                Trace.WriteLine($"[Install] [{instanceId}] OptiFine {optifineVersion} 将走独立安装器路径");
                session.SetStage("installing-optifine", 70, $"安装 OptiFine {optifineVersion}...");
                await InstallLoader(core.Installer, versionDirName, jsonContent, gameDir,
                    "optifine", optifineVersion, gameVersion, null, downloadSourceId, session, ct);
                session.SetStage("installing-optifine", 75);
            }
        }

        // === 延迟解析 FTB 等附加文件（在 pipeline 内部执行，不阻塞 Start() 返回） ===
        if (resolveAdditionalFiles is not null)
        {
            ct.ThrowIfCancellationRequested();
            session.SetStage("downloading-addons", 60, "解析 FTB 整合包文件清单...");
            var resolved = await resolveAdditionalFiles(ct);
            if (resolved is { Count: > 0 })
            {
                additionalFiles = (additionalFiles is { Count: > 0 })
                    ? [..additionalFiles, ..resolved]
                    : resolved;
            }
        }

        // === Goal 6: 解析 addons → AdditionalFile 列表 ===
        var allAdditionalFiles = new List<AdditionalFile>();
        if (resolvedAddons.Count > 0)
        {
            session.SetStage("downloading-addons", 65, $"解析 {resolvedAddons.Count} 个附加 Mod...");
            var resolved = await ResolveAddonsAsync(resolvedAddons, gameVersion, gameDir, downloadSourceId, ct);
            allAdditionalFiles.AddRange(resolved);
        }

        if (additionalFiles is { Count: > 0 })
            allAdditionalFiles.AddRange(additionalFiles);

        // === Goal 6: 批量下载附加文件 ===
        if (allAdditionalFiles.Count > 0)
        {
            session.SetStage("downloading-additional-files", 70, $"下载 {allAdditionalFiles.Count} 个附加文件...");
            var afTasks = allAdditionalFiles.Select(af =>
            {
                var destPath = Path.Combine(gameDir, af.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                var headers = new Dictionary<string, string>();
                if (string.Equals(af.Source, "modrinth", StringComparison.OrdinalIgnoreCase))
                    headers["User-Agent"] = "QomicexLauncher/1.0";
                var isCf = string.Equals(af.Source, "curseforge", StringComparison.OrdinalIgnoreCase) || IsCfDomain(af.Identifier);
                if (isCf)
                {
                    headers["x-api-key"] = _curseForgeApiKey;
                    headers["User-Agent"] = "QomicexLauncher/1.0";
                }
                System.Diagnostics.Trace.WriteLine($"[Install] [附加文件] url={af.Identifier[..Math.Min(60, af.Identifier.Length)]}, source={af.Source}, isCfDomain={IsCfDomain(af.Identifier)}, hasApiKey={headers.ContainsKey("x-api-key")}, apiKeyLen={_curseForgeApiKey?.Length ?? 0}");
                return new DownloadTask { Url = af.Identifier, SavePath = destPath, Headers = headers.Count > 0 ? headers : null };
            }).ToList();

            var afResult = await session.RunBatchAsync(afTasks, ct, 70, 85, maxConcurrency: downloadThreads);
            if (afResult.FailedTasks > 0)
            {
                var retried = await RetryFailedFiles(afResult.FailedTaskList, downloadThreads, session, ct, 70, 85);
                if (retried.FailedTasks > 0)
                    throw new Exception($"附加文件下载失败 ({retried.FailedTasks} 个)");
            }
        }
        else
        {
            session.SetStage("downloading-additional-files", 85);
        }

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

    /// <summary>合并前端传参 addons 与后端默认清单，去重返回。</summary>
    private static List<string> MergeAddons(string[]? userAddons, string? loader)
    {
        var result = new List<string>();
        if (userAddons is { Length: > 0 })
            result.AddRange(userAddons);
        if (!string.IsNullOrEmpty(loader) && DefaultLoaderAddons.TryGetValue(loader, out var defaults))
        {
            foreach (var d in defaults)
            {
                if (!result.Contains(d, StringComparer.OrdinalIgnoreCase))
                    result.Add(d);
            }
        }
        return result;
    }

    /// <summary>
    /// 将 addon slug 列表解析为 AdditionalFile 列表。
    /// 支持格式：普通 slug（如 "fabric-api"），OptiFine 特殊格式（"optifine:mcversion:type-patch"）。
    /// </summary>
    private async Task<List<AdditionalFile>> ResolveAddonsAsync(
        List<string> addonIds, string gameVersion, string gameDir, int downloadSourceId, CancellationToken ct)
    {
        var result = new List<AdditionalFile>();
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("QomicexLauncher/1.0");

        var slugList = new List<string>();
        foreach (var id in addonIds)
        {
            if (id.StartsWith("optifine:", StringComparison.OrdinalIgnoreCase))
            {
                // OptiFine as mod for forge/neoforge
                var parts = id.Split(':');
                if (parts.Length >= 3)
                {
                    var mcVer = parts[1];
                    var ofVer = parts[2];
                    var ofParts = ofVer.Split('-');
                    var type = ofParts.Length >= 2 ? ofParts[0] : "HD_U";
                    var patch = ofParts.Length >= 2 ? ofParts[1] : ofVer;
                    var baseUrl = downloadSourceId == 1
                        ? "https://bmclapi2.bangbang93.com/optifine"
                        : "https://optifine.net/download";
                    var url = $"{baseUrl}/{Uri.EscapeDataString(mcVer)}/{type}/{patch}";
                    var filename = $"OptiFine-{mcVer}_{type}_{patch}.jar";
                    result.Add(new AdditionalFile(
                        Source: downloadSourceId == 1 ? "url" : "modrinth",
                        Identifier: url,
                        RelativePath: Path.Combine("mods", filename)
                    ));
                }
                continue;
            }
            slugList.Add(id);
        }

        if (slugList.Count == 0) return result;

        // 并发解析 Modrinth slug
        using var semaphore = new SemaphoreSlim(12);
        var tasks = slugList.Select(async slug =>
        {
            await semaphore.WaitAsync(ct);
            try
            {
                var url = $"https://api.modrinth.com/v2/project/{Uri.EscapeDataString(slug)}/version";
                var json = await client.GetStringAsync(url, ct);
                var versions = JsonSerializer.Deserialize(json, ApiJsonContext.Default.ListModrinthVersion);
                var match = versions?.FirstOrDefault(v =>
                    v.GameVersions.Contains(gameVersion) && v.Files.Count > 0);

                if (match?.Files.FirstOrDefault() is { } file)
                {
                    var destPath = "mods/" + file.Filename;
                    lock (result)
                    {
                        result.Add(new AdditionalFile(
                            Source: "modrinth",
                            Identifier: file.Url,
                            RelativePath: destPath
                        ));
                    }
                }
                else
                {
                    Trace.WriteLine($"[Install] 未找到 addon {slug} 的兼容版本 (MC {gameVersion})");
                }
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"[Install] 解析 addon {slug} 失败: {ex.Message}");
            }
            finally { semaphore.Release(); }
        });

        await Task.WhenAll(tasks);
        return result;
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
            if (state.Status is "completed" or "failed" or "cancelled") continue;
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
        if (_states.TryGetValue(instanceId, out var state))
        {
            state.Cancel();
            _ = Task.Delay(100).ContinueWith(t => { _states.TryRemove(instanceId, out _); });
        }
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

    public async Task ShutdownAsync()
    {
        var instanceIds = _states.Keys.ToList();
        foreach (var id in instanceIds)
        {
            if (_states.TryGetValue(id, out var state))
                state.Cancel();
            _sessionManager.CancelSession($"install-{id}");
        }
        await Task.Delay(200);
        _states.Clear();
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

    public void Cancel()
    {
        System.Diagnostics.Trace.WriteLine($"[InstallState] Cancel() called\n{Environment.StackTrace}");
        cts.Cancel();
    }
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
