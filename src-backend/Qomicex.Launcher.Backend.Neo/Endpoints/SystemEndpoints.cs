using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Diagnostics;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class SystemEndpoints
{
    private static readonly string SettingsPath = Path.Combine(AppPaths.BaseDir, "QML", "settings.json");
    private static readonly string BackgroundsDir = Path.Combine(AppPaths.BaseDir, "QML", "backgrounds");
    private static readonly string GitHash = typeof(Program).Assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "GitHash")?.Value ?? "unknown";

    public static SettingsResponse LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var json = File.ReadAllText(SettingsPath);
                return JsonSerializer.Deserialize(json, ApiJsonContext.Default.SettingsResponse)
                    ?? DefaultSettings();
            }
        }
        catch { }
        return DefaultSettings();
    }

    private static void SaveSettings(SettingsResponse settings)
    {
        var dir = Path.GetDirectoryName(SettingsPath)!;
        Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(settings, ApiJsonContext.Default.SettingsResponse);
        File.WriteAllText(SettingsPath, json);
    }

    private static SettingsResponse DefaultSettings()
    {
        var defaultDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".minecraft");
        return new SettingsResponse(GameDir: defaultDir);
    }

    public static void MapSystemEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api");

        group.MapGet("/health", () =>
            Results.Json(new HealthResponse("OK", DateTime.UtcNow), ApiJsonContext.Default.HealthResponse));

        group.MapGet("/diagnostics/health", () =>
            Results.Json(new HealthResponse("OK", DateTime.UtcNow), ApiJsonContext.Default.HealthResponse));

        group.MapGet("/system/info", () => SysInfo());
        group.MapGet("/systeminfo", () => SysInfo());

        static IResult SysInfo()
        {
            var osName = GetOsName();
            var osDescription = RuntimeInformation.OSDescription;
            return Results.Json(new SystemInfoResponse(
                Os: osName,
                Architecture: RuntimeInformation.ProcessArchitecture.ToString(),
                OsName: osDescription,
                OsVersion: Environment.OSVersion.VersionString,
                OsVersionId: GetOsVersionId(osName),
                OsDisplayName: GetOsDisplayName(osName, osDescription),
                GitCommit: GitHash,
                Memory: SystemMemoryHelper.GetTotalPhysicalMemory(),
                AvailableMemory: SystemMemoryHelper.GetAvailablePhysicalMemory()
            ), ApiJsonContext.Default.SystemInfoResponse);
        }

        group.MapGet("/diagnostics/trace", (TraceBufferStore store) =>
            Results.Json(new List<string>(store.Snapshot()), ApiJsonContext.Default.ListString));

        group.MapPost("/diagnostics/dump", (TraceDumpService dumpService) =>
        {
            var path = dumpService.Dump("manual");
            return Results.Json(new OpenPathResponse(path), ApiJsonContext.Default.OpenPathResponse);
        });

        group.MapGet("/settings", () =>
            Results.Json(LoadSettings(), ApiJsonContext.Default.SettingsResponse));

        group.MapPut("/settings", (SettingsResponse body) =>
        {
            SaveSettings(body);
            return Results.NoContent();
        });

        group.MapPost("/settings/open-folder", (OpenPathRequest body) =>
        {
            var path = body.Path;
            if (string.IsNullOrEmpty(path)) return Results.BadRequest();
            if (!Path.IsPathRooted(path))
                path = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), path));
            try
            {
                Directory.CreateDirectory(path);
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true, Verb = "open" });
            }
            catch { }
            return Results.Ok();
        });

        group.MapPost("/settings/open-backgrounds", () =>
        {
            Directory.CreateDirectory(BackgroundsDir);
            try { Process.Start(new ProcessStartInfo(BackgroundsDir) { UseShellExecute = true }); }
            catch { }
            return Results.Ok();
        });

        group.MapGet("/settings/backgrounds", () =>
        {
            Directory.CreateDirectory(BackgroundsDir);
            var files = Directory.EnumerateFiles(BackgroundsDir, "*", SearchOption.TopDirectoryOnly)
                .Select(f => Path.GetFileName(f)!)
                .Where(f => !string.IsNullOrEmpty(f))
                .OrderBy(f => f)
                .ToList();
            return Results.Json(files, ApiJsonContext.Default.ListString);
        });

        group.MapGet("/settings/backgrounds/{name}", (string name) =>
        {
            var path = Path.Combine(BackgroundsDir, name);
            if (!File.Exists(path))
                throw ApiException.NotFound("BACKGROUND_NOT_FOUND", "Background image not found");
            return Results.File(path, "image/png");
        });

        group.MapGet("/settings/download-sources/ping", () =>
            Results.Json(new List<DownloadSourcePing>(), ApiJsonContext.Default.ListDownloadSourcePing));

        group.MapGet("/settings/mod-sources/ping", () =>
            Results.Json(new List<ModSourcePing>(), ApiJsonContext.Default.ListModSourcePing));
    }

    private static string GetOsName()
    {
        if (OperatingSystem.IsWindows()) return "windows";
        if (OperatingSystem.IsLinux()) return "linux";
        if (OperatingSystem.IsMacOS()) return "osx";
        return "unknown";
    }

    private static string GetOsVersionId(string osName)
    {
        try
        {
            if (osName == "windows")
                return Environment.OSVersion.Version.Major.ToString();
            var parts = RuntimeInformation.OSDescription.Split(' ');
            if (parts.Length > 1 && int.TryParse(parts[1].Split('.')[0], out var major))
                return major.ToString();
            return "unknown";
        }
        catch { return "unknown"; }
    }

    private static string GetOsDisplayName(string osName, string osDescription)
    {
        try
        {
            if (osName == "windows")
            {
                var v = Environment.OSVersion.Version;
                return ResolveWindowsName(v.Major, v.Minor, v.Build);
            }
            if (osName == "linux") return ResolveLinuxDistro(osDescription);
        }
        catch { }
        return osDescription;
    }

    private static string ResolveWindowsName(int major, int minor, int build)
    {
        if (major == 10 && minor == 0)
        {
            if (build >= 26100) return "Windows 11 24H2+";
            if (build >= 22631) return "Windows 11 23H2";
            if (build >= 22621) return "Windows 11 22H2";
            if (build >= 22000) return "Windows 11 21H2";
            if (build >= 19045) return "Windows 10 22H2";
            if (build >= 19044) return "Windows 10 21H2";
            if (build >= 19043) return "Windows 10 21H1";
            if (build >= 19042) return "Windows 10 20H2";
            if (build >= 19041) return "Windows 10 2004";
            if (build >= 18363) return "Windows 10 1909";
            if (build >= 18362) return "Windows 10 1903";
            if (build >= 17763) return "Windows 10 1809";
            if (build >= 17134) return "Windows 10 1803";
            if (build >= 16299) return "Windows 10 1709";
            if (build >= 15063) return "Windows 10 1703";
            if (build >= 10586) return "Windows 10 1511";
            if (build >= 10240) return "Windows 10 1507";
        }
        if (major == 6 && minor == 3) return "Windows 8.1";
        if (major == 6 && minor == 2) return "Windows 8";
        if (major == 6 && minor == 1) return "Windows 7";
        if (major == 6 && minor == 0) return "Windows Vista";
        if (major == 5 && minor == 2) return "Windows XP x64 / Server 2003";
        if (major == 5 && minor == 1) return "Windows XP";
        return $"Windows NT {major}.{minor}.{build}";
    }

    private static string ResolveLinuxDistro(string osDescription)
    {
        try
        {
            if (File.Exists("/etc/os-release"))
            {
                foreach (var line in File.ReadAllLines("/etc/os-release"))
                {
                    if (line.StartsWith("PRETTY_NAME="))
                    {
                        var val = line["PRETTY_NAME=".Length..].Trim('"', '\'');
                        if (!string.IsNullOrEmpty(val)) return val;
                    }
                }
            }
            else if (File.Exists("/usr/lib/os-release"))
            {
                foreach (var line in File.ReadAllLines("/usr/lib/os-release"))
                {
                    if (line.StartsWith("PRETTY_NAME="))
                    {
                        var val = line["PRETTY_NAME=".Length..].Trim('"', '\'');
                        if (!string.IsNullOrEmpty(val)) return val;
                    }
                }
            }
        }
        catch { }
        var parts = osDescription.Split(' ');
        return parts.Length > 1 ? string.Join(" ", parts[1..]) : osDescription;
    }
}
