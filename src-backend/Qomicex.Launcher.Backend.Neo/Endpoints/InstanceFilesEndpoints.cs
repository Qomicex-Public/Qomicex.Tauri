using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Models.Expansion.Local;
using Qomicex.Core.AOT.Services.Options;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class InstanceFilesEndpoints
{
    public static void MapInstanceFilesEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/instance/{id}/files");

        MapModEndpoints(group);
        MapResourcepackEndpoints(group);
        MapShadersEndpoints(group);
        MapDataPacksEndpoints(group);
        MapScreenshotsEndpoints(group);
        MapSavesEndpoints(group);
        MapServerEndpoints(group);
        MapOptionsEndpoints(group);
    }

    private static (string GameDir, string Version, bool Isolated) ResolveInstance(
        string id, InstanceService instances, ContentService content)
    {
        var inst = instances.GetById(id)
            ?? throw ApiException.NotFound($"Instance {id} not found");
        var gameDir = Path.GetFullPath(inst.ResolvedGameDir ?? inst.GameDir);
        var version = inst.VersionDirName ?? inst.Name;
        var isolated = inst.VersionIsolation ?? false;
        return (gameDir, version, isolated);
    }

    // ───────────── Mods ─────────────

    private static void MapModEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/mods", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var mods = content.CreateMods(version, isolated);
            var list = await mods.GetModList();
            return Results.Json(list, ApiJsonContext.Default.ListModInfo);
        });

        group.MapPost("/mods/enable", (FileOperationRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var mods = content.CreateMods(version, isolated);
            mods.EnableMod(req.Path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/mods/disable", (FileOperationRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var mods = content.CreateMods(version, isolated);
            mods.DisableMod(req.Path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/mods/batch-enable", (BatchFileRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var mods = content.CreateMods(version, isolated);
            foreach (var path in req.Paths)
                mods.EnableMod(path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/mods/batch-disable", (BatchFileRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var mods = content.CreateMods(version, isolated);
            foreach (var path in req.Paths)
                mods.DisableMod(path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    // ───────────── Resourcepacks ─────────────

    private static void MapResourcepackEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/resourcepacks", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var rp = content.CreateResourcepack(version, isolated);
            var list = await rp.GetResourcePackList();
            return Results.Json(list, ApiJsonContext.Default.ListResourcePackInfo);
        });

        group.MapPost("/resourcepacks/delete", (FileOperationRequest req) =>
        {
            if (File.Exists(req.Path))
                File.Delete(req.Path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    // ───────────── Shaders ─────────────

    private static void MapShadersEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/shaders", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var s = content.CreateShaders(version, isolated);
            var list = await s.GetShaderList();
            return Results.Json(list, ApiJsonContext.Default.ListShaderInfo);
        });

        group.MapPost("/shaders/delete", (FileOperationRequest req) =>
        {
            if (File.Exists(req.Path))
                File.Delete(req.Path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    // ───────────── DataPacks ─────────────

    private static void MapDataPacksEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/datapacks", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var dp = content.CreateDataPacks(version, isolated);
            var list = await dp.GetDataPackList();
            return Results.Json(list, ApiJsonContext.Default.ListDataPackInfo);
        });

        group.MapPost("/datapacks/delete", (FileOperationRequest req) =>
        {
            if (File.Exists(req.Path))
                File.Delete(req.Path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    // ───────────── Screenshots ─────────────

    private static void MapScreenshotsEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/screenshots", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var sc = content.CreateScreenshots(version, isolated);
            var list = sc.GetScreenshotList();
            return Results.Json(list, ApiJsonContext.Default.ListScreenshotInfo);
        });

        group.MapPost("/screenshots/delete", (FileOperationRequest req) =>
        {
            if (File.Exists(req.Path))
                File.Delete(req.Path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    // ───────────── Saves ─────────────

    private static void MapSavesEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/saves", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var saves = content.CreateSaves(version, isolated);
            var list = saves.GetSaveList();
            return Results.Json(list, ApiJsonContext.Default.ListSaveInfo);
        });

        group.MapPost("/saves/copy", (SaveCopyRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var savesDir = isolated
                ? Path.Combine(gameDir, "versions", version, "saves")
                : Path.Combine(gameDir, "saves");
            var src = Path.Combine(savesDir, req.Source);
            var dst = Path.Combine(savesDir, req.Target);
            CopyDirectory(src, dst);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/saves/rename", (SaveRenameRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var saves = content.CreateSaves(version, isolated);
            saves.RenameSave(req.Path, req.NewName);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/saves/backup", (FileOperationRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var saves = content.CreateSaves(version, isolated);
            saves.BackupSave(req.Path);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    // ───────────── Servers ─────────────

    private static void MapServerEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/servers", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var sm = content.CreateServerManager(gameDir, version, isolated);
            var list = sm.LoadServerList();
            return Results.Json(list, ApiJsonContext.Default.ListServerEntry);
        });

        group.MapPost("/servers", (ServerEntry entry, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            content.CreateServerManager(gameDir, version, isolated).AddOrUpdateServer(entry);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapDelete("/servers/{address}", (string address, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var removed = content.CreateServerManager(gameDir, version, isolated).RemoveServer(address);
            return removed
                ? Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse)
                : Results.NotFound();
        });

        group.MapGet("/servers/ping/{address}", (string address, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var state = content.CreateServerManager(gameDir, version, isolated).GetServerStateByAddress(address);
            return state is not null
                ? Results.Json(state, ApiJsonContext.Default.ServerState)
                : Results.NotFound();
        });

        group.MapGet("/lan-servers", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var servers = content.CreateServerManager(gameDir, version, isolated)
                .DiscoverLanServers(TimeSpan.FromSeconds(5));
            return Results.Json(servers, ApiJsonContext.Default.ListLanServerEntry);
        });
    }

    // ───────────── Options ─────────────

    private static void MapOptionsEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/options", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var options = await content.CreateOptionsAsync(gameDir, version, isolated);
            var list = options.GetOptionViewItems("en");
            return Results.Json(list, ApiJsonContext.Default.ListOptionViewItem);
        });

        group.MapGet("/options/{name}", async (string name, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var options = await content.CreateOptionsAsync(gameDir, version, isolated);
            var opt = options.GetDefinition(name);
            return opt is not null
                ? Results.Json(opt, ApiJsonContext.Default.OptionDefinition)
                : Results.NotFound();
        });

        group.MapPut("/options/{name}", async (string name, SetOptionRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = ResolveInstance(id, instances, content);
            var options = await content.CreateOptionsAsync(gameDir, version, isolated);
            options.SetOption(name, req.Value);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    private static void CopyDirectory(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);
        foreach (var file in Directory.GetFiles(sourceDir))
        {
            var dest = Path.Combine(destDir, Path.GetFileName(file));
            File.Copy(file, dest, true);
        }
        foreach (var dir in Directory.GetDirectories(sourceDir))
        {
            var dest = Path.Combine(destDir, Path.GetFileName(dir));
            CopyDirectory(dir, dest);
        }
    }
}

// ── Request DTOs ──

public sealed record FileOperationRequest(string Path);
public sealed record BatchFileRequest(string[] Paths);
public sealed record SaveCopyRequest(string Source, string Target);
public sealed record SaveRenameRequest(string Path, string NewName);
public sealed record SetOptionRequest(string Value);
