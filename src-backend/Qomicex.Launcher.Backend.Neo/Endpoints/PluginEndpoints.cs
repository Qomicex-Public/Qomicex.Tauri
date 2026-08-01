using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class PluginEndpoints
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> SettingsLocks = new();
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> CacheLocks = new();

    private static async Task<JsonObject> ReadSettingsAsync(string settingsFile)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (!File.Exists(settingsFile)) return new JsonObject();
                var existing = await File.ReadAllTextAsync(settingsFile);
                return JsonNode.Parse(existing) as JsonObject ?? new JsonObject();
            }
            catch (IOException) when (attempt < 2)
            {
                await Task.Delay(50 * (attempt + 1));
            }
        }
    }

    private static async Task WriteSettingsAsync(string settingsFile, string json)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await File.WriteAllTextAsync(settingsFile, json);
                return;
            }
            catch (IOException) when (attempt < 2)
            {
                await Task.Delay(50 * (attempt + 1));
            }
        }
    }

    private static async Task<JsonObject> ReadCacheAsync(string cacheFile)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (!File.Exists(cacheFile)) return new JsonObject();
                var existing = await File.ReadAllTextAsync(cacheFile);
                return JsonNode.Parse(existing) as JsonObject ?? new JsonObject();
            }
            catch (IOException) when (attempt < 2)
            {
                await Task.Delay(50 * (attempt + 1));
            }
        }
    }

    private static async Task WriteCacheAsync(string cacheFile, JsonObject cache)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await File.WriteAllTextAsync(cacheFile, cache.ToJsonString());
                return;
            }
            catch (IOException) when (attempt < 2)
            {
                await Task.Delay(50 * (attempt + 1));
            }
        }
    }

    public static void MapPluginEndpoints(this WebApplication app)
    {
        var plugins = app.MapGroup("/api/plugins");

        plugins.MapGet("/", (PluginStore store) =>
        {
            return Results.Ok(store.ListPlugins());
        });

        plugins.MapGet("/{id}", (string id, PluginStore store) =>
        {
            var plugin = store.GetPlugin(id);
            return plugin != null ? Results.Ok(plugin) : Results.NotFound();
        });

        plugins.MapPost("/rescan", (PluginStore store) =>
        {
            store.InvalidateCache();
            return Results.Ok(new RescanResponse { Scanned = store.ListPlugins().Count });
        });

        plugins.MapPost("/install", (PluginStore store, InstallRequest req) =>
        {
            var plugin = store.InstallPlugin(req.SourceDir);
            return plugin != null ? Results.Ok(plugin) : Results.BadRequest("Invalid plugin package");
        });

        plugins.MapDelete("/{id}", (string id, PluginStore store) =>
        {
            store.UninstallPlugin(id);
            return Results.NoContent();
        });

        plugins.MapPost("/upload", async (HttpRequest request, PluginPackageService packageService, PluginStore store) =>
        {
            if (!request.HasFormContentType)
                return Results.BadRequest("Expected multipart form");

            var file = request.Form.Files.GetFile("plugin");
            if (file == null)
                return Results.BadRequest("No plugin file uploaded");

            using var stream = file.OpenReadStream();
            var plugin = packageService.InstallFromPackage(stream);
            if (plugin == null)
                return Results.BadRequest("Invalid plugin package");

            store.InvalidateCache();
            return Results.Ok(plugin);
        });

        plugins.MapPut("/{id}/state", (string id, PluginStore store, SetPluginStateRequest req) =>
        {
            var plugin = store.GetPlugin(id);
            if (plugin == null) return Results.NotFound();

            store.SetPluginState(id, req.State);
            plugin.State = req.State;
            return Results.Ok(plugin);
        });

        plugins.MapGet("/{id}/files/{*path}", (string id, string path) =>
        {
            var filePath = Path.Combine(AppPaths.PluginsDir, id, path);
            if (!File.Exists(filePath)) return Results.NotFound();
            var ext = Path.GetExtension(filePath).ToLowerInvariant();
            var contentType = ext switch
            {
                ".css" => "text/css",
                ".js" => "application/javascript",
                ".json" => "application/json",
                ".png" => "image/png",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".svg" => "image/svg+xml",
                ".html" or ".htm" => "text/html",
                _ => "application/octet-stream",
            };
            return Results.File(filePath, contentType);
        });

        plugins.MapGet("/settings/{id}", (string id) =>
        {
            var settingsFile = Path.Combine(AppPaths.PluginsDir, id, "settings.json");
            if (!File.Exists(settingsFile))
                return Results.Content("{}", "application/json");
            var json = File.ReadAllText(settingsFile);
            return Results.Content(json, "application/json");
        });

        plugins.MapPost("/settings/{id}", async (string id, HttpRequest request) =>
        {
            var settingsDir = Path.Combine(AppPaths.PluginsDir, id);
            Directory.CreateDirectory(settingsDir);
            var settingsFile = Path.Combine(settingsDir, "settings.json");

            using var reader = new StreamReader(request.Body);
            var body = await reader.ReadToEndAsync();

            var incoming = JsonNode.Parse(body) as JsonObject;
            if (incoming == null || !incoming.ContainsKey("key"))
                return Results.BadRequest("Expected { key, value }");

            var key = incoming["key"]?.GetValue<string>() ?? "";
            var value = incoming["value"];

            var gate = SettingsLocks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync();
            try
            {
                var settings = await ReadSettingsAsync(settingsFile);
                settings[key] = value?.DeepClone();
                await WriteSettingsAsync(settingsFile, settings.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
            }
            finally
            {
                gate.Release();
            }
            return Results.Ok();
        });

        plugins.MapPost("/proxy", async (CorsProxyRequest req, IHttpClientFactory factory) =>
        {
            if (string.IsNullOrWhiteSpace(req.Url))
                throw ApiException.BadRequest("url 不能为空", "PROXY_URL_REQUIRED");

            await ValidateTargetAsync(req.Url);

            var method = string.IsNullOrWhiteSpace(req.Method)
                ? HttpMethod.Get
                : new HttpMethod(req.Method.ToUpperInvariant());

            using var reqMsg = new HttpRequestMessage(method, req.Url);
            var reqContentType = "application/json";
            if (req.Headers != null)
            {
                foreach (var (key, value) in req.Headers)
                {
                    if (string.IsNullOrWhiteSpace(key)) continue;
                    if (key.Equals("Host", StringComparison.OrdinalIgnoreCase)) continue;
                    if (key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                    if (key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) { reqContentType = value; continue; }
                    reqMsg.Headers.TryAddWithoutValidation(key, value);
                }
            }
            if (!string.IsNullOrEmpty(req.Body) && method != HttpMethod.Get && method != HttpMethod.Head)
                reqMsg.Content = new StringContent(req.Body, Encoding.UTF8, reqContentType);

            var client = factory.CreateClient("PluginProxy");
            var cts = new CancellationTokenSource(Math.Clamp(req.TimeoutMs ?? 15000, 1000, 60000));
            var resp = await client.SendAsync(reqMsg, HttpCompletionOption.ResponseHeadersRead, cts.Token);

            if (req.Stream)
            {
                return Results.Stream(async outputStream =>
                {
                    try
                    {
                        await using var upstream = await resp.Content.ReadAsStreamAsync(cts.Token);
                        await upstream.CopyToAsync(outputStream, cts.Token);
                    }
                    finally
                    {
                        resp.Dispose();
                        cts.Dispose();
                    }
                }, "application/octet-stream");
            }

            try
            {
                var bodyBytes = await resp.Content.ReadAsByteArrayAsync(cts.Token);
                var outHeaders = new Dictionary<string, string>();
                foreach (var h in resp.Headers)
                    outHeaders[h.Key] = string.Join(", ", h.Value);
                foreach (var h in resp.Content.Headers)
                    if (!outHeaders.ContainsKey(h.Key))
                        outHeaders[h.Key] = string.Join(", ", h.Value);

                var contentType = resp.Content.Headers.ContentType?.MediaType ?? "";
                bool isText = contentType.StartsWith("text/", StringComparison.OrdinalIgnoreCase)
                    || contentType.Contains("json", StringComparison.OrdinalIgnoreCase)
                    || contentType.Contains("xml", StringComparison.OrdinalIgnoreCase)
                    || contentType.Contains("javascript", StringComparison.OrdinalIgnoreCase)
                    || contentType.Contains("x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase)
                    || contentType.Contains("svg", StringComparison.OrdinalIgnoreCase)
                    || bodyBytes.Length == 0;

                return Results.Ok(new CorsProxyResponse
                {
                    Status = (int)resp.StatusCode,
                    Headers = outHeaders,
                    Body = isText ? (bodyBytes.Length == 0 ? "" : Encoding.UTF8.GetString(bodyBytes)) : null,
                    BodyBase64 = isText ? null : Convert.ToBase64String(bodyBytes),
                });
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
            {
                throw ApiException.BadGateway("上游响应中断", "PROXY_UPSTREAM_FAILED", ex);
            }
            finally
            {
                resp.Dispose();
                cts.Dispose();
            }
        });

        plugins.MapPost("/cache/{id}", async (string id, HttpRequest request) =>
        {
            using var reader = new StreamReader(request.Body);
            var body = await reader.ReadToEndAsync();

            var incoming = JsonNode.Parse(body) as JsonObject;
            if (incoming == null || !incoming.ContainsKey("key") || !incoming.ContainsKey("value"))
                return Results.BadRequest("Expected { key, value, ttlSeconds? }");

            var key = incoming["key"]?.GetValue<string>() ?? "";
            if (string.IsNullOrWhiteSpace(key))
                return Results.BadRequest("key 不能为空");
            if (key.Length > 512)
                return Results.BadRequest("key 过长");

            int? ttlSeconds = null;
            if (incoming["ttlSeconds"] is JsonValue ttlValue && ttlValue.TryGetValue<int>(out var ttl) && ttl > 0)
                ttlSeconds = ttl;

            var cacheFile = Path.Combine(AppPaths.PluginsDir, id, "cache.json");
            var gate = CacheLocks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync();
            try
            {
                var cache = await ReadCacheAsync(cacheFile);
                cache[key] = new JsonObject
                {
                    ["v"] = incoming["value"]?.DeepClone(),
                    ["e"] = ttlSeconds.HasValue ? JsonValue.Create(DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ttlSeconds.Value) : null,
                };
                await WriteCacheAsync(cacheFile, cache);
            }
            finally
            {
                gate.Release();
            }
            return Results.Ok();
        });

        plugins.MapGet("/cache/{id}", async (string id, string key) =>
        {
            if (string.IsNullOrWhiteSpace(key))
                throw ApiException.BadRequest("key 不能为空", "CACHE_KEY_REQUIRED");

            var cacheFile = Path.Combine(AppPaths.PluginsDir, id, "cache.json");
            var gate = CacheLocks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync();
            try
            {
                var cache = await ReadCacheAsync(cacheFile);
                if (cache[key] is not JsonObject entry || entry["v"] == null)
                    return Results.Content("{\"value\":null}", "application/json");

                var expiresAt = entry["e"]?.GetValue<long>();
                if (expiresAt is long expTs && DateTimeOffset.UtcNow.ToUnixTimeSeconds() > expTs)
                {
                    cache.Remove(key);
                    await WriteCacheAsync(cacheFile, cache);
                    return Results.Content("{\"value\":null}", "application/json");
                }

                return Results.Content("{\"value\":" + entry["v"]!.ToJsonString() + "}", "application/json");
            }
            finally
            {
                gate.Release();
            }
        });
    }

    private static async Task ValidateTargetAsync(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            throw ApiException.BadRequest("无效的代理 URL", "PROXY_INVALID_URL");
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            throw ApiException.BadRequest("仅支持 http/https 协议", "PROXY_SCHEME_NOT_ALLOWED");

        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(uri.IdnHost);
        }
        catch
        {
            throw ApiException.BadRequest("无法解析目标主机", "PROXY_DNS_FAILED");
        }
        if (addresses.Length == 0)
            throw ApiException.BadRequest("无法解析目标主机", "PROXY_DNS_FAILED");
        foreach (var addr in addresses)
        {
            if (IsPrivateAddress(addr))
                throw ApiException.BadRequest("禁止访问内网或保留地址", "PROXY_PRIVATE_ADDRESS");
        }
    }

    private static bool IsPrivateAddress(IPAddress addr)
    {
        if (addr.IsIPv4MappedToIPv6) addr = addr.MapToIPv4();
        if (IPAddress.IsLoopback(addr)) return true;

        if (addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var b = addr.GetAddressBytes();
            if (b[0] == 0) return true;                          // 0.0.0.0/8
            if (b[0] == 10) return true;                         // 10.0.0.0/8
            if (b[0] == 100 && b[1] is >= 64 and <= 127) return true; // 100.64.0.0/10 CGNAT
            if (b[0] == 127) return true;                        // 127.0.0.0/8 loopback
            if (b[0] == 169 && b[1] == 254) return true;         // 169.254.0.0/16 link-local
            if (b[0] == 172 && b[1] is >= 16 and <= 31) return true; // 172.16.0.0/12
            if (b[0] == 192 && b[1] == 168) return true;         // 192.168.0.0/16
            if (b[0] == 192 && b[1] == 0) return true;           // 192.0.0.0/24 + 192.0.2.0/24
            if (b[0] == 198 && (b[1] == 18 || b[1] == 19)) return true; // 198.18.0.0/15
            if (b[0] == 198 && b[1] == 51) return true;          // 198.51.100.0/24
            if (b[0] == 203 && b[1] == 0 && b[2] == 113) return true; // 203.0.113.0/24
            if (b[0] >= 224) return true;                        // multicast + reserved
        }
        else if (addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (addr.IsIPv6LinkLocal || addr.IsIPv6Multicast) return true;
            if ((addr.GetAddressBytes()[0] & 0xFE) == 0xFC) return true; // fc00::/7 unique local
        }
        return false;
    }
}

public record SetPluginStateRequest(string State);

public class CorsProxyRequest
{
    public string Url { get; set; } = "";
    public string? Method { get; set; }
    public Dictionary<string, string>? Headers { get; set; }
    public string? Body { get; set; }
    public int? TimeoutMs { get; set; }
    public bool Stream { get; set; }
}

public class CorsProxyResponse
{
    public int Status { get; set; }
    public Dictionary<string, string> Headers { get; set; } = new();
    public string? Body { get; set; }
    public string? BodyBase64 { get; set; }
}
