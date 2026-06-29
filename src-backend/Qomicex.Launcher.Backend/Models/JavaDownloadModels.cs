namespace Qomicex.Launcher.Backend.Models;

public class JavaDownloadVendorInfo
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string> Platforms { get; set; } = new();
    public List<string> Architectures { get; set; } = new();
    public List<int> Versions { get; set; } = new();
}

public class JavaDownloadCatalogResponse
{
    public List<JavaDownloadVendorInfo> Vendors { get; set; } = new();
}

public class JavaDownloadStartRequest
{
    public string Vendor { get; set; } = string.Empty;
    public int Version { get; set; }
    public string Platform { get; set; } = string.Empty;
    public string Architecture { get; set; } = string.Empty;
}

public class JavaDownloadStartResponse
{
    public string TaskId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string TargetDir { get; set; } = string.Empty;
}

public class JavaDownloadProgressResponse
{
    public string TaskId { get; set; } = string.Empty;
    public string Status { get; set; } = "queued";
    public double Progress { get; set; }
    public double Speed { get; set; }
    public string FileName { get; set; } = string.Empty;
    public string TargetDir { get; set; } = string.Empty;
    public string? Error { get; set; }
}
