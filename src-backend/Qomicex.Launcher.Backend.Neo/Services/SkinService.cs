using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class SkinService
{
    private readonly HttpClient _http;
    private readonly AccountService _accountService;
    private static byte[]? _defaultSkin;

    // 微软 profile 响应缓存（每次 mc-capes 都打微软 API 太重），30 秒 TTL，按 token 区分账户。
    private readonly Dictionary<string, (DateTime Ts, JsonDocument Doc)> _mcProfileCache = new();
    private readonly SemaphoreSlim _mcProfileLock = new(1, 1);

    public SkinService(IHttpClientFactory httpFactory, AccountService accountService)
    {
        _http = httpFactory.CreateClient("default");
        _accountService = accountService;
    }

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
            var jsonStr = await resp.Content.ReadAsStringAsync();
            var json = JsonDocument.Parse(jsonStr).RootElement;
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
            var decoded = JsonDocument.Parse(Convert.FromBase64String(value)).RootElement;
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

    // ---------- 真实上传 / 重置（对齐移动端 SkinHandler） ----------

    private async Task<string> GetAccountTokenAsync(string uuid)
    {
        var account = await _accountService.GetAccountAsync(uuid);
        if (account == null) throw ApiException.NotFound("account not found", "ACCOUNT_NOT_FOUND");
        if (string.IsNullOrEmpty(account.AccessToken))
            throw new ApiException(401, "TOKEN_EXPIRED", "access token missing, please re-login");
        return account.AccessToken;
    }

    private async Task<string> GetMicrosoftTokenAsync(string uuid)
    {
        var account = await _accountService.GetAccountAsync(uuid);
        if (account == null) throw ApiException.NotFound("account not found", "ACCOUNT_NOT_FOUND");
        if (account.LoginMethod != "Microsoft")
            throw ApiException.BadRequest("not a Microsoft account", "NOT_MICROSOFT");
        if (string.IsNullOrEmpty(account.AccessToken))
            throw new ApiException(401, "TOKEN_EXPIRED", "access token missing, please re-login");
        return account.AccessToken;
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n];

    /// <summary>真实上传到官方 API；成功后清除本地皮肤（texture 重新拉取服务器上的新皮肤）。</summary>
    public async Task UploadSkinAsync(string uuid, string loginMethod, string? serverUrl, byte[] data, bool isSlim)
    {
        switch (loginMethod)
        {
            case "Microsoft":
            {
                var token = await GetMicrosoftTokenAsync(uuid);
                using var form = new MultipartFormDataContent();
                form.Add(new StringContent(isSlim ? "slim" : "classic"), "variant");
                var fileContent = new ByteArrayContent(data);
                fileContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
                form.Add(fileContent, "file", "skin.png");
                var req = new HttpRequestMessage(HttpMethod.Post, "https://api.minecraftservices.com/minecraft/profile/skins");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                req.Content = form;
                using var resp = await _http.SendAsync(req);
                var body = await resp.Content.ReadAsStringAsync();
                if (resp.StatusCode == HttpStatusCode.Unauthorized)
                    throw new ApiException(401, "TOKEN_EXPIRED", "microsoft token expired or invalid, please re-login");
                if (!resp.IsSuccessStatusCode)
                    throw ApiException.BadGateway($"minecraftservices upload {(int)resp.StatusCode}: {Truncate(body, 200)}", "SKIN_UPLOAD_FAILED");
                break;
            }
            case "Yggdrasil":
            case "统一通行证":
            {
                if (string.IsNullOrEmpty(serverUrl))
                    throw ApiException.BadRequest("missing server for Yggdrasil upload");
                var token = await GetAccountTokenAsync(uuid);
                using var form = new MultipartFormDataContent();
                form.Add(new StringContent(isSlim ? "slim" : ""), "model");
                var fileContent = new ByteArrayContent(data);
                fileContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
                form.Add(fileContent, "file", "skin.png");
                var req = new HttpRequestMessage(HttpMethod.Put, $"{serverUrl.TrimEnd('/')}/api/user/profile/{uuid.Replace("-", "")}/skin");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                req.Content = form;
                using var resp = await _http.SendAsync(req);
                var body = await resp.Content.ReadAsStringAsync();
                if (resp.StatusCode == HttpStatusCode.Unauthorized)
                    throw new ApiException(401, "TOKEN_EXPIRED", "yggdrasil token expired or invalid, please re-login");
                if (!resp.IsSuccessStatusCode)
                    throw ApiException.BadGateway($"yggdrasil upload {(int)resp.StatusCode}: {Truncate(body, 200)}", "SKIN_UPLOAD_FAILED");
                break;
            }
            default:
                SaveSkin(uuid, data); // Offline → 仅本地保存
                return;
        }
        DeleteSkin(uuid);
    }

    /// <summary>真实重置为默认皮肤（调用官方删除 API）；成功后清除本地皮肤。</summary>
    public async Task ResetSkinAsync(string uuid, string loginMethod, string? serverUrl)
    {
        switch (loginMethod)
        {
            case "Microsoft":
            {
                var token = await GetMicrosoftTokenAsync(uuid);
                var req = new HttpRequestMessage(HttpMethod.Delete, "https://api.minecraftservices.com/minecraft/profile/skins/active");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using var resp = await _http.SendAsync(req);
                var body = await resp.Content.ReadAsStringAsync();
                if (resp.StatusCode == HttpStatusCode.Unauthorized)
                    throw new ApiException(401, "TOKEN_EXPIRED", "microsoft token expired or invalid, please re-login");
                if (!resp.IsSuccessStatusCode)
                    throw ApiException.BadGateway($"minecraftservices reset {(int)resp.StatusCode}: {Truncate(body, 200)}", "SKIN_RESET_FAILED");
                break;
            }
            case "Yggdrasil":
            case "统一通行证":
            {
                if (string.IsNullOrEmpty(serverUrl))
                    throw ApiException.BadRequest("missing server for Yggdrasil reset");
                var token = await GetAccountTokenAsync(uuid);
                var req = new HttpRequestMessage(HttpMethod.Delete, $"{serverUrl.TrimEnd('/')}/api/user/profile/{uuid.Replace("-", "")}/skin");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using var resp = await _http.SendAsync(req);
                var body = await resp.Content.ReadAsStringAsync();
                if (resp.StatusCode == HttpStatusCode.Unauthorized)
                    throw new ApiException(401, "TOKEN_EXPIRED", "yggdrasil token expired or invalid, please re-login");
                if (!resp.IsSuccessStatusCode)
                    throw ApiException.BadGateway($"yggdrasil reset {(int)resp.StatusCode}: {Truncate(body, 200)}", "SKIN_RESET_FAILED");
                break;
            }
        }
        DeleteSkin(uuid);
    }

    // ---------- 微软披风管理（api.minecraftservices.com，仅 Microsoft 账户） ----------
    //
    //   GET    /skin/mc-capes/{uuid}          → {capes:[{id,state,alias}]}
    //   GET    /skin/mc-cape/{uuid}/{capeId}  → 披风完整 PNG（前端裁剪左上 64×32）
    //   PUT    /skin/mc-capes/{uuid}/{capeId} → 装备（PUT /minecraft/profile/capes/active {capeId}）
    //   DELETE /skin/mc-capes/{uuid}/{capeId} → 卸下（DELETE /minecraft/profile/capes/active）

    private async Task<JsonDocument> McApiGetAsync(string url, string token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var resp = await _http.SendAsync(req);
        var body = await resp.Content.ReadAsStringAsync();
        return McResponseOrThrow(resp.StatusCode, body);
    }

    private async Task<JsonDocument?> McApiSendAsync(HttpMethod method, string url, string token, string? jsonBody = null)
    {
        var req = new HttpRequestMessage(method, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (jsonBody != null)
            req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        using var resp = await _http.SendAsync(req);
        var body = await resp.Content.ReadAsStringAsync();
        if (string.IsNullOrEmpty(body))
        {
            McResponseOrThrow(resp.StatusCode, "{}");
            return null;
        }
        return McResponseOrThrow(resp.StatusCode, body);
    }

    private static JsonDocument McResponseOrThrow(HttpStatusCode code, string body)
    {
        if (code == HttpStatusCode.Unauthorized)
            throw new ApiException(401, "TOKEN_EXPIRED", "microsoft token expired or invalid, please re-login");
        if ((int)code < 200 || (int)code >= 300)
            throw ApiException.BadGateway($"minecraftservices API {(int)code}: {Truncate(body, 200)}", "MC_API_ERROR");
        try { return JsonDocument.Parse(body); }
        catch (JsonException) { throw ApiException.BadGateway("unparseable minecraftservices response", "MC_API_ERROR"); }
    }

    private async Task<JsonDocument> McProfileAsync(string token)
    {
        await _mcProfileLock.WaitAsync();
        try
        {
            if (_mcProfileCache.TryGetValue(token, out var cached) && (DateTime.UtcNow - cached.Ts).TotalSeconds < 30)
                return cached.Doc;
            var doc = await McApiGetAsync("https://api.minecraftservices.com/minecraft/profile", token);
            _mcProfileCache[token] = (DateTime.UtcNow, doc);
            return doc;
        }
        finally { _mcProfileLock.Release(); }
    }

    private void ClearMcProfileCache(string token)
    {
        if (_mcProfileCache.Remove(token, out var cached)) cached.Doc.Dispose();
    }

    public async Task<List<McCape>> GetMcCapesAsync(string uuid)
    {
        var token = await GetMicrosoftTokenAsync(uuid);
        var doc = await McProfileAsync(token);
        if (!doc.RootElement.TryGetProperty("capes", out var capes) || capes.ValueKind != JsonValueKind.Array)
            return new();
        var list = new List<McCape>();
        foreach (var c in capes.EnumerateArray())
        {
            var id = c.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
            if (string.IsNullOrEmpty(id)) continue;
            list.Add(new McCape
            {
                Id = id,
                State = c.TryGetProperty("state", out var st) ? st.GetString() ?? "INACTIVE" : "INACTIVE",
                Alias = c.TryGetProperty("alias", out var al) ? al.GetString() : null,
            });
        }
        return list;
    }

    /// <summary>下载披风完整 PNG。披风不存在返回 null。</summary>
    public async Task<byte[]?> DownloadMcCapeAsync(string uuid, string capeId)
    {
        var token = await GetMicrosoftTokenAsync(uuid);
        var doc = await McProfileAsync(token);
        if (!doc.RootElement.TryGetProperty("capes", out var capes) || capes.ValueKind != JsonValueKind.Array)
            return null;
        string? url = null;
        foreach (var c in capes.EnumerateArray())
        {
            if (c.TryGetProperty("id", out var idEl) && idEl.GetString() == capeId && c.TryGetProperty("url", out var urlEl))
            {
                url = urlEl.GetString();
                break;
            }
        }
        return string.IsNullOrEmpty(url) ? null : await DownloadSkin(url);
    }

    public async Task EquipMcCapeAsync(string uuid, string capeId)
    {
        var token = await GetMicrosoftTokenAsync(uuid);
        await McApiSendAsync(HttpMethod.Put, "https://api.minecraftservices.com/minecraft/profile/capes/active", token, $"{{\"capeId\":\"{capeId}\"}}");
        ClearMcProfileCache(token);
    }

    public async Task UnequipMcCapeAsync(string uuid)
    {
        var token = await GetMicrosoftTokenAsync(uuid);
        await McApiSendAsync(HttpMethod.Delete, "https://api.minecraftservices.com/minecraft/profile/capes/active", token);
        ClearMcProfileCache(token);
    }
}

public class McCape
{
    public string Id { get; set; } = "";
    public string State { get; set; } = "";
    public string? Alias { get; set; }
}

public record McCapeListResponse(List<McCape> Capes);

public class SkinProfile
{
    public string? ProfileId { get; set; }
    public string? ProfileName { get; set; }
    public string SkinUrl { get; set; } = "";
    public string? CapeUrl { get; set; }
    public string Model { get; set; } = "classic";
    public string SkinSource { get; set; } = "remote";
}
