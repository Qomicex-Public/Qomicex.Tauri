using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Downloader
{
    public class DownloadManager : IDisposable
    {
        private readonly Dictionary<int, DownloadTask> _tasks = new();
        private readonly object _sync = new();
        private int _nextTaskId = 0;
        private readonly Timer _progressTimer;
        private readonly int _intervalMs;

        private readonly Dictionary<int, long> _lastBytes = new();
        private readonly Dictionary<int, DateTimeOffset> _lastTime = new();

        public event Action<int, DownloadTask.TaskInfo>? OnTaskProgressUpdated;
        public event Action<int>? OnTaskCompleted;
        public event Action<GlobalInfo>? OnGlobalProgressUpdated;

        public class GlobalInfo
        {
            public double TotalProgress { get; set; }
            public double TotalSpeed { get; set; }
            public int TotalTasks { get; set; }
            public int RunningTasks { get; set; }
        }

        public DownloadManager(int intervalMs = 500)
        {
            _intervalMs = intervalMs;
            _progressTimer = new Timer(_ => ReportAllProgress(), null, _intervalMs, _intervalMs);
        }

        public int CreateTask(int maxConcurrentFiles = 1, int singleFileThreadCount = 0, int maxRetries = 4, bool ignoreRangeProbe200Ok = false)
        {
            lock (_sync)
            {
                var taskId = _nextTaskId++;
                var task = new DownloadTask(maxConcurrentFiles, singleFileThreadCount, maxRetries, ignoreRangeProbe200Ok);

                task.OnProgressUpdated += (info) =>
                {
                    OnTaskProgressUpdated?.Invoke(taskId, info);
                    if (info.CompletedFiles + info.FailedFiles + info.CanceledFiles == info.TotalFiles)
                    {
                        OnTaskCompleted?.Invoke(taskId);
                    }
                };

                _tasks[taskId] = task;
                _lastBytes[taskId] = 0;
                _lastTime[taskId] = DateTimeOffset.Now;

                return taskId;
            }
        }

        public int AddFileToTask(int taskId, string url, string destinationPath)
        {
            lock (_sync)
            {
                if (_tasks.TryGetValue(taskId, out var task))
                {
                    return task.AddFile(url, destinationPath);
                }
            }

            throw new ArgumentException($"任务 ID {taskId} 不存在");
        }

        public async Task StartTaskAsync(int taskId, CancellationToken token, string? ua = null)
        {
            DownloadTask? task;
            lock (_sync)
            {
                _tasks.TryGetValue(taskId, out task);
            }

            if (task is not null)
            {
                await task.StartDownloadAsync(token, ua);
            }
        }

        public void PauseTask(int taskId)
        {
            lock (_sync)
            {
                if (_tasks.TryGetValue(taskId, out var task))
                {
                    task.PauseDownload(-1);
                }
            }
        }

        public void ContinueTask(int taskId)
        {
            lock (_sync)
            {
                if (_tasks.TryGetValue(taskId, out var task))
                {
                    task.ContinueDownload(-1);
                }
            }
        }

        public void StopTask(int taskId)
        {
            lock (_sync)
            {
                if (_tasks.TryGetValue(taskId, out var task))
                {
                    task.StopDownload(-1);
                }
            }
        }

        public IReadOnlyDictionary<int, DownloadTask.TaskInfo> GetAllTaskInfos()
        {
            KeyValuePair<int, DownloadTask>[] snapshot;
            lock (_sync)
            {
                snapshot = _tasks.ToArray();
            }

            return snapshot.ToDictionary(kvp => kvp.Key, kvp => kvp.Value.GetTaskInfo());
        }

        public IReadOnlyList<(int Id, string Name, double Progress, DownloadTask.FileStatus Status)> GetTaskFileStatuses(int taskId)
        {
            lock (_sync)
            {
                if (_tasks.TryGetValue(taskId, out var task))
                {
                    return task.GetFileStatuses();
                }
            }

            return new List<(int, string, double, DownloadTask.FileStatus)>();
        }

        public DownloadTask.FileMeta? GetFileMeta(int taskId, int fileId)
        {
            lock (_sync)
            {
                if (_tasks.TryGetValue(taskId, out var task))
                {
                    return task.GetFileMeta(fileId);
                }
            }

            return null;
        }

        /// <summary>
        /// 定时汇报所有任务的进度和速度。
        /// </summary>
        private void ReportAllProgress()
        {
            double totalProgress = 0;
            double totalSpeed = 0;
            int runningTasks = 0;

            KeyValuePair<int, DownloadTask>[] snapshot;
            lock (_sync)
            {
                snapshot = _tasks.ToArray();
            }

            foreach (var kvp in snapshot)
            {
                int taskId = kvp.Key;
                var task = kvp.Value;

                task.UpdateProgress();
                var info = task.GetTaskInfo();
                var fileStatuses = task.GetFileStatuses();

                long currentBytes = 0;
                if (info.DownloadingFiles > 0)
                {
                    foreach (var fileStatus in fileStatuses)
                    {
                        var meta = task.GetFileMeta(fileStatus.Id);
                        if (meta is not null)
                        {
                            currentBytes += meta.DownloadedBytes;
                        }
                    }
                }

                var now = DateTimeOffset.Now;
                DateTimeOffset lastTime;
                long lastBytes;
                lock (_sync)
                {
                    if (!_lastTime.TryGetValue(taskId, out lastTime) || !_lastBytes.TryGetValue(taskId, out lastBytes))
                    {
                        continue;
                    }
                }

                var elapsed = (now - lastTime).TotalSeconds;
                if (elapsed > 0.5)
                {
                    double speed = (currentBytes - lastBytes) / elapsed;
                    info.Speed = speed;
                    lock (_sync)
                    {
                        _lastBytes[taskId] = currentBytes;
                        _lastTime[taskId] = now;
                    }
                }

                OnTaskProgressUpdated?.Invoke(taskId, info);

                totalProgress += info.Progress;
                totalSpeed += info.Speed;
                if (task.IsRunning) runningTasks++;
            }

            if (snapshot.Length > 0)
            {
                var globalInfo = new GlobalInfo
                {
                    TotalProgress = totalProgress / snapshot.Length,
                    TotalSpeed = totalSpeed,
                    TotalTasks = snapshot.Length,
                    RunningTasks = runningTasks
                };
                OnGlobalProgressUpdated?.Invoke(globalInfo);
            }
        }

        public void Dispose()
        {
            _progressTimer.Dispose();
        }
    }
}
