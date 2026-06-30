namespace Qomicex.Launcher.Backend.Models;

public class LaunchProgress
{
    public string Stage { get; set; } = "idle";
    public string Message { get; set; } = "";
    public double Progress { get; set; }
    public string? Error { get; set; }
    public int? ProcessId { get; set; }
    public int? ExitCode { get; set; }
    public string? CrashReport { get; set; }
    public List<string>? MissingFiles { get; set; }
    public string? Arguments { get; set; }
    public bool IsRunning { get; set; }
}
