//! 404 统一兜底封装。
//!
//! 对应 C# `ErrorHandlingMiddleware` 的兜底 + ASP.NET 未匹配路由返回的 404。
//! 未匹配路由返回 `404`，body 复用 `ApiErrorBody` 的契约（camelCase，
//! 无 detail 时省略），content-type 为 `application/json; charset=utf-8`。

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::error::ApiErrorBody;

/// axum `Router::fallback` 处理器：任意未匹配路由 → 404 封装。
///
/// 期望接线：`router.fallback(not_found::handler)`。
pub async fn handler() -> Response {
    let body = ApiErrorBody {
        code: "NOT_FOUND".to_string(),
        message: "The requested route was not found.".to_string(),
        detail: None,
        trace_id: uuid::Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        status: StatusCode::NOT_FOUND.as_u16(),
    };
    let json = serde_json::to_string(&body).unwrap_or_else(|_| "{}".to_string());
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        json,
    )
        .into_response()
}
