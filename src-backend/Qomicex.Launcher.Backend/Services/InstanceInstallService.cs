using System.Collections.Concurrent;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
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
    private readonly JavaRuntimeStore _javaRuntimeStore;
    private readonly string? _cfApiKey;
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

    public InstanceInstallService(IHttpClientFactory httpClientFactory, JavaRuntimeStore javaRuntimeStore, IConfiguration configuration)
    {
        _httpClientFactory = httpClientFactory;
        _javaRuntimeStore = javaRuntimeStore;
        _cfApiKey = configuration["CurseForge:ApiKey"];
    }

    [Obsolete("Use constructor without DownloadManager — InstallTask creates its own")]
    public InstanceInstallService(IHttpClientFactory httpClientFactory, DownloadManager _, JavaRuntimeStore javaRuntimeStore, IConfiguration configuration)
        : this(httpClientFactory, javaRuntimeStore, configuration) { }

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

    public List<InstallState> GetAllActiveStates()
    {
        return _tasks.Values
            .Where(t => !t.IsCompleted && t.Stage != "completed" && t.Stage != "cancelled" && t.Stage != "failed")
            .Select(t => new InstallState
            {
                InstanceId = t.InstanceId,
                Stage = t.Stage,
                Progress = t.Progress,
                Error = t.Error,
                TotalFiles = t.TotalFiles,
                CompletedFiles = t.CompletedFiles,
                FailedFiles = t.FailedFiles,
                CurrentFile = t.CurrentFile,
                Speed = t.Speed,
                IsPaused = t.IsPaused,
            })
            .ToList();
    }

    public void StartInstall(string instanceId, string gameVersion, string gameDir,
        string? loader, string? loaderVersion, string[]? addons,
        int downloadThreads = 64, bool versionIsolation = true, int downloadSourceId = 0, int downloadTimeout = 15,
        string? javaPath = null, string? versionId = null)
    {
        if (string.IsNullOrEmpty(javaPath))
        {
            var customJavas = _javaRuntimeStore.GetCustomAsync().GetAwaiter().GetResult();
            var valid = customJavas.FirstOrDefault(j => j.State == JavaHelper.JavaState.Valid);
            if (valid != null)
                javaPath = valid.Path;
        }

        var task = new InstallTask(instanceId, gameVersion, gameDir,
            loader, loaderVersion, addons, downloadThreads, versionIsolation,
            _httpClientFactory, downloadSourceId, downloadTimeout, javaPath, versionId);

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

    public void StartModpackInstall(string instanceId, string gameVersion, string gameDir,
        string? loader, string? loaderVersion, string instName, int downloadThreads,
        bool versionIsolation, List<ModpackFileEntry> files, byte[]? overridesZip,
        string? javaPath, int downloadSourceId = 0, int downloadTimeout = 15)
    {
        if (string.IsNullOrEmpty(javaPath))
        {
            var customJavas = _javaRuntimeStore.GetCustomAsync().GetAwaiter().GetResult();
            var valid = customJavas.FirstOrDefault(j => j.State == JavaHelper.JavaState.Valid);
            if (valid != null)
                javaPath = valid.Path;
        }

        var installTask = new InstallTask(instanceId, gameVersion, gameDir,
            loader, loaderVersion, null, downloadThreads, versionIsolation,
            _httpClientFactory, downloadSourceId, downloadTimeout, javaPath, instName);

        _tasks[instanceId] = installTask;

        _ = Task.Run(async () =>
        {
            try
            {
                await installTask.StartAsync();
                if (installTask.IsCompleted && installTask.Error == null)
                {
                    var modpackTask = new ModpackInstallTask(instanceId, gameDir, instName,
                        files, overridesZip, versionIsolation, _cfApiKey);
                    _tasks[instanceId] = modpackTask;
                    await modpackTask.StartAsync();
                }
            }
            finally { }
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
        string? loader = null, string? loaderVersion = null, int downloadThreads = 64,
        bool versionIsolation = true)
    {
        var task = new InstallTask(instanceId, gameVersion, gameDir,
            loader, loaderVersion, null, downloadThreads, versionIsolation,
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
