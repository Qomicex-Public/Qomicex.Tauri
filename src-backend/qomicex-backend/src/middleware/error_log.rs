// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! API 错误响应日志。
//!
//! `ApiError::into_response` 会把 `ApiErrorMeta` 挂到响应扩展上；这里在请求
//! 维度补齐 method/uri/latency，并把 code/detail/traceId 一起写进 trace。
//! 旧实现只有 `request failed: status=500 latency=...`，用户日志无法定位
//! 是哪个接口、什么错误码、什么原因。

use std::time::Instant;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

use crate::error::ApiErrorMeta;

pub async fn log_api_errors(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let started = Instant::now();
    let response = next.run(req).await;
    let latency_ms = started.elapsed().as_millis();

    if let Some(meta) = response.extensions().get::<ApiErrorMeta>() {
        // 只记 API 路径的 4xx 与所有 5xx；静态资源/浏览器 favicon 的 404 不刷日志。
        let is_api = uri.path().starts_with("/api");
        if meta.status < 500 && !is_api {
            return response;
        }
        // 只记 path，丢掉 query：签名/令牌常在 query 里。
        let path = uri.path();
        if meta.status >= 500 {
            tracing::error!(
                method = %method,
                uri = %path,
                status = meta.status,
                code = %meta.code,
                message = %meta.message,
                detail = ?meta.detail,
                trace_id = %meta.trace_id,
                latency_ms,
                "api error"
            );
        } else {
            tracing::warn!(
                method = %method,
                uri = %path,
                status = meta.status,
                code = %meta.code,
                message = %meta.message,
                detail = ?meta.detail,
                trace_id = %meta.trace_id,
                latency_ms,
                "api error"
            );
        }
    } else {
        // 框架层错误（JSON extractor 拒绝、路由 405 等）没有 ApiErrorMeta：
        // 至少把 method/path/status 记下来，避免只剩 TraceLayer 的通用行。
        let status = response.status();
        if status.as_u16() >= 400 && (status.is_server_error() || uri.path().starts_with("/api")) {
            tracing::warn!(
                method = %method,
                uri = %uri.path(),
                status = status.as_u16(),
                code = "FRAMEWORK_ERROR",
                latency_ms,
                "api error (framework)"
            );
        }
    }
    response
}
