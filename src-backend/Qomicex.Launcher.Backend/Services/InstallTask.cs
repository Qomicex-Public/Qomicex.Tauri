using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
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

    private readonly CancellationTokenSource _cts = new();
    private readonly DownloadManager _downloadManager = new(intervalMs: 500);

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
        IHttpClientFactory httpClientFactory, int downloadSourceId = 0, int downloadTimeout = 15)
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

    public async Task StartAsync()
    {
        try
        {
            var httpClient = _httpClientFactory.CreateClient();

            // Stage 1: Core - download version JSON (0-5%)
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
            SetState("downloading-json", 5);
            _cts.Token.ThrowIfCancellationRequested();

            var resourceHelper = new LocalResourceHelper();

            // Stage 2: DownloadManager - libraries (5-25%)
            SetState("downloading-libraries", 5, "正在扫描支持库...");
            var missLibs = await resourceHelper.GetMissLibrariesAsync(_gameVersion, _gameDir);
            if (missLibs.Count > 0)
                await RunDownloadStage(_downloadThreads, missLibs, 5, 25);
            else
                SetState("downloading-libraries", 25);
            _cts.Token.ThrowIfCancellationRequested();

            // Stage 3: DownloadManager - assets (25-45%)
            SetState("downloading-assets", 25, "正在扫描资源文件...");
            var missAssets = await resourceHelper.GetMissAssetsAsync(_gameVersion, _gameDir);
            if (missAssets.Count > 0)
                await RunDownloadStage(_downloadThreads, missAssets, 25, 45);
            else
                SetState("downloading-assets", 45);
            _cts.Token.ThrowIfCancellationRequested();

            // Stage 4: Core - download main jar (45-50%)
            SetState("downloading-mainjar", 45, "正在检查主文件...");
            var missMainJar = await resourceHelper.GetMissMainJarAsync(_gameVersion, _gameDir);
            if (missMainJar != null && !string.IsNullOrEmpty(missMainJar.Path))
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, missMainJar.Url, missMainJar.Path);
                await RunDownloadManagerStage(tid, 45, 50);
            }
            else
            {
                SetState("downloading-mainjar", 50);
            }
            _cts.Token.ThrowIfCancellationRequested();

            // Stage 5-7: Mod loader
            if (!string.IsNullOrEmpty(_loader) && !string.IsNullOrEmpty(_loaderVersion))
            {
                string loaderLower = _loader.ToLowerInvariant();
                bool isForgeLike = loaderLower is "forge" or "neoforge";

                if (isForgeLike)
                {
                    // Stage 5: Core - download installer JAR (50-55%)
                    SetState("downloading-loader", 50, $"正在下载 {_loader} 安装程序...");
                    var downloadUrl = await ResolveLoaderDownloadUrl(_loader, _gameVersion, _loaderVersion);
                    var tempDir = Path.Combine(_gameDir, "temp");
                    Directory.CreateDirectory(tempDir);
                    var installerPath = Path.Combine(tempDir, $"{_loader}-{_gameVersion}-{_loaderVersion}-installer.jar");

                    if (!File.Exists(installerPath) || new FileInfo(installerPath).Length == 0)
                    {
                        var jarTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                        _downloadManager.AddFileToTask(jarTid, downloadUrl, installerPath);
                        await RunDownloadManagerStage(jarTid, 50, 55);
                    }
                    else
                    {
                        SetState("downloading-loader", 55);
                    }
                    _cts.Token.ThrowIfCancellationRequested();

                    // Stage 6: Install loader (forge handles its own lib download + processors) (55-75%)
                    SetState("installing-loader", 55, $"{_loader} {_loaderVersion}");
                    await InstallModLoader(httpClient, _versionId, installerPath);

                    // Stage 7: DownloadManager - remaining loader libs (75-85%)
                    SetState("downloading-loader-libs", 75, "正在补全加载器库文件...");
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
                        await RunDownloadStage(_downloadThreads, remainingLibs, 75, 85);
                    else
                        SetState("downloading-loader-libs", 85);

                    // Stage 7b: Core - ensure main jar for merged version (85-95%)
                    _cts.Token.ThrowIfCancellationRequested();
                    SetState("downloading-mainjar", 85, $"{_versionId}.jar");
                    var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
                    if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
                    {
                        var jarTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                        _downloadManager.AddFileToTask(jarTid, loaderMainJar.Url, loaderMainJar.Path);
                        await RunDownloadManagerStage(jarTid, 85, 95);
                    }
                    else
                    {
                        SetState("downloading-mainjar", 95);
                    }

                    TryDelete(installerPath);
                }
                else
                {
                    // Fabric/Quilt: install writes merged JSON, then we scan+download remaining libs
                    SetState("installing-loader", 50, $"{_loader} {_loaderVersion}");

                    var loaderJsonPath = Path.Combine(_gameDir, "versions", _versionId, $"{_versionId}.json");
                    if (!File.Exists(loaderJsonPath))
                    {
                        // First install — run the installer to produce the merged JSON
                        await InstallModLoader(httpClient, _versionId);
                    }

                    // Scan the merged versionId JSON for missing libs (covers both install and repair)
                    SetState("downloading-loader-libs", 60, "正在补全加载器库文件...");
                    var loaderLibs = await resourceHelper.GetMissLibrariesAsync(_versionId, _gameDir);
                    if (loaderLibs.Count > 0)
                        await RunDownloadStage(_downloadThreads, loaderLibs, 60, 75);
                    else
                        SetState("downloading-loader-libs", 75);

                    // Also ensure main jar exists for this versionId
                    _cts.Token.ThrowIfCancellationRequested();
                    SetState("downloading-mainjar", 75, $"{_versionId}.jar");
                    var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
                    if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
                    {
                        var jarTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                        _downloadManager.AddFileToTask(jarTid, loaderMainJar.Url, loaderMainJar.Path);
                        await RunDownloadManagerStage(jarTid, 75, 85);
                    }
                    else
                    {
                        SetState("downloading-mainjar", 85);
                    }
                }
            }
            else
            {
                SetState(null!, 85);
            }
            _cts.Token.ThrowIfCancellationRequested();

            // Stage 8: DownloadManager - addons (85-100%)
            if (_addons != null && _addons.Length > 0)
            {
                SetState("downloading-addons", 85, "附加内容...");
                var modsDir = Path.Combine(_effectiveGameDir, "mods");
                Directory.CreateDirectory(modsDir);

                var addonTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var addonId in _addons)
                {
                    _cts.Token.ThrowIfCancellationRequested();
                    var (url, filename) = await ResolveAddonDownload(httpClient, addonId, _gameVersion);
                    if (url != null && filename != null)
                        _downloadManager.AddFileToTask(addonTid, url, Path.Combine(modsDir, filename));
                }
                if (_downloadManager.GetAllTaskInfos().TryGetValue(addonTid, out var addonInfo) && addonInfo.TotalFiles > 0)
                    await RunDownloadManagerStage(addonTid, 85, 100);
                else
                    SetState("downloading-addons", 100);
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
            Debug.WriteLine($"[InstallTask] 安装失败: {ex}");
        }
        finally
        {
            _downloadManager.StopTask(-1);
        }
    }

    private async Task RunDownloadStage(int threadNum,
        List<LocalResourceHelper.MissFileData> files, double stageStart, double stageEnd)
    {
        var tid = _downloadManager.CreateTask(maxConcurrentFiles: threadNum, maxRetries: 3, ignoreRangeProbe200Ok: true);
        foreach (var f in files)
            _downloadManager.AddFileToTask(tid, f.Url, f.Path);
        await RunDownloadManagerStage(tid, stageStart, stageEnd);
    }

    private async Task RunDownloadManagerStage(int taskId, double stageStart, double stageEnd)
    {
        var downloadTask = _downloadManager.StartTaskAsync(taskId, _cts.Token);

        int lastCompleted = 0;
        while (!downloadTask.IsCompleted && !_cts.Token.IsCancellationRequested)
        {
            var infos = _downloadManager.GetAllTaskInfos();
            if (infos.TryGetValue(taskId, out var info))
            {
                Progress = stageStart + (info.Progress / 100.0) * (stageEnd - stageStart);
                TotalFiles = info.TotalFiles;
                CompletedFiles = info.CompletedFiles;
                FailedFiles = info.FailedFiles;
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
            try { await Task.Delay(100, _cts.Token); } catch (OperationCanceledException) { break; }
        }

        await downloadTask;

        var finalInfos = _downloadManager.GetAllTaskInfos();
        if (finalInfos.TryGetValue(taskId, out var finalInfo) && finalInfo.FailedFiles > 0)
        {
            var statuses = _downloadManager.GetTaskFileStatuses(taskId);
            var failed = statuses.FirstOrDefault(s => s.Status == DownloadTask.FileStatus.Failed);
            throw new Exception($"下载失败: {failed.Name} (共 {finalInfo.FailedFiles} 个文件失败)");
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
            Debug.WriteLine($"[InstallTask] 加载器安装失败: {ex.Message}");
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
                $"https://api.modrinth.com/v2/project/{addonId}/version");
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
            Debug.WriteLine($"[InstallTask] 解析附加内容失败 ({addonId}): {ex.Message}");
        }
        return (null, null);
    }

    private static string FindJavaExecutable()
    {
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
