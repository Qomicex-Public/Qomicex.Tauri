using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

public class ModInfo
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("cn_name")]
    public string CnName { get; set; } = string.Empty;

    [JsonPropertyName("en_name")]
    public string EnName { get; set; } = string.Empty;

    [JsonPropertyName("modid")]
    public string ModId { get; set; } = string.Empty;

    [JsonPropertyName("curseforge_id")]
    public string CurseForgeId { get; set; } = string.Empty;

    [JsonPropertyName("modrinth_id")]
    public string ModrinthId { get; set; } = string.Empty;

    [JsonPropertyName("tags")]
    public List<string> Tags { get; set; } = [];

    public string DisplayName => !string.IsNullOrEmpty(CnName) ? CnName : EnName;

    public string TagsText => string.Join(", ", Tags);
}

public class ModListRoot
{
    [JsonPropertyName("metadata")]
    public ModListMetadata Metadata { get; set; } = new();

    [JsonPropertyName("mods")]
    public List<ModInfo> Mods { get; set; } = [];
}

public class ModListMetadata
{
    [JsonPropertyName("generated_at")]
    public DateTime GeneratedAt { get; set; }

    [JsonPropertyName("total_count")]
    public int TotalCount { get; set; }

    [JsonPropertyName("source")]
    public string Source { get; set; } = string.Empty;

    [JsonPropertyName("url_template")]
    public string UrlTemplate { get; set; } = string.Empty;
}
