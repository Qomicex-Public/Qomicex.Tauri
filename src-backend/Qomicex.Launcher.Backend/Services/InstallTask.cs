using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using Qomicex.Downloader;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Core.Modules.Helpers.Installers;
using Qomicex.Core.Modules.Helpers.Resources;

namespace Qomicex.Launcher.Backend.Services;

public class InstallTask : IInstallTask
{
    private readonly string _gameVersion;
    private readonly string _gameDir;
    private readonly string? _loader;
    private readonly string? _loaderVersion;
    private readonly string[]? _addons;
    private readonly int _downloadThreads;
    private readonly bool _versionIsolation;
    private readonly int _downloadSourceId;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly string? _javaPath;

    private readonly CancellationTokenSource _cts = new();
    private readonly DownloadManager _downloadManager = new(intervalMs: 500);

    // Group B parallel progress tracking
    private double _libsProgress;
    private double _assetsProgress;
    private double _mainJarProgress;
    private double _loaderJarProgress;

    private string _versionId = string.Empty;
    private string _effectiveGameDir = string.Empty;

    // --- Public state (polled by frontend) ---
    public string InstanceId { get; }
    public string Stage { get; private set; } = "queued";
    public double Progress { get; private set; }
    public string? Error { get; private set; }
    public int TotalFiles { get; private set; }
    public int CompletedFiles { get; private set; }
    public int FailedFiles { get; private set; }
    public string CurrentFile { get; private set; } = string.Empty;
    public double Speed { get; private set; }
    public bool IsPaused { get; private set; }
    public bool IsCompleted { get; private set; }

    public event Action<InstallTask>? OnStateChanged;

    public CancellationToken Token => _cts.Token;

    public InstallTask(string instanceId, string gameVersion, string gameDir,
        string? loader, string? loaderVersion, string[]? addons,
        int downloadThreads, bool versionIsolation,
        IHttpClientFactory httpClientFactory, int downloadSourceId = 0, int downloadTimeout = 15,
        string? javaPath = null)
    {
        InstanceId = instanceId;
        _gameVersion = gameVersion;
        _gameDir = gameDir;
        _loader = loader;
        _loaderVersion = loaderVersion;
        _addons = addons;
        _downloadThreads = downloadThreads;
        _versionIsolation = versionIsolation;
        _downloadSourceId = downloadSourceId;
        _httpClientFactory = httpClientFactory;
        _javaPath = javaPath;

        _versionId = !string.IsNullOrEmpty(loader) && !string.IsNullOrEmpty(loaderVersion)
            ? $"{gameVersion}-{loader}-{loaderVersion}"
            : gameVersion;
        _effectiveGameDir = versionIsolation
            ? Path.Combine(gameDir, "versions", _versionId)
            : gameDir;

        _downloadManager.OnTaskProgressUpdated += (taskId, info) =>
        {
            TotalFiles = info.TotalFiles;
            CompletedFiles = info.CompletedFiles;
            FailedFiles = info.FailedFiles;
            Speed = info.Speed;
        };

        _downloadManager.OnGlobalProgressUpdated += info =>
        {
            Speed = info.TotalSpeed;
        };
    }

    public void SetState(string stage, double progress, string currentFile = "")
    {
        Stage = stage;
        Progress = progress;
        if (!string.IsNullOrEmpty(currentFile))
            CurrentFile = currentFile;
        OnStateChanged?.Invoke(this);
    }

    private double GroupBWeightedProgress()
    {
        return _libsProgress * 0.35 + _assetsProgress * 0.35 + _mainJarProgress * 0.15 + _loaderJarProgress * 0.15;
    }

