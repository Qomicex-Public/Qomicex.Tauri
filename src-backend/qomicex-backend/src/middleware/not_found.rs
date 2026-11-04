// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 404 统一兜底封装。
//!
//! 对应 C# `ErrorHandlingMiddleware` 的兜底 + ASP.NET 未匹配路由返回的 404。
//! 走 `ApiError` 统一响应，确保 traceId / 错误日志与其它接口一致。

use axum::response::{IntoResponse, Response};

use crate::error::ApiError;

/// axum `Router::fallback` 处理器：任意未匹配路由 → 404 封装。
///
/// 期望接线：`router.fallback(not_found::handler)`。
pub async fn handler() -> Response {
    ApiError::not_found("NOT_FOUND", "The requested route was not found.").into_response()
}
