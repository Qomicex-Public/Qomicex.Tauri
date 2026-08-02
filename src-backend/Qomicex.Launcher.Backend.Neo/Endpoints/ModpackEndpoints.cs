using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ModpackEndpoints
{
    public static void MapModpackEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/modpack");

        group.MapPost("/parse", async (IFormFile file, ModpackService svc) =>
        {
            if (file is not { Length: > 0 })
                throw new InvalidOperationException("未上传文件");

            var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
            if (ext is not ".zip" and not ".mrpack")
                throw new InvalidOperationException("仅支持 .zip 或 .mrpack 格式");

            await using var stream = file.OpenReadStream();
            var result = await svc.ParseFileAsync(stream, file.FileName);
            return Results.Json(result, ApiJsonContext.Default.ModpackParseResult);
        }).DisableAntiforgery();

        group.MapPost("/resolve", async (ModpackResolveRequest req, ModpackService svc) =>
        {
            var result = await svc.ResolveOnlineAsync(req.Source, req.ProjectId, req.VersionId);
            return Results.Json(result, ApiJsonContext.Default.ModpackParseResult);
        });

        group.MapPost("/install", async (ModpackInstallRequest req, ModpackService svc, IHttpClientFactory httpFactory) =>
        {
            LicenseValidator.ValidateAsync(httpFactory).GetAwaiter().GetResult();
            var instanceId = await svc.InstallAsync(req);
            return Results.Json(new MessageResponse("安装已启动", instanceId), ApiJsonContext.Default.MessageResponse);
        });

        // 一键安装整合包：在线（type + projectId + fileId）或本地（path），走正常整合包安装流程
        group.MapPost("/install-direct", async (ModpackInstallDirectRequest req, ModpackService svc, IHttpClientFactory httpFactory) =>
        {
            LicenseValidator.ValidateAsync(httpFactory).GetAwaiter().GetResult();

            if (string.IsNullOrWhiteSpace(req.Id))
                throw ApiException.BadRequest("id（实例名）不能为空", "MODPACK_NAME_REQUIRED");
            if (string.IsNullOrWhiteSpace(req.GameDir))
                throw ApiException.BadRequest("gameDir 不能为空", "MODPACK_GAME_DIR_REQUIRED");

            ModpackParseResult resolved;
            if (!string.IsNullOrWhiteSpace(req.Path))
            {
                if (!File.Exists(req.Path))
                    throw ApiException.NotFound("整合包文件不存在", "MODPACK_FILE_NOT_FOUND");
                await using var fs = File.OpenRead(req.Path);
                resolved = await svc.ParseFileAsync(fs, Path.GetFileName(req.Path));
            }
            else
            {
                if (string.IsNullOrWhiteSpace(req.ProjectId) || string.IsNullOrWhiteSpace(req.FileId))
                    throw ApiException.BadRequest("必须提供 projectId+fileId（在线）或 path（本地）", "MODPACK_SOURCE_REQUIRED");
                var source = (req.Type ?? "").ToLowerInvariant() switch
                {
                    "mr" or "modrinth" => "modrinth",
                    "cf" or "curseforge" => "curseforge",
                    "ftb" => "ftb",
                    _ => throw ApiException.BadRequest("无效的整合包来源类型（mr/cf/ftb）", "MODPACK_SOURCE_INVALID")
                };
                resolved = await svc.ResolveOnlineAsync(source, req.ProjectId, req.FileId);
            }

            var installRequest = new ModpackInstallRequest(
                Name: req.Id,
                GameVersion: resolved.GameVersion,
                Loader: resolved.Loader,
                LoaderVersion: resolved.LoaderVersion,
                MaxMemory: req.MaxMemory ?? 4096,
                GameDir: req.GameDir,
                VersionIsolation: req.VersionIsolation ?? false,
                ModpackFiles: resolved.Files,
                OverridesZip: resolved.OverridesZip,
                IconData: resolved.IconData,
                ModpackName: resolved.Name,
                ModpackVersion: resolved.Version,
                ModpackAuthor: resolved.Author,
                ModpackSummary: resolved.Summary,
                Source: resolved.Source,
                ProjectId: req.ProjectId,
                VersionId: req.FileId
            );
            var instanceId = await svc.InstallAsync(installRequest);
            return Results.Json(new ModpackInstallDirectResponse(instanceId), ApiJsonContext.Default.ModpackInstallDirectResponse);
        });
    }
}
