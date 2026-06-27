namespace Qomicex.Launcher.Backend.Models;

public class CreateInstanceRequest
{
    public string Name { get; set; } = string.Empty;
    public string GameVersion { get; set; } = string.Empty;
    public string? Loader { get; set; }
    public string? LoaderVersion { get; set; }
    public string? JavaPath { get; set; }
    public int MaxMemory { get; set; } = 4096;
    public string GameDir { get; set; } = ".minecraft";
    public string? AccountName { get; set; }
    public string? AccountUuid { get; set; }
    public string? AccessToken { get; set; }
    public string? JvmArgs { get; set; }
    public bool VersionIsolation { get; set; }
}
