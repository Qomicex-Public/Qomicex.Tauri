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
}

public class GatewayPluginListResponse
{
    [System.Text.Json.Serialization.JsonPropertyName("plugins")]
    public List<string> Plugins { get; set; } = [];
}
