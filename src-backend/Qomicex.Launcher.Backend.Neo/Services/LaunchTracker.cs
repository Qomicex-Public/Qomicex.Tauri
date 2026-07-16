using System.Collections.Concurrent;
using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class LaunchTracker
{
    private readonly ConcurrentDictionary<string, ProcessState> _states = new();

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
        if (_states.TryRemove(instanceId, out var state))
        {
            state.Kill();
            return state;
        }
        return null;
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
