using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Common;

/// <summary>
/// 统一 API 错误响应格式
/// </summary>
public sealed class ApiError
{
    /// <summary>机器可读的错误码，如 "INSTALL_FAILED", "VALIDATION_ERROR"</summary>
    [JsonPropertyName("code")]
    public required string Code { get; init; }

    /// <summary>人类可读的简短描述</summary>
    [JsonPropertyName("message")]
    public required string Message { get; init; }

    /// <summary>详细技术信息（仅开发环境或非敏感场景）</summary>
    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; init; }

    /// <summary>请求追踪 ID，用于日志关联</summary>
    [JsonPropertyName("traceId")]
    public required string TraceId { get; init; }

    /// <summary>UTC 时间戳</summary>
    [JsonPropertyName("timestamp")]
    public required DateTime Timestamp { get; init; }

    /// <summary>HTTP 状态码（方便前端不用再从 response.status 拿）</summary>
    [JsonPropertyName("status")]
    public required int Status { get; init; }

    public static ApiError Create(int status, string code, string message, string traceId, string? detail = null)
    {
        return new ApiError
        {
            Status = status,
            Code = code,
            Message = message,
            Detail = detail,
            TraceId = traceId,
            Timestamp = DateTime.UtcNow,
        };
    }
}

/// <summary>
/// 已知业务异常 — 抛出时会映射为对应 HTTP 状态码而非 500
/// </summary>
public class ApiException : Exception
{
    public int StatusCode { get; }
    public string ErrorCode { get; }

    public ApiException(int statusCode, string errorCode, string message, Exception? inner = null)
        : base(message, inner)
    {
        StatusCode = statusCode;
        ErrorCode = errorCode;
    }

    /// <summary>400 Bad Request</summary>
    public static ApiException BadRequest(string message, string code = "BAD_REQUEST")
        => new(400, code, message);

    /// <summary>404 Not Found</summary>
    public static ApiException NotFound(string message, string code = "NOT_FOUND")
        => new(404, code, message);

    /// <summary>502 Bad Gateway（上游 API 错误）</summary>
    public static ApiException BadGateway(string message, string code = "UPSTREAM_ERROR", Exception? inner = null)
        => new(502, code, message, inner);

    /// <summary>500 Internal Server Error</summary>
    public static ApiException Internal(string message, string code = "INTERNAL_ERROR", Exception? inner = null)
        => new(500, code, message, inner);
}
