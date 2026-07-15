using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class InstanceEndpoints
{
    public static void MapInstanceEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/instances");

        group.MapGet("/", (InstanceService instances) =>
        {
            return Results.Json(instances.GetAll(), ApiJsonContext.Default.ListGameInstance);
        });

        group.MapPost("/", (CreateInstanceRequest req, InstanceService instances) =>
        {
            var instance = new GameInstance
            {
                Name = req.Name,
                GameVersion = req.GameVersion,
                Loader = req.Loader,
                LoaderVersion = req.LoaderVersion,
                JavaPath = req.JavaPath,
                MaxMemory = req.MaxMemory,
                GameDir = req.GameDir,
            };
            var created = instances.Create(instance);
            return Results.Created($"/api/instances/{created.Id}", created);
        });

        group.MapGet("/{id}", (string id, InstanceService instances) =>
        {
            var instance = instances.GetById(id);
            return instance is not null
                ? Results.Json(instance, ApiJsonContext.Default.GameInstance)
                : Results.NotFound(new { Message = $"Instance {id} not found" });
        });

        group.MapPut("/{id}", (string id, UpdateInstanceRequest req, InstanceService instances) =>
        {
            var existing = instances.GetById(id);
            if (existing is null)
                throw ApiException.NotFound($"Instance {id} not found");

            if (req.Name is not null) existing.Name = req.Name;
            if (req.GameVersion is not null) existing.GameVersion = req.GameVersion;
            if (req.Loader is not null) existing.Loader = req.Loader;
            if (req.LoaderVersion is not null) existing.LoaderVersion = req.LoaderVersion;
            if (req.JavaPath is not null) existing.JavaPath = req.JavaPath;
            if (req.MaxMemory.HasValue) existing.MaxMemory = req.MaxMemory.Value;
            if (req.JvmArgs is not null) existing.JvmArgs = req.JvmArgs;
            if (req.IsHidden.HasValue) existing.IsHidden = req.IsHidden.Value;
            if (req.VersionIsolation.HasValue) existing.VersionIsolation = req.VersionIsolation.Value;

            var updated = instances.Update(id, existing);
            return Results.Json(updated, ApiJsonContext.Default.GameInstance);
        });

        group.MapDelete("/{id}", (string id, InstanceService instances) =>
        {
            var deleted = instances.Delete(id);
            if (deleted is not null)
                return Results.Json(new MessageResponse($"Instance {id} deleted"), ApiJsonContext.Default.MessageResponse);
            return Results.NotFound(new { Message = $"Instance {id} not found" });
        });
    }
}
