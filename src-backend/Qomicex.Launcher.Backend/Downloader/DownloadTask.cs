using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Downloader
{
    public class DownloadTask
    {
        public class FileMeta
        {
            public string Name { get; set; } = string.Empty;
            public string Url { get; set; } = string.Empty;
            public string Path { get; set; } = string.Empty;
            public long Size { get; set; } = 0;
            public double Progress { get; set; } = 0;
            public long DownloadedBytes { get; set; } = 0;
            public int Speed { get; set; } = 0;
            public int Id { get; set; } = 0;
            public int Status { get; set; } = 0;
            public IDownloadEngine? EngineInstance { get; set; }
        }

        public enum FileStatus
        {
            Pending = 0,
            Downloading = 1,
            Completed = 2,
            Failed = 3,
            Canceled = 4,
            Paused = 5
        }

        public class TaskInfo
        {
            public double Progress { get; set; } = 0;
            public double Speed { get; set; } = 0;
            public int TotalFiles { get; set; } = 0;
            public int CompletedFiles { get; set; } = 0;
            public int FailedFiles { get; set; } = 0;
            public int PendingFiles { get; set; } = 0;
            public int DownloadingFiles { get; set; } = 0;
            public int PausedFiles { get; set; } = 0;
            public int CanceledFiles { get; set; } = 0;
        }

        private readonly List<FileMeta> _files = new();
        private readonly int _threadNum;
        private readonly int _maxRetries;
        private readonly int _attemptTimeout;

        public event Action<TaskInfo>? OnProgressUpdated;
        public event Action? OnAllDownloadsCompleted;

        public DownloadTask(int threadNum = 1, int maxRetries = 3, int attemptTimeout = 15)
        {
            _threadNum = threadNum;
            _maxRetries = maxRetries;
            _attemptTimeout = attemptTimeout;
        }

        public int AddFile(string url, string destinationPath)
        {
            var id = _files.Count;
            _files.Add(new FileMeta
            {
                Url = url,
                Path = destinationPath,
                Name = System.IO.Path.GetFileName(destinationPath),
                Id = id,
                Status = (int)FileStatus.Pending
            });
            return id;
        }

        public async Task StartDownloadAsync(CancellationToken token, string? ua = null)
        {
            SemaphoreSlim semaphore = new(_threadNum);
            Task[] tasks = new Task[_files.Count];

            for (int i = 0; i < _files.Count; i++)
            {
                int index = i;
                var file = _files[index];

                tasks[index] = Task.Run(async () =>
                {
                    await semaphore.WaitAsync(token);

                    // ponytail: each file uses 1 segment — threadNum controls file-level concurrency,
                    // not per-file range segments. Avoids socket exhaustion with high thread counts.
                    IDownloadEngine engine = new Core(threadCount: 1, _maxRetries, _attemptTimeout);
                    file.EngineInstance = engine;

                    try
                    {
                        file.Status = (int)FileStatus.Downloading;
                        await engine.DownloadFileAsync(file.Url, file.Path, null, token, ua);
                        file.Status = (int)FileStatus.Completed;
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested)
                    {
                        file.Status = (int)FileStatus.Canceled;
                    }
                    catch (Exception ex)
                    {
                        file.Status = (int)FileStatus.Failed;
                        Debug.WriteLine($"下载失败: {file.Name}, 错误: {ex.Message}");
                    }
                    finally
                    {
                        semaphore.Release();
                        file.EngineInstance = null;
                    }
                }, token);
            }

            await Task.WhenAll(tasks);
            OnAllDownloadsCompleted?.Invoke();
        }

        public void StopDownload(int id)
        {
            foreach (var file in _files.Where(f => id == -1 || f.Id == id))
            {
                file.EngineInstance?.Cancel();
                file.Status = (int)FileStatus.Canceled;
            }
        }

        public void PauseDownload(int id)
        {
            foreach (var file in _files.Where(f => id == -1 || f.Id == id))
            {
                file.EngineInstance?.Pause();
                file.Status = (int)FileStatus.Paused;
            }
        }

        public void ContinueDownload(int id)
        {
            foreach (var file in _files.Where(f => id == -1 || f.Id == id))
            {
                file.EngineInstance?.Resume();
                file.Status = (int)FileStatus.Downloading;
            }
        }

        public void UpdateProgress()
        {
            foreach (var file in _files)
            {
                if (file.EngineInstance is Core core)
                {
                    var p = core.GetProgress();
                    file.Progress = p.Progress;
                    file.DownloadedBytes = p.DownloadedBytes;
                    file.Speed = (int)p.Speed;
                    if (p.TotalBytes > 0) file.Size = p.TotalBytes;
                }
                file.EngineInstance?.UpdateProgress();
            }
            OnProgressUpdated?.Invoke(GetTaskInfo());
        }

        public TaskInfo GetTaskInfo()
        {
            return new TaskInfo
            {
                TotalFiles = _files.Count,
                CompletedFiles = _files.Count(f => f.Status == (int)FileStatus.Completed),
                FailedFiles = _files.Count(f => f.Status == (int)FileStatus.Failed),
                PendingFiles = _files.Count(f => f.Status == (int)FileStatus.Pending),
                DownloadingFiles = _files.Count(f => f.Status == (int)FileStatus.Downloading),
                PausedFiles = _files.Count(f => f.Status == (int)FileStatus.Paused),
                CanceledFiles = _files.Count(f => f.Status == (int)FileStatus.Canceled),
                Progress = GetWeightedProgress(),
                Speed = _files.Sum(f => f.Speed)
            };
        }

        private double GetWeightedProgress()
        {
            if (_files.Count == 0) return 0;
            var totalBytes = _files.Sum(f => f.Size);
            if (totalBytes <= 0) return Math.Round(_files.Average(f => f.Progress), 2);
            var totalDownloaded = _files.Sum(f => f.Size * f.Progress / 100.0);
            return Math.Round(totalDownloaded / totalBytes * 100, 2);
        }

        public IReadOnlyList<(int Id, string Name, double Progress, FileStatus Status)> GetFileStatuses()
        {
            return _files.Select(f => (f.Id, f.Name, f.Progress, (FileStatus)f.Status)).ToList();
        }

        public FileMeta? GetFileMeta(int id) => _files.FirstOrDefault(f => f.Id == id);

        public bool IsRunning => _files.Any(f => f.Status == (int)FileStatus.Downloading);
    }
}