    public async Task StartAsync()
    {
        try
        {
            if (_loader is "forge" or "neoforge")
            {
                FindJavaExecutable();
            }

            // ===== Group A: Download JSON (3%) =====
            SetState("downloading-json", 0, $"{_gameVersion}.json");
            var versionJsonUrl = await ResolveVersionJsonUrl();
            if (string.IsNullOrEmpty(versionJsonUrl))
                throw new Exception($"无法解析版本 {_gameVersion} 的 JSON 下载地址");

            var vanillaVersionDir = Path.Combine(_gameDir, "versions", _gameVersion);
            Directory.CreateDirectory(vanillaVersionDir);
            var versionJsonPath = Path.Combine(vanillaVersionDir, $"{_gameVersion}.json");

            if (!File.Exists(versionJsonPath))
            {
                var core = new Qomicex.Downloader.Core(threadCount: 4, maxRetries: 3, ignoreRangeProbe200Ok: true);
                await core.DownloadFileAsync(versionJsonUrl, versionJsonPath, null, _cts.Token);
            }
            SetState("downloading-json", 3);
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Scan missing files (parallel) =====
            var resourceHelper = new LocalResourceHelper();
            var missLibs = await resourceHelper.GetMissLibrariesAsync(_gameVersion, _gameDir);
            var missAssets = await resourceHelper.GetMissAssetsAsync(_gameVersion, _gameDir);
            var missMainJar = await resourceHelper.GetMissMainJarAsync(_gameVersion, _gameDir);

            bool needLoaderJar = false;
            string loaderDownloadUrl = string.Empty;
            string installerPath = string.Empty;

            if (!string.IsNullOrEmpty(_loader) && !string.IsNullOrEmpty(_loaderVersion))
            {
                var loaderLower = _loader.ToLowerInvariant();
                if (loaderLower is "forge" or "neoforge")
                {
                    loaderDownloadUrl = await ResolveLoaderDownloadUrl(_loader, _gameVersion, _loaderVersion);
                    var tempDir = Path.Combine(_gameDir, "temp");
                    Directory.CreateDirectory(tempDir);
                    installerPath = Path.Combine(tempDir, $"{_loader}-{_gameVersion}-{_loaderVersion}-installer.jar");
                    needLoaderJar = !File.Exists(installerPath) || new FileInfo(installerPath).Length == 0;
                }
            }

            // ===== Group D: Mod download (starts immediately, runs in parallel) =====
            Task? modTask = null;
            if (_addons != null && _addons.Length > 0)
            {
                modTask = DownloadAddonsParallel();
            }

            // ===== Group B: Parallel download (libs + assets + mainJar + loaderJar) -> 3%-53% =====
            SetState("downloading", 3);
            _libsProgress = missLibs.Count > 0 ? 0 : 100;
            _assetsProgress = missAssets.Count > 0 ? 0 : 100;
            _mainJarProgress = (missMainJar?.Path != null) ? 0 : 100;
            _loaderJarProgress = needLoaderJar ? 0 : 100;

            var groupBTasks = new List<Task>();

            if (missLibs.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in missLibs)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _libsProgress = p, _cts.Token));
            }

            if (missAssets.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in missAssets)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _assetsProgress = p, _cts.Token));
            }

            if (missMainJar != null && !string.IsNullOrEmpty(missMainJar.Path))
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, missMainJar.Url, missMainJar.Path);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _mainJarProgress = p, _cts.Token));
            }

            if (needLoaderJar)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, loaderDownloadUrl, installerPath);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _loaderJarProgress = p, _cts.Token));
            }

            // Poll weighted progress while Group B runs
            var groupBPollCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            _ = Task.Run(async () =>
            {
                while (!groupBPollCts.IsCancellationRequested)
                {
                    Progress = 3 + GroupBWeightedProgress() / 100.0 * 50;
                    OnStateChanged?.Invoke(this);
                    try { await Task.Delay(100, groupBPollCts.Token); } catch { break; }
                }
            });

            await Task.WhenAll(groupBTasks);
            groupBPollCts.Cancel();

            // Check for failures in Group B
            var allInfos = _downloadManager.GetAllTaskInfos();
            foreach (var (_, info) in allInfos)
            {
                if (info.FailedFiles > 0)
                    throw new Exception($"下载阶段失败: {info.FailedFiles} 个文件");
            }

            SetState("downloading", 53);
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Loader handling (53%-85%) =====
            if (!string.IsNullOrEmpty(_loader) && !string.IsNullOrEmpty(_loaderVersion))
            {
                await HandleLoaderInstall(
                    resourceHelper, installerPath, needLoaderJar);
            }
            else
            {
                SetState("completed", 85);
            }
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Wait for Group D (mods) =====
            if (modTask != null)
            {
                SetState("downloading-addons", 85, "附加内容...");
                await modTask;
            }

            IsCompleted = true;
            SetState("completed", 100);
        }
        catch (OperationCanceledException)
        {
            SetState("cancelled", Progress);
        }
        catch (Exception ex)
        {
            Error = ex.Message;
            SetState("failed", Progress);
            Trace.WriteLine($"[InstallTask] 安装失败: {ex}");
        }
        finally
        {
            _downloadManager.StopTask(-1);
        }
    }

    private async Task RunDownloadTaskWithCallback(int taskId, Action<double> onProgress, CancellationToken ct)
    {
        var downloadTask = _downloadManager.StartTaskAsync(taskId, ct);
        int lastCompleted = 0;
        while (!downloadTask.IsCompleted && !ct.IsCancellationRequested)
        {
            var infos = _downloadManager.GetAllTaskInfos();
            if (infos.TryGetValue(taskId, out var info))
            {
                onProgress(info.Progress);

                TotalFiles += info.TotalFiles;
                CompletedFiles += info.CompletedFiles;
                FailedFiles += info.FailedFiles;
                Speed = info.Speed;

                if (info.CompletedFiles > lastCompleted)
                {
                    var statuses = _downloadManager.GetTaskFileStatuses(taskId);
                    var lastDone = statuses.LastOrDefault(s =>
                        s.Status == DownloadTask.FileStatus.Completed ||
                        s.Status == DownloadTask.FileStatus.Failed);
                    if (lastDone.Name != null)
                        CurrentFile = lastDone.Name;
                    lastCompleted = info.CompletedFiles;
                }
                OnStateChanged?.Invoke(this);
            }
            try { await Task.Delay(100, ct); } catch (OperationCanceledException) { break; }
        }
        await downloadTask;
    }

    private async Task HandleLoaderInstall(
        LocalResourceHelper resourceHelper, string installerPath, bool needLoaderJar)
    {
        var loaderLower = _loader!.ToLowerInvariant();
        bool isForgeLike = loaderLower is "forge" or "neoforge";

        if (isForgeLike)
        {
            // Group C: Download loader libs BEFORE install (to speed up)
            SetState("downloading-loader-libs", 53, "正在补全加载器库文件...");
            List<LocalResourceHelper.MissFileData> remainingLibs;
            if (loaderLower == "forge")
            {
                var fi = new ForgeInstaller(0, _gameDir, _gameVersion);
                remainingLibs = fi.GetMissForgeLibraries(installerPath, _versionId);
            }
            else
            {
                var nfi = new NeoForgeInstaller(0, _gameDir, _gameVersion);
                remainingLibs = nfi.GetMissNeoForgeLibraries(installerPath, _versionId);
            }

            if (remainingLibs.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in remainingLibs)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                double loaderLibProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    loaderLibProgress = p;
                    Progress = 53 + loaderLibProgress / 100.0 * 15;
                }, _cts.Token);
            }
            SetState("downloading-loader-libs", 68);
            _cts.Token.ThrowIfCancellationRequested();

            // Install loader (68%-80%)
            SetState("installing-loader", 68, $"{_loader} {_loaderVersion}");
            var httpClient = _httpClientFactory.CreateClient();
            await InstallModLoader(httpClient, _versionId, installerPath);
            SetState("installing-loader", 80);

            // Merged main jar (80%-85%)
            SetState("downloading-mainjar", 80, $"{_versionId}.jar");
            var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
            if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, loaderMainJar.Url, loaderMainJar.Path);
                double mainJarProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    mainJarProgress = p;
                    Progress = 80 + mainJarProgress / 100.0 * 5;
                }, _cts.Token);
            }
            SetState("downloading-mainjar", 85);

            TryDelete(installerPath);
        }
        else
        {
            // Fabric/Quilt/LiteLoader: install writes merged JSON, then scan + download remaining libs
            SetState("installing-loader", 53, $"{_loader} {_loaderVersion}");
            var loaderJsonPath = Path.Combine(_gameDir, "versions", _versionId, $"{_versionId}.json");
            if (!File.Exists(loaderJsonPath))
            {
                var httpClient = _httpClientFactory.CreateClient();
                await InstallModLoader(httpClient, _versionId);
            }
            SetState("installing-loader", 60);

            // Download loader libs (60%-75%)
            SetState("downloading-loader-libs", 60, "正在补全加载器库文件...");
            var loaderLibs = await resourceHelper.GetMissLibrariesAsync(_versionId, _gameDir);
            if (loaderLibs.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in loaderLibs)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                double libProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    libProgress = p;
                    Progress = 60 + libProgress / 100.0 * 15;
                }, _cts.Token);
            }
            SetState("downloading-loader-libs", 75);

            // Merged main jar (75%-85%)
            SetState("downloading-mainjar", 75, $"{_versionId}.jar");
            var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
            if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, loaderMainJar.Url, loaderMainJar.Path);
                double mainJarProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    mainJarProgress = p;
                    Progress = 75 + mainJarProgress / 100.0 * 10;
                }, _cts.Token);
            }
            SetState("downloading-mainjar", 85);
        }
    }

    private async Task DownloadAddonsParallel()
    {
        var httpClient = _httpClientFactory.CreateClient();
        var modsDir = Path.Combine(_effectiveGameDir, "mods");
        Directory.CreateDirectory(modsDir);

        var addonTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
        var addonLock = new object();

        // Parallel URL resolution with SemaphoreSlim
        var semaphore = new SemaphoreSlim(12);
        var resolveTasks = _addons!.Select(async addonId =>
        {
            await semaphore.WaitAsync(_cts.Token);
            try
            {
                _cts.Token.ThrowIfCancellationRequested();
                var (url, filename) = await ResolveAddonDownload(httpClient, addonId, _gameVersion);
                if (url != null && filename != null)
                {
                    lock (addonLock)
                    {
                        _downloadManager.AddFileToTask(addonTid, url, Path.Combine(modsDir, filename));
                    }
                }
            }
            finally
            {
                semaphore.Release();
            }
        });

        await Task.WhenAll(resolveTasks);

        var infos = _downloadManager.GetAllTaskInfos();
        if (infos.TryGetValue(addonTid, out var info) && info.TotalFiles > 0)
        {
            double progress = 0;
            await RunDownloadTaskWithCallback(addonTid, p =>
            {
                progress = p;
                Progress = 85 + progress / 100.0 * 15;
            }, _cts.Token);
        }
    }

    private async Task InstallModLoader(HttpClient httpClient, string versionId, string? installerPath = null)
    {
        try
        {
            switch (_loader?.ToLowerInvariant())
            {
                case "fabric":
                    await new FabricInstaller(0, _gameDir)
                        .InstallFabricAsync(versionId, _loaderVersion!, _gameVersion);
                    break;
                case "quilt":
                    await new QuiltInstaller(0, _gameDir)
                        .InstallQuiltAsync(versionId, _loaderVersion!, _gameVersion);
                    break;
                case "liteloader":
                    await new LiteloaderInstaller(0, _gameDir, _gameVersion)
                        .InstallAsync(versionId, "", _loaderVersion!, _gameVersion, null, null);
                    break;
                case "forge":
                {
                    var javaPath = FindJavaExecutable();
                    var baseJsonPath = Path.Combine(_gameDir, "versions", _gameVersion, $"{_gameVersion}.json");
                    var inheritsFromJson = File.Exists(baseJsonPath)
                        ? await File.ReadAllTextAsync(baseJsonPath)
                        : string.Empty;
                    await new ForgeInstaller(0, _gameDir, _gameVersion)
                        .InstallAsync(versionId, inheritsFromJson, javaPath, installerPath!, null, null);
                    break;
                }
                case "neoforge":
                {
                    var javaPath = FindJavaExecutable();
                    var baseJsonPath = Path.Combine(_gameDir, "versions", _gameVersion, $"{_gameVersion}.json");
                    var inheritsFromJson = File.Exists(baseJsonPath)
                        ? await File.ReadAllTextAsync(baseJsonPath)
                        : string.Empty;
                    await new NeoForgeInstaller(0, _gameDir, _gameVersion)
                        .InstallAsync(versionId, inheritsFromJson, javaPath, installerPath!, null, null);
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[InstallTask] 加载器安装失败: {ex.Message}");
            throw; // ponytail: let caller handle it so install shows as failed
        }
    }

    private async Task<string?> ResolveVersionJsonUrl()
    {
        try
        {
            var httpClient = _httpClientFactory.CreateClient();
            var manifestJson = await httpClient.GetStringAsync(
                "https://launchermeta.mojang.com/mc/game/version_manifest.json", _cts.Token);
            var manifest = JsonNode.Parse(manifestJson)?.AsObject();
            var versions = manifest?["versions"]?.AsArray();
            if (versions == null) return null;
            foreach (var v in versions.OfType<JsonObject>())
                if (SafeGetString(v["id"], "manifest.id") == _gameVersion)
                    return SafeGetString(v["url"], "manifest.url");
            return null;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[InstallTask] ResolveVersionJsonUrl failed: {ex.Message}");
            return null;
        }
    }

    private static string? SafeGetString(JsonNode? node, string context)
    {
        if (node is JsonValue jv && jv.TryGetValue<string>(out var val))
            return val;
        Console.WriteLine($"[InstallTask] {context}: expected string, got {node?.GetType().Name ?? "null"} | raw: {node?.ToJsonString() ?? "null"}");
        return null;
    }

    private async Task<string> ResolveLoaderDownloadUrl(string loader, string gameVersion, string loaderVersion)
    {
        var helper = new ModLoaderResourceHelper(downloadSourceId: _downloadSourceId);
        var type = loader.ToLowerInvariant() switch
        {
            "forge" => ModLoaderResourceHelper.ModLoaderType.Forge,
            "neoforge" => ModLoaderResourceHelper.ModLoaderType.NeoForge,
            _ => throw new ArgumentException($"不支持的加载器: {loader}")
        };
        var versions = await helper.GetAvailableModLoaders(gameVersion, type);
        var match = versions.FirstOrDefault(v => v.Version == loaderVersion);
        if (match == null || string.IsNullOrEmpty(match.DownloadUrl))
            throw new Exception($"未找到 {loader} {loaderVersion} 的下载地址");
        return match.DownloadUrl;
    }

    private static async Task<(string? url, string? filename)> ResolveAddonDownload(
        HttpClient httpClient, string addonId, string gameVersion)
    {
        try
        {
            var response = await httpClient.GetAsync(
                ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{addonId}/version"));
            if (!response.IsSuccessStatusCode) return (null, null);

            var versionsJson = await response.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(versionsJson);

            foreach (var version in doc.RootElement.EnumerateArray())
            {
                var gameVersions = version.GetProperty("game_versions")
                    .EnumerateArray().Select(x => x.GetString()).ToList();
                if (!gameVersions.Contains(gameVersion)) continue;

                foreach (var file in version.GetProperty("files").EnumerateArray())
                {
                    var url = file.GetProperty("url").GetString();
                    var filename = file.GetProperty("filename").GetString();
                    if (!string.IsNullOrEmpty(url) && !string.IsNullOrEmpty(filename))
                        return (url, filename);
                }
            }
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[InstallTask] 解析附加内容失败 ({addonId}): {ex.Message}");
        }
        return (null, null);
    }

    private string FindJavaExecutable()
    {
        if (!string.IsNullOrEmpty(_javaPath))
        {
            if (File.Exists(_javaPath))
                return _javaPath;
            throw new Exception($"Java 运行时不存在: {_javaPath}");
        }
        var javas = JavaHelper.SearchJava();
        var valid = javas.FirstOrDefault(j => j.State == JavaHelper.JavaState.Valid);
        if (valid == null)
            throw new Exception("未找到可用的 Java 运行时。请在设置中扫描或安装 Java。");
        return valid.Path;
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    // --- Control ---
    public void Pause()
    {
        IsPaused = true;
        _downloadManager.PauseTask(-1);
        OnStateChanged?.Invoke(this);
    }

    public void Resume()
    {
        IsPaused = false;
        _downloadManager.ContinueTask(-1);
        OnStateChanged?.Invoke(this);
    }

    public void Cancel()
    {
        _cts.Cancel();
        _downloadManager.StopTask(-1);
        SetState("cancelled", Progress);
    }
}
