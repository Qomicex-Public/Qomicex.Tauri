using Qomicex.Downloader.Refactor.Core;
using Qomicex.Downloader.Refactor.Model;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ResourceDownloadEndpoints
{
    public static void MapResourceDownloadEndpoints(this WebApplication app, string curseForgeApiKey)
    {
        var cfHeaders = new Dictionary<string, string> { ["x-api-key"] = curseForgeApiKey };
        var group = app.MapGroup("/api/resource-download");

        group.MapPost("/start", async (StartDownloadRequest req, IHttpClientFactory httpFactory) =>
        {
            await LicenseValidator.ValidateAsync(httpFactory);
            var orchestrator = app.Services.GetRequiredService<DownloadSessionManager>();
            var targetDir = req.TargetPath;
            if (string.IsNullOrEmpty(targetDir))
            {
                var instances = app.Services.GetRequiredService<InstanceService>();
                var inst = instances.GetById(req.InstanceId);
                if (inst is null) return Results.NotFound();
                var isolation = inst.VersionIsolation ?? SystemEndpoints.GetGlobalVersionIsolation();
                var gameDir = isolation
                    ? Path.GetFullPath(inst.GameDir)
                    : Path.GetFullPath(inst.ResolvedGameDir ?? inst.GameDir);
                var cat = req.Category?.ToLowerInvariant() switch
                {
                    "resourcepacks" or "resourcepack" => "resourcepacks",
                    "shaderpacks" or "shader" => "shaderpacks",
                    "datapacks" or "datapack" => "datapacks",
                    "saves" or "save" => "saves",
                    "screenshots" => "screenshots",
                    _ => "mods",
                };
                targetDir = isolation
                    ? Path.Combine(gameDir, "versions", inst.Name, cat)
                    : Path.Combine(gameDir, cat);
            }

            Directory.CreateDirectory(targetDir);
            var taskId = Guid.NewGuid().ToString();
            var session = orchestrator.CreateSession(taskId, "resource");
            StartDownloadTask(taskId, session, req.Url!, req.FileName!, targetDir, cfHeaders);
            return Results.Json(new DownloadStartResponse(taskId, req.FileName!), ApiJsonContext.Default.DownloadStartResponse);
        });

        group.MapPost("/download-to", async (DownloadToRequest req, IHttpClientFactory httpFactory) =>
        {
            await LicenseValidator.ValidateAsync(httpFactory);
            var orchestrator = app.Services.GetRequiredService<DownloadSessionManager>();
            var targetDir = Path.GetDirectoryName(req.TargetPath)!;
            Directory.CreateDirectory(targetDir);
            var taskId = Guid.NewGuid().ToString();
            var session = orchestrator.CreateSession(taskId, "resource");
            StartDownloadTask(taskId, session, req.Url!, Path.GetFileName(req.TargetPath), targetDir, cfHeaders);
            return Results.Json(new DownloadToResponse(taskId, req.TargetPath), ApiJsonContext.Default.DownloadToResponse);
        });

        group.MapGet("/{taskId}/progress", (string taskId) =>
        {
            var orchestrator = app.Services.GetRequiredService<DownloadSessionManager>();
            var session = orchestrator.GetSession(taskId);
            if (session is null)
                return Results.Json(new StatusResponse("not_found"), ApiJsonContext.Default.StatusResponse);
            var snap = session.GetSnapshot();
            return Results.Json(new DownloadProgressResponse(snap.Progress, snap.DownloadedBytes, snap.TotalBytes, snap.Status, snap.Error), ApiJsonContext.Default.DownloadProgressResponse);
        });

        group.MapPost("/{taskId}/cancel", (string taskId) =>
        {
            var orchestrator = app.Services.GetRequiredService<DownloadSessionManager>();
            orchestrator.CancelSession(taskId);
            return Results.Ok(new { Status = "cancelled" });
        });

        group.MapPost("/cancel-batch", (CancelBatchRequest req) =>
        {
            var orchestrator = app.Services.GetRequiredService<DownloadSessionManager>();
            foreach (var tid in req.TaskIds)
                orchestrator.CancelSession(tid);
            return Results.Ok(new { Status = "cancelled" });
        });
    }

    private static void StartDownloadTask(string taskId, DownloadSession session, string url, string fileName, string targetDir, Dictionary<string, string> cfHeaders)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var headers = IsCfUrl(url) ? cfHeaders : null;
                var fullPath = Path.Combine(targetDir, fileName);
                var task = new DownloadTask { Url = url, SavePath = fullPath };
                await session.RunSingleAsync(task, headers: headers);
                session.ReportCompleted();
            }
            catch (OperationCanceledException)
            {
                session.ReportCancelled();
            }
            catch (Exception ex)
            {
                session.ReportFailed(ex.Message);
            }
            finally
            {
                var tmpPath = Path.Combine(targetDir, fileName) + ".qdtmp";
                try { if (File.Exists(tmpPath)) File.Delete(tmpPath); } catch { }
            }
        });
    }

    private static bool IsCfUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        return uri.Host.Contains("forgecdn.net", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Contains("curseforge.com", StringComparison.OrdinalIgnoreCase);
    }

    public sealed record StartDownloadRequest(
        string InstanceId,
        string Url,
        string FileName,
        string? Category = null,
        string? TargetPath = null
    );

    public sealed record CancelBatchRequest(List<string> TaskIds);

    public sealed record DownloadStartResponse(string TaskId, string FileName);

    public sealed record StatusResponse(string Status);

    public sealed record DownloadProgressResponse(double Progress, long DownloadedBytes, long TotalBytes, string Status, string? Error);

    public sealed record DownloadToRequest(string Url, string TargetPath);

    public sealed record DownloadToResponse(string TaskId, string Path);
}
