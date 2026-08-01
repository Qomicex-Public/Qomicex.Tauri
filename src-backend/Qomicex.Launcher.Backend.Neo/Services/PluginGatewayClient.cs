using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class PluginGatewayClient
{
    private readonly HttpClient _http;
    private readonly string _portFilePath;

    public PluginGatewayClient(HttpClient http)
    {
        _http = http;
        _portFilePath = Path.Combine(AppPaths.PluginsDir, ".gateway_port");
    }

    private string? GetGatewayUrl()
    {
        if (!File.Exists(_portFilePath)) return null;
        var port = File.ReadAllText(_portFilePath).Trim();
        if (string.IsNullOrEmpty(port)) return null;
        return $"http://127.0.0.1:{port}";
    }

    public async Task<bool> IsGatewayAliveAsync()
    {
        var baseUrl = GetGatewayUrl();
        if (baseUrl == null) return false;
        try
        {
            var res = await _http.GetAsync($"{baseUrl}/health");
            return res.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<List<string>> GetLoadedPluginsAsync()
    {
        var baseUrl = GetGatewayUrl();
        if (baseUrl == null) return [];
        try
        {
            var res = await _http.GetAsync($"{baseUrl}/plugins");
            res.EnsureSuccessStatusCode();
            var json = await res.Content.ReadAsStringAsync();
            var obj = JsonSerializer.Deserialize(json, ApiJsonContext.Default.GatewayPluginListResponse);
            return obj?.Plugins ?? [];
        }
        catch { return []; }
    }

    /// <summary>查询 WASM 插件信息。</summary>
    public async Task<JsonElement?> GetPluginInfoAsync(string id)
    {
        var baseUrl = GetGatewayUrl();
        if (baseUrl == null) return null;
        try
        {
            var res = await _http.GetAsync($"{baseUrl}/plugins/{Uri.EscapeDataString(id)}/info");
            if (!res.IsSuccessStatusCode) return null;
            var json = await res.Content.ReadAsStringAsync();
            return JsonDocument.Parse(json).RootElement.Clone();
        }
        catch { return null; }
    }

    /// <summary>调用 WASM 插件导出的函数。</summary>
    public async Task<JsonElement?> InvokePluginAsync(string id, string export)
    {
        var baseUrl = GetGatewayUrl();
        if (baseUrl == null) return null;
        try
        {
            var content = new StringContent(
                System.Text.Json.JsonSerializer.Serialize(new { export },
                    ApiJsonContext.Default.WasmInvokeRequest),
                System.Text.Encoding.UTF8, "application/json");
            var res = await _http.PostAsync($"{baseUrl}/plugins/{Uri.EscapeDataString(id)}/invoke", content);
            if (!res.IsSuccessStatusCode) return null;
            var json = await res.Content.ReadAsStringAsync();
            return JsonDocument.Parse(json).RootElement.Clone();
        }
        catch { return null; }
    }
}

public class GatewayPluginListResponse
{
    [System.Text.Json.Serialization.JsonPropertyName("plugins")]
    public List<string> Plugins { get; set; } = [];
}

public class WasmInvokeRequest
{
    [System.Text.Json.Serialization.JsonPropertyName("export")]
    public string Export { get; set; } = "on_load";
}
