using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using Qomicex.Downloader;
using DownloadCore = Qomicex.Downloader.Core;

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
    public CancellationTokenSource? Cts { get; set; }
    public DownloadCore? Engine { get; set; }
}

public class ResourceDownloadService
{
    private readonly ConcurrentDictionary<string, ResourceDownloadState> _downloads = new();
    private readonly ConcurrentDictionary<string, DownloadCore> _engines = new();
    private readonly HttpClient _httpClient;
    private readonly string? _cfApiKey;

    public ResourceDownloadService(IHttpClientFactory httpClientFactory, IConfiguration configuration)
    {
        _httpClient = httpClientFactory.CreateClient();
        _httpClient.Timeout = TimeSpan.FromMinutes(30);
        _cfApiKey = configuration["CurseForge:ApiKey"];
    }

    private IReadOnlyDictionary<string, string>? ResolveHeaders(string url)
    {
        if (!string.IsNullOrEmpty(_cfApiKey) && url.Contains("forgecdn.net", StringComparison.OrdinalIgnoreCase))
            return new Dictionary<string, string> { ["x-api-key"] = _cfApiKey };
        return null;
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
            state.Cts?.Cancel();
            state.Status = "cancelled";
            return true;
        }
        return false;
    }

    public bool Pause(string taskId)
    {
        if (_engines.TryGetValue(taskId, out var engine))
        {
            if (_downloads.TryGetValue(taskId, out var state))
                state.Status = "paused";
            engine.Pause();
            return true;
        }
        return false;
    }

    public bool Resume(string taskId)
    {
        if (_engines.TryGetValue(taskId, out var engine))
        {
            if (_downloads.TryGetValue(taskId, out var state))
                state.Status = "downloading";
            engine.Resume();
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

    public List<ResourceDownloadState> GetAllActiveStates()
    {
        return _downloads.Values
            .Where(s => s.Status is "queued" or "downloading" or "paused")
            .ToList();
    }

    public string DownloadTo(string url, string targetPath)
    {
        var taskId = Guid.NewGuid().ToString("N")[..12];
        var state = new ResourceDownloadState
        {
            TaskId = taskId,
            Url = url,
            TargetPath = targetPath,
            FileName = Path.GetFileName(targetPath),
            Status = "downloading",
        };
        _downloads[taskId] = state;
        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
        _ = DownloadToAsync(taskId, state);
        return taskId;
    }

    private async Task DownloadToAsync(string taskId, ResourceDownloadState state)
    {
        state.Cts = new CancellationTokenSource();
        try
        {
            var core = new DownloadCore(threadCount: 0, maxRetries: 3, autoUpdate: true);
            state.Engine = core;
            _engines[taskId] = core;

            var progress = new Progress<DownloadProgress>(p =>
            {
                state.DownloadedBytes = p.DownloadedBytes;
                state.TotalBytes = p.TotalBytes;
                state.Speed = p.Speed;
                state.Progress = p.Progress;
            });

            await core.DownloadFileAsync(state.Url, state.TargetPath, progress, state.Cts.Token,
                headers: ResolveHeaders(state.Url));
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
        finally
        {
            _engines.TryRemove(taskId, out _);
        }
    }

    private async Task DownloadAsync(string taskId, ResourceDownloadState state)
    {
        state.Status = "downloading";
        var filePath = Path.Combine(state.TargetPath, state.FileName);
        state.Cts = new CancellationTokenSource();

        try
        {
            var core = new DownloadCore(threadCount: 0, maxRetries: 3, autoUpdate: true);
            state.Engine = core;
            _engines[taskId] = core;

            var progress = new Progress<DownloadProgress>(p =>
            {
                state.DownloadedBytes = p.DownloadedBytes;
                state.TotalBytes = p.TotalBytes;
                state.Speed = p.Speed;
                state.Progress = p.Progress;
            });

            await core.DownloadFileAsync(state.Url, filePath, progress, state.Cts.Token,
                headers: ResolveHeaders(state.Url));

            var sw = Stopwatch.StartNew();
            using var sha1 = SHA1.Create();
            await using var fs = File.OpenRead(filePath);
            var hash = Convert.ToHexStringLower(await sha1.ComputeHashAsync(fs));
            sw.Stop();
            Trace.WriteLine($"[ResourceDownload] integrity sha1={hash} elapsed={sw.ElapsedMilliseconds}ms file={state.FileName}");

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
        finally
        {
            _engines.TryRemove(taskId, out _);
        }
    }
}
