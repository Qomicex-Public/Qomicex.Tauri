using System.Diagnostics;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class LogEndpoints
{
    public static void MapLogEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/logs");

        group.MapPost("/open", (OpenPathRequest body, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger("Log");
            var path = body.Path;
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                return Results.NotFound();
            try
            {
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                return Results.Ok();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to open file: {Path}", path);
                return Results.BadRequest();
            }
        });

        group.MapPost("/open-dir", (OpenPathRequest body, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger("Log");
            var path = body.Path;
            if (string.IsNullOrEmpty(path)) return Results.NotFound();
            try
            {
                var dir = File.Exists(path) ? Path.GetDirectoryName(path) : path;
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                    return Results.NotFound();
                Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true });
                return Results.Ok();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to open directory: {Path}", path);
                return Results.BadRequest();
            }
        });
    }
}
