mod app;
mod endpoints;
mod error;
mod middleware;
mod models;
mod services;
mod settings;
mod state;
mod util;

use std::net::SocketAddr;

use state::{AppState, DEFAULT_PORT};

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

#[tokio::main]
async fn main() {
    init_tracing();

    let port = std::env::var("QOMICEX_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    // 外部管理器已拉起后端时（如 Tauri 开发期附加），可跳过自建监听逻辑的校验提示。
    let state = AppState::build();
    let app = app::build_router(std::sync::Arc::new(state));

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("绑定后端监听地址 {addr} 失败: {e}"));
    tracing::info!("qomicex-backend listening on http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .expect("axum server error");
}
