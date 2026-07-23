using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Core;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ResourceEndpoints
{
    public static void MapResourceEndpoints(this WebApplication app, DefaultGameCore core)
    {
        var group = app.MapGroup("/api/resources");

        group.MapPost("/complete", async (ResourceCompleteRequest req) =>
        {
            if (req.CheckOnly)
            {
                var installed = core.Version.IsVersionInstalled(req.VersionId);
                return Results.Json(new CheckResourcesResponse(installed, req.VersionId),
                    ApiJsonContext.Default.CheckResourcesResponse);
            }

            _ = core.Version.InstallVersionAsync(req.VersionId);
            return Results.Accepted("/api/resources/complete/progress",
                new MessageResponse($"Resource completion started for {req.VersionId}", req.VersionId));
        });

        group.MapGet("/complete/progress", () =>
        {
            return Results.Json(new ProgressResponse(
                TaskId: "resource-complete",
                Percentage: 0,
                Downloaded: 0,
                Total: 0,
                CurrentFile: null,
                Status: "started"
            ), ApiJsonContext.Default.ProgressResponse);
        });
    }
}
