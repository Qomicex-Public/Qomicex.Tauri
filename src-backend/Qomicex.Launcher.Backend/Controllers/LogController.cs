using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/logs")]
public class LogController : ControllerBase
{
    private readonly IInstanceRepository _repository;
    private static readonly DateTime ProcessStartTime = Process.GetCurrentProcess().StartTime;

    public LogController(IInstanceRepository repository)
    {
        _repository = repository;
    }

    [HttpGet]
    public IActionResult ListLogs()
    {
        var entries = new List<LogEntry>();

        var backendDir = Path.Combine(AppPaths.BaseDir, "logs");
        if (Directory.Exists(backendDir))
        {
            foreach (var f in Directory.GetFiles(backendDir, "*.log"))
            {
                var fi = new FileInfo(f);
                entries.Add(new LogEntry
                {
                    Path = f,
                    Name = Path.GetRelativePath(AppPaths.BaseDir, f),
                    Size = fi.Length,
                    LastModified = fi.LastWriteTime.ToString("O"),
                    IsCurrentSession = fi.CreationTime >= ProcessStartTime.AddSeconds(-5),
                });
            }
        }

        var instances = _repository.GetAll();
        foreach (var inst in instances)
        {
            var logDir = Path.Combine(inst.GameDir, "logs");
            if (!Directory.Exists(logDir)) continue;
            foreach (var f in Directory.GetFiles(logDir, "*.log")
                         .Concat(Directory.GetFiles(logDir, "*.log.gz")))
            {
                var fi = new FileInfo(f);
                entries.Add(new LogEntry
                {
                    Path = f,
                    Name = $"[{inst.Name}] {fi.Name}",
                    Size = fi.Length,
                    LastModified = fi.LastWriteTime.ToString("O"),
                    IsCurrentSession = false,
                });
            }
        }

        // cleanup: backend trace logs > 10, keep newest
        var backendLogs = entries
            .Where(e => e.Path.StartsWith(backendDir, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(e => e.LastModified)
            .ToList();
        if (backendLogs.Count > 10)
        {
            foreach (var old in backendLogs.Skip(10))
            {
                try { System.IO.File.Delete(old.Path); } catch { }
            }
            entries.RemoveAll(e => !System.IO.File.Exists(e.Path));
        }

        entries = entries
            .OrderByDescending(e => e.LastModified)
            .ToList();

        return Ok(entries);
    }

    [HttpGet("preview")]
    public IActionResult Preview([FromQuery] string path)
    {
        if (!System.IO.File.Exists(path))
            return NotFound();

        long fileSize = new FileInfo(path).Length;
        int readSize = (int)Math.Min(100_000, fileSize);

        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
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
        if (!System.IO.File.Exists(path))
            return NotFound();

        var fileName = Path.GetFileName(path) + ".gz";
        var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true))
        using (var fs = System.IO.File.OpenRead(path))
            fs.CopyTo(gz);
        ms.Position = 0;

        return File(ms, "application/gzip", fileName);
    }

    [HttpGet("export-all")]
    public IActionResult ExportAll()
    {
        var entries = CollectAllLogFiles();
        var fileName = $"logs-{DateTime.Now:yyyyMMdd-HHmmss}.zip";
        var ms = new MemoryStream();

        using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (filePath, entryName) in entries)
            {
                try
                {
                    var entry = archive.CreateEntry(entryName);
                    using var entryStream = entry.Open();
                    using var fileStream = System.IO.File.OpenRead(filePath);
                    fileStream.CopyTo(entryStream);
                } catch { }
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

    private List<(string filePath, string entryName)> CollectAllLogFiles()
    {
        var result = new List<(string, string)>();

        var backendDir = Path.Combine(AppPaths.BaseDir, "logs");
        if (Directory.Exists(backendDir))
        {
            foreach (var f in Directory.GetFiles(backendDir, "*.log"))
                result.Add((f, "backend/" + Path.GetFileName(f)));
        }

        var instances = _repository.GetAll();
        foreach (var inst in instances)
        {
            var logDir = Path.Combine(inst.GameDir, "logs");
            if (!Directory.Exists(logDir)) continue;
            foreach (var f in Directory.GetFiles(logDir, "*.log")
                         .Concat(Directory.GetFiles(logDir, "*.log.gz")))
                result.Add((f, $"{inst.Name}/{Path.GetFileName(f)}"));
        }

        return result;
    }
}

public class LogEntry
{
    public string Path { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public long Size { get; set; }
    public string LastModified { get; set; } = string.Empty;
    public bool IsCurrentSession { get; set; }
}
