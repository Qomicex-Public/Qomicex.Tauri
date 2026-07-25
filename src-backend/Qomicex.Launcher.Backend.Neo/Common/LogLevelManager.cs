namespace Qomicex.Launcher.Backend.Neo.Common;

public sealed class LogLevelManager
{
    public LogLevel Minimum { get; private set; } = LogLevel.Information;

    public void SetLevel(string? level)
    {
        Minimum = level?.ToLowerInvariant() switch
        {
            "error" => LogLevel.Error,
            "warn" => LogLevel.Warning,
            "info" => LogLevel.Information,
            "debug" => LogLevel.Debug,
            "trace" => LogLevel.Trace,
            _ => LogLevel.Information,
        };
    }
}
