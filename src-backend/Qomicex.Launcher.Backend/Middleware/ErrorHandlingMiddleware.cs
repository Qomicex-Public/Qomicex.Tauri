using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Qomicex.Launcher.Backend.Common;

namespace Qomicex.Launcher.Backend.Middleware;

/// <summary>
/// 全局异常处理中间件 — 捕获所有未处理异常，返回统一 ApiError 格式，
/// 同时输出结构化日志到控制台和日志文件。
/// </summary>
public sealed class ErrorHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ErrorHandlingMiddleware> _logger;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

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
        await context.Response.WriteAsync(JsonSerializer.Serialize(error, JsonOptions));
    }

    private static (int status, string code, string message, string? detail) MapException(Exception ex)
    {
        return ex switch
        {
            ApiException api => (api.StatusCode, api.ErrorCode, api.Message, api.InnerException?.Message),
            ArgumentNullException arg => (400, "MISSING_PARAMETER", $"缺少必要参数: {arg.ParamName}", null),
            ArgumentException arg => (400, "INVALID_PARAMETER", arg.Message, null),
            FileNotFoundException fnf => (404, "FILE_NOT_FOUND", $"文件不存在: {fnf.FileName ?? "unknown"}", null),
            DirectoryNotFoundException => (404, "DIRECTORY_NOT_FOUND", "目录不存在", null),
            HttpRequestException http => (502, "UPSTREAM_ERROR", $"上游服务请求失败: {http.Message}", http.StatusCode?.ToString()),
            TaskCanceledException => (499, "REQUEST_CANCELLED", "请求已取消", null),
            OperationCanceledException => (499, "OPERATION_CANCELLED", "操作已取消", null),
            JsonException json => (400, "INVALID_JSON", $"JSON 解析失败: {json.Message}", null),
            NotSupportedException => (501, "NOT_SUPPORTED", ex.Message, null),
            _ => (500, "INTERNAL_ERROR", "服务器内部错误", ex.Message),
        };
    }
}

/// <summary>
/// 注册中间件的扩展方法
/// </summary>
public static class ErrorHandlingMiddlewareExtensions
{
    public static IApplicationBuilder UseErrorHandling(this IApplicationBuilder app)
    {
        return app.UseMiddleware<ErrorHandlingMiddleware>();
    }
}
