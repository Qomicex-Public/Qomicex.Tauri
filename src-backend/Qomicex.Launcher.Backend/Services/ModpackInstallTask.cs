using System.IO.Compression;
using Qomicex.Downloader;

namespace Qomicex.Launcher.Backend.Services;

public class ModpackInstallTask : IInstallTask
{
    private readonly string _instanceId;
    private readonly string _gameDir;
    private readonly string _instName;
    private readonly List<ModpackFileEntry> _files;
    private readonly byte[]? _overridesZip;
    private readonly bool _versionIsolation;
    private readonly CancellationTokenSource _cts = new();

    private readonly DownloadManager _downloadManager = new(intervalMs: 500);

    public string InstanceId => _instanceId;
    public string Stage { get; private set; } = "queued";
    public double Progress { get; private set; }
    public string? Error { get; private set; }
    public int TotalFiles { get; private set; }
    public int CompletedFiles { get; private set; }
    public int FailedFiles { get; private set; }
    public string CurrentFile { get; private set; } = "";
    public double Speed { get; private set; }
    public bool IsPaused { get; private set; }
    public bool IsCompleted { get; private set; }

    public event Action<IInstallTask>? OnStateChanged;

    public ModpackInstallTask(string instanceId, string gameDir, string instName,
        List<ModpackFileEntry> files, byte[]? overridesZip, bool versionIsolation)
    {
        _instanceId = instanceId;
        _gameDir = gameDir;
        _instName = instName;
        _files = files;
        _overridesZip = overridesZip;
        _versionIsolation = versionIsolation;

        _downloadManager.OnTaskProgressUpdated += (taskId, info) =>
        {
            TotalFiles = info.TotalFiles;
            CompletedFiles = info.CompletedFiles;
            FailedFiles = info.FailedFiles;
            Speed = info.Speed;
        };
    }

    public async Task StartAsync()
    {
        try
        {
            var targetDir = _versionIsolation
                ? Path.Combine(_gameDir, "versions", _instName)
                : _gameDir;

            var downloadables = _files.Where(f => !string.IsNullOrEmpty(f.DownloadUrl)).ToList();
            TotalFiles = downloadables.Count + (_overridesZip != null ? 1 : 0);
            SetState("modpack-files", 0);

            if (downloadables.Count == 0 && _overridesZip == null)
            {
                throw new Exception("整合包文件列表为空，所有文件下载地址均不可用（CurseForge API 可能已更改）");
            }

            if (downloadables.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 4, maxRetries: 2);
                foreach (var f in downloadables)
                {
                    var filePath = Path.Combine(targetDir, f.Path);
                    Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
                    _downloadManager.AddFileToTask(tid, f.DownloadUrl!, filePath);
                }

                await RunWithProgress(tid, 0, 90);
            }
            SetState("modpack-files", 90);

            if (_overridesZip != null)
            {
                SetState("modpack-overrides", 90, "正在解压覆盖文件...");
                using var ms = new MemoryStream(_overridesZip);
                using var archive = new ZipArchive(ms);
                foreach (var entry in archive.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    var entryPath = Path.Combine(targetDir, entry.FullName);
                    Directory.CreateDirectory(Path.GetDirectoryName(entryPath)!);
                    entry.ExtractToFile(entryPath, overwrite: true);
                }
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
        }
        finally
        {
            _downloadManager.StopTask(-1);
        }
    }

    private async Task RunWithProgress(int taskId, double stageStart, double stageEnd)
    {
        var downloadTask = _downloadManager.StartTaskAsync(taskId, _cts.Token);
        int lastCompleted = 0;
        while (!downloadTask.IsCompleted && !_cts.Token.IsCancellationRequested)
        {
            var infos = _downloadManager.GetAllTaskInfos();
            if (infos.TryGetValue(taskId, out var info))
            {
                Progress = stageStart + info.Progress / 100.0 * (stageEnd - stageStart);
                CompletedFiles = info.CompletedFiles;
                TotalFiles = info.TotalFiles;
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
            try { await Task.Delay(100, _cts.Token); } catch { break; }
        }
        await downloadTask;
    }

    private void SetState(string stage, double progress, string currentFile = "")
    {
        Stage = stage;
        Progress = progress;
        if (!string.IsNullOrEmpty(currentFile))
            CurrentFile = currentFile;
        OnStateChanged?.Invoke(this);
    }

    public void Pause() { IsPaused = true; _downloadManager.PauseTask(-1); OnStateChanged?.Invoke(this); }
    public void Resume() { IsPaused = false; _downloadManager.ContinueTask(-1); OnStateChanged?.Invoke(this); }
    public void Cancel() { _cts.Cancel(); _downloadManager.StopTask(-1); SetState("cancelled", Progress); }
}
