using System.Net.Http.Headers;
using System.Text.Json;

namespace Qomicex.Launcher.Backend;

public static class ModApiMirror
{
    private static string SettingsPath => Path.Combine(AppPaths.BaseDir, "QML", "settings.json");

    public static bool IsEnabled
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return false;
                var json = File.ReadAllText(SettingsPath);
                using var doc = JsonDocument.Parse(json);
                return doc.RootElement.TryGetProperty("modMirror", out var p) && p.ValueKind == JsonValueKind.Number && p.GetInt32() == 1;
            }
            catch { return false; }
        }
    }

    public static string MirrorModrinth(string url)
    {
        if (!IsEnabled) return url;
        return url.Replace("https://api.modrinth.com/", "https://mod.mcimirror.top/modrinth/");
    }

    /// <summary> 获取镜像 URL 和官方 URL，镜像启用时优先尝试镜像 </summary>
    public static string[] MirrorCurseForgeUrls(string relativeOrAbsolute)
    {
        var isRelative = relativeOrAbsolute.StartsWith('/');
        var official = isRelative ? $"https://api.curseforge.com{relativeOrAbsolute}" : relativeOrAbsolute;
        if (!IsEnabled) return [official];

        var path = isRelative ? relativeOrAbsolute : relativeOrAbsolute.Replace("https://api.curseforge.com", "");
        var mirror = $"https://mod.mcimirror.top/curseforge{path}";
        return [mirror, official];
    }

    /// <summary> 获取镜像 URL 和官方 URL，镜像启用时优先尝试镜像 </summary>
    public static string[] MirrorModrinthUrls(string url)
    {
        if (!IsEnabled) return [url];
        return [url.Replace("https://api.modrinth.com/", "https://mod.mcimirror.top/modrinth/"), url];
    }

    public static string MirrorCurseForge(string relativeOrAbsolute)
    {
        var isRelative = relativeOrAbsolute.StartsWith('/');
        if (!IsEnabled)
            return isRelative ? $"https://api.curseforge.com{relativeOrAbsolute}" : relativeOrAbsolute;

        var path = isRelative ? relativeOrAbsolute : relativeOrAbsolute.Replace("https://api.curseforge.com", "");
        return $"https://mod.mcimirror.top/curseforge{path}";
    }

    public static string MirrorCurseForgeUrl(string url)
    {
        if (!IsEnabled) return url;
        return url.Replace("https://api.curseforge.com/", "https://mod.mcimirror.top/curseforge/");
    }
}

public static class HttpClientMirrorExtensions
{
    /// <summary> 依次尝试多个 URL，第一个成功的返回；全部失败则抛出最后一条异常 </summary>
    public static async Task<HttpResponseMessage> SendWithFallbackAsync(this HttpClient client, HttpMethod method, string[] urls, Action<HttpRequestMessage>? configure = null)
    {
        Exception? lastEx = null;
        foreach (var url in urls)
        {
            try
            {
                var req = new HttpRequestMessage(method, url);
                configure?.Invoke(req);
                var resp = await client.SendAsync(req);
                if (resp.IsSuccessStatusCode || resp.StatusCode != System.Net.HttpStatusCode.NotFound)
                    return resp;
                // 404 时继续尝试下一个 URL
                lastEx = null;
            }
            catch (Exception ex)
            {
                lastEx = ex;
            }
        }
        if (lastEx != null) throw lastEx;
        // 所有 URL 都返回 404
        return new HttpResponseMessage(System.Net.HttpStatusCode.NotFound);
    }
}
