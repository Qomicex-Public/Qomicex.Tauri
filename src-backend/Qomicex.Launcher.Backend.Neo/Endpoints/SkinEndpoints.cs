using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class SkinEndpoints
{
    public static void MapSkinEndpoints(this WebApplication app, SkinService skinService)
    {
        var group = app.MapGroup("/api/skin");

        group.MapGet("/profile/{uuid}", async (string uuid, string? type, string? server) =>
        {
            var profile = await skinService.FetchProfile(uuid, type ?? "Microsoft", server);
            if (profile == null)
                throw ApiException.NotFound("profile not found");
            if (skinService.GetLocalSkin(uuid) != null)
                profile.SkinSource = "local";
            return Results.Json(profile, ApiJsonContext.Default.SkinProfile);
        });

        group.MapGet("/texture/{uuid}", async (string uuid, string? type, string? server) =>
        {
            var local = skinService.GetLocalSkin(uuid);
            if (local != null)
                return Results.File(local, "image/png");

            if (type == "Offline")
                return Results.File(SkinService.GetDefaultSkinBytes(), "image/png");

            var profile = await skinService.FetchProfile(uuid, type ?? "Microsoft", server);
            if (profile?.SkinUrl != null)
            {
                var data = await skinService.DownloadSkin(profile.SkinUrl);
                if (data != null)
                    return Results.File(data, "image/png");
            }
            return Results.File(SkinService.GetDefaultSkinBytes(), "image/png");
        });

        group.MapPost("/upload/{uuid}", async (string uuid, string? type, string? server, string? model, HttpRequest request) =>
        {
            if (!request.HasFormContentType)
                throw ApiException.BadRequest("No file uploaded");

            var file = request.Form.Files.GetFile("file");
            if (file == null || file.Length == 0)
                throw ApiException.BadRequest("No file uploaded");

            using var ms = new MemoryStream();
            await file.CopyToAsync(ms);
            var loginMethod = type ?? "Microsoft";
            if (loginMethod is "Microsoft" or "Yggdrasil" or "统一通行证")
                await skinService.UploadSkinAsync(uuid, loginMethod, server, ms.ToArray(), model == "slim");
            else
                skinService.SaveSkin(uuid, ms.ToArray()); // Offline → 仅本地保存
            return Results.Json(new MessageResponse("Skin uploaded"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapDelete("/upload/{uuid}", async (string uuid, string? type, string? server) =>
        {
            var loginMethod = type ?? "Microsoft";
            if (loginMethod is "Microsoft" or "Yggdrasil" or "统一通行证")
                await skinService.ResetSkinAsync(uuid, loginMethod, server);
            else
                skinService.DeleteSkin(uuid);
            return Results.Json(new MessageResponse("Skin reset to default"), ApiJsonContext.Default.MessageResponse);
        });

        // 披风图（Mojang / Yggdrasil profile 的 capeUrl）。无披风 404。
        group.MapGet("/cape/{uuid}", async (string uuid, string? type, string? server) =>
        {
            if (type == "Offline")
                throw ApiException.NotFound("no cape for this account");

            var profile = await skinService.FetchProfile(uuid, type ?? "Microsoft", server);
            if (profile?.CapeUrl == null)
                throw ApiException.NotFound("no cape for this account");

            var data = await skinService.DownloadSkin(profile.CapeUrl);
            if (data == null)
                throw ApiException.NotFound("no cape for this account");
            return Results.File(data, "image/png");
        });

        // ---------- 微软披风管理（仅 Microsoft 账户） ----------

        group.MapGet("/mc-capes/{uuid}", async (string uuid) =>
        {
            var capes = await skinService.GetMcCapesAsync(uuid);
            return Results.Json(new McCapeListResponse(capes), ApiJsonContext.Default.McCapeListResponse);
        });

        group.MapGet("/mc-cape/{uuid}/{capeId}", async (string uuid, string capeId) =>
        {
            var data = await skinService.DownloadMcCapeAsync(uuid, capeId);
            if (data == null)
                throw ApiException.NotFound("cape not found", "CAPE_NOT_FOUND");
            return Results.File(data, "image/png");
        });

        group.MapPut("/mc-capes/{uuid}/{capeId}", async (string uuid, string capeId) =>
        {
            await skinService.EquipMcCapeAsync(uuid, capeId);
            return Results.Json(new MessageResponse("Cape equipped"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapDelete("/mc-capes/{uuid}/{capeId}", async (string uuid, string capeId) =>
        {
            await skinService.UnequipMcCapeAsync(uuid);
            return Results.Json(new MessageResponse("Cape unequipped"), ApiJsonContext.Default.MessageResponse);
        });
    }
}
