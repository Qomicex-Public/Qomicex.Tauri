using System.Diagnostics;
using System.Text.Json;
using Qomicex.Core.AOT.Exceptions;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Middleware;

public sealed class ErrorHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ErrorHandlingMiddleware> _logger;

    public ErrorHandlingMiddleware(RequestDelegate next, ILogger<ErrorHandlingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            await HandleExceptionAsync(context, ex);
        }
    }

    private async Task HandleExceptionAsync(HttpContext context, Exception exception)
    {
        var traceId = Activity.Current?.Id ?? context.TraceIdentifier;
        var (statusCode, errorCode, message, detail) = MapException(exception);

        _logger.LogError(exception,
            "[{ErrorCode}] {Message} | TraceId={TraceId} | Path={Path}",
            errorCode, exception.Message, traceId, context.Request.Path);

        var error = ApiError.Create(statusCode, errorCode, message, traceId, detail);

        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsync(JsonSerializer.Serialize(error, ApiJsonContext.Default.ApiError));
    }

    private static (int status, string code, string message, string? detail) MapException(Exception ex)
    {
        return ex switch
        {
            ApiException api => (api.StatusCode, api.ErrorCode, api.Message, api.InnerException?.Message),
            VersionNotFoundException => (404, "VERSION_NOT_FOUND", ex.Message, null),
            VersionMetadataException => (400, "VERSION_METADATA_ERROR", ex.Message, null),
            DownloadFailedException => (502, "DOWNLOAD_FAILED", ex.Message, ex.InnerException?.Message),
            ResourceCompletionException => (502, "RESOURCE_COMPLETION_FAILED", ex.Message, null),
            ArgumentNullException arg => (400, "MISSING_PARAMETER", $"Missing parameter: {arg.ParamName}", null),
            ArgumentException arg => (400, "INVALID_PARAMETER", arg.Message, null),
            FileNotFoundException fnf => (404, "FILE_NOT_FOUND", $"File not found: {fnf.FileName ?? "unknown"}", null),
            DirectoryNotFoundException => (404, "DIRECTORY_NOT_FOUND", "Directory not found", null),
            HttpRequestException http => (502, "UPSTREAM_ERROR", $"Upstream request failed: {http.Message}", http.StatusCode?.ToString()),
            TaskCanceledException => (499, "REQUEST_CANCELLED", "Request cancelled", null),
            OperationCanceledException => (499, "OPERATION_CANCELLED", "Operation cancelled", null),
            JsonException json => (400, "INVALID_JSON", $"JSON parse error: {json.Message}", null),
            NotSupportedException => (501, "NOT_SUPPORTED", ex.Message, null),
            _ => (500, "INTERNAL_ERROR", "Internal server error", ex.Message),
        };
    }
}

public static class ErrorHandlingMiddlewareExtensions
{
    public static IApplicationBuilder UseErrorHandling(this IApplicationBuilder app)
    {
        return app.UseMiddleware<ErrorHandlingMiddleware>();
    }
}
