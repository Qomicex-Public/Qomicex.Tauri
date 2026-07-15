using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Core;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class LaunchEndpoints
{
    public static void MapLaunchEndpoints(this WebApplication app, DefaultGameCore core)
    {
        var group = app.MapGroup("/api/launch");

        group.MapPost("/", async (LaunchRequest req, InstanceService instances) =>
        {
            var instance = instances.GetById(req.InstanceId);
            if (instance == null)
                throw ApiException.NotFound($"Instance {req.InstanceId} not found");

            var launchOptions = new LaunchOptions
            {
                Version = req.VersionId,
                VersionIsolation = req.VersionIsolation,
                JoinServer = req.JoinServer,
                JoinWorld = req.JoinWorld,
                JavaOptions = new JavaOptions
                {
                    JavaPath = req.JavaPath,
                    MaxMemoryMB = req.MaxMemory,
                    ExtraJvmArgs = req.JvmArgs?.Split(' ', StringSplitOptions.RemoveEmptyEntries),
                },
                AuthOptions = string.IsNullOrEmpty(req.AuthToken) ? null : new AuthOptions
                {
                    Name = req.AuthName ?? "Player",
                    Uuid = req.AuthUuid,
                    AccessToken = req.AuthToken,
                }
            };

            var result = await core.Launch.LaunchAsync(launchOptions);
            return Results.Json(result, ApiJsonContext.Default.LaunchResult);
        });

        group.MapPost("/{pid}/kill", async (int pid) =>
        {
            var killed = await core.Launch.KillAsync(pid);
            if (killed)
                return Results.Json(new MessageResponse($"Process {pid} killed"), ApiJsonContext.Default.MessageResponse);
            return Results.NotFound(new MessageResponse($"Process {pid} not found or could not be killed"));
        });
    }
}
