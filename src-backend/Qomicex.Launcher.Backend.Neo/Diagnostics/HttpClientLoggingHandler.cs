using System.Diagnostics;
using Qomicex.Launcher.Backend.Neo.Common;

namespace Qomicex.Launcher.Backend.Neo.Diagnostics;

public sealed class HttpClientLoggingHandler : DelegatingHandler
{
    private readonly ILogger<HttpClientLoggingHandler> _logger;
    private readonly LogLevelManager _levelManager;

    public HttpClientLoggingHandler(ILogger<HttpClientLoggingHandler> logger, LogLevelManager levelManager)
    {
        _logger = logger;
        _levelManager = levelManager;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var response = await base.SendAsync(request, cancellationToken);
            sw.Stop();
            if (_levelManager.Minimum <= LogLevel.Information)
            {
                _logger.LogInformation(
                    "[HTTP {Method}] {Url} => {Status} in {Duration}ms",
                    request.Method, request.RequestUri, (int)response.StatusCode, sw.ElapsedMilliseconds);
            }
            return response;
        }
        catch (Exception ex)
        {
            sw.Stop();
            _logger.LogError(ex,
                "[HTTP {Method}] {Url} => FAILED in {Duration}ms: {Message}",
                request.Method, request.RequestUri, sw.ElapsedMilliseconds, ex.Message);
            throw;
        }
    }
}
