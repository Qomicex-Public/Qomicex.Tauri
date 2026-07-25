using System.Diagnostics;
using System.IO.Compression;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class LogEndpoints
{
    private static readonly string LogDir = Path.Combine(AppPaths.BaseDir, "logs");
    private static readonly DateTime SessionStart = Process.GetCurrentProcess().StartTime.ToLocalTime();

    private static string? ResolveLogPath(string? path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var full = Path.GetFullPath(path);
        return full.StartsWith(LogDir, StringComparison.OrdinalIgnoreCase) && File.Exists(full) ? full : null;
    }

    public static void MapLogEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/logs");

        group.MapGet("/", () =>
        {
            Directory.CreateDirectory(LogDir);
            var files = Directory.EnumerateFiles(LogDir, "*", SearchOption.TopDirectoryOnly)
                .Select(f =>
                {
                    var info = new FileInfo(f);
                    return new LogEntry(
                        Path: f,
                        Name: info.Name,
                        Size: info.Length,
                        LastModified: info.LastWriteTime.ToString("o"),
                        IsCurrentSession: info.LastWriteTime >= SessionStart
                    );
                })
                .OrderByDescending(e => e.LastModified)
                .ToList();
            return Results.Json(files, ApiJsonContext.Default.ListLogEntry);
        });

        group.MapGet("/preview", ([Microsoft.AspNetCore.Mvc.FromQuery] string path) =>
        {
            var resolved = ResolveLogPath(path);
            if (resolved == null) return Results.NotFound();
            var info = new FileInfo(resolved);
            var totalSize = info.Length;
            const int maxPreview = 100 * 1024;
            string content;
            if (totalSize <= maxPreview)
            {
                content = File.ReadAllText(resolved);
            }
            else
            {
                using var stream = new FileStream(resolved, FileMode.Open, FileAccess.Read);
                stream.Seek(-maxPreview, SeekOrigin.End);
                var reader = new StreamReader(stream);
                content = reader.ReadToEnd();
                if (content.Length > 0 && content[0] != '\n')
                {
                    var idx = content.IndexOf('\n');
                    if (idx > 0) content = content[(idx + 1)..];
                }
            }
            return Results.Json(new PreviewResult(content, totalSize, maxPreview), ApiJsonContext.Default.PreviewResult);
        });

        group.MapGet("/export", ([Microsoft.AspNetCore.Mvc.FromQuery] string path) =>
        {
            string? decoded;
            try { decoded = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(path)); }
            catch { decoded = Uri.UnescapeDataString(path); }
            var resolved = ResolveLogPath(decoded);
            if (resolved == null) return Results.NotFound();
            var fileName = Path.GetFileName(resolved);
            return Results.File(resolved, "application/octet-stream", fileName);
        });

        group.MapPost("/export-to", (ExportRequest body) =>
        {
            var resolved = ResolveLogPath(body.Path);
            if (resolved == null) return Results.NotFound();
            try
            {
                var destDir = Path.GetDirectoryName(body.Dest);
                if (!string.IsNullOrEmpty(destDir)) Directory.CreateDirectory(destDir);
                File.Copy(resolved, body.Dest, overwrite: true);
                return Results.Json(new OpenPathResponse(body.Dest), ApiJsonContext.Default.OpenPathResponse);
            }
            catch { return Results.BadRequest(); }
        });

        group.MapPost("/export-all-to", async (ExportAllRequest body) =>
        {
            Directory.CreateDirectory(LogDir);
            var destDir = Path.GetDirectoryName(body.Dest);
            if (!string.IsNullOrEmpty(destDir)) Directory.CreateDirectory(destDir);
            try
            {
                if (File.Exists(body.Dest)) File.Delete(body.Dest);
                ZipFile.CreateFromDirectory(LogDir, body.Dest);
                return Results.Json(new OpenPathResponse(body.Dest), ApiJsonContext.Default.OpenPathResponse);
            }
            catch { return Results.BadRequest(); }
        });

        group.MapGet("/export-all", () =>
        {
            Directory.CreateDirectory(LogDir);
            var zipPath = Path.Combine(Path.GetTempPath(), $"logs-{DateTime.Now:yyyyMMdd-HHmmss}.zip");
            try
            {
                ZipFile.CreateFromDirectory(LogDir, zipPath);
                return Results.File(zipPath, "application/zip", $"logs-{DateTime.Now:yyyyMMdd-HHmmss}.zip");
            }
            catch { return Results.NotFound(); }
        });

        group.MapDelete("/", ([Microsoft.AspNetCore.Mvc.FromQuery] string path) =>
        {
            var resolved = ResolveLogPath(Uri.UnescapeDataString(path));
            if (resolved == null) return Results.NotFound();
            try
            {
                File.Delete(resolved);
                return Results.Ok();
            }
            catch { return Results.BadRequest(); }
        });

        group.MapPost("/open", (OpenPathRequest body, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger("Log");
            var path = body.Path;
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                return Results.NotFound();
            try
            {
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                return Results.Ok();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to open file: {Path}", path);
                return Results.BadRequest();
            }
        });

        group.MapPost("/open-dir", (OpenPathRequest body, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger("Log");
            var path = body.Path;
            if (string.IsNullOrEmpty(path)) return Results.NotFound();
            try
            {
                var dir = File.Exists(path) ? Path.GetDirectoryName(path) : path;
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                    return Results.NotFound();
                Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true });
                return Results.Ok();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to open directory: {Path}", path);
                return Results.BadRequest();
            }
        });
    }
}
