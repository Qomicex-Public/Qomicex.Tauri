namespace Qomicex.Launcher.Backend.Models;

public class GameInstance
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..12];
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
    public DateTime? LastPlayed { get; set; }
    public long PlayTime { get; set; }
    public bool IsHidden { get; set; }
}
