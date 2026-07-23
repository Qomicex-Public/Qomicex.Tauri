using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public sealed record ProgressSsePayload(
    string Type,
    List<InstallProgressResponse> Installs,
    List<JavaDownloadProgressResponse> JavaDownloads,
    List<object> Resources,
    ProgressSseSummary Summary
);

public sealed record ProgressSseSummary(int ActiveCount, double TotalSpeed);

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

                    var payload = new ProgressSsePayload(
                        Type: "progress",
                        Installs: installs,
                        JavaDownloads: [],
                        Resources: [],
                        Summary: new ProgressSseSummary(ActiveCount: installs.Count, TotalSpeed: totalSpeed)
                    );

                    var json = JsonSerializer.Serialize(payload, ApiJsonContext.Default.ProgressSsePayload);
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
