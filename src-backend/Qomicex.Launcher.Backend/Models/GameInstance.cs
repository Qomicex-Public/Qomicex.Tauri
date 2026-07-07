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
    public bool? VersionIsolation { get; set; }
    public string? VersionDirName { get; set; }
    public bool IsDefault { get; set; }
    public string? Icon { get; set; }
    public string? IconData { get; set; }
    public string? ModpackName { get; set; }
    public string? ModpackVersion { get; set; }
    public string? ModpackAuthor { get; set; }
    public string? ModpackSummary { get; set; }
    public bool SkipIntegrityCheck { get; set; }

    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? ResolvedGameDir { get; set; }
}
