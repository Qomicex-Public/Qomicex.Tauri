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

            // result.DownloadUrl points to latest.json (Tauri update manifest),
            // download it and extract per-platform installer URL + signature
            try
            {
                using var client = httpFactory.CreateClient();
                var remoteManifest = await client.GetFromJsonAsync(
                    result.DownloadUrl,
                    ApiJsonContext.Default.TauriManifestResponse,
                    ct);

                if (remoteManifest?.Platforms is null || !remoteManifest.Platforms.TryGetValue(target, out var platform))
                    return Results.NoContent();

                return Results.Json(remoteManifest, ApiJsonContext.Default.TauriManifestResponse);
            }
            catch
            {
                return Results.NoContent();
            }
        });
    }
}
