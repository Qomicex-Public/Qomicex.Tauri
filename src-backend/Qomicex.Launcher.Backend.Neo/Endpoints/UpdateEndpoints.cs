using Qomicex.Launcher.Backend.Neo.JsonContext;
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
    }
}
