using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Downloader
{
    public class Core : IDownloadEngine
    {
        private static readonly HttpClient _httpClient = new HttpClient();
        private readonly int _maxRetries;
        private readonly int _threadCount;
        private readonly bool _autoUpdate;
        private readonly bool _ignoreRangeProbe200Ok;
        private IProgress<DownloadProgress>? _progress;
        private DownloadProgress _latestProgress = new();
        private long _downloadedBytes;
        private long _lastReportedBytes;
        private DateTimeOffset _lastReportTime;
        private readonly object _progressSync = new object();

        private volatile bool _isPaused = false;
        private volatile bool _isCanceled = false;

        public Core(int threadCount = 4, int maxRetries = 3, bool autoUpdate = true, bool ignoreRangeProbe200Ok = false)
        {
            if (threadCount < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(threadCount), "threadCount 不能小于 0。");
            }

            _threadCount = threadCount;
            _maxRetries = maxRetries;
            _autoUpdate = autoUpdate;
            _ignoreRangeProbe200Ok = ignoreRangeProbe200Ok;
        }

        public async Task DownloadFileAsync(string url, string outputPath, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default, string? ua = null)
        {
            _progress = progress;
            _isCanceled = false;
            _isPaused = false;

            if (!Directory.Exists(Path.GetDirectoryName(outputPath)))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
            }

            var headRequest = new HttpRequestMessage(HttpMethod.Head, url);
            ApplyUserAgent(headRequest, ua);
            var response = await _httpClient.SendAsync(headRequest, cancellationToken);
            response.EnsureSuccessStatusCode();
            long totalSize = response.Content.Headers.ContentLength ?? throw new Exception("无法获取文件大小");

            var actualThreadCount = ResolveThreadCount(totalSize);
            _latestProgress = new DownloadProgress
            {
                Progress = 0,
                DownloadedBytes = 0,
                TotalBytes = totalSize,
                Speed = 0,
                IsCompleted = false
            };
            _downloadedBytes = 0;
            _lastReportedBytes = 0;
            _lastReportTime = DateTimeOffset.UtcNow;

            if (actualThreadCount <= 1)
            {
                await DownloadSingleStreamAsync(url, outputPath, totalSize, cancellationToken, ua);
                return;
            }

            if (!await CanUseRangeAsync(url, cancellationToken, ua))
            {
                await DownloadSingleStreamAsync(url, outputPath, totalSize, cancellationToken, ua);
                return;
            }

            await DownloadMultiPartAsync(url, outputPath, totalSize, actualThreadCount, cancellationToken, ua);
        }

        public void Pause() => _isPaused = true;
        public void Resume() => _isPaused = false;
        public void Cancel() => _isCanceled = true;

        public void UpdateProgress()
        {
            _progress?.Report(_latestProgress);
        }

        private static void ApplyUserAgent(HttpRequestMessage request, string? userAgent)
        {
            if (!string.IsNullOrWhiteSpace(userAgent))
            {
                request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
            }
        }

        private async Task<bool> CanUseRangeAsync(string url, CancellationToken cancellationToken, string? ua)
        {
            using var probeRequest = new HttpRequestMessage(HttpMethod.Get, url);
            ApplyUserAgent(probeRequest, ua);
            probeRequest.Headers.Range = new RangeHeaderValue(0, 0);

            using var probeResponse = await _httpClient.SendAsync(probeRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            probeResponse.EnsureSuccessStatusCode();

            if (probeResponse.StatusCode == HttpStatusCode.PartialContent)
            {
                return true;
            }

            if (_ignoreRangeProbe200Ok && probeResponse.StatusCode == HttpStatusCode.OK)
            {
                return true;
            }

            return false;
        }

        private async Task DownloadSingleStreamAsync(string url, string outputPath, long totalSize, CancellationToken cancellationToken, string? ua)
        {
            using var fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None);
            fs.SetLength(totalSize);

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            ApplyUserAgent(request, ua);
            using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            response.EnsureSuccessStatusCode();
            using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);

            await CopyToFileWithProgressAsync(stream, fs, totalSize, 0, cancellationToken);
            MarkDownloadCompleted(totalSize);
        }

        private async Task DownloadMultiPartAsync(string url, string outputPath, long totalSize, int actualThreadCount, CancellationToken cancellationToken, string? ua)
        {
            using var fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None);
            fs.SetLength(totalSize);

            long partSize = totalSize / actualThreadCount;
            var tasks = new Task[actualThreadCount];

            for (int i = 0; i < actualThreadCount; i++)
            {
                long start = i * partSize;
                long end = (i == actualThreadCount - 1) ? totalSize - 1 : (start + partSize - 1);

                tasks[i] = Task.Run(async () =>
                {
                    int retries = 0;
                    while (true)
                    {
                        try
                        {
                            using var req = new HttpRequestMessage(HttpMethod.Get, url);
                            ApplyUserAgent(req, ua);
                            req.Headers.Range = new RangeHeaderValue(start, end);

                            using var partResp = await _httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                            partResp.EnsureSuccessStatusCode();

                            using var stream = await partResp.Content.ReadAsStreamAsync(cancellationToken);
                            await CopyToFileWithProgressAsync(stream, fs, totalSize, start, cancellationToken);
                            break;
                        }
                        catch when (retries < _maxRetries)
                        {
                            retries++;
                            await Task.Delay(1000 * retries, cancellationToken);
                        }
                    }
                }, cancellationToken);
            }

            await Task.WhenAll(tasks);
            MarkDownloadCompleted(totalSize);
        }

        private async Task CopyToFileWithProgressAsync(Stream source, FileStream destination, long totalSize, long startPosition, CancellationToken cancellationToken)
        {
            byte[] buffer = new byte[8192];
            int read;
            long position = startPosition;

            while ((read = await source.ReadAsync(buffer, 0, buffer.Length, cancellationToken)) > 0)
            {
                if (_isCanceled)
                {
                    return;
                }

                while (_isPaused)
                {
                    await Task.Delay(200, cancellationToken);
                }

                DownloadProgress progressSnapshot;
                lock (_progressSync)
                {
                    destination.Position = position;
                    destination.Write(buffer, 0, read);

                    _downloadedBytes += read;

                    var now = DateTimeOffset.UtcNow;
                    var elapsedSeconds = Math.Max((now - _lastReportTime).TotalSeconds, 0.001d);
                    var bytesDelta = _downloadedBytes - _lastReportedBytes;
                    var speed = bytesDelta / elapsedSeconds;

                    _latestProgress = new DownloadProgress
                    {
                        Progress = (double)_downloadedBytes / totalSize * 100d,
                        DownloadedBytes = _downloadedBytes,
                        TotalBytes = totalSize,
                        Speed = speed,
                        IsCompleted = _downloadedBytes >= totalSize
                    };

                    _lastReportedBytes = _downloadedBytes;
                    _lastReportTime = now;
                    progressSnapshot = _latestProgress;
                }

                position += read;

                if (_autoUpdate)
                {
                    _progress?.Report(progressSnapshot);
                }
            }
        }

        private void MarkDownloadCompleted(long totalSize)
        {
            _latestProgress = new DownloadProgress
            {
                Progress = 100d,
                DownloadedBytes = totalSize,
                TotalBytes = totalSize,
                Speed = 0,
                IsCompleted = true
            };

            if (_autoUpdate)
            {
                _progress?.Report(_latestProgress);
            }
        }

        private int ResolveThreadCount(long totalSize)
        {
            if (_threadCount > 0)
            {
                return _threadCount;
            }

            const long chunkSize = 16L * 1024 * 1024;
            var calculated = (int)Math.Ceiling((double)totalSize / chunkSize);
            return Math.Min(Math.Max(calculated, 1), 16);
        }
    }
}
