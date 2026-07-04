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

    public async Task StartAsync()
    {
        try
        {
            if (_loader is "forge" or "neoforge")
            {
                FindJavaExecutable();
            }

            // ===== Fetch version JSON into memory (0-3%) =====
            SetState("downloading-json", 0, $"{_gameVersion}.json");
            var versionJsonUrl = await ResolveVersionJsonUrl();
            if (string.IsNullOrEmpty(versionJsonUrl))
                throw new Exception($"无法解析版本 {_gameVersion} 的 JSON 下载地址");

            var httpClient = _httpClientFactory.CreateClient();
            using var jsonReq = new HttpRequestMessage(HttpMethod.Get, versionJsonUrl);
            jsonReq.Headers.TryAddWithoutValidation("User-Agent", CoreConfig.UserAgent);
            var jsonResp = await httpClient.SendAsync(jsonReq, _cts.Token);
            jsonResp.EnsureSuccessStatusCode();
            var jsonContent = await jsonResp.Content.ReadAsStringAsync();
            SetState("downloading-json", 3);
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Loader JAR download (start early for Forge/NeoForge) =====
            string installerPath = string.Empty;
            Task? loaderJarTask = null;
            int jarTaskId = -1;

            if (!string.IsNullOrEmpty(_loader) && !string.IsNullOrEmpty(_loaderVersion))
            {
                var loaderLower = _loader.ToLowerInvariant();
                if (loaderLower is "forge" or "neoforge")
                {
                    var loaderDownloadUrl = await ResolveLoaderDownloadUrl(_loader, _gameVersion, _loaderVersion);
                    var tempDir = Path.Combine(_gameDir, "temp");
                    Directory.CreateDirectory(tempDir);
                    installerPath = Path.Combine(tempDir, $"{_loader}-{_gameVersion}-{_loaderVersion}-installer.jar");

                    if (!File.Exists(installerPath) || new FileInfo(installerPath).Length == 0)
                    {
                        jarTaskId = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                        _downloadManager.AddFileToTask(jarTaskId, loaderDownloadUrl, installerPath);
                        loaderJarTask = _downloadManager.StartTaskAsync(jarTaskId, _cts.Token);
                    }
                }
            }

            // ===== Scan + Download base files (3%-65%) =====
            SetState("downloading", 3, "正在扫描缺失文件...");
            var resourceHelper = new LocalResourceHelper();
            List<LocalResourceHelper.MissFileData> allMissFiles;

            if (!string.IsNullOrEmpty(_loader))
            {
                allMissFiles = await resourceHelper.GetAllMissFilesFromJsonAsync(jsonContent, _gameVersion, _gameDir);
            }
            else
            {
                var vanillaVersionDir = Path.Combine(_gameDir, "versions", _gameVersion);
                Directory.CreateDirectory(vanillaVersionDir);
                var versionJsonPath = Path.Combine(vanillaVersionDir, $"{_gameVersion}.json");
                await File.WriteAllTextAsync(versionJsonPath, jsonContent, _cts.Token);
                allMissFiles = await resourceHelper.GetAllMissFilesAsync(_gameVersion, _gameDir);
            }

            if (allMissFiles.Count > 0)
            {
                var missTid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in allMissFiles)
                    _downloadManager.AddFileToTask(missTid, f.Url, f.Path);
                await RunDownloadTaskWithCallback(missTid, p => { Progress = 3 + p / 100.0 * 62; }, _cts.Token);
            }
            SetState("downloading", 65);
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Loader libs -> Install (65%-95%) =====
            if (!string.IsNullOrEmpty(_loader) && !string.IsNullOrEmpty(_loaderVersion))
            {
                if (loaderJarTask != null)
                {
                    await loaderJarTask;
                    if (jarTaskId >= 0)
                    {
                        var infos = _downloadManager.GetAllTaskInfos();
                        if (infos.TryGetValue(jarTaskId, out var jarInfo) && jarInfo.FailedFiles > 0)
                        {
                            var statuses = _downloadManager.GetTaskFileStatuses(jarTaskId);
                            var failed = statuses.FirstOrDefault(s => s.Status == DownloadTask.FileStatus.Failed);
                            throw new Exception($"下载失败: {failed.Name} (共 {jarInfo.FailedFiles} 个文件失败)");
                        }
                    }
                }

                // Download loader libs
                SetState("downloading-loader-libs", 65, "正在补全加载器库文件...");
                var loaderLibs = await GetLoaderLibraries(installerPath);
                if (loaderLibs.Count > 0)
                {
                    var libTid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                    foreach (var f in loaderLibs)
                        _downloadManager.AddFileToTask(libTid, f.Url, f.Path);
                    await RunDownloadTaskWithCallback(libTid, p => { Progress = 65 + p / 100.0 * 15; }, _cts.Token);
                }
                SetState("downloading-loader-libs", 80);
                _cts.Token.ThrowIfCancellationRequested();

                // Install loader
                SetState("installing-loader", 80, $"{_loader} {_loaderVersion}");
                await InstallModLoader(httpClient, _versionId, jsonContent, installerPath);

                if (_loader.ToLowerInvariant() is "forge" or "neoforge")
                    TryDelete(installerPath);

                _cts.Token.ThrowIfCancellationRequested();

                // Check merged main JAR
                SetState("downloading-mainjar", 85, $"{_versionId}.jar");
                var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
                if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
                {
                    var jarTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                    _downloadManager.AddFileToTask(jarTid, loaderMainJar.Url, loaderMainJar.Path);
                    await RunDownloadTaskWithCallback(jarTid, p => { Progress = 85 + p / 100.0 * 10; }, _cts.Token);
                }
                SetState("downloading-mainjar", 95);
            }
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Mod download (95%-100%) =====
            if (_addons != null && _addons.Length > 0)
            {
                SetState("downloading-addons", 95, "附加内容...");
                await DownloadAddonsParallel(95, 100);
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

    private async Task<List<LocalResourceHelper.MissFileData>> GetLoaderLibraries(string installerPath)
    {
        var loaderLower = _loader!.ToLowerInvariant();
        return loaderLower switch
        {
            "forge" => new ForgeInstaller(0, _gameDir, _gameVersion).GetMissForgeLibraries(installerPath, _versionId),
            "neoforge" => new NeoForgeInstaller(0, _gameDir, _gameVersion).GetMissNeoForgeLibraries(installerPath, _versionId),
            "fabric" => await new FabricInstaller(0, _gameDir).GetMissFabricLibraries(_loaderVersion!, _gameVersion, _gameDir),
            "quilt" => await new QuiltInstaller(0, _gameDir).GetMissQuiltLibraries(_loaderVersion!, _gameVersion, _gameDir),
            _ => new List<LocalResourceHelper.MissFileData>()
        };
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
            try { await Task.Delay(100, ct); } catch (OperationCanceledException) { break; }
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

    private async Task DownloadAddonsParallel(double stageStart, double stageEnd)
    {
        var httpClient = _httpClientFactory.CreateClient();
        var modsDir = Path.Combine(_effectiveGameDir, "mods");
        Directory.CreateDirectory(modsDir);

        var addonTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
        var addonLock = new object();

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
            var range = stageEnd - stageStart;
            await RunDownloadTaskWithCallback(addonTid, p =>
            {
                progress = p;
                Progress = stageStart + progress / 100.0 * range;
            }, _cts.Token);
        }
    }

    private async Task InstallModLoader(HttpClient httpClient, string versionId, string inheritsFromJson, string? installerPath = null)
    {
        try
        {
            switch (_loader?.ToLowerInvariant())
            {
                case "fabric":
                    await new FabricInstaller(0, _gameDir)
                        .InstallFabricAsync(versionId, _loaderVersion!, _gameVersion, inheritsFromJson);
                    break;
                case "quilt":
                    await new QuiltInstaller(0, _gameDir)
                        .InstallQuiltAsync(versionId, _loaderVersion!, _gameVersion, inheritsFromJson);
                    break;
                case "liteloader":
                    await new LiteloaderInstaller(0, _gameDir, _gameVersion)
                        .InstallAsync(versionId, inheritsFromJson, _loaderVersion!, _gameVersion, null, null);
                    break;
                case "forge":
                {
                    var javaPath = FindJavaExecutable();
                    await new ForgeInstaller(0, _gameDir, _gameVersion)
                        .InstallAsync(versionId, inheritsFromJson, javaPath, installerPath!, null, null);
                    break;
                }
                case "neoforge":
                {
                    var javaPath = FindJavaExecutable();
                    await new NeoForgeInstaller(0, _gameDir, _gameVersion)
                        .InstallAsync(versionId, inheritsFromJson, javaPath, installerPath!, null, null);
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[InstallTask] 加载器安装失败: {ex.Message}");
            throw;
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
