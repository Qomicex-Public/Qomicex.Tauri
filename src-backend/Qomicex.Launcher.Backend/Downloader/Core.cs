using System;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Downloader
{
    public class Core : IDownloadEngine
    {
        private static readonly HttpClient _httpClient = new()
        {
            Timeout = TimeSpan.FromMinutes(5),
            DefaultRequestHeaders = { { "User-Agent", "QomicexLauncher/1.0" } }
        };
        private readonly int _maxRetries;
        private readonly int _threadCount;
        private readonly TimeSpan _attemptTimeout;
        private long _totalBytes;
        private long _downloadedBytes;
        private double _progressDouble;
        private FileProgress _lastProgress = new();
        private readonly object _lock = new();

        private long _speedWindowBytes;
        private long _speedWindowStartTick;
        private double _currentSpeed;

        private volatile bool _isPaused = false;
        private volatile bool _isCanceled = false;

        public Core(int threadCount = 4, int maxRetries = 3, int attemptTimeoutSeconds = 15)
        {
            _threadCount = threadCount;
            _maxRetries = maxRetries;
            _attemptTimeout = attemptTimeoutSeconds > 0 ? TimeSpan.FromSeconds(attemptTimeoutSeconds) : TimeSpan.FromDays(1);
            _speedWindowStartTick = System.Diagnostics.Stopwatch.GetTimestamp();
        }

        public async Task DownloadFileAsync(string url, string outputPath, IProgress<FileProgress>? progress = null, CancellationToken cancellationToken = default, string? ua = null)
        {
            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            // Try HEAD to get size for multi-segment download
            long contentLength = -1;
            try
            {
                var headReq = new HttpRequestMessage(HttpMethod.Head, url);
                var resp = await _httpClient.SendAsync(headReq, cancellationToken);
                if (resp.IsSuccessStatusCode)
                    contentLength = resp.Content.Headers.ContentLength ?? -1;
            }
            catch { /* HEAD not supported or failed, fall through to single-stream */ }

            if (contentLength > 0 && _threadCount > 1)
            {
                await DownloadMultiSegment(url, outputPath, contentLength, progress, cancellationToken);
            }
            else
            {
                await DownloadSingleStream(url, outputPath, progress, cancellationToken);
            }
        }

        private async Task DownloadSingleStream(string url, string outputPath, IProgress<FileProgress>? progress, CancellationToken cancellationToken)
        {
            int retries = 0;
            while (true)
            {
                try
                {
                    using var attemptCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    attemptCts.CancelAfter(_attemptTimeout);
                    var ct = attemptCts.Token;

                    using var resp = await _httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
                    resp.EnsureSuccessStatusCode();
                    _totalBytes = resp.Content.Headers.ContentLength ?? 0;

                    using var stream = await resp.Content.ReadAsStreamAsync(ct);
                    using var fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None);
                    byte[] buffer = new byte[8192];
                    int read;

                    while ((read = await stream.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
                    {
                        if (_isCanceled) return;
                        while (_isPaused)
                        {
                            await Task.Delay(200, cancellationToken);
                            if (_isCanceled) return;
                        }

                        fs.Write(buffer, 0, read);
                        lock (_lock)
                        {
                            _downloadedBytes += read;
                            _progressDouble = _totalBytes > 0 ? (double)_downloadedBytes / _totalBytes * 100 : 0;
                            UpdateSpeed(read);
                        }
                        progress?.Report(_lastProgress);
                    }

                    lock (_lock)
                    {
                        _progressDouble = 100;
                        _lastProgress = new FileProgress
                        {
                            Progress = 100,
                            DownloadedBytes = _downloadedBytes,
                            TotalBytes = _totalBytes,
                            IsCompleted = true,
                        };
                    }
                    return;
                }
                catch when (retries < _maxRetries && !_isCanceled)
                {
                    retries++;
                    await Task.Delay(1000 * retries, cancellationToken);
                }
            }
        }

        private async Task DownloadMultiSegment(string url, string outputPath, long totalBytes, IProgress<FileProgress>? progress, CancellationToken cancellationToken)
        {
            _totalBytes = totalBytes;

            using var fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None);
            fs.SetLength(_totalBytes);

            long partSize = _totalBytes / _threadCount;
            object fileLock = new();

            var tasks = new Task[_threadCount];
            for (int i = 0; i < _threadCount; i++)
            {
                long start = i * partSize;
                long end = (i == _threadCount - 1) ? _totalBytes - 1 : (start + partSize - 1);

                tasks[i] = Task.Run(async () =>
                {
                    int retries = 0;
                    while (true)
                    {
                        try
                        {
                            using var attemptCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                            attemptCts.CancelAfter(_attemptTimeout);
                            var ct = attemptCts.Token;

                            var req = new HttpRequestMessage(HttpMethod.Get, url);
                            if (!_isCanceled)
                                req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(start, end);

                            using var partResp = await _httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
                            partResp.EnsureSuccessStatusCode();

                            using var stream = await partResp.Content.ReadAsStreamAsync(ct);
                            byte[] buffer = new byte[8192];
                            int read;
                            long position = start;

                            while ((read = await stream.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
                            {
                                if (_isCanceled) return;
                                while (_isPaused)
                                {
                                    await Task.Delay(200, cancellationToken);
                                    if (_isCanceled) return;
                                }

                                lock (fileLock)
                                {
                                    fs.Position = position;
                                    fs.Write(buffer, 0, read);
                                }
                                position += read;

                                lock (_lock)
                                {
                                    _downloadedBytes += read;
                                    _progressDouble = (double)_downloadedBytes / _totalBytes * 100;
                                    UpdateSpeed(read);
                                }
                                progress?.Report(_lastProgress);
                            }
                            break;
                        }
                        catch when (retries < _maxRetries && !_isCanceled)
                        {
                            retries++;
                            await Task.Delay(1000 * retries, cancellationToken);
                        }
                        catch
                        {
                            throw;
                        }
                    }
                }, cancellationToken);
            }

            try { await Task.WhenAll(tasks); }
            catch { throw; }
            finally
            {
                lock (_lock)
                {
                    _lastProgress = new FileProgress
                    {
                        Progress = _isCanceled ? 0 : 100,
                        DownloadedBytes = _downloadedBytes,
                        TotalBytes = _totalBytes,
                        IsCompleted = !_isCanceled && !_isPaused,
                    };
                }
            }
        }

        private void UpdateSpeed(int bytesRead)
        {
            _speedWindowBytes += bytesRead;
            var nowTick = System.Diagnostics.Stopwatch.GetTimestamp();
            var elapsed = (nowTick - _speedWindowStartTick) / (double)System.Diagnostics.Stopwatch.Frequency;
            if (elapsed >= 0.5)
            {
                _currentSpeed = _speedWindowBytes / elapsed;
                _speedWindowBytes = 0;
                _speedWindowStartTick = nowTick;
            }
            _lastProgress = new FileProgress
            {
                Progress = _progressDouble,
                DownloadedBytes = _downloadedBytes,
                TotalBytes = _totalBytes,
                Speed = _currentSpeed,
            };
        }
        public FileProgress GetProgress()
        {
            lock (_lock)
            {
                return new FileProgress
                {
                    Progress = _progressDouble,
                    DownloadedBytes = _downloadedBytes,
                    TotalBytes = _totalBytes,
                    Speed = _currentSpeed,
                    IsCompleted = _lastProgress.IsCompleted,
                };
            }
        }

        public bool IsCompleted
        {
            get { lock (_lock) { return _lastProgress.IsCompleted; } }
        }

        public void Pause() => _isPaused = true;
        public void Resume() => _isPaused = false;
        public void Cancel() => _isCanceled = true;
        public void UpdateProgress() { }

        public class FileProgress
        {
            public double Progress { get; set; }
            public long DownloadedBytes { get; set; }
            public long TotalBytes { get; set; }
            public double Speed { get; set; }
            public bool IsCompleted { get; set; }
        }
    }
}
