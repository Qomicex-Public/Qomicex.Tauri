using System.Text.Json;

namespace Qomicex.Launcher.Backend;

public static class ModApiMirror
{
    private static string SettingsPath => Path.Combine(AppPaths.BaseDir, "QML", "settings.json");

    private static bool UseMcim()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return false;
            var json = File.ReadAllText(SettingsPath);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("modMirror", out var p) && p.ValueKind == JsonValueKind.Number && p.GetInt32() == 1;
        }
        catch
        {
            return false;
        }
    }

    public static string MirrorModrinth(string url)
    {
        if (!UseMcim()) return url;
        return url.Replace("https://api.modrinth.com/", "https://mod.mcimirror.top/modrinth/");
    }

    public static string MirrorCurseForge(string relativeOrAbsolute)
    {
        var isRelative = relativeOrAbsolute.StartsWith('/');
        if (!UseMcim())
            return isRelative ? $"https://api.curseforge.com{relativeOrAbsolute}" : relativeOrAbsolute;

        var path = isRelative ? relativeOrAbsolute : relativeOrAbsolute.Replace("https://api.curseforge.com", "");
        return $"https://mod.mcimirror.top/curseforge{path}";
    }

    public static string MirrorCurseForgeUrl(string url)
    {
        if (!UseMcim()) return url;
        return url.Replace("https://api.curseforge.com/", "https://mod.mcimirror.top/curseforge/");
    }
}
