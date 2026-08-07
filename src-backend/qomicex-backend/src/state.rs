//! 应用全局状态，在启动时组装（对应 Program.cs 的 DI/Singleton 注册项）。
//!
//! 本阶段先承载：GameCore（复用 qomicex-core）、DownloadManager（复用
//! qomicex-downloader）、数据目录、HTTP 客户端与静态配置。后续各 Endpoint
//! 批次用到的服务（账号/皮肤/整合包/连接器等）再分子模块增量加入。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use qomicex_core::builder::GameCoreBuilder;
use qomicex_core::core::GameCore;
use qomicex_core::models::download::DownloadMirror;
use qomicex_downloader::{DownloadManager, DownloadOptions};

use crate::services::account::AccountService;
use crate::services::install_tracker::InstallTracker;
use crate::services::instance::InstanceService;
use crate::services::trace::{LogLevelManager, TraceBufferStore, TraceDumpService};
use crate::settings;

pub const DEFAULT_PORT: u16 = 5000;

pub struct AppState {
    /// 游戏核心（复用 qomicex-core-rust）。
    pub core: Arc<GameCore>,
    /// 下载管理器（复用 qomicex-downloader）。
    pub download_manager: Arc<DownloadManager>,
    /// 数据目录（AppPaths.BaseDir）。
    pub data_dir: PathBuf,
    /// CurseForge API Key。
    pub curse_forge_api_key: String,
    /// 全局共享 HTTP 客户端。
    pub http_client: reqwest::Client,
    /// 启动器版本串（如 "Qomicex.Launcher/1.0.0"）。
    pub user_agent: String,
    /// 启动器版本号（major.minor.build）。
    pub app_version: String,
    /// 游戏实例服务（对应 Program.cs 的 InstanceService）。
    pub instance: Arc<InstanceService>,
    /// 账号持久化服务（对应 AccountService）。
    pub account: Arc<AccountService>,
    /// 内存 trace 缓冲（对应 TraceBufferStore，容量 2000）。
    pub trace_buffer: Arc<TraceBufferStore>,
    /// trace 落盘服务（对应 TraceDumpService）。
    pub trace_dump: Arc<TraceDumpService>,
    /// 日志级别管理（对应 LogLevelManager）。
    pub log_level: Arc<LogLevelManager>,
    /// 安装任务跟踪（对应 InstallTracker）。
    pub install_tracker: Arc<InstallTracker>,
}

impl AppState {
    pub fn build() -> Self {
        let settings_now = settings::load_settings();
        let game_root = std::path::Path::new(&settings_now.game_dir)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&settings_now.game_dir));
        let app_version = "1.0.0".to_string();
        let user_agent = format!("Qomicex.Launcher/{}", app_version);
        let curse_forge_api_key = std::env::var("CURSEFORGE_API_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(embedded_cf_api_key);
        let microsoft_client_id = std::env::var("MICROSOFT_CLIENT_ID").unwrap_or_default();
        let global_mirror = if settings_now.download_source == 1 {
            DownloadMirror::Bmclapi
        } else {
            DownloadMirror::Official
        };

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(&user_agent)
            .build()
            .expect("构建共享 HTTP 客户端失败");

        let mut builder = GameCoreBuilder::new();
        builder
            .configure(|o| {
                o.launcher_name = "QML".to_string();
                o.game_root = game_root.to_string_lossy().into_owned();
                o.max_concurrent_downloads = 8;
                o.cache_expiry = Duration::from_secs(1800);
                o.user_agent = user_agent.clone();
            })
            .use_microsoft_auth(microsoft_client_id)
            .use_download_mirror(global_mirror)
            .with_http_client(http_client.clone());
        let core = builder.build();

        // 下载管理器（对应 DownloadSessionManagerBuilder 的核心参数）。
        let download_manager = Arc::new(DownloadManager::new(DownloadOptions::default(), 64));

        // 共享后端服务（对应 Program.cs 中 Singleton 注册）。
        let instance = Arc::new(InstanceService::new());
        let account = Arc::new(AccountService::new().unwrap_or_default());
        let trace_buffer = Arc::new(TraceBufferStore::default());
        let trace_dump = Arc::new(TraceDumpService::new(trace_buffer.clone()));

        // 启动时套用已保存的日志级别（对应 Program.cs 中 levelManager.SetLevel）。
        let log_level = Arc::new(LogLevelManager::default());
        let saved_log = settings_now
            .log_level
            .clone()
            .unwrap_or_else(|| "info".to_string());
        log_level.set_level(saved_log);

        let install_tracker = Arc::new(InstallTracker::new(core.clone()));

        Self {
            core,
            download_manager,
            data_dir: settings::resolve_base_dir(),
            curse_forge_api_key,
            http_client,
            user_agent,
            app_version,
            instance,
            account,
            trace_buffer,
            trace_dump,
            log_level,
            install_tracker,
        }
    }
}

/// Fallback CurseForge API key read from the (embedded) C# `appsettings.json`
/// `CurseForge:ApiKey`, matching the C# backend's configuration source. The
/// repo-default value is a placeholder that CurseForge rejects; a real key is
/// injected via `CURSEFORGE_API_KEY` (or by deploying a real appsettings).
fn embedded_cf_api_key() -> String {
    const APP_SETTINGS: &str =
        include_str!("../../Qomicex.Launcher.Backend.Neo/appsettings.json");
    serde_json::from_str::<serde_json::Value>(APP_SETTINGS)
        .ok()
        .and_then(|v| {
            v.get("CurseForge")
                .and_then(|c| c.get("ApiKey"))
                .and_then(|k| k.as_str())
                .map(String::from)
        })
        .unwrap_or_default()
}

pub type SharedState = Arc<AppState>;
