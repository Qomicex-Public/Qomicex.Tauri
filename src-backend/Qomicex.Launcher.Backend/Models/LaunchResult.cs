namespace Qomicex.Launcher.Backend.Models;

public class LaunchResult
{
    public bool Success { get; set; }
    public int ProcessId { get; set; }
    public string? Error { get; set; }
    public string? Detail { get; set; }
    public string? Arguments { get; set; }
    public string? Stage { get; set; }
    public List<string>? MissingFiles { get; set; }
    public int? ExitCode { get; set; }
    public string? CrashReport { get; set; }
}
