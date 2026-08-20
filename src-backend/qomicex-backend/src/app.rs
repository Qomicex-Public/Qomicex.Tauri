//! 应用路由组装（对应 Program.cs 中 `app.MapXxxEndpoints(...)` 系列 + CORS）。

use std::sync::Arc;

use axum::http::Request;
use axum::routing::get;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};
use tracing::Level;

use crate::endpoints;
use crate::state::AppState;

pub fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::permissive();

    let api = Router::new()
        .merge(endpoints::system::router())
        .merge(endpoints::version::router())
        .merge(endpoints::loader::router())
        .merge(endpoints::java::router())
        .merge(endpoints::instance::router())
        .merge(endpoints::instance_logs::router())
        .merge(endpoints::resource::router())
        .merge(endpoints::resource_center::router())
        .merge(endpoints::resource_download::router())
        .merge(endpoints::instance_files::router())
        .merge(endpoints::auth::router())
        .merge(endpoints::account::router())
        .merge(endpoints::skin::router())
        .merge(endpoints::modpack::router())
        .merge(endpoints::announcement::router())
        .merge(endpoints::client_logs::router())
        .merge(endpoints::update::router())
        .merge(endpoints::log::router())
        .merge(endpoints::loganalysis::router())
        .merge(endpoints::mcmod::router())
        .merge(endpoints::launch::router())
        .merge(endpoints::license::router())
        .merge(endpoints::progress_sse::router())
        .merge(endpoints::plugin::router())
        .merge(endpoints::connector::router())
        .route("/ping", get(|| async { "pong" })); // 通用存活探针

    let app = Router::new()
        .nest("/api", api)
        // 独立日志页（非 /api，供系统级浏览器窗口直连）。
        .merge(endpoints::instance_logs::page_router())
        // fallback must be registered BEFORE .layer() so the CORS middleware
        // also wraps 404 responses (otherwise cross-origin errors from
        // unregistered /api/* routes are blocked without CORS headers).
        .fallback(crate::middleware::not_found::handler)
        .layer(cors)
        // 请求日志：正常请求（<400）静默；>=400 记录 ERROR（method/uri/status/latency）。
        // 用闭包实现 OnResponse（tower-http 支持 FnOnce(&Response, Duration, &Span)），
        // 避免 tower_http 默认在 DEBUG 级为每个请求打两条日志淹没业务日志。
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::DEBUG))
                .on_response(
                    |response: &axum::http::Response<axum::body::Body>,
                     latency: std::time::Duration,
                     span: &tracing::Span| {
                        let status = response.status();
                        if status.as_u16() >= 400 {
                            // span 的 debug 输出即 `request{method=GET uri=/api/...}`，
                            // 事件落在 span 上下文内，fmt 会附加字段
                            tracing::event!(
                                parent: span,
                                Level::ERROR,
                                "request failed: status={} latency={}ms",
                                status.as_u16(),
                                latency.as_millis()
                            );
                        }
                    },
                )
                // 连接级错误（无响应）也记录 ERROR
                .on_failure(
                    |error_class: tower_http::classify::ServerErrorsFailureClass,
                     latency: std::time::Duration,
                     span: &tracing::Span| {
                        tracing::event!(
                            parent: span,
                            Level::ERROR,
                            "request failed: {error_class:?} latency={}ms",
                            latency.as_millis()
                        );
                    },
                ),
        )
        .with_state(state);

    app
}
