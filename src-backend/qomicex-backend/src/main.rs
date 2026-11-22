// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

mod app;
// 开发期 `.env` 加载（issue #159 / PR #170）：`#[cfg]` 限定为 debug 专属，
// release 的凭据由 CI/发布流水线在构建期经 `CURSEFORGE_API_KEY` 注入并编译进产物，
// 不得再去读用户机器上意外存在的 `.env`（那会让发布行为依赖进程工作目录）。
#[cfg(debug_assertions)]
mod dev_env;
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
    // 格式由 `services::log_format::UnifiedFormat` 全权决定（时间戳 + 级别 + service +
    // startup_id），因此 with_ansi/with_target 这些默认格式器的选项在此不再适用；
    // 该格式器不输出任何 ANSI 转义码。
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(crate::services::trace::TraceWriter::default())
        .event_format(crate::services::log_format::UnifiedFormat)
        .init();
    // 桥接 `log` crate 事件 → tracing：connector 的 log::info/warn/error! 自动进日志体系。
    tracing_log::LogTracer::init().ok();
}

/// 启动阶段跟踪：正常结束走 [`Startup::ready`]；中途 panic / 提前返回时 `Drop`
/// 补一条 `app_start_failed`，并带上当时所处的阶段 —— 否则启动卡死时无从判断卡在哪。
struct Startup {
    started: std::time::Instant,
    stage: &'static str,
    ready: bool,
}

impl Startup {
    fn begin() -> Self {
        Self {
            started: std::time::Instant::now(),
            stage: "init",
            ready: false,
        }
    }

    fn stage(&mut self, stage: &'static str) {
        self.stage = stage;
        // INFO 而非 DEBUG：启动只有 5 个阶段，日志量可忽略，但这几行是启动卡住时唯一
        // 能定位"卡在哪一步"的线索（默认级别下 DEBUG 看不见）。
        tracing::info!(
            event = "app_stage",
            stage,
            elapsed_ms = self.elapsed_ms(),
            "启动阶段"
        );
    }

    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn ready(&mut self, listen: &str) {
        self.ready = true;
        tracing::info!(
            event = "app_ready",
            listen,
            duration_ms = self.elapsed_ms(),
            "启动完成"
        );
    }

    /// 显式失败：落一条 `app_start_failed` 并标记已收尾（避免 `Drop` 再打一条）。
    fn fail(&mut self, stage: &'static str) {
        self.stage = stage;
        self.ready = true;
        tracing::error!(
            event = "app_start_failed",
            stage,
            duration_ms = self.elapsed_ms(),
            "启动失败"
        );
    }
}

impl Drop for Startup {
    fn drop(&mut self) {
        if !self.ready {
            tracing::error!(
                event = "app_start_failed",
                stage = self.stage,
                duration_ms = self.elapsed_ms(),
                "启动失败"
            );
        }
    }
}

/// 启动环境快照：出问题时先看这一行，确认版本、路径、资源与监听方式。
fn log_app_starting(state: &AppState, port: u16, pipe: Option<&str>, tcp_enabled: bool) {
    let (total_mb, available_mb) = crate::util::sysinfo::memory();
    let settings = state.settings.try_read().ok();
    let game_dir = settings
        .as_ref()
        .map(|s| s.game_dir.clone())
        .unwrap_or_default();
    let log_level = settings
        .as_ref()
        .and_then(|s| s.log_level.clone())
        .unwrap_or_else(|| "info".to_string());
    tracing::info!(
        event = "app_starting",
        version = env!("CARGO_PKG_VERSION"),
        pid = std::process::id(),
        os = crate::util::sysinfo::os_name(),
        os_display = %crate::util::sysinfo::os_display_name(),
        arch = crate::util::sysinfo::architecture(),
        data_dir = %state.data_dir.display(),
        game_dir = %game_dir,
        home_dir = %std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from)
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        cwd = %std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        cpu = %crate::util::sysinfo::cpu_brand(),
        memory_total_mb = total_mb,
        memory_available_mb = available_mb,
        log_level = %log_level,
        tcp_enabled,
        port,
        ipc_pipe = pipe.unwrap_or(""),
        "后端启动"
    );
}

