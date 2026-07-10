using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Core.Modules.Helpers.MultiPlatforms;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/instance/{id}/export-diagnostics")]
public class DiagnosticExportController : ControllerBase
{
    private readonly IInstanceRepository _repository;
    private readonly LaunchService _launchService;
    private readonly TraceDumpService _traceDump;

    private static readonly string GitHash = typeof(Program).Assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "GitHash")
        ?.Value ?? "unknown";

    public DiagnosticExportController(IInstanceRepository repository, LaunchService launchService, TraceDumpService traceDump)
    {
        _repository = repository;
        _launchService = launchService;
        _traceDump = traceDump;
    }

    [HttpPost]
    public IActionResult Export(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        var progress = _launchService.Get(id);
        var safeName = SanitizeFileName(instance.Name);
        var fileName = $"diagnostics-{safeName}-{DateTime.Now:yyyyMMdd-HHmmss}.zip";

        using var ms = new MemoryStream();
        using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            var sysInfo = SystemInfoHelper.GetSystemInfo();
            AddJsonEntry(archive, "system-info.json", new
            {
                osName = sysInfo.OSName,
                os = sysInfo.OS,
                osVersion = sysInfo.OSVersion,
                architecture = sysInfo.Architecture,
                osVersionId = sysInfo.OSVersionID,
                osDisplayName = sysInfo.OSDisplayName,
                gitCommit = GitHash,
                memory = SystemMemoryHelper.GetTotalPhysicalMemory(),
                availableMemory = SystemMemoryHelper.GetAvailablePhysicalMemory() / (1024.0 * 1024.0)
            });

            AddJsonEntry(archive, "launcher-version.json", new
            {
                version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown",
                gitCommit = GitHash,
                instanceGameVersion = instance.GameVersion,
                instanceLoader = instance.Loader,
                instanceLoaderVersion = instance.LoaderVersion,
                timestamp = DateTime.UtcNow.ToString("O")
            });

            if (progress != null && (progress.Stage == "failed" || progress.Stage == "crashed"))
            {
                AddJsonEntry(archive, "launch-error.json", new
                {
                    stage = progress.Stage,
                    error = progress.Error,
                    message = progress.Message,
                    exitCode = progress.ExitCode,
                    crashReport = progress.CrashReport,
                    hasArguments = progress.Arguments != null
                });

                if (progress.Arguments != null)
                {
                    var argsEntry = archive.CreateEntry("launch-args.txt");
                    using (var writer = new StreamWriter(argsEntry.Open(), Encoding.UTF8))
                        writer.Write(progress.Arguments);
                }
            }

            var logsDir = Path.Combine(instance.GameDir, "logs");
            AddFileIfExists(archive, "launcher-stderr.log", Path.Combine(logsDir, "launcher-latest.log"));
            AddFileIfExists(archive, "launcher-stdout.log", Path.Combine(logsDir, "launcher-stdout.log"));

            AddCrashReports(archive, instance);
            AddHsErrCrashLogs(archive, instance);

            var tracePath = _traceDump.Dump("diagnostic-export");
            if (System.IO.File.Exists(tracePath))
                AddFileIfExists(archive, "backend-trace.log", tracePath);
        }

        ms.Position = 0;
        return new FileContentResult(ms.ToArray(), "application/zip") { FileDownloadName = fileName };
    }

    private static void AddJsonEntry(ZipArchive archive, string name, object data)
    {
        var entry = archive.CreateEntry(name);
        using var writer = new StreamWriter(entry.Open(), Encoding.UTF8);
        writer.Write(JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static void AddFileIfExists(ZipArchive archive, string entryName, string filePath)
    {
        if (!System.IO.File.Exists(filePath)) return;
        var entry = archive.CreateEntry(entryName);
        using var entryStream = entry.Open();
        using var fileStream = System.IO.File.OpenRead(filePath);
        fileStream.CopyTo(entryStream);
    }

    private static void AddCrashReports(ZipArchive archive, GameInstance instance)
    {
        var crashDir = Path.Combine(instance.GameDir, "versions", instance.Name, "crash-reports");
        if (!Directory.Exists(crashDir))
            crashDir = Path.Combine(instance.GameDir, "crash-reports");
        if (!Directory.Exists(crashDir)) return;

        var latest = Directory.GetFiles(crashDir, "*.txt")
            .OrderByDescending(f => System.IO.File.GetLastWriteTime(f))
            .FirstOrDefault();
        if (latest == null) return;

        var content = System.IO.File.ReadAllText(latest);
        if (content.Length > 100_000) content = content[..100_000] + "\n... (truncated)";
        var entry = archive.CreateEntry("crash-report.txt");
        using var writer = new StreamWriter(entry.Open(), Encoding.UTF8);
        writer.Write(content);
    }

    private static void AddHsErrCrashLogs(ZipArchive archive, GameInstance instance)
    {
        for (var d = instance.GameDir; d != null && Directory.Exists(d); d = Path.GetDirectoryName(d))
        {
            var files = Directory.GetFiles(d, "hs_err_pid*.log")
                .OrderByDescending(f => System.IO.File.GetLastWriteTime(f))
                .Take(1)
                .ToArray();
            if (files.Length == 0) continue;

            var content = System.IO.File.ReadAllText(files[0]);
            if (content.Length > 100_000) content = content[..100_000] + "\n... (truncated)";
            var entry = archive.CreateEntry("hs_err.log");
            using var writer = new StreamWriter(entry.Open(), Encoding.UTF8);
            writer.Write(content);
            break;
        }
    }

    private static string SanitizeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (var c in name)
            sb.Append(invalid.Contains(c) ? '_' : c);
        return sb.ToString();
    }
}
