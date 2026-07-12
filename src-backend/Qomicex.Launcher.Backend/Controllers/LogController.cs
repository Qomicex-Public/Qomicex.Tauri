using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/logs")]
public class LogController : ControllerBase
{
    private readonly ILogger<LogController> _logger;
    private static readonly string BackendDir = Path.Combine(AppPaths.BaseDir, "logs");
    private static readonly DateTime ProcessStartTime = Process.GetCurrentProcess().StartTime;

    public LogController(ILogger<LogController> logger)
    {
        _logger = logger;
    }

    [HttpGet]
    public IActionResult ListLogs()
    {
        var entries = new List<LogEntry>();
        if (!Directory.Exists(BackendDir))
            return Ok(entries);

        foreach (var f in Directory.GetFiles(BackendDir, "backend-trace-*.log").OrderByDescending(f => f))
        {
            var fi = new FileInfo(f);
            entries.Add(new LogEntry
            {
                Path = f,
                Name = fi.Name,
                Size = fi.Length,
                LastModified = fi.LastWriteTime.ToString("O"),
                IsCurrentSession = fi.CreationTime >= ProcessStartTime.AddSeconds(-5),
            });
        }

        if (entries.Count > 10)
        {
            foreach (var old in entries.Skip(10))
            {
                try { System.IO.File.Delete(old.Path); }
                catch (Exception ex) { _logger.LogWarning(ex, "Failed to delete old backend log: {Path}", old.Path); }
            }
            entries.RemoveAll(e => !System.IO.File.Exists(e.Path));
        }

        return Ok(entries);
    }

    [HttpGet("preview")]
    public IActionResult Preview([FromQuery] string path)
    {
        if (!System.IO.File.Exists(path))
            return NotFound();

        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var fileSize = fs.Length;
        var readSize = (int)Math.Min(100_000, fileSize);
        if (fileSize > 100_000)
            fs.Seek(-100_000, SeekOrigin.End);
        var buffer = new byte[readSize];
        var bytesRead = fs.Read(buffer, 0, buffer.Length);
        var content = Encoding.UTF8.GetString(buffer, 0, bytesRead);

        return Ok(new { content, totalSize = fileSize, previewSize = readSize });
    }

    [HttpGet("export")]
    public IActionResult Export([FromQuery] string path)
    {
        string decoded;
        try { decoded = Encoding.UTF8.GetString(Convert.FromBase64String(path)); }
        catch { return BadRequest(); }

        if (!System.IO.File.Exists(decoded))
            return NotFound();

        var fileName = Path.GetFileName(decoded) + ".gz";
        var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true))
        using (var fs = System.IO.File.OpenRead(decoded))
            fs.CopyTo(gz);
        ms.Position = 0;

        return File(ms, "application/gzip", fileName);
    }

    [HttpPost("export-to")]
    public IActionResult ExportTo([FromBody] JsonElement body)
    {
        var path = body.GetProperty("path").GetString();
        var dest = body.GetProperty("dest").GetString();
        if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(dest) || !System.IO.File.Exists(path))
            return NotFound();

        try
        {
            var destDir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(destDir)) Directory.CreateDirectory(destDir);
            using var source = System.IO.File.OpenRead(path);
            using var gz = new GZipStream(System.IO.File.Create(dest), CompressionLevel.Fastest);
            source.CopyTo(gz);
            return Ok(new { path = dest });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to export log to: {Dest}", dest);
            return BadRequest(new { message = "导出失败" });
        }
    }

    [HttpPost("export-all-to")]
    public IActionResult ExportAllTo([FromBody] JsonElement body)
    {
        var dest = body.GetProperty("dest").GetString();
        if (string.IsNullOrEmpty(dest)) return BadRequest();

        try
        {
            var destDir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(destDir)) Directory.CreateDirectory(destDir);

            using var ms = System.IO.File.Create(dest);
            using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            {
                if (Directory.Exists(BackendDir))
                {
                    foreach (var f in Directory.GetFiles(BackendDir, "backend-trace-*.log"))
                    {
                        try
                        {
                            var entry = archive.CreateEntry(Path.GetFileName(f));
                            using var entryStream = entry.Open();
                            using var fileStream = System.IO.File.OpenRead(f);
                            fileStream.CopyTo(entryStream);
                        }
                        catch (Exception ex) { _logger.LogWarning(ex, "Failed to add log to export zip: {Path}", f); }
                    }
                }
            }
            return Ok(new { path = dest });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to export all logs to: {Dest}", dest);
            return BadRequest(new { message = "导出失败" });
        }
    }

    [HttpGet("export-all")]
    public IActionResult ExportAll()
    {
        var fileName = $"logs-{DateTime.Now:yyyyMMdd-HHmmss}.zip";
        var ms = new MemoryStream();

        using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            if (Directory.Exists(BackendDir))
            {
                foreach (var f in Directory.GetFiles(BackendDir, "backend-trace-*.log"))
                {
                    try
                    {
                        var entry = archive.CreateEntry(Path.GetFileName(f));
                        using var entryStream = entry.Open();
                        using var fileStream = System.IO.File.OpenRead(f);
                        fileStream.CopyTo(entryStream);
                    }
                    catch (Exception ex) { _logger.LogWarning(ex, "Failed to add log to export zip: {Path}", f); }
                }
            }
        }

        ms.Position = 0;
        return File(ms, "application/zip", fileName);
    }

    [HttpDelete]
    public IActionResult Delete([FromQuery] string path)
    {
        if (!System.IO.File.Exists(path))
            return NotFound();
        try
        {
            System.IO.File.Delete(path);
            return NoContent();
        }
        catch
        {
            return BadRequest(new { message = "无法删除文件" });
        }
    }

    [HttpPost("open")]
    public IActionResult Open([FromBody] JsonElement body)
    {
        var path = body.GetProperty("path").GetString();
        if (string.IsNullOrEmpty(path) || !System.IO.File.Exists(path))
            return NotFound();
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to open file: {Path}", path);
            return BadRequest(new { message = "无法打开文件" });
        }
    }

    [HttpPost("open-dir")]
    public IActionResult OpenDir([FromBody] JsonElement body)
    {
        var path = body.GetProperty("path").GetString();
        if (string.IsNullOrEmpty(path)) return NotFound();
        try
        {
            var dir = System.IO.File.Exists(path)
                ? Path.GetDirectoryName(path)
                : path;
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                return NotFound();
            Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true });
            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to open directory: {Path}", path);
            return BadRequest(new { message = "无法打开目录" });
        }
    }
}
