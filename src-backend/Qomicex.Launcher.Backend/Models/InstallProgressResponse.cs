namespace Qomicex.Launcher.Backend.Models;

public class InstallProgressResponse
{
    public string InstanceId { get; set; } = string.Empty;
    public string Status { get; set; } = "not-started";
    public double Progress { get; set; }
    public string? Error { get; set; }
    public int TotalFiles { get; set; }
    public int CompletedFiles { get; set; }
    public int FailedFiles { get; set; }
    public string CurrentFile { get; set; } = string.Empty;
    public double Speed { get; set; }
    public bool IsPaused { get; set; }
}