#[tokio::main]
async fn main() {
    let mut startup = Startup::begin();

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

    // 开发期先从 `.env.local` / `.env` 注入环境变量（issue #159 / PR #170）：
    // `appsettings.json` 改为构建期生成后本地 dev 默认没有 CurseForge key，相关
    // 功能静默降级；`AppState::build()` 的取值顺序是「运行时环境变量非空优先，
    // 否则回退编译期嵌入值」，故必须**在它之前**加载。debug-only（见模块声明）。
    #[cfg(debug_assertions)]
    crate::dev_env::load();

    // 日志 sink 与 tracing 必须在**构建 state 之前**就位：AppState::build 里任何
    // panic 都要能落一条 app_start_failed（Startup 的 Drop）+ 原始 panic 文本
    // （stdout/stderr 捕获）。注册晚了一步，这批最早的启动事件就静默丢失。
    crate::services::trace::ensure_sinks();
    init_tracing();
    crate::services::trace::start_io_capture();

    startup.stage("state");
    let state = AppState::build();
    // 注册进程级 panic hook（后端崩溃 → 自动上报严重错误日志）。
    crate::services::error_report::install_panic_hook(
        state.settings.clone(),
        state.http_client.clone(),
    );

    let port = std::env::var("QOMICEX_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    // IPC 管道：QOMICEX_IPC_PIPE 设置时启用（release 由 Tauri 注入）。
    // QOMICEX_NO_TCP=1 关闭 TCP 监听（release 用，端口彻底消失）；
    // dev/CI 默认保留 TCP 兼容 curl 冒烟与测试脚本。
    let pipe_name = std::env::var("QOMICEX_IPC_PIPE").ok();
    let tcp_enabled = std::env::var("QOMICEX_NO_TCP")
        .map(|v| v != "1")
        .unwrap_or(true);
    log_app_starting(&state, port, pipe_name.as_deref(), tcp_enabled);

    // 预热 mcmod 中文名索引（首个 /mcmod/* 请求不再承担 5.5MB JSON 冷加载）。
    // 在 async 上下文里同步构建会阻塞当前 worker；这里放在 serve 之前的
    // 启动阶段执行，最坏情况只是延迟监听建立，不影响运行时请求。
    startup.stage("prewarm");
    endpoints::mcmod::prewarm();

    // 崩溃恢复：进程在「整合包原地更新」的应用阶段被杀死会留下半更新实例。
    // 扫描各实例的 update-journal.json，状态停留在 applying 的立即回滚
    // （issue #118）。必须在开始服务之前做完 —— 否则用户可能先操作到
    // 一个半更新的实例。
    startup.stage("rollback");
    let rolled_back = crate::services::modpack_update::rollback_pending_updates(&state.instance);
    if rolled_back > 0 {
        tracing::warn!(count = rolled_back, "启动时已回滚未完成的整合包更新");
    }

    // 联机中继节点：有自定义节点时，初始客户端只用「自定义 + 内建默认官方节点」
    // （`OnceLock` 初始化不能 await）。这里在 async 上下文里后台换成带**线上最新
    // 官方列表**的客户端（issue #112 评审 finding）。空闲时才换，联机中则跳过。
    endpoints::connector::spawn_startup_relay_refresh();

    // 外部管理器已拉起后端时（如 Tauri 开发期附加），可跳过自建监听逻辑的校验提示。
    startup.stage("router");
    let app = app::build_router(std::sync::Arc::new(state));

    // 共享 shutdown：TCP 的 graceful shutdown 与 qipc accept loop 同时退出，
    // 避免双开场景下 tcp_task 结束后 pipe_task 永久挂起（进程无法退出）。
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let shutdown_for_pipe = shutdown_rx.clone();

    // 父进程看护：启动器崩溃 / 被任务管理器结束 / 更新器替换进程时，它来不及执行
    // RunEvent::Exit 里的 kill，后端必须自己退出。否则每遇到一次就留一个僵尸后端，
    // 堆积后新启动器连不上自己的管道，所有 API 502
    // （见 services/parent_watch.rs）。
    {
        let tx = shutdown_tx.clone();
        crate::services::parent_watch::spawn_guard(move || {
            tracing::warn!("父进程已退出，后端随之关闭");
            let _ = tx.send(true);
        });
    }

    // Ctrl-C 也并入同一条 shutdown 通道：无 TCP 时 main 等的是 shutdown 而不是
    // ctrl_c 本身（见下方），若这里不联动，Ctrl-C 就再也无法让后端退出。
    {
        let tx = shutdown_tx.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = tx.send(true);
            }
        });
    }

    startup.stage("listen");
    let tcp_task = if tcp_enabled {
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .unwrap_or_else(|e| panic!("绑定后端监听地址 {addr} 失败: {e}"));
        tracing::info!("qomicex-backend listening on http://{addr}");
        let app = app.clone();
        let shutdown_for_tcp = shutdown_rx.clone();
        Some(tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let mut rx = shutdown_for_tcp;
                    if !*rx.borrow() {
                        let _ = rx.changed().await;
                    }
                })
                .await
                .expect("axum server error");
        }))
    } else {
        None
    };

    let listen = match (tcp_enabled, pipe_name.as_deref()) {
        (true, Some(p)) => format!("http://{addr} + ipc:{p}"),
        (true, None) => format!("http://{addr}"),
        (false, Some(p)) => format!("ipc:{p}"),
        (false, None) => "none".to_string(),
    };

    // qipc 的 socket/管道在 task 内建立，绑定失败必须算**启动失败**：
    // 先等 task 给出「已监听」信号再报 app_ready，否则日志里会是
    // 「启动完成」紧跟一条「qipc server failed」，而 release 只有 IPC 一条通道，
    // 后端实际不可用。
    let (ipc_ready_tx, ipc_ready_rx) = tokio::sync::oneshot::channel::<()>();
    let has_ipc = pipe_name.is_some();
    let pipe_task = pipe_name.map(|name| {
        let app = app.clone();
        tokio::spawn(async move {
            match ipc::serve_with_ready(app, name, shutdown_for_pipe, Some(ipc_ready_tx)).await {
                Ok(()) => {}
                Err(e) => tracing::error!(
                    event = "qipc_server_failed",
                    err = %e,
                    "qipc server failed"
                ),
            }
        })
    });
    if has_ipc && ipc_ready_rx.await.is_err() {
        startup.fail("listen");
        std::process::exit(1);
    }
    startup.ready(&listen);

    drop(app);

    if !tcp_enabled {
        // 无 TCP 时没有 axum 的 graceful shutdown 作为等待点，但**不能直接 await
        // ctrl_c**：父进程消失时看护发的是 shutdown 信号，Ctrl-C 永远不会来，main
        // 会滞留在这一行，进程不退出（服务已停但进程还在 —— 正是要消除的僵尸形态）。
        // 这里改为等 shutdown 通道，把 Ctrl-C 也并入同一个信号源。
        let mut rx = shutdown_rx.clone();
        if !*rx.borrow() {
            let _ = rx.changed().await;
        }
    }
    if let Some(t) = tcp_task {
        t.await.expect("axum server error");
    }
    if let Some(t) = pipe_task {
        t.await.ok();
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    #[test]
    fn unfinished_startup_logs_app_start_failed_with_stage() {
        let out = crate::services::log_format::test_support::capture(|| {
            let mut startup = Startup::begin();
            startup.stage("listen");
            // 未调用 ready() 即离开作用域 = 启动失败
        });
        assert!(out.contains("ERROR [backend]"), "{out}");
        assert!(out.contains("event=app_start_failed"), "{out}");
        assert!(out.contains("stage=listen"), "{out}");
        assert!(out.contains("duration_ms="), "{out}");
    }

    #[test]
    fn ready_startup_skips_the_failure_line() {
        let out = crate::services::log_format::test_support::capture(|| {
            let mut startup = Startup::begin();
            startup.stage("listen");
            startup.ready("http://127.0.0.1:5000");
        });
        assert!(out.contains("event=app_ready"), "{out}");
        assert!(!out.contains("app_start_failed"), "{out}");
    }
}
