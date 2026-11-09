// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! API 错误响应日志。
//!
//! `ApiError::into_response` 会把 `ApiErrorMeta` 挂到响应扩展上；这里在请求
//! 维度补齐 method/uri/latency，并把 code/detail/traceId 一起写进 trace。
//! 框架层拒绝（JSON extractor、405 等）没有 `ApiErrorMeta`，只靠状态码无法定位
//! 原因，因此对**体积已知且很小**的 JSON/text 错误响应额外记录 body 摘要。

use std::time::Instant;

use axum::body::to_bytes;
use axum::extract::Request;
use axum::http::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, TRANSFER_ENCODING};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use http_body::Body as _;

use crate::error::ApiErrorMeta;

/// 只读取不超过该体积的错误响应体。更大的响应一律不碰：错误响应偶尔会带
/// 下载/导出内容，读进来既浪费内存又可能把二进制塞进日志。
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
/// 日志里保留的字符数（按字符截断，避免切出半个 UTF-8）。
const MAX_ERROR_BODY_CHARS: usize = 512;

/// 中间件入口：为 `ApiError` 响应补齐请求维度日志；框架层错误额外读小体积 body。
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
        return response;
    }

    // 框架层错误（JSON extractor 拒绝、路由 405 等）没有 ApiErrorMeta。
    let status = response.status();
    if status.as_u16() < 400 || !(status.is_server_error() || uri.path().starts_with("/api")) {
        return response;
    }

    // 体积用 size_hint 而不是 Content-Length：axum 生成拒绝响应时不会写
    // Content-Length（由 hyper 在序列化阶段补），按头判断会永远跳过。
    // size_hint 只有上下界相等时才敢读——流式/未知长度响应原样放行。
    let exact_len = response.body().size_hint().exact();
    if !is_loggable_error_body(response.headers(), exact_len) {
        log_framework_error(&method, uri.path(), status.as_u16(), None, latency_ms);
        return response;
    }

    let (mut parts, body) = response.into_parts();
    match to_bytes(body, MAX_ERROR_BODY_BYTES).await {
        Ok(bytes) => {
            let excerpt = body_excerpt(&String::from_utf8_lossy(&bytes));
            log_framework_error(
                &method,
                uri.path(),
                status.as_u16(),
                Some(&excerpt),
                latency_ms,
            );
            // 读过的 body 必须原样放回：日志不能改变客户端收到的响应。
            Response::from_parts(parts, axum::body::Body::from(bytes))
        }
        Err(_) => {
            // 只有在 size_hint 与实际长度不一致（上游 bug）时才会走到这里；
            // body 已被消费且无法还原：清掉长度/编码头，避免它们与空 body 冲突。
            log_framework_error(&method, uri.path(), status.as_u16(), None, latency_ms);
            parts.headers.remove(CONTENT_LENGTH);
            parts.headers.remove(CONTENT_ENCODING);
            parts.headers.remove(TRANSFER_ENCODING);
            Response::from_parts(parts, axum::body::Body::empty())
        }
    }
}

/// 记录框架层错误：5xx 用 error，4xx 用 warn；`body` 为已脱敏/截断的响应摘要。
fn log_framework_error(
    method: &axum::http::Method,
    path: &str,
    status: u16,
    body: Option<&str>,
    latency_ms: u128,
) {
    if status >= 500 {
        tracing::error!(
            method = %method,
            uri = %path,
            status,
            body = body.unwrap_or(""),
            latency_ms,
            "api error (framework)"
        );
    } else {
        tracing::warn!(
            method = %method,
            uri = %path,
            status,
            body = body.unwrap_or(""),
            latency_ms,
            "api error (framework)"
        );
    }
}

/// 只有「体积已知、足够小、且是 JSON/文本」的错误响应才值得读 body 进日志。
fn is_loggable_error_body(headers: &HeaderMap, exact_len: Option<u64>) -> bool {
    let small = matches!(exact_len, Some(n) if n > 0 && n <= MAX_ERROR_BODY_BYTES as u64);
    if !small {
        return false;
    }
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // `application/problem+json; charset=utf-8` 这类带参数的 MIME：先去掉参数再判断。
    let mime = content_type.split(';').next().unwrap_or("").trim();
    mime.starts_with("application/json") || mime.starts_with("text/") || mime.ends_with("+json")
}

