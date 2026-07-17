using System.Collections.Concurrent;
using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class LaunchTracker
{
    private readonly ConcurrentDictionary<string, ProcessState> _states = new();
    private readonly ConcurrentDictionary<string, LaunchProgressState> _progress = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _cts = new();

    public void Track(string instanceId, int processId)
    {
        _states[instanceId] = new ProcessState(processId);
    }

    public ProcessState? GetState(string instanceId)
    {
        if (_states.TryGetValue(instanceId, out var state))
        {
            state.Refresh();
            if (state.HasExited)
            {
                _states.TryRemove(instanceId, out _);
                return state;
            }
            return state;
        }
        return null;
    }

    public ProcessState? Stop(string instanceId)
    {
        CancelAndRemove(instanceId);
        if (_states.TryRemove(instanceId, out var state))
        {
            state.Kill();
            return state;
        }
        return null;
    }

    public LaunchProgressState? GetProgress(string instanceId)
    {
        _progress.TryGetValue(instanceId, out var state);
        return state;
    }

    public void SetProgress(string instanceId, LaunchProgressState state)
    {
        _progress[instanceId] = state;
    }

    public CancellationTokenSource GetOrCreateCts(string instanceId)
    {
        return _cts.GetOrAdd(instanceId, _ => new CancellationTokenSource());
    }

    public void CancelAndRemove(string instanceId)
    {
        if (_cts.TryRemove(instanceId, out var cts))
        {
            try { cts.Cancel(); } catch { }
            cts.Dispose();
        }
        _progress.TryRemove(instanceId, out _);
    }
}

public sealed class ProcessState
{
    private readonly int _processId;

    public ProcessState(int processId)
    {
        _processId = processId;
        StartedAt = DateTime.UtcNow;
    }

    public int ProcessId => _processId;
    public DateTime StartedAt { get; }
    public bool HasExited { get; private set; }
    public int? ExitCode { get; private set; }

    public void Refresh()
    {
        try
        {
            var p = Process.GetProcessById(_processId);
            HasExited = p.HasExited;
            if (HasExited)
            {
                ExitCode = p.ExitCode;
                p.Dispose();
            }
        }
        catch (ArgumentException)
        {
            HasExited = true;
            ExitCode = null;
        }
    }

    public void Kill()
    {
        try
        {
            var p = Process.GetProcessById(_processId);
            if (!p.HasExited)
            {
                p.Kill(true);
                p.WaitForExit(5000);
                ExitCode = p.ExitCode;
            }
            HasExited = true;
            p.Dispose();
        }
        catch { HasExited = true; }
    }
}

public sealed class LaunchProgressState
{
    public string Stage { get; set; } = "";
    public string Message { get; set; } = "";
    public double Progress { get; set; }
    public string? Error { get; set; }
    public string? CurrentFile { get; set; }
    public int TotalFiles { get; set; }
    public int CompletedFiles { get; set; }
    public int? ProcessId { get; set; }
    public bool IsRunning { get; set; }
    public List<string> MissingFiles { get; set; } = [];
}
