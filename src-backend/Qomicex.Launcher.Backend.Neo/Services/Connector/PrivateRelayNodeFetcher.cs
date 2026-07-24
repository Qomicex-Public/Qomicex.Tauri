using Microsoft.Extensions.Logging;
using Qomicex.Connector;

namespace Qomicex.Launcher.Backend.Neo.Services.Connector;

public class PrivateRelayNodeFetcher
{
    private readonly HttpClient _http;
    private readonly string _apiUrl;
    private readonly string _userAgent;
    private readonly ILogger<PrivateRelayNodeFetcher>? _logger;

    public PrivateRelayNodeFetcher(
        HttpClient http,
        string apiUrl,
        string userAgent,
        ILogger<PrivateRelayNodeFetcher>? logger = null)
    {
        _http = http;
        _apiUrl = apiUrl;
        _userAgent = userAgent;
        _logger = logger;
    }

    public async Task<string[]> FetchAsync(CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(_apiUrl))
            return [];

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, _apiUrl);
            request.Headers.TryAddWithoutValidation("User-Agent", _userAgent);

            using var response = await _http.SendAsync(request, ct);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync(ct);
            var nodes = RelayNodeProvider.ParseNodes(json);

            nodes = await ResolveHttpNodesAsync(nodes, ct);
            if (nodes.Length > 0)
            {
                _logger?.LogInformation("已从私有节点服务获取 {Count} 个中继节点", nodes.Length);
                return nodes;
            }

            _logger?.LogWarning("私有节点服务返回空列表，回退到公开节点");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "获取私有中继节点失败，回退到公开节点");
        }

        return [];
    }

    private async Task<string[]> ResolveHttpNodesAsync(string[] nodes, CancellationToken ct)
    {
        var resolved = new List<string>();
        foreach (var node in nodes)
        {
            if (node.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                || node.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                var actual = await ResolveSingleNodeAsync(node, ct);
                if (actual is not null)
                    resolved.Add(actual);
            }
            else
            {
                resolved.Add(node);
            }
        }
        return resolved.ToArray();
    }

    private async Task<string?> ResolveSingleNodeAsync(string nodeUrl, CancellationToken ct)
    {
        try
        {
            var result = await _http.GetStringAsync(nodeUrl, ct);
            if (!string.IsNullOrWhiteSpace(result))
                return result.Trim();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "解析节点 {Url} 失败，已跳过", nodeUrl);
        }

        return null;
    }
}
