using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class SystemEndpoints
{
    private static readonly string SettingsPath = Path.Combine(
        AppPaths.BaseDir, "QML", "settings.json");
    private static readonly string BackgroundsDir = Path.Combine(
        AppPaths.BaseDir, "QML", "backgrounds");

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
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".minecraft");
        return new SettingsResponse(GameDir: defaultDir);
    }

    public static void MapSystemEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api");

        group.MapGet("/health", () =>
        {
            return Results.Json(new HealthResponse("OK", DateTime.UtcNow),
                ApiJsonContext.Default.HealthResponse);
        });

        group.MapGet("/diagnostics/health", () =>
        {
            return Results.Json(new HealthResponse("OK", DateTime.UtcNow),
                ApiJsonContext.Default.HealthResponse);
        });

        group.MapGet("/system/info", () => SysInfo());
        group.MapGet("/systeminfo", () => SysInfo());

        static IResult SysInfo() => Results.Json(new SystemInfoResponse(
            Os: RuntimeInformation.OSDescription,
            Architecture: RuntimeInformation.ProcessArchitecture.ToString(),
            Runtime: RuntimeInformation.FrameworkDescription,
            ProcessorCount: Environment.ProcessorCount,
            WorkingDirectory: Environment.CurrentDirectory
        ), ApiJsonContext.Default.SystemInfoResponse);

        group.MapGet("/settings", () =>
        {
            return Results.Json(LoadSettings(), ApiJsonContext.Default.SettingsResponse);
        });

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
            try
            {
                Process.Start(new ProcessStartInfo(BackgroundsDir) { UseShellExecute = true });
            }
            catch { }
            return Results.Ok();
        });
    }
}
