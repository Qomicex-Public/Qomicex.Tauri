using System.Diagnostics;
using Qomicex.Downloader;
using Qomicex.Core.Modules.Helpers.Resources;

namespace Qomicex.Launcher.Backend.Services;

public class RepairResourcesTask
{
    private readonly string _gameDir;
    private readonly List<LocalResourceHelper.MissFileData> _missingFiles;
    private readonly CancellationTokenSource _cts = new();
    private readonly DownloadManager _downloadManager = new(intervalMs: 500);

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

    public event Action<RepairResourcesTask>? OnStateChanged;

    public RepairResourcesTask(string instanceId, string gameDir, List<LocalResourceHelper.MissFileData> missingFiles)
    {
        InstanceId = instanceId;
        _gameDir = gameDir;
        _missingFiles = missingFiles;

        _downloadManager.OnTaskProgressUpdated += (taskId, info) =>
        {
            TotalFiles = info.TotalFiles;
            CompletedFiles = info.CompletedFiles;
            FailedFiles = info.FailedFiles;
            Speed = info.Speed;
        };
    }

    private void SetState(string stage, double progress, string currentFile = "")
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
            SetState("repairing-resources", 0, "正在补全缺失资源...");

            var tid = _downloadManager.CreateTask(maxConcurrentFiles: 4, maxRetries: 3, ignoreRangeProbe200Ok: true);
            foreach (var file in _missingFiles)
            {
                if (!string.IsNullOrEmpty(file.Url) && !string.IsNullOrEmpty(file.Path))
                    _downloadManager.AddFileToTask(tid, file.Url, file.Path);
            }

            var downloadTask = _downloadManager.StartTaskAsync(tid, _cts.Token);

            int lastCompleted = 0;
            while (!downloadTask.IsCompleted && !_cts.Token.IsCancellationRequested)
            {
                var infos = _downloadManager.GetAllTaskInfos();
                if (infos.TryGetValue(tid, out var info))
                {
                    Progress = info.Progress;
                    TotalFiles = info.TotalFiles;
                    CompletedFiles = info.CompletedFiles;
                    FailedFiles = info.FailedFiles;
                    Speed = info.Speed;

                    if (info.CompletedFiles > lastCompleted)
                    {
                        var statuses = _downloadManager.GetTaskFileStatuses(tid);
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
            if (finalInfos.TryGetValue(tid, out var finalInfo) && finalInfo.FailedFiles > 0)
            {
                var statuses = _downloadManager.GetTaskFileStatuses(tid);
                var failed = statuses.FirstOrDefault(s => s.Status == DownloadTask.FileStatus.Failed);
                throw new Exception($"补全失败: {failed.Name} (共 {finalInfo.FailedFiles} 个文件失败)");
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
            Debug.WriteLine($"[RepairResourcesTask] 补全失败: {ex}");
        }
        finally
        {
            _downloadManager.StopTask(-1);
        }
    }

    public void Cancel()
    {
        _cts.Cancel();
        _downloadManager.StopTask(-1);
        SetState("cancelled", Progress);
    }
}