/// 压成一行、脱敏 URL、按字符截断。JSON 里的换行/缩进进日志只会让一行变十行。
fn body_excerpt(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = redact_quoted_values(&crate::util::url::redact_urls_in_text(&collapsed));
    if cleaned.chars().count() <= MAX_ERROR_BODY_CHARS {
        return cleaned;
    }
    let mut out: String = cleaned.chars().take(MAX_ERROR_BODY_CHARS).collect();
    out.push('…');
    out
}

/// 把双引号内的内容替换为 `*`：axum/serde 的部分错误会回显请求值
/// （如类型错误里的 `"token"`），不能原样写进日志。保留引号与其余原因文本。
fn redact_quoted_values(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_quote = false;
    for ch in text.chars() {
        if ch == '"' {
            out.push(ch);
            in_quote = !in_quote;
            continue;
        }
        out.push(if in_quote { '*' } else { ch });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{HeaderValue, StatusCode};
    use axum::routing::post;
    use axum::Json;
    use axum::Router;
    use tower::ServiceExt;

    fn headers_with_content_type(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn gate_requires_small_known_json_or_text() {
        let json = headers_with_content_type("application/json");
        assert!(is_loggable_error_body(&json, Some(32)));
        assert!(is_loggable_error_body(
            &json,
            Some(MAX_ERROR_BODY_BYTES as u64)
        ));
        // 未知长度（流式）不读。
        assert!(!is_loggable_error_body(&json, None));
        // 超限不读。
        assert!(!is_loggable_error_body(
            &json,
            Some(MAX_ERROR_BODY_BYTES as u64 + 1)
        ));
        // 空 body 不读。
        assert!(!is_loggable_error_body(&json, Some(0)));
        // 二进制不读。
        let bin = headers_with_content_type("application/octet-stream");
        assert!(!is_loggable_error_body(&bin, Some(32)));
        // problem+json 也算 JSON（带 charset 参数也要识别）。
        let problem = headers_with_content_type("application/problem+json; charset=utf-8");
        assert!(is_loggable_error_body(&problem, Some(32)));
    }

    #[test]
    fn excerpt_collapses_lines_and_truncates_on_char_boundary() {
        let raw = "{\n  \"error\": \"invalid JSON\"\n}";
        let out = body_excerpt(raw);
        assert!(!out.contains('\n'), "必须压成一行: {out}");
        assert!(!out.contains("invalid JSON"), "引号内值必须打码: {out}");
        assert!(
            out.starts_with('{') && out.ends_with('}'),
            "整体结构保留: {out}"
        );

        // 中文按字符截断，不能切出半个字符（切字节会产出非法 UTF-8）。
        let long = "错".repeat(MAX_ERROR_BODY_CHARS + 10);
        let out = body_excerpt(&long);
        assert_eq!(out.chars().count(), MAX_ERROR_BODY_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    /// serde 的类型错误会回显请求值，日志里必须打码，只留结构原因。
    #[test]
    fn excerpt_masks_quoted_request_values() {
        let raw = r#"invalid type: string "s3cr3t", expected a map at line 1 column 2"#;
        let out = body_excerpt(raw);
        assert!(!out.contains("s3cr3t"), "实际: {out}");
        assert!(out.contains("invalid type"), "实际: {out}");
        assert!(out.contains("expected a map"), "实际: {out}");
    }

    /// 真实的 `Json` extractor 拒绝也要走同一条日志路径，且响应体保持可读。
    #[tokio::test]
    async fn middleware_handles_real_json_extractor_rejection() {
        async fn json_handler(_: Json<serde_json::Value>) -> &'static str {
            "ok"
        }
        let app = Router::new()
            .route("/api/probe_json", post(json_handler))
            .layer(axum::middleware::from_fn(log_api_errors));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/probe_json")
                    .header("content-type", "application/json")
                    .body(Body::from("{ not json"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("Failed to parse the request body as JSON"),
            "extractor 拒绝原因不能丢: {text}"
        );
    }

    /// 中间件读 body 后必须原样放回：客户端收到的状态码与内容不能变。
    #[tokio::test]
    async fn middleware_preserves_framework_error_response() {
        async fn handler() -> (StatusCode, Json<serde_json::Value>) {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Failed to deserialize the JSON body" })),
            )
        }
        let app = Router::new()
            .route("/api/probe", post(handler))
            .layer(axum::middleware::from_fn(log_api_errors));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/probe")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("Failed to deserialize the JSON body"),
            "响应体被中间件破坏: {text}"
        );
    }
}
