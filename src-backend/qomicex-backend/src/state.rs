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
}

impl AppState {
    pub fn build() -> Self {
        let settings_now = settings::load_settings();
        let game_root = std::path::Path::new(&settings_now.game_dir)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&settings_now.game_dir));
        let app_version = "1.0.0".to_string();
        let user_agent = format!("Qomicex.Launcher/{}", app_version);
        let curse_forge_api_key = std::env::var("CURSEFORGE_API_KEY").unwrap_or_default();
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

        Self {
            core,
            download_manager,
            data_dir: settings::resolve_base_dir(),
            curse_forge_api_key,
            http_client,
            user_agent,
            app_version,
        }
    }
}

pub type SharedState = Arc<AppState>;
