using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Http;
using System.Text.Json.Nodes;
using Qomicex.Downloader;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Core.Modules.Helpers.Resources;

namespace Qomicex.Launcher.Backend.Services;

public interface IInstallTask
{
    string InstanceId { get; }
    string Stage { get; }
    double Progress { get; }
    string? Error { get; }
    int TotalFiles { get; }
    int CompletedFiles { get; }
    int FailedFiles { get; }
    string CurrentFile { get; }
    double Speed { get; }
    bool IsPaused { get; }
    bool IsCompleted { get; }
    void Pause();
    void Resume();
    void Cancel();
}

public class InstanceInstallService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ConcurrentDictionary<string, IInstallTask> _tasks = new();

    public class InstallState
    {
        public string InstanceId { get; set; } = string.Empty;
        public string Stage { get; set; } = "queued";
        public double Progress { get; set; }
        public string? Error { get; set; }
        public DateTime StartedAt { get; set; } = DateTime.UtcNow;
        public int TotalFiles { get; set; }
        public int CompletedFiles { get; set; }
        public int FailedFiles { get; set; }
        public string CurrentFile { get; set; } = string.Empty;
        public double Speed { get; set; }
        public bool IsPaused { get; set; }
    }

    public InstanceInstallService(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    [Obsolete("Use constructor without DownloadManager — InstallTask creates its own")]
    public InstanceInstallService(IHttpClientFactory httpClientFactory, DownloadManager _)
        : this(httpClientFactory) { }

    public InstallState? GetState(string instanceId)
    {
        if (_tasks.TryGetValue(instanceId, out var task))
        {
            return new InstallState
            {
                InstanceId = task.InstanceId,
                Stage = task.Stage,
                Progress = task.Progress,
                Error = task.Error,
                TotalFiles = task.TotalFiles,
                CompletedFiles = task.CompletedFiles,
                FailedFiles = task.FailedFiles,
                CurrentFile = task.CurrentFile,
                Speed = task.Speed,
                IsPaused = task.IsPaused,
                StartedAt = DateTime.UtcNow
            };
        }
        return null;
    }

    public void StartInstall(string instanceId, string gameVersion, string gameDir,
        string? loader, string? loaderVersion, string[]? addons,
        int downloadThreads = 3, bool versionIsolation = true, int downloadSourceId = 0, int downloadTimeout = 15)
    {
        var task = new InstallTask(instanceId, gameVersion, gameDir,
            loader, loaderVersion, addons, downloadThreads, versionIsolation,
            _httpClientFactory, downloadSourceId, downloadTimeout);

        _tasks[instanceId] = task;

        _ = Task.Run(async () =>
        {
            try
            {
                await task.StartAsync();
            }
            finally
            {
                // Keep task in dict so GetState can read final state
                // It will be removed by RemoveInstall or after timeout
            }
        });
    }

    public void PauseInstall(string instanceId)
    {
        if (_tasks.TryGetValue(instanceId, out var task))
            task.Pause();
    }

    public void ResumeInstall(string instanceId)
    {
        if (_tasks.TryGetValue(instanceId, out var task))
            task.Resume();
    }

    public void CancelInstall(string instanceId)
    {
        if (_tasks.TryRemove(instanceId, out var task))
            task.Cancel();
    }

    public void RemoveInstall(string instanceId)
    {
        _tasks.TryRemove(instanceId, out _);
    }

    public void StartRepair(string instanceId, string gameVersion, string gameDir,
        string? loader = null, string? loaderVersion = null, int downloadThreads = 3)
    {
        // Repair reuses InstallTask with loader info so it scans the correct versionId
        var task = new InstallTask(instanceId, gameVersion, gameDir,
            loader, loaderVersion, null, downloadThreads, false,
            _httpClientFactory);

        _tasks[instanceId] = task;

        _ = Task.Run(async () =>
        {
            try
            {
                await task.StartAsync();
            }
            finally { }
        });
    }

    public void StartRepairResources(string instanceId, string gameDir,
        List<LocalResourceHelper.MissFileData> missingFiles)
    {
        var task = new RepairResourcesTask(instanceId, gameDir, missingFiles);
        _tasks[instanceId] = task;

        _ = Task.Run(async () =>
        {
            try
            {
                await task.StartAsync();
            }
            finally { }
        });
    }
}
