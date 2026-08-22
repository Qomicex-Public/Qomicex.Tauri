mod app;
mod endpoints;
mod error;
mod ipc;
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
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
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
    // 注册进程级 panic hook（后端崩溃 → 自动上报严重错误日志）。
    crate::services::error_report::install_panic_hook(
        state.settings.clone(),
        state.http_client.clone(),
    );
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

    // IPC 管道：QOMICEX_IPC_PIPE 设置时启用（release 由 Tauri 注入）。
    // QOMICEX_NO_TCP=1 关闭 TCP 监听（release 用，端口彻底消失）；
    // dev/CI 默认保留 TCP 兼容 curl 冒烟与测试脚本。
    let pipe_name = std::env::var("QOMICEX_IPC_PIPE").ok();
    let tcp_enabled = std::env::var("QOMICEX_NO_TCP")
        .map(|v| v != "1")
        .unwrap_or(true);

    // 共享 shutdown：TCP 的 graceful shutdown 与 qipc accept loop 同时退出，
    // 避免双开场景下 tcp_task 结束后 pipe_task 永久挂起（进程无法退出）。
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let shutdown_for_pipe = shutdown_rx.clone();

    let ctrl_c = async move {
        tokio::signal::ctrl_c().await.ok();
        let _ = shutdown_tx.send(true);
    };

    let tcp_task = if tcp_enabled {
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .unwrap_or_else(|e| panic!("绑定后端监听地址 {addr} 失败: {e}"));
        tracing::info!("qomicex-backend listening on http://{addr}");
        let app = app.clone();
        Some(tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(ctrl_c)
                .await
                .expect("axum server error");
        }))
    } else {
        None
    };

    let pipe_task = pipe_name.map(|name| {
        let app = app.clone();
        tokio::spawn(async move {
            if let Err(e) = ipc::serve(app, name, shutdown_for_pipe).await {
                tracing::error!("qipc server failed: {e}");
            }
        })
    });
    drop(app);

    if !tcp_enabled {
        // 无 TCP 时没有 graceful shutdown 触发源，直接监听 Ctrl-C
        tokio::signal::ctrl_c().await.ok();
    }
    if let Some(t) = tcp_task {
        t.await.expect("axum server error");
    }
    if let Some(t) = pipe_task {
        t.await.ok();
    }
}
