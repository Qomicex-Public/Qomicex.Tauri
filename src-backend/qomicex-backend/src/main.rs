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
    // 默认只开 info 级业务日志；tower_http 请求日志已由 TraceLayer 按 >=400 过滤，
    // 不再全局放行 debug（避免每请求两条 DEBUG 噪音）。RUST_LOG 环境变量可覆盖。
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        // ⚠️ 强制关闭 ANSI 转义码：tracing-subscriber 的 `ansi` feature 会被
        // easytier→kcp-sys 传递启用（`cfg!(feature = "ansi")` 全局求值），导致 fmt
        // 默认向 TraceWriter 输出 `\x1b[32m` 等颜色码，实时日志（/diagnostics/trace）
        // 在前端渲染为错误符号。即使 feature 已启用，`with_ansi(false)` 仍强制禁用。
        .with_ansi(false)
        // 简洁格式：`[2026-08-15 20:14:01.815] [INFO] [module] message`
        // 去掉 span 上下文（request{method=...}）与长 target，日志行可读、便于提取。
        .with_target(false)
        .with_span_events(tracing_subscriber::fmt::format::FmtSpan::NONE)
        .with_writer(crate::services::trace::TraceWriter::default())
        .init();
    // 桥接 `log` crate 事件 → tracing：connector 的 log::info/warn/error! 自动进日志体系。
    tracing_log::LogTracer::init().ok();
}

#[tokio::main]
async fn main() {
    // 控制台代码页默认 936 (GBK)，UTF-8 中文日志输出到控制台会乱码；
    // 启动即切换为 UTF-8 代码页（SetConsoleOutputCP 仅在 Windows 存在）。
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::SetConsoleOutputCP;
        const CP_UTF8: u32 = 65001;
        unsafe {
            SetConsoleOutputCP(CP_UTF8);
        }
    }

    // 先构建 state（内部注册全局 trace 缓冲），再初始化 tracing 与 stdout/stderr 捕获，
    // 保证日志写入有目标可落。
    let state = AppState::build();
    init_tracing();
    crate::services::trace::start_io_capture();

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
