using System.Collections.Concurrent;

namespace Qomicex.Launcher.Backend.Services;

public class ResourceDownloadState
{
    public string TaskId { get; set; } = "";
    public string Url { get; set; } = "";
    public string TargetPath { get; set; } = "";
    public string FileName { get; set; } = "";
    public double Progress { get; set; }
    public double Speed { get; set; }
    public string Status { get; set; } = "queued"; // queued, downloading, completed, failed, cancelled
    public string? Error { get; set; }
    public long DownloadedBytes { get; set; }
    public long TotalBytes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class ResourceDownloadService
{
    private readonly ConcurrentDictionary<string, ResourceDownloadState> _downloads = new();
    private readonly HttpClient _httpClient;

    public ResourceDownloadService(IHttpClientFactory httpClientFactory)
    {
        _httpClient = httpClientFactory.CreateClient();
        _httpClient.Timeout = TimeSpan.FromMinutes(30);
    }

    public string StartDownload(string url, string targetDir, string fileName)
    {
        var taskId = Guid.NewGuid().ToString("N")[..12];
        var state = new ResourceDownloadState
        {
            TaskId = taskId,
            Url = url,
            TargetPath = targetDir,
            FileName = fileName,
            Status = "queued",
        };
        _downloads[taskId] = state;
        Directory.CreateDirectory(targetDir);
        _ = DownloadAsync(taskId, state);
        return taskId;
    }

    public ResourceDownloadState? GetProgress(string taskId)
    {
        return _downloads.GetValueOrDefault(taskId);
    }

    public bool Cancel(string taskId)
    {
        if (_downloads.TryGetValue(taskId, out var state) && state.Status is "queued" or "downloading")
        {
            state.Status = "cancelled";
            return true;
        }
        return false;
    }

    public void Remove(string taskId)
    {
        _downloads.TryRemove(taskId, out _);
    }

    public List<ResourceDownloadState> GetAll()
    {
        return _downloads.Values.ToList();
    }

    private async Task DownloadAsync(string taskId, ResourceDownloadState state)
    {
        state.Status = "downloading";
        var filePath = Path.Combine(state.TargetPath, state.FileName);

        try
        {
            using var response = await _httpClient.GetAsync(state.Url, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();

            state.TotalBytes = response.Content.Headers.ContentLength ?? -1;
            await using var stream = await response.Content.ReadAsStreamAsync();
            await using var fileStream = System.IO.File.Create(filePath);

            var buffer = new byte[81920];
            long totalRead = 0;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            long lastBytes = 0;
            var lastTime = sw.Elapsed.TotalSeconds;

            int bytesRead;
            while ((bytesRead = await stream.ReadAsync(buffer)) > 0)
            {
                await fileStream.WriteAsync(buffer.AsMemory(0, bytesRead));
                totalRead += bytesRead;
                state.DownloadedBytes = totalRead;

                var now = sw.Elapsed.TotalSeconds;
                if (now - lastTime >= 0.5)
                {
                    var elapsed = now - lastTime;
                    state.Speed = elapsed > 0 ? (totalRead - lastBytes) / elapsed : 0;
                    lastBytes = totalRead;
                    lastTime = now;
                }

                state.Progress = state.TotalBytes > 0 ? (double)totalRead / state.TotalBytes * 100 : 0;
            }

            state.Progress = 100;
            state.Speed = 0;
            state.Status = "completed";
        }
        catch (OperationCanceledException)
        {
            state.Status = "cancelled";
        }
        catch (Exception ex)
        {
            state.Status = "failed";
            state.Error = ex.Message;
        }
    }
}
