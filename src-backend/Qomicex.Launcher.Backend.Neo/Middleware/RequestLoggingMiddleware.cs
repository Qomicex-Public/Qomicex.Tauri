using System.Diagnostics;
using Qomicex.Launcher.Backend.Neo.Common;

namespace Qomicex.Launcher.Backend.Neo.Middleware;

public sealed class RequestLoggingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RequestLoggingMiddleware> _logger;
    private readonly LogLevelManager _levelManager;

    public RequestLoggingMiddleware(RequestDelegate next, ILogger<RequestLoggingMiddleware> logger, LogLevelManager levelManager)
    {
        _next = next;
        _logger = logger;
        _levelManager = levelManager;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await _next(context);
            sw.Stop();
            if (_levelManager.Minimum <= LogLevel.Information)
            {
                _logger.LogInformation(
                    "{Method} {Path} => {Status} in {Duration}ms",
                    context.Request.Method, context.Request.Path, context.Response.StatusCode, sw.ElapsedMilliseconds);
            }
        }
        catch (Exception)
        {
            sw.Stop();
            throw;
        }
    }
}

public static class RequestLoggingMiddlewareExtensions
{
    public static IApplicationBuilder UseRequestLogging(this IApplicationBuilder app)
    {
        return app.UseMiddleware<RequestLoggingMiddleware>();
    }
}
