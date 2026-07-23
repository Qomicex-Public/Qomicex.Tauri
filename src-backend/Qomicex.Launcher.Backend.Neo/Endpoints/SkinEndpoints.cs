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

        group.MapPost("/upload/{uuid}", async (string uuid, HttpRequest request) =>
        {
            if (!request.HasFormContentType)
                throw ApiException.BadRequest("No file uploaded");

            var file = request.Form.Files.GetFile("file");
            if (file == null || file.Length == 0)
                throw ApiException.BadRequest("No file uploaded");

            using var ms = new MemoryStream();
            await file.CopyToAsync(ms);
            skinService.SaveSkin(uuid, ms.ToArray());
            return Results.Json(new MessageResponse("Skin uploaded"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapDelete("/upload/{uuid}", (string uuid) =>
        {
            skinService.DeleteSkin(uuid);
            return Results.Json(new MessageResponse("Skin reset to default"), ApiJsonContext.Default.MessageResponse);
        });
    }
}
