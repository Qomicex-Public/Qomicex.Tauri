using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.JsonContext;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class VersionEndpoints
{
    public static void MapVersionEndpoints(this WebApplication app, DefaultGameCore core)
    {
        var group = app.MapGroup("/api/versions");

        group.MapGet("/", async (bool? forceRefresh) =>
        {
            var versions = await core.Version.GetAvailableVersionsAsync(forceRefresh ?? false);
            return Results.Json(versions, ApiJsonContext.Default.ListManifestVersionInfo);
        });

        group.MapGet("/latest", async (bool? forceRefresh) =>
        {
            var latest = await core.Version.GetLatestVersionsAsync(forceRefresh ?? false);
            return Results.Json(latest, ApiJsonContext.Default.LatestVersionInfo);
        });

        group.MapGet("/installed", () =>
        {
            var installed = core.Version.GetInstalledVersions();
            return Results.Json(installed, ApiJsonContext.Default.ListLocalVersionInfo);
        });

        group.MapGet("/{name}", async (string name) =>
        {
            var metadata = await core.Version.GetVersionMetadataAsync(name);
            return Results.Json(metadata, CombinedJsonContext.Default.CompleteVersionMetadata);
        });

        group.MapPost("/{name}/install", async (string name) =>
        {
            await core.Version.InstallVersionAsync(name);
            return Results.Json(new MessageResponse($"Installing version {name}", name), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/{name}/uninstall", async (string name) =>
        {
            if (!core.Version.IsVersionInstalled(name))
                throw new Qomicex.Core.AOT.Exceptions.VersionNotFoundException($"Version {name} is not installed");
            await core.Version.UninstallVersionAsync(name);
            return Results.Json(new MessageResponse($"Uninstalled version {name}"), ApiJsonContext.Default.MessageResponse);
        });
    }
}
