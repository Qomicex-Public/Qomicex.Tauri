namespace Qomicex.Launcher.Backend.Models;

public class VerifyResourcesResult
{
    public bool Complete { get; set; }
    public int TotalCount { get; set; }
    public List<MissingFileInfo> MissingFiles { get; set; } = new();
}

public class MissingFileInfo
{
    public string Name { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string Sha1 { get; set; } = string.Empty;
}
