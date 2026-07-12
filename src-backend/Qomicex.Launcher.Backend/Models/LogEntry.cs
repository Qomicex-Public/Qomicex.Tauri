namespace Qomicex.Launcher.Backend.Models;

public class LogEntry
{
    public string Path { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public long Size { get; set; }
    public string LastModified { get; set; } = string.Empty;
    public bool IsCurrentSession { get; set; }
}
