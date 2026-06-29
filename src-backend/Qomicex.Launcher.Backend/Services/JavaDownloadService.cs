using System.Collections.Concurrent;
using Qomicex.Downloader;
using Qomicex.Launcher.Backend.Common;
using Qomicex.Launcher.Backend.Models;

namespace Qomicex.Launcher.Backend.Services;

public class JavaDownloadService
{
    private readonly JavaRuntimeStore _javaRuntimeStore;
    private readonly ConcurrentDictionary<string, JavaDownloadTaskState> _tasks = new();

    private sealed class JavaDownloadTaskState
    {
        public string TaskId { get; init; } = string.Empty;
        public string Status { get; set; } = "queued";
        public double Progress { get; set; }
        public double Speed { get; set; }
        public string FileName { get; set; } = string.Empty;
        public string TargetDir { get; set; } = string.Empty;
        public string? Error { get; set; }
        public CancellationTokenSource Cancellation { get; } = new();
    }

    public JavaDownloadService(JavaRuntimeStore javaRuntimeStore)
    {
        _javaRuntimeStore = javaRuntimeStore;
    }

    public Task<JavaDownloadCatalogResponse> GetCatalogAsync()
    {
        var response = new JavaDownloadCatalogResponse
        {
            Vendors = new List<JavaDownloadVendorInfo>
            {
                new()
                {
                    Id = "temurin",
                    Name = "Temurin",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64", "x86" },
                    Versions = new() { 8, 11, 17, 21 },
                },
                new()
                {
                    Id = "zulu",
                    Name = "Zulu",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64", "x86" },
                    Versions = new() { 8, 11, 17, 21 },
                },
                new()
                {
                    Id = "microsoft-jdk",
                    Name = "Microsoft JDK",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64" },
                    Versions = new() { 11, 17, 21 },
                },
                new()
                {
                    Id = "oracle",
                    Name = "Oracle",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64" },
                    Versions = new() { 8, 17, 21 },
                },
            }
        };

        return Task.FromResult(response);
    }

    public Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)
    {
        throw new NotImplementedException();
    }

    public JavaDownloadProgressResponse? GetProgress(string taskId)
    {
        if (!_tasks.TryGetValue(taskId, out var state)) return null;
        return new JavaDownloadProgressResponse
        {
            TaskId = state.TaskId,
            Status = state.Status,
            Progress = state.Progress,
            Speed = state.Speed,
            FileName = state.FileName,
            TargetDir = state.TargetDir,
            Error = state.Error,
        };
    }

    public bool Cancel(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state))
        {
            state.Cancellation.Cancel();
            state.Status = "cancelled";
            return true;
        }
        return false;
    }
}
