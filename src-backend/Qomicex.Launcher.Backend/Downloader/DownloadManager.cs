using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Downloader
{
    public class DownloadManager : IDisposable
    {
        private readonly Dictionary<int, DownloadTask> _tasks = new();
        private int _nextTaskId = 0;
        private readonly Timer _progressTimer;
        private readonly int _intervalMs;

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

        public int CreateTask(int threadNum = 1, int maxRetries = 4, int attemptTimeout = 15)
        {
            var taskId = _nextTaskId++;
            var task = new DownloadTask(threadNum, maxRetries, attemptTimeout);

            task.OnProgressUpdated += (info) =>
            {
                OnTaskProgressUpdated?.Invoke(taskId, info);
                if (info.CompletedFiles + info.FailedFiles + info.CanceledFiles == info.TotalFiles)
                {
                    OnTaskCompleted?.Invoke(taskId);
                }
            };

            _tasks[taskId] = task;

            return taskId;
        }

        public int AddFileToTask(int taskId, string url, string destinationPath)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                return task.AddFile(url, destinationPath);
            }
            throw new ArgumentException($"任务 ID {taskId} 不存在");
        }

        public async Task StartTaskAsync(int taskId, CancellationToken token, string? ua = null)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                await task.StartDownloadAsync(token, ua);
            }
        }

        public void PauseTask(int taskId)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                task.PauseDownload(-1);
            }
        }

        public void ContinueTask(int taskId)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                task.ContinueDownload(-1);
            }
        }

        public void StopTask(int taskId)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                task.StopDownload(-1);
            }
        }

        public IReadOnlyDictionary<int, DownloadTask.TaskInfo> GetAllTaskInfos()
        {
            return _tasks.ToDictionary(kvp => kvp.Key, kvp =>
            {
                kvp.Value.UpdateProgress();
                return kvp.Value.GetTaskInfo();
            });
        }

        public IReadOnlyList<(int Id, string Name, double Progress, DownloadTask.FileStatus Status)> GetTaskFileStatuses(int taskId)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                return task.GetFileStatuses();
            }
            return new List<(int, string, double, DownloadTask.FileStatus)>();
        }

        public DownloadTask.FileMeta? GetFileMeta(int taskId, int fileId)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                return task.GetFileMeta(fileId);
            }
            return null;
        }

        private void ReportAllProgress()
        {
            double totalProgress = 0;
            double totalSpeed = 0;
            int runningTasks = 0;

            foreach (var kvp in _tasks)
            {
                int taskId = kvp.Key;
                var task = kvp.Value;

                task.UpdateProgress();
                var info = task.GetTaskInfo();

                OnTaskProgressUpdated?.Invoke(taskId, info);

                totalProgress += info.Progress;
                totalSpeed += info.Speed;
                if (task.IsRunning) runningTasks++;
            }

            if (_tasks.Count > 0)
            {
                var globalInfo = new GlobalInfo
                {
                    TotalProgress = totalProgress / _tasks.Count,
                    TotalSpeed = totalSpeed,
                    TotalTasks = _tasks.Count,
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
