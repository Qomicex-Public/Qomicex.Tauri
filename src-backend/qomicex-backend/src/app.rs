//! 应用路由组装（对应 Program.cs 中 `app.MapXxxEndpoints(...)` 系列 + CORS）。

use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

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
        .merge(endpoints::resource::router())
        .merge(endpoints::resource_center::router())
        .merge(endpoints::resource_download::router())
        .merge(endpoints::instance_files::router())
        .merge(endpoints::auth::router())
        .merge(endpoints::account::router())
        .merge(endpoints::skin::router())
        .route("/ping", get(|| async { "pong" })); // 通用存活探针

    let app = Router::new()
        .nest("/api", api)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .fallback(crate::middleware::not_found::handler)
        .with_state(state);

    app
}
