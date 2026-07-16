using System.Collections.Concurrent;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Services.Installers;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class InstallTracker
{
    private readonly ConcurrentDictionary<string, InstallState> _states = new();

    public void Start(string instanceId, string gameVersion, string gameDir,
        string? loader, string? loaderVersion, int? downloadSourceId, DefaultGameCore core)
    {
        var cts = new CancellationTokenSource();
        var state = new InstallState(cts);
        _states[instanceId] = state;

        Task.Run(async () =>
        {
            try
            {
                state.Status = "downloading";
                state.CurrentFile = "下载基础版本...";
                state.Progress = 10;

                await core.Version.InstallVersionAsync(gameVersion, progress: null);

                state.Progress = 40;
                state.CurrentFile = "下载完成";

                if (!string.IsNullOrEmpty(loader) && !string.IsNullOrEmpty(loaderVersion))
                {
                    state.Status = "installing";
                    state.CurrentFile = $"安装 {loader} {loaderVersion}...";
                    state.Progress = 50;

                    var source = downloadSourceId ?? 0;
                    await InstallLoader(instanceId, gameVersion, gameDir,
                        loader, loaderVersion, source, cts.Token);
                }

                state.Status = "completed";
                state.Progress = 100;
                state.CurrentFile = "";
            }
            catch (OperationCanceledException)
            {
                state.Status = "failed";
                state.Error = "安装已取消";
            }
            catch (Exception ex)
            {
                state.Status = "failed";
                state.Error = ex.Message;
            }
        });
    }

    private static async Task InstallLoader(string instanceId, string gameVersion,
        string gameDir, string loader, string loaderVersion, int downloadSource,
        CancellationToken ct)
    {
        var lower = loader.ToLowerInvariant();
        if (lower is "fabric" or "quilt")
        {
            IInstaller installer = lower == "fabric"
                ? new FabricInstaller(downloadSource, gameDir)
                : new QuiltInstaller(downloadSource, gameDir);

            // ponytail: inheritsFromJson loaded from base version after InstallVersionAsync
            var baseJsonPath = Path.Combine(gameDir, "versions", gameVersion, $"{gameVersion}.json");
            var inheritsFromJson = File.Exists(baseJsonPath) ? await File.ReadAllTextAsync(baseJsonPath, ct) : "{}";

            await installer.InstallAsync(instanceId, inheritsFromJson,
                loaderVersion, gameVersion, null, null);
            return;
        }

        // ponytail: Forge/NeoForge need Java runtime to run installer JAR — skip for now
        // add when forge installer support is needed
        throw new NotSupportedException($"加载器 {loader} 暂不支持在线安装，请手动安装");
    }

    public InstallState? GetState(string instanceId)
    {
        _states.TryGetValue(instanceId, out var state);
        return state;
    }

    public void Cancel(string instanceId)
    {
        if (_states.TryRemove(instanceId, out var state))
            state.Cancel();
    }
}

public sealed class InstallState(CancellationTokenSource cts)
{
    public string Status { get; set; } = "not-started";
    public double Progress { get; set; }
    public string? Error { get; set; }
    public string CurrentFile { get; set; } = "";

    public InstallProgressResponse ToResponse(string instanceId) => new(
        InstanceId: instanceId,
        Status: Status,
        Progress: Progress,
        Error: Error,
        CurrentFile: CurrentFile
    );

    public void Cancel() => cts.Cancel();
}
