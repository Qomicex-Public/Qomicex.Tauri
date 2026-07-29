using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Neo.Models;

public class PluginManifest
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("minLauncherVersion")]
    public string MinLauncherVersion { get; set; } = "";

    [JsonPropertyName("layers")]
    public List<string> Layers { get; set; } = [];

    [JsonPropertyName("permissions")]
    public List<string> Permissions { get; set; } = [];

    [JsonPropertyName("entry")]
    public PluginEntry Entry { get; set; } = new();

    [JsonPropertyName("contributes")]
    public PluginContributes? Contributes { get; set; }
}

public class PluginEntry
{
    [JsonPropertyName("backend")]
    public string? Backend { get; set; }

    [JsonPropertyName("frontend")]
    public string? Frontend { get; set; }

    [JsonPropertyName("theme")]
    public string? Theme { get; set; }
}

public class PluginContributes
{
    [JsonPropertyName("downloadSources")]
    public List<string>? DownloadSources { get; set; }

    [JsonPropertyName("commands")]
    public List<string>? Commands { get; set; }

    [JsonPropertyName("settingsPages")]
    public List<string>? SettingsPages { get; set; }

    [JsonPropertyName("menuItems")]
    public List<PluginMenuItem>? MenuItems { get; set; }
}

public class PluginMenuItem
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = "";

    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("icon")]
    public string? Icon { get; set; }
}

public class PluginInfo
{
    [JsonPropertyName("manifest")]
    public PluginManifest Manifest { get; set; } = new();

    [JsonPropertyName("dir")]
    public string Dir { get; set; } = "";

    [JsonPropertyName("state")]
    public string State { get; set; } = "installed";

    [JsonPropertyName("installedAt")]
    public string InstalledAt { get; set; } = "";
}
