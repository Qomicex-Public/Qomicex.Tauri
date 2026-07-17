using System.Runtime.InteropServices;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class SystemEndpoints
{
    private static readonly string SettingsPath = Path.Combine(
        AppPaths.BaseDir, "data", "settings.json");

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
    }
}
