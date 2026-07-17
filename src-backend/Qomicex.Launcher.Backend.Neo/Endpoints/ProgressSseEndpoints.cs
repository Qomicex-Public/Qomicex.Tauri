using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ProgressSseEndpoints
{
    public static void MapProgressSseEndpoints(this WebApplication app)
    {
        app.MapGet("/api/progress/stream", async (
            HttpContext context,
            InstallTracker installTracker,
            CancellationToken ct) =>
        {
            context.Response.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";

            try
            {
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(300, ct);

                    var installs = installTracker.GetAllActiveStates();

                    double totalSpeed = 0;
                    foreach (var i in installs)
                        totalSpeed += i.Speed;

                    var payload = new
                    {
                        type = "progress",
                        installs,
                        javaDownloads = Array.Empty<object>(),
                        resources = Array.Empty<object>(),
                        summary = new
                        {
                            activeCount = installs.Count,
                            totalSpeed
                        }
                    };

                    var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
                    {
                        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                    });
                    await context.Response.WriteAsync($"data: {json}\n\n", ct);
                    await context.Response.Body.FlushAsync(ct);
                }
            }
            catch (OperationCanceledException)
            {
            }
        });
    }
}
