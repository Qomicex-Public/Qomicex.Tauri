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
