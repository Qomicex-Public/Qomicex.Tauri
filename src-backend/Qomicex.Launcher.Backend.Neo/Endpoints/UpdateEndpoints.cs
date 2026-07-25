using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class UpdateEndpoints
{
    public static void MapUpdateEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api");

        group.MapGet("/update/check", async (
            string current,
            string? channel,
            UpdateService updateService,
            IHttpClientFactory httpFactory,
            CancellationToken ct) =>
        {
            var result = await updateService.CheckAsync(current, channel, httpFactory, ct);
            return Results.Json(result, ApiJsonContext.Default.UpdateCheckResponse);
        });

        group.MapGet("/update/manifest", async (
            string current,
            string target,
            string arch,
            HttpContext httpContext,
            UpdateService updateService,
            IHttpClientFactory httpFactory,
            CancellationToken ct) =>
        {
            var channel = httpContext.Request.Headers["X-Updater-Channel"].FirstOrDefault() ?? "stable";
            var result = await updateService.CheckAsync(current, channel, httpFactory, ct);

            if (!result.HasUpdate || string.IsNullOrEmpty(result.DownloadUrl))
                return Results.NoContent();

            // The download URL from UpdateService already has proxy prefix applied
            // Use empty signature since we skip validation in dev

            // ponytail: hardcoded platform map, extend when adding more targets
            var platform = target switch
            {
                "windows-x86_64" => new TauriPlatformEntry("", result.DownloadUrl),
                "windows-x86" => new TauriPlatformEntry("", result.DownloadUrl),
                "darwin-x86_64" => new TauriPlatformEntry("", result.DownloadUrl),
                "darwin-aarch64" => new TauriPlatformEntry("", result.DownloadUrl),
                "linux-x86_64" => new TauriPlatformEntry("", result.DownloadUrl),
                _ => null
            };

            if (platform is null)
                return Results.NoContent();

            var manifest = new TauriManifestResponse(
                Version: result.Version!,
                Notes: result.Changelog,
                PubDate: DateTime.UtcNow.ToString("o"),
                Platforms: new Dictionary<string, TauriPlatformEntry>
                {
                    [target] = platform
                }
            );

            return Results.Json(manifest, ApiJsonContext.Default.TauriManifestResponse);
        });
    }
}
