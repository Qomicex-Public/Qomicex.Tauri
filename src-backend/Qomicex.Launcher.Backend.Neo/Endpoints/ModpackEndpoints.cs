using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ModpackEndpoints
{
    public static void MapModpackEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/modpack");

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
    }
}
