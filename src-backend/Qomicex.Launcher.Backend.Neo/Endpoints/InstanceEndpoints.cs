using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Core;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class InstanceEndpoints
{
    public static void MapInstanceEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/instance");

        group.MapGet("/", (InstanceService instances) =>
        {
            return Results.Json(instances.GetAll(), ApiJsonContext.Default.ListGameInstance);
        });

        group.MapGet("/default", (InstanceService instances) =>
        {
            var id = instances.GetDefaultId();
            if (id is null) return Results.NoContent();
            var inst = instances.GetById(id);
            return inst is not null
                ? Results.Json(inst, ApiJsonContext.Default.GameInstance)
                : Results.NoContent();
        });

        group.MapPut("/{id}/default", (string id, InstanceService instances) =>
        {
            instances.SetDefaultId(id);
            var inst = instances.GetById(id);
            return inst is not null
                ? Results.Json(inst, ApiJsonContext.Default.GameInstance)
                : Results.NoContent();
        });

        group.MapDelete("/{id}/default", (string id, InstanceService instances) =>
        {
            instances.ClearDefaultId();
            return Results.NoContent();
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
            return Results.Created($"/api/instance/{created.Id}", created);
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

        group.MapPost("/{id}/launch", async (string id, InstanceService instances, DefaultGameCore core, LaunchTracker tracker) =>
        {
            var instance = instances.GetById(id);
            if (instance is null)
                throw ApiException.NotFound($"Instance {id} not found");

            var launchOptions = new LaunchOptions
            {
                Version = instance.Name,
                VersionIsolation = instance.VersionIsolation ?? false,
                JavaOptions = new JavaOptions
                {
                    JavaPath = instance.JavaPath ?? "java",
                    MaxMemoryMB = instance.MaxMemory,
                    ExtraJvmArgs = string.IsNullOrEmpty(instance.JvmArgs)
                        ? null
                        : instance.JvmArgs.Split(' ', StringSplitOptions.RemoveEmptyEntries),
                },
            };

            var result = await core.Launch.LaunchAsync(launchOptions);

            if (result.Success)
                tracker.Track(id, result.ProcessId);

            return Results.Json(new LaunchResultDto(
                Success: result.Success,
                ProcessId: result.Success ? result.ProcessId : -1,
                Error: result.Success ? null : (result.Exception?.Message ?? result.Message),
                Detail: result.Exception?.ToString()
            ), ApiJsonContext.Default.LaunchResultDto);
        });

        group.MapGet("/{id}/launch/progress", (string id, LaunchTracker tracker) =>
        {
            var state = tracker.GetState(id);
            if (state is null)
                return Results.Json(new LaunchProgressDto(
                    Stage: "completed",
                    Message: "进程已结束",
                    Progress: 100,
                    IsRunning: false
                ), ApiJsonContext.Default.LaunchProgressDto);

            return Results.Json(new LaunchProgressDto(
                Stage: "running",
                Message: "游戏运行中",
                Progress: 50,
                IsRunning: true,
                ProcessId: state.ProcessId
            ), ApiJsonContext.Default.LaunchProgressDto);
        });

        group.MapPost("/{id}/launch/cancel", (string id, LaunchTracker tracker) =>
        {
            tracker.Stop(id);
            return Results.Json(new MessageResponse($"Launch cancelled for {id}"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/{id}/install", async (string id, InstallerRequest req, InstanceService instances, DefaultGameCore core, InstallTracker tracker) =>
        {
            var instance = instances.GetById(id);
            if (instance is null)
                throw ApiException.NotFound($"Instance {id} not found");

            if (!string.IsNullOrEmpty(req.Loader))
            {
                var loaderType = MapLoaderType(req.Loader);
                if (loaderType is null)
                    throw ApiException.BadRequest($"加载器 {req.Loader} 不支持", "INSTALL_LOADER_INVALID");

                var available = await core.InstallerProvider.GetAvailableModLoaders(instance.GameVersion, loaderType.Value);
                if (available.Count == 0)
                    throw ApiException.BadRequest($"游戏版本 {instance.GameVersion} 不支持加载器 {req.Loader}", "INSTALL_LOADER_NOT_AVAILABLE");

                if (!string.IsNullOrEmpty(req.LoaderVersion) && !available.Any(l => l.Version == req.LoaderVersion))
                    throw ApiException.BadRequest($"加载器版本 {req.LoaderVersion} 不可用", "INSTALL_LOADER_VERSION_INVALID");
            }

            var gameDir = Path.GetFullPath(instance.GameDir ?? ".minecraft");
            tracker.Start(id, instance.GameVersion, gameDir,
                req.Loader, req.LoaderVersion, req.DownloadSourceId, core);

            return Results.Accepted($"/api/instance/{id}/install/progress",
                new MessageResponse($"Install started for {id}", id));
        });

        group.MapGet("/{id}/install/progress", (string id, InstallTracker tracker) =>
        {
            var state = tracker.GetState(id);
            return state is not null
                ? Results.Json(state.ToResponse(id), ApiJsonContext.Default.InstallProgressResponse)
                : Results.Json(new InstallProgressResponse(id, "completed", 100), ApiJsonContext.Default.InstallProgressResponse);
        });

        group.MapPost("/{id}/install/cancel", (string id, InstallTracker tracker) =>
        {
            tracker.Cancel(id);
            return Results.Json(new MessageResponse($"Install cancelled for {id}"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapGet("/loaders", async (DefaultGameCore core, string gameVersion, string? type) =>
        {
            var loaderType = type is not null ? MapLoaderType(type) : null;
            var loaders = await core.InstallerProvider.GetAvailableModLoaders(
                gameVersion, loaderType ?? Qomicex.Core.AOT.Public.Models.ModLoaderType.All);
            return Results.Json(loaders);
        });
    }

    private static Qomicex.Core.AOT.Public.Models.ModLoaderType? MapLoaderType(string loader) => loader.ToLowerInvariant() switch
    {
        "fabric" => Qomicex.Core.AOT.Public.Models.ModLoaderType.Fabic,
        "quilt" => Qomicex.Core.AOT.Public.Models.ModLoaderType.Quilt,
        "forge" => Qomicex.Core.AOT.Public.Models.ModLoaderType.Forge,
        "neoforge" => Qomicex.Core.AOT.Public.Models.ModLoaderType.NeoForge,
        "liteloader" => Qomicex.Core.AOT.Public.Models.ModLoaderType.LiteLoader,
        "optifine" => Qomicex.Core.AOT.Public.Models.ModLoaderType.OptiFine,
        _ => null
    };
}
