using System.Reflection;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class SkinService
{
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static byte[]? _defaultSkin;

    public SkinService(IHttpClientFactory httpFactory) { _http = httpFactory.CreateClient(); }

    private static string SkinDir => Path.Combine(AppPaths.BaseDir, "QML", "skins");
    private static string SkinPath(string uuid) => Path.Combine(SkinDir, $"{uuid.Replace("-", "")}.png");

    private static byte[] GetDefaultSkin()
    {
        if (_defaultSkin != null) return _defaultSkin;
        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("Qomicex.Launcher.Backend.Neo.Resources.Alex.png");
        if (stream == null) throw new InvalidOperationException("Embedded Alex.png not found");
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return _defaultSkin = ms.ToArray();
    }

    public byte[]? GetLocalSkin(string uuid)
    {
        var path = SkinPath(uuid);
        return File.Exists(path) ? File.ReadAllBytes(path) : null;
    }

    public void SaveSkin(string uuid, byte[] data)
    {
        Directory.CreateDirectory(SkinDir);
        File.WriteAllBytes(SkinPath(uuid), data);
    }

    public void DeleteSkin(string uuid)
    {
        var path = SkinPath(uuid);
        if (File.Exists(path)) File.Delete(path);
    }

    public async Task<SkinProfile?> FetchProfile(string uuid, string loginMethod, string? serverUrl)
    {
        return loginMethod switch
        {
            "Microsoft" => await FetchMojangProfile(uuid),
            "Offline" => new SkinProfile { ProfileId = uuid, Model = "slim" },
            "Yggdrasil" => await FetchYggdrasilProfile(uuid, serverUrl),
            "统一通行证" => await FetchYggdrasilProfile(uuid, serverUrl),
            _ => null,
        };
    }

    private async Task<SkinProfile?> FetchMojangProfile(string uuid)
    {
        var url = $"https://sessionserver.mojang.com/session/minecraft/profile/{uuid.Replace("-", "")}";
        return await FetchProfileFromUrl(url);
    }

    private async Task<SkinProfile?> FetchYggdrasilProfile(string uuid, string? serverUrl)
    {
        if (string.IsNullOrEmpty(serverUrl)) return null;
        var url = $"{serverUrl.TrimEnd('/')}/sessionserver/session/minecraft/profile/{uuid.Replace("-", "")}";
        return await FetchProfileFromUrl(url);
    }

    private async Task<SkinProfile?> FetchProfileFromUrl(string url)
    {
        try
        {
            var resp = await _http.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return null;
            var json = await resp.Content.ReadFromJsonAsync<JsonElement>(JsonOptions);
            return ParseProfile(json);
        }
        catch { return null; }
    }

    private static SkinProfile? ParseProfile(JsonElement json)
    {
        if (!json.TryGetProperty("properties", out var props)) return null;
        foreach (var prop in props.EnumerateArray())
        {
            if (prop.GetProperty("name").GetString() != "textures") continue;
            var value = prop.GetProperty("value").GetString();
            if (value == null) continue;
            var decoded = JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(value));
            var profile = new SkinProfile();
            if (decoded.TryGetProperty("profileId", out var pid)) profile.ProfileId = pid.GetString();
            if (decoded.TryGetProperty("profileName", out var pn)) profile.ProfileName = pn.GetString();
            if (decoded.TryGetProperty("textures", out var textures))
            {
                if (textures.TryGetProperty("SKIN", out var skin))
                {
                    profile.SkinUrl = skin.GetProperty("url").GetString() ?? "";
                    if (skin.TryGetProperty("metadata", out var meta) && meta.TryGetProperty("model", out var model))
                        profile.Model = model.GetString() == "slim" ? "slim" : "classic";
                }
                if (textures.TryGetProperty("CAPE", out var cape))
                    profile.CapeUrl = cape.GetProperty("url").GetString();
            }
            return profile;
        }
        return null;
    }

    public async Task<byte[]?> DownloadSkin(string url)
    {
        try
        {
            var resp = await _http.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadAsByteArrayAsync();
        }
        catch { return null; }
    }

    public static byte[] GetDefaultSkinBytes() => GetDefaultSkin();
}

public class SkinProfile
{
    public string? ProfileId { get; set; }
    public string? ProfileName { get; set; }
    public string SkinUrl { get; set; } = "";
    public string? CapeUrl { get; set; }
    public string Model { get; set; } = "classic";
    public string SkinSource { get; set; } = "remote";
}
