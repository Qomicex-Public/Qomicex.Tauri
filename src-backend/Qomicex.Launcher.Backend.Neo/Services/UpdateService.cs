using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class UpdateService
{
    private static readonly string[] ProxyPrefixes =
    [
        "",
        "https://edgeone.gh-proxy.org/",
        "https://cdn.gh-proxy.org/",
        "https://hk.gh-proxy.org/",
        "https://v6.gh-proxy.org/",
        "https://ghfast.top/"
    ];

    private static readonly TimeSpan ProxyCacheTtl = TimeSpan.FromMinutes(30);

    private readonly ConcurrentDictionary<string, (string Prefix, DateTime CachedAt)> _proxyCache = new();
    private readonly SemaphoreSlim _proxyLock = new(1, 1);

    public async Task<UpdateCheckResponse> CheckAsync(string currentVersion, string? channel, IHttpClientFactory httpFactory, CancellationToken ct)
    {
        var client = httpFactory.CreateClient("QomicexWeb");

        var request = new HttpRequestMessage(HttpMethod.Get, $"/api/client/version/check?current={Uri.EscapeDataString(currentVersion)}");

        if (string.Equals(channel, "alpha", StringComparison.OrdinalIgnoreCase) && LicenseValidator.LicenseFileExists())
        {
            var rawToken = ReadAndDecryptLicenseToken();
            if (!string.IsNullOrEmpty(rawToken))
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", rawToken);
        }

        var response = await client.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadAsStringAsync(ct);
        var result = JsonSerializer.Deserialize(json, ApiJsonContext.Default.UpdateCheckResponse)
            ?? new UpdateCheckResponse(false);

        if (result.HasUpdate && !string.IsNullOrEmpty(result.DownloadUrl))
        {
            var fastestPrefix = await GetFastestProxyPrefixAsync(result.DownloadUrl, ct);
            var proxiedUrl = fastestPrefix + result.DownloadUrl;
            result = result with { DownloadUrl = proxiedUrl };
        }

        return result;
    }

    private async Task<string> GetFastestProxyPrefixAsync(string downloadUrl, CancellationToken ct)
    {
        if (_proxyCache.TryGetValue("fastest", out var cached) && DateTime.UtcNow - cached.CachedAt < ProxyCacheTtl)
            return cached.Prefix;

        await _proxyLock.WaitAsync(ct);
        try
        {
            if (_proxyCache.TryGetValue("fastest", out cached) && DateTime.UtcNow - cached.CachedAt < ProxyCacheTtl)
                return cached.Prefix;

            var fastest = await RaceProxiesAsync(downloadUrl, ct);
            _proxyCache["fastest"] = (fastest, DateTime.UtcNow);
            return fastest;
        }
        finally
        {
            _proxyLock.Release();
        }
    }

    private static async Task<string> RaceProxiesAsync(string downloadUrl, CancellationToken ct)
    {
        var bestPrefix = "";
        var bestLatency = long.MaxValue;

        var tasks = ProxyPrefixes.Select(async prefix =>
        {
            var url = prefix + downloadUrl;
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(TimeSpan.FromSeconds(5));

                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Range = new RangeHeaderValue(0, 0);

                var sw = Stopwatch.StartNew();
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
                sw.Stop();

                if (response.IsSuccessStatusCode || (int)response.StatusCode == 206)
                {
                    var latency = sw.ElapsedMilliseconds;
                    lock (ProxyPrefixes)
                    {
                        if (latency < bestLatency)
                        {
                            bestLatency = latency;
                            bestPrefix = prefix;
                        }
                    }
                }
            }
            catch
            {
            }
        });

        await Task.WhenAll(tasks);

        return bestPrefix;
    }

    private static string ReadAndDecryptLicenseToken()
    {
        try
        {
            var licenseToken = File.ReadAllText(LicenseValidator.LicenseFilePath).Trim();
            var machineCode = CryptHelper.GetMachineCode();
            return CryptHelper.DecryptFromBase64(licenseToken, LicenseValidator.LicensePassword(machineCode));
        }
        catch
        {
            return string.Empty;
        }
    }
}
