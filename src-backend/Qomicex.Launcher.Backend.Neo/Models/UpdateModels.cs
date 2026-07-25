using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Neo.Models;

public sealed record UpdateCheckResponse(
    bool HasUpdate,
    string? Version = null,
    string? Type = null,
    bool Required = false,
    string? Title = null,
    string? Changelog = null,
    string? DownloadUrl = null
);

public sealed record TauriManifestResponse(
    string Version,
    string? Notes,
    [property: JsonPropertyName("pub_date")] string PubDate,
    Dictionary<string, TauriPlatformEntry> Platforms
);

public sealed record TauriPlatformEntry(
    string Signature,
    string Url
);
