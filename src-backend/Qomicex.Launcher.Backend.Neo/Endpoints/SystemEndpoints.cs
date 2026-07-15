using System.Runtime.InteropServices;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class SystemEndpoints
{
    public static void MapSystemEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api");

        group.MapGet("/health", () =>
        {
            return Results.Json(new HealthResponse("OK", DateTime.UtcNow),
                ApiJsonContext.Default.HealthResponse);
        });

        group.MapGet("/system/info", () =>
        {
            return Results.Json(new SystemInfoResponse(
                Os: RuntimeInformation.OSDescription,
                Architecture: RuntimeInformation.ProcessArchitecture.ToString(),
                Runtime: RuntimeInformation.FrameworkDescription,
                ProcessorCount: Environment.ProcessorCount,
                WorkingDirectory: Environment.CurrentDirectory
            ), ApiJsonContext.Default.SystemInfoResponse);
        });
    }
}
