using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Downloader
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
            public double Speed { get; set; } = 0;
            public int Id { get; set; } = 0;
            public FileStatus Status { get; set; } = FileStatus.Pending;
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
        private readonly int _maxConcurrentFiles;
        private readonly int _singleFileThreadCount;
        private readonly int _maxRetries;
        private readonly bool _ignoreRangeProbe200Ok;

        public event Action<TaskInfo>? OnProgressUpdated;
        public event Action? OnAllDownloadsCompleted;

        public DownloadTask(int maxConcurrentFiles = 1, int singleFileThreadCount = 0, int maxRetries = 3, bool ignoreRangeProbe200Ok = false)
        {
            if (maxConcurrentFiles <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(maxConcurrentFiles), "maxConcurrentFiles 必须大于 0。");
            }

            if (singleFileThreadCount < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(singleFileThreadCount), "singleFileThreadCount 不能小于 0。");
            }

            _maxConcurrentFiles = maxConcurrentFiles;
            _singleFileThreadCount = singleFileThreadCount;
            _maxRetries = maxRetries;
            _ignoreRangeProbe200Ok = ignoreRangeProbe200Ok;
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
                Status = FileStatus.Pending
            });
            return id;
        }

        public async Task StartDownloadAsync(CancellationToken token, string? ua = null)
        {
            SemaphoreSlim semaphore = new(_maxConcurrentFiles);
            Task[] tasks = new Task[_files.Count];

            for (int i = 0; i < _files.Count; i++)
            {
                int index = i;
                var file = _files[index];

                tasks[index] = Task.Run(async () =>
                {
                    await semaphore.WaitAsync(token);

                    IDownloadEngine engine = new Core(
                        _singleFileThreadCount,
                        _maxRetries,
                        autoUpdate: false,
                        ignoreRangeProbe200Ok: _ignoreRangeProbe200Ok);
                    file.EngineInstance = engine;
                    var progress = new Progress<DownloadProgress>(p =>
                    {
                        file.Progress = p.Progress;
                        file.DownloadedBytes = p.DownloadedBytes;
                        file.Size = p.TotalBytes;
                        file.Speed = p.Speed;

                        if (p.IsCompleted)
                        {
                            file.Status = FileStatus.Completed;
                        }
                    });

                    try
                    {
                        file.Status = FileStatus.Downloading;
                        await engine.DownloadFileAsync(file.Url, file.Path, progress, token, ua);

                        if (file.Status != FileStatus.Canceled)
                        {
                            file.Status = FileStatus.Completed;
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        file.Status = FileStatus.Canceled;
                    }
                    catch (Exception ex)
                    {
                        file.Status = FileStatus.Failed;
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
                if (file.EngineInstance is null)
                {
                    if (file.Status is FileStatus.Pending or FileStatus.Paused)
                    {
                        file.Status = FileStatus.Canceled;
                    }

                    continue;
                }

                file.EngineInstance.Cancel();
                file.Status = FileStatus.Canceled;
            }
        }

        public void PauseDownload(int id)
        {
            foreach (var file in _files.Where(f => id == -1 || (f.Id == id && f.EngineInstance is not null)))
            {
                file.EngineInstance!.Pause();
                file.Status = FileStatus.Paused;
            }
        }

        public void ContinueDownload(int id)
        {
            foreach (var file in _files.Where(f => id == -1 || (f.Id == id && f.EngineInstance is not null)))
            {
                file.EngineInstance!.Resume();
                file.Status = FileStatus.Downloading;
            }
        }

        /// <summary>
        /// 手动更新进度，避免频繁触发卡顿
        /// </summary>
        public void UpdateProgress()
        {
            foreach (var file in _files)
            {
                file.EngineInstance?.UpdateProgress();
            }
            OnProgressUpdated?.Invoke(GetTaskInfo());
        }

        public TaskInfo GetTaskInfo()
        {
            return new TaskInfo
            {
                TotalFiles = _files.Count,
                CompletedFiles = _files.Count(f => f.Status == FileStatus.Completed),
                FailedFiles = _files.Count(f => f.Status == FileStatus.Failed),
                PendingFiles = _files.Count(f => f.Status == FileStatus.Pending),
                DownloadingFiles = _files.Count(f => f.Status == FileStatus.Downloading),
                PausedFiles = _files.Count(f => f.Status == FileStatus.Paused),
                CanceledFiles = _files.Count(f => f.Status == FileStatus.Canceled),
                Progress = _files.Count > 0 ? Math.Round(_files.Average(f => f.Progress), 2) : 0,
                Speed = _files.Sum(f => f.Speed)
            };
        }

        public IReadOnlyList<(int Id, string Name, double Progress, FileStatus Status)> GetFileStatuses()
        {
            return _files.Select(f => (f.Id, f.Name, f.Progress, (FileStatus)f.Status)).ToList();
        }

        public FileMeta? GetFileMeta(int id) => _files.FirstOrDefault(f => f.Id == id);

        public bool IsRunning => _files.Any(f => f.Status == FileStatus.Downloading);
    }
}
