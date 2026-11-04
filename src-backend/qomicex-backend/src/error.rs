// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
    /// 通用构造（任意状态码/错误码）。
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
            status,
        }
    }

    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
            status: StatusCode::BAD_REQUEST,
        }
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
            status: StatusCode::FORBIDDEN,
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

    /// 资源冲突（如目标文件正被其它进程占用）→ 409。
    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
            status: StatusCode::CONFLICT,
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

    /// 上游请求失败 + 完整错误链（DNS/TLS/连接重置/解析位置）。
    pub fn upstream_cause(
        context: impl std::fmt::Display,
        err: &(dyn std::error::Error + 'static),
    ) -> Self {
        let chain = crate::util::error::error_chain(err);
        Self {
            code: "UPSTREAM_ERROR".to_string(),
            message: format!("Upstream request failed: {context}: {chain}"),
            detail: Some(chain),
            status: StatusCode::BAD_GATEWAY,
        }
    }

    /// 补充 detail（不覆盖已有 detail）。
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        if self.detail.is_none() {
            self.detail = Some(detail.into());
        }
        self
    }
}

/// `ApiError` 转成响应时附带的元数据；由 `middleware::error_log` 读取并写日志。
/// 这样日志能同时拿到请求 method/uri 与错误 code/detail/traceId。
#[derive(Clone, Debug)]
pub struct ApiErrorMeta {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub trace_id: String,
    pub status: u16,
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
        let trace_id = uuid::Uuid::new_v4().to_string();
        let meta = ApiErrorMeta {
            code: self.code.clone(),
            message: self.message.clone(),
            detail: self.detail.clone(),
            trace_id: trace_id.clone(),
            status: self.status.as_u16(),
        };
        let body = ApiErrorBody {
            code: self.code,
            message: self.message,
            detail: self.detail,
            trace_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            status: self.status.as_u16(),
        };
        let mut response = (self.status, Json(body)).into_response();
        // 供 middleware::error_log 读取：日志里同时带上 method/uri 与错误详情。
        response.extensions_mut().insert(meta);
        response
    }
}

/// 便捷 Result 别名，供各端点 handler 使用。
pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoints::connector::map_connector_error;

    /// 回归（issue #182）：联机 join/host 失败时真实报错（如「未在 EasyTier 网络
    /// 中发现联机中心（超时 30s）」）被塞进 UPSTREAM_ERROR 的 message，而前端
    /// CODE_TO_KEY 把 UPSTREAM_ERROR 翻译成通用文案「上游服务请求失败」并丢弃
    /// message → 用户无法排障。改用专属错误码 CONNECTOR_FAILED：不在前端映射表
    /// 中，displayMessage 回退后端 message，真实原因原样透出。
    #[test]
    fn connector_error_uses_dedicated_code_and_keeps_message() {
        let err = map_connector_error(qomicex_connector::error::ScaffoldingError::CenterNotFound(
            "未在 EasyTier 网络中发现联机中心（超时 30s）".to_string(),
        ));
        assert_eq!(err.code, "CONNECTOR_FAILED");
        assert_eq!(err.status, reqwest::StatusCode::BAD_GATEWAY);
        assert!(
            err.message.contains("未在 EasyTier 网络中发现联机中心"),
            "message 必须保留真实报错，实际: {}",
            err.message
        );
    }

    /// 守护：非联机场景的 upstream() 语义不变（仍是 UPSTREAM_ERROR）。
    #[test]
    fn upstream_error_code_unchanged_for_other_callers() {
        let err = ApiError::upstream("资源站不可达");
        assert_eq!(err.code, "UPSTREAM_ERROR");
    }

    /// 回归：错误响应必须携带 ApiErrorMeta，否则 middleware::error_log 拿不到
    /// code/detail/traceId，用户日志又退化成只有 status。
    #[test]
    fn api_error_response_carries_log_meta() {
        let response = ApiError::bad_request("TEST_CODE", "测试消息")
            .with_detail("底层原因")
            .into_response();
        let meta = response
            .extensions()
            .get::<ApiErrorMeta>()
            .expect("ApiError 响应必须挂 ApiErrorMeta");
        assert_eq!(meta.code, "TEST_CODE");
        assert_eq!(meta.status, 400);
        assert_eq!(meta.detail.as_deref(), Some("底层原因"));
        assert!(!meta.trace_id.is_empty());
    }
}

/// 将 std::io::Error 映射为 HTTP 错误（对应源 ErrorHandlingMiddleware.MapException）：
/// `NotFound`→404（FileNotFoundException 语义）、`PermissionDenied`→403、
/// 其余→500（IOException 语义）。
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match e.kind() {
            ErrorKind::NotFound => ApiError::not_found("NOT_FOUND", e.to_string()),
            ErrorKind::PermissionDenied => ApiError::forbidden("FORBIDDEN", e.to_string()),
            _ => ApiError::internal(e.to_string()),
        }
    }
}
