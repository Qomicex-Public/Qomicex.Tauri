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
    // 默认放行 tower_http 的请求日志（Debug 级），实时日志可见前后端通信；
    // RUST_LOG 环境变量可覆盖。
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=debug"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(crate::services::trace::TraceWriter::default())
        .init();
}

#[tokio::main]
async fn main() {
    // 先构建 state（内部注册全局 trace 缓冲），再初始化 tracing 与 stderr 捕获，
    // 保证日志写入有目标可落。
    let state = AppState::build();
    init_tracing();
    crate::services::trace::start_stderr_capture();

    let port = std::env::var("QOMICEX_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    // 预热 mcmod 中文名索引（首个 /mcmod/* 请求不再承担 5.5MB JSON 冷加载）。
    // 在 async 上下文里同步构建会阻塞当前 worker；这里放在 serve 之前的
    // 启动阶段执行，最坏情况只是延迟监听建立，不影响运行时请求。
    endpoints::mcmod::prewarm();

    // 外部管理器已拉起后端时（如 Tauri 开发期附加），可跳过自建监听逻辑的校验提示。
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
