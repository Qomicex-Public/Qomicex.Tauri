using System.Collections.Concurrent;
using Qomicex.Downloader.Refactor.Configuration;
using Qomicex.Downloader.Refactor.Model;
using Qomicex.Downloader.Refactor.Progress;
using RefDl = Qomicex.Downloader.Refactor.Downloader;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ResourceDownloadEndpoints
{
    public static void MapResourceDownloadEndpoints(this WebApplication app, string curseForgeApiKey)
    {
        var states = new ConcurrentDictionary<string, DownloadState>();
        var cfHeaders = new Dictionary<string, string> { ["x-api-key"] = curseForgeApiKey };

        var group = app.MapGroup("/api/resource-download");

        group.MapPost("/start", async (StartDownloadRequest req, IHttpClientFactory httpFactory) =>
        {
            await LicenseValidator.ValidateAsync(httpFactory);
            var targetDir = req.TargetPath;
            if (string.IsNullOrEmpty(targetDir))
            {
                var instances = app.Services.GetRequiredService<Services.InstanceService>();
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
                    ? Path.Combine(gameDir, "versions", inst.VersionDirName ?? inst.Name, cat)
                    : Path.Combine(gameDir, cat);
            }

            Directory.CreateDirectory(targetDir);
            var taskId = Guid.NewGuid().ToString();
            var state = new DownloadState { Url = req.Url, FileName = req.FileName, TargetPath = targetDir };
            states[taskId] = state;
            StartDownloadTask(state, cfHeaders, state.Cts.Token);

            return Results.Json(new DownloadStartResponse(taskId, req.FileName!), ApiJsonContext.Default.DownloadStartResponse);
        });

        group.MapPost("/download-to", async (DownloadToRequest req, IHttpClientFactory httpFactory) =>
        {
            await LicenseValidator.ValidateAsync(httpFactory);
            var targetDir = Path.GetDirectoryName(req.TargetPath)!;
            Directory.CreateDirectory(targetDir);
            var taskId = Guid.NewGuid().ToString();
            var state = new DownloadState { Url = req.Url, FileName = Path.GetFileName(req.TargetPath), TargetPath = targetDir };
            states[taskId] = state;
            StartDownloadTask(state, cfHeaders, state.Cts.Token);

            return Results.Json(new DownloadToResponse(taskId, req.TargetPath), ApiJsonContext.Default.DownloadToResponse);
        });

        group.MapGet("/{taskId}/progress", (string taskId) =>
        {
            if (!states.TryGetValue(taskId, out var state))
                return Results.Json(new StatusResponse("not_found"), ApiJsonContext.Default.StatusResponse);
            return Results.Json(new DownloadProgressResponse(state.Progress, state.DownloadedBytes, state.TotalBytes, state.Status, state.Error), ApiJsonContext.Default.DownloadProgressResponse);
        });

        group.MapPost("/{taskId}/cancel", (string taskId) =>
        {
            if (states.TryRemove(taskId, out var state))
                state.Cts.Cancel();
            return Results.Ok(new { Status = "cancelled" });
        });

        group.MapPost("/cancel-batch", (CancelBatchRequest req) =>
        {
            foreach (var tid in req.TaskIds)
            {
                if (states.TryRemove(tid, out var state))
                    state.Cts.Cancel();
            }
            return Results.Ok(new { Status = "cancelled" });
        });
    }

    private static void StartDownloadTask(DownloadState state, Dictionary<string, string> cfHeaders, CancellationToken ct)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var headers = new Dictionary<string, string>();
                if (state.Url?.Contains("forgecdn.net") == true || state.Url?.Contains("curseforge.com") == true)
                {
                    foreach (var (k, v) in cfHeaders) headers[k] = v;
                }

                var fileProgress = new Progress<FileProgressInfo>(p =>
                {
                    state.DownloadedBytes = p.DownloadedBytes;
                    state.TotalBytes = p.TotalBytes;
                    state.Progress = p.ProgressPercent;
                });

                state.Progress = 0;
                using var downloader = new RefDl(builder => builder
                    .WithUserAgent("QomicexLauncher/1.0")
                    .WithDefaultHeaders(headers)
                    .WithProgress(null, fileProgress, DownloaderTrace.CreateLogProgress()));
                var task = new DownloadTask { Url = state.Url!, SavePath = Path.Combine(state.TargetPath, state.FileName!) };
                await downloader.DownloadAsync(task, ct);
                state.Progress = 100;
                state.Status = "completed";
            }
            catch (OperationCanceledException)
            {
                state.Status = "cancelled";
            }
            catch (Exception ex)
            {
                state.Status = "failed";
                state.Error = ex.Message;
            }
            finally
            {
                if (!string.IsNullOrEmpty(state.FileName))
                {
                    var tmpPath = Path.Combine(state.TargetPath, state.FileName) + ".qdtmp";
                    try { if (File.Exists(tmpPath)) File.Delete(tmpPath); } catch { }
                }
            }
        });
    }

    private sealed class DownloadState
    {
        public string? Url { get; set; }
        public string? FileName { get; set; }
        public string TargetPath { get; set; } = "";
        public double Progress { get; set; }
        public long DownloadedBytes { get; set; }
        public long TotalBytes { get; set; }
        public string Status { get; set; } = "pending";
        public string? Error { get; set; }
        public CancellationTokenSource Cts { get; set; } = new();
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
