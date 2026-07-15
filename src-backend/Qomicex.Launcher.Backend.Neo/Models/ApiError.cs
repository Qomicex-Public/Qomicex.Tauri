using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Neo.Models;

public sealed class ApiError
{
    [JsonPropertyName("code")]
    public required string Code { get; init; }

    [JsonPropertyName("message")]
    public required string Message { get; init; }

    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; init; }

    [JsonPropertyName("traceId")]
    public required string TraceId { get; init; }

    [JsonPropertyName("timestamp")]
    public required DateTime Timestamp { get; init; }

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

    public static ApiException BadRequest(string message, string code = "BAD_REQUEST")
        => new(400, code, message);

    public static ApiException NotFound(string message, string code = "NOT_FOUND")
        => new(404, code, message);

    public static ApiException BadGateway(string message, string code = "UPSTREAM_ERROR", Exception? inner = null)
        => new(502, code, message, inner);

    public static ApiException Internal(string message, string code = "INTERNAL_ERROR", Exception? inner = null)
        => new(500, code, message, inner);
}
