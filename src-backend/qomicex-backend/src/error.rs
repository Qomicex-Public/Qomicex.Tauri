//! 统一错误类型与 HTTP 错误封装（对应源 Middleware/ErrorHandlingMiddleware.cs + Models/ApiError.cs）。
//!
//! 对外错误 JSON 契约（camelCase，与源 ApiError 一致）：
//! ```json
//! { "code":"...", "message":"...", "detail":"...", "traceId":"...", "timestamp":"...", "status":500 }
//! ```

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub status: StatusCode,
}

impl ApiError {
    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
            status: StatusCode::BAD_REQUEST,
        }
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
            status: StatusCode::NOT_FOUND,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL_ERROR".to_string(),
            message: message.into(),
            detail: None,
            status: StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// 上游请求失败（对应源 HttpRequestException → 502 UPSTREAM_ERROR）。
    pub fn upstream(message: impl Into<String>) -> Self {
        Self {
            code: "UPSTREAM_ERROR".to_string(),
            message: format!("Upstream request failed: {}", message.into()),
            detail: None,
            status: StatusCode::BAD_GATEWAY,
        }
    }
}

/// 序列化到响应体的 ApiError（camelCase，忽略详细/空值）。
/// 字段顺序：code/message/detail/traceId/timestamp/status。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub trace_id: String,
    pub timestamp: String,
    pub status: u16,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ApiErrorBody {
            code: self.code,
            message: self.message,
            detail: self.detail,
            trace_id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            status: self.status.as_u16(),
        };
        (self.status, Json(body)).into_response()
    }
}

/// 便捷 Result 别名，供各端点 handler 使用。
pub type ApiResult<T> = Result<T, ApiError>;

/// 将任意 std::io::Error 包装为 500（内部错误）。
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError::internal(e.to_string())
    }
}
