using System.Collections.Concurrent;
using Qomicex.Launcher.Backend.Models;

namespace Qomicex.Launcher.Backend.Services;

public class LaunchService
{
    private readonly ConcurrentDictionary<string, LaunchProgress> _states = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _cancellations = new();
    private readonly ConcurrentDictionary<string, int> _processIds = new();

    public LaunchProgress? Get(string instanceId) =>
        _states.TryGetValue(instanceId, out var s) ? s : null;

    public void Set(string instanceId, LaunchProgress state) =>
        _states[instanceId] = state;

    public void RegisterProcess(string instanceId, int processId) =>
        _processIds[instanceId] = processId;

    public CancellationToken GetCancellationToken(string instanceId) =>
        _cancellations.GetOrAdd(instanceId, _ => new()).Token;

    public void Cancel(string instanceId)
    {
        if (_cancellations.TryGetValue(instanceId, out var cts))
            cts.Cancel();
        if (_processIds.TryRemove(instanceId, out var pid))
        {
            try { System.Diagnostics.Process.GetProcessById(pid)?.Kill(); } catch { }
        }
        Remove(instanceId);
    }

    public void Remove(string instanceId)
    {
        _states.TryRemove(instanceId, out _);
        if (_cancellations.TryRemove(instanceId, out var cts))
            cts.Dispose();
        _processIds.TryRemove(instanceId, out _);
    }
}
