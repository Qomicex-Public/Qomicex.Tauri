namespace Qomicex.Launcher.Backend.Models;

public class InstallRequest
{
    public string? Loader { get; set; }
    public string? LoaderVersion { get; set; }
    public string[]? Addons { get; set; }
    public int? DownloadThreads { get; set; }
    public bool VersionIsolation { get; set; } = true;
    public int DownloadSourceId { get; set; } = 0;
    public int DownloadTimeout { get; set; } = 15;
}
