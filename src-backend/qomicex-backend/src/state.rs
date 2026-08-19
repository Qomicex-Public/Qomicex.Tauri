//! 应用全局状态，在启动时组装（对应 Program.cs 的 DI/Singleton 注册项）。
//!
//! 本阶段先承载：GameCore（复用 qomicex-core）、DownloadManager（复用
//! qomicex-downloader）、数据目录、HTTP 客户端与静态配置。后续各 Endpoint
//! 批次用到的服务（账号/皮肤/整合包/连接器等）再分子模块增量加入。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use qomicex_core::builder::GameCoreBuilder;
use qomicex_core::core::GameCore;
use qomicex_core::models::download::DownloadMirror;
use qomicex_downloader::{DownloadManager, DownloadOptions};
use tokio::sync::RwLock;

use crate::services::account::AccountService;
use crate::services::curseforge_fetch::CurseForgeVersionFetchService;
use crate::services::export_tracker::ExportTaskManager;
use crate::services::install_tracker::InstallTracker;
use crate::services::instance::InstanceService;
use crate::services::instance_group::InstanceGroupService;
use crate::services::launch_tracker::LaunchTracker;
use crate::services::plugin::{FileAuthService, PluginGatewayClient, PluginStore};
use crate::services::trace::{
    init_file_log, FileLog, LogLevelManager, TraceBufferStore, TraceDumpService,
};
use crate::settings;
use crate::settings::SettingsResponse;

pub const DEFAULT_PORT: u16 = 5000;

/// 启动器版本（联机节点服务 UA、vendor 等共用，如 `QML/1.0.0`）。
///
/// 取后端 crate 的 `Cargo.toml` 版本（`env!("CARGO_PKG_VERSION")`，编译期注入）：
/// - 开发期 = `src-backend/qomicex-backend/Cargo.toml` 的 version（当前 0.1.0）；
/// - 发布构建 = `release.yml` 先执行 `scripts/bump-version.mjs <VERSION>` 同步更新该
///   Cargo.toml 的 version，再编译 backend，故 `CARGO_PKG_VERSION` 自动跟随发布版本。
///   对应 C# 旧版 `AssemblyInformationalVersion`（构建时程序集版本）。
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 后端所有出站 HTTP 请求的统一 User-Agent（发布版本自动跟随 CARGO_PKG_VERSION）。
/// 联机节点获取（connector.rs ScaffoldingClient）的 UA 单独为 `QML/{version}`，不受此处约束。
pub const USER_AGENT: &str = concat!("Qomicex.Launcher/", env!("CARGO_PKG_VERSION"));

pub struct AppState {
    /// 游戏核心（复用 qomicex-core-rust）。
    pub core: Arc<GameCore>,
    /// 下载管理器（复用 qomicex-downloader）。用 `ArcSwap` 支持运行时热替换
    /// （切换 HTTP/3 开关时重建并替换，旧管理器进行中的任务被取消）。
    pub download_manager: ArcSwap<DownloadManager>,
    /// 数据目录（AppPaths.BaseDir）。
    pub data_dir: PathBuf,
    /// CurseForge API Key。
    pub curse_forge_api_key: String,
    /// 全局共享 HTTP 客户端。
    pub http_client: reqwest::Client,
    /// 启动器版本串（如 "Qomicex.Launcher/1.0.0"）。
    #[allow(dead_code)]
    pub user_agent: String,
    /// 启动器版本号（major.minor.build）。
    #[allow(dead_code)]
    pub app_version: String,
    /// 游戏实例服务（对应 Program.cs 的 InstanceService）。
    pub instance: Arc<InstanceService>,
    /// 实例自定义分组服务（独立 groups.json）。
    pub instance_groups: Arc<InstanceGroupService>,
    /// 账号持久化服务（对应 AccountService）。
    pub account: Arc<AccountService>,
    /// 内存 trace 缓冲（对应 TraceBufferStore，容量 2000）。
    pub trace_buffer: Arc<TraceBufferStore>,
    /// trace 落盘服务（对应 TraceDumpService）。
    pub trace_dump: Arc<TraceDumpService>,
    /// 日志级别管理（对应 LogLevelManager）。
    #[allow(dead_code)]
    pub log_level: Arc<LogLevelManager>,
    /// 安装任务跟踪（对应 InstallTracker）。
    pub install_tracker: Arc<InstallTracker>,
    /// 导出任务跟踪（异步整合包导出：进度轮询 + 取消 + 产物保存）。
    pub export_tasks: Arc<ExportTaskManager>,
    /// 启动进程跟踪（对应 LaunchTracker）。
    pub launch_tracker: Arc<LaunchTracker>,
    /// 插件商店（对应 PluginStore）。
    pub plugin_store: Arc<PluginStore>,
    /// 插件文件授权（对应 FileAuthService）。
    pub plugin_auth: Arc<FileAuthService>,
    /// WASM 网关桥接客户端（对应 PluginGatewayClient）。
    pub plugin_gateway: Arc<PluginGatewayClient>,
    /// 插件 proxy 专用 HTTP 客户端（对应命名 HttpClient "PluginProxy"）。
    pub proxy_client: reqwest::Client,
    /// 当前设置（内存缓存，PUT /settings 时同步更新）。
    pub settings: Arc<RwLock<SettingsResponse>>,
    /// CurseForge 版本异步拉取服务（对应 CurseForgeVersionFetchService）。
    pub curseforge_fetch: Arc<CurseForgeVersionFetchService>,
}

impl AppState {
    pub fn build() -> Self {
        let settings_now = settings::load_settings();
        let game_root = std::path::Path::new(&settings_now.game_dir)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&settings_now.game_dir));
        let app_version = APP_VERSION.to_string();
        let user_agent = USER_AGENT.to_string();
        let curse_forge_api_key = std::env::var("CURSEFORGE_API_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(embedded_cf_api_key);
        let microsoft_client_id = std::env::var("MICROSOFT_CLIENT_ID")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(embedded_ms_client_id);
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

        let mods_icon_dir = settings::resolve_base_dir().join("QML").join("mod-icons");
        let _ = std::fs::create_dir_all(&mods_icon_dir);

        let mut builder = GameCoreBuilder::new();
        builder
            .configure(|o| {
                o.launcher_name = "QML".to_string();
                o.game_root = game_root.to_string_lossy().into_owned();
                o.max_concurrent_downloads = 8;
                o.cache_expiry = Duration::from_secs(1800);
                o.user_agent = user_agent.clone();
                o.icon_cache_dir = Some(mods_icon_dir.to_string_lossy().into_owned());
            })
            .use_microsoft_auth(microsoft_client_id)
            .use_download_mirror(global_mirror)
            .with_http_client(http_client.clone())
            .with_icon_cache_dir(mods_icon_dir);
        let core = builder.build();

        // 下载管理器（对应 DownloadSessionManagerBuilder 的核心参数）。
        // 显式传入统一 UA，避免 fallback 到 downloader 库默认（qomicex-downloader/0.1.0）。
        // enable_http3 / http3_fallback 跟随设置：HTTP/3 开启时强制不回退（实验性）。
        let download_manager = new_download_manager(&settings_now);

        // 插件 proxy 客户端（对应命名 HttpClient "PluginProxy"）。
        let proxy_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent(user_agent.clone())
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("构建插件代理 HTTP 客户端失败");

        // 共享后端服务（对应 Program.cs 中 Singleton 注册）。
        let instance = Arc::new(InstanceService::new());
        let instance_groups = Arc::new(InstanceGroupService::new());
        let account = Arc::new(AccountService::new().unwrap_or_default());
        let trace_buffer = Arc::new(TraceBufferStore::default());
        // 注册为全局 trace 缓冲：实时日志（TraceWriter / stderr 捕获）写入此处
        crate::services::trace::init_global_trace(trace_buffer.clone());
        // 文件日志：trace 行持续落盘（崩溃/重启后日志仍在）
        init_file_log(Arc::new(FileLog::new()));
        let trace_dump = Arc::new(TraceDumpService::new(trace_buffer.clone()));

        // 启动时套用已保存的日志级别（对应 Program.cs 中 levelManager.SetLevel）。
        let log_level = Arc::new(LogLevelManager::default());
        let saved_log = settings_now
            .log_level
            .clone()
            .unwrap_or_else(|| "info".to_string());
        log_level.set_level(saved_log);

        let install_tracker = Arc::new(InstallTracker::new(core.clone()));
        let launch_tracker = Arc::new(LaunchTracker::new());
        let export_tasks = Arc::new(ExportTaskManager::new());

        let plugin_store = Arc::new(PluginStore::new());
        let plugin_auth = Arc::new(FileAuthService::new());
        let plugin_gateway = Arc::new(PluginGatewayClient::new(http_client.clone()));
        let settings = Arc::new(RwLock::new(settings_now.clone()));
        let curseforge_fetch = CurseForgeVersionFetchService::new_with_config(
            http_client.clone(),
            curse_forge_api_key.clone(),
            settings_now.curseforge_fetch_config(),
        );

        Self {
            core,
            download_manager: ArcSwap::from(download_manager),
            data_dir: settings::resolve_base_dir(),
            curse_forge_api_key,
            http_client,
            user_agent,
            app_version,
            instance,
            instance_groups,
            account,
            trace_buffer,
            trace_dump,
            log_level,
            install_tracker,
            launch_tracker,
            export_tasks,
            plugin_store,
            plugin_auth,
            plugin_gateway,
            proxy_client,
            settings,
            curseforge_fetch,
        }
    }

    /// 运行时重建并热替换下载管理器（切换 HTTP/3 开关时调用）。
    /// 旧管理器在无引用后释放，其进行中的任务被取消。
    pub fn replace_download_manager(&self, settings: &SettingsResponse) {
        self.download_manager.store(new_download_manager(settings));
    }
}

/// 下载管理器并发上限（worker 级全局最大任务数）。
const DOWNLOAD_CONCURRENCY: usize = 64;

/// 按设置构造下载管理器，并挂接 downloader 日志转发到 trace 体系。
fn new_download_manager(settings: &SettingsResponse) -> Arc<DownloadManager> {
    let enable_http3 = settings.enable_http3.unwrap_or(false);
    let dm = Arc::new(DownloadManager::new(
        DownloadOptions {
            user_agent: USER_AGENT.to_string(),
            // 关闭：enable_http3=false → 只建 h2 client，完全不用 HTTP/3，强制 HTTP/2。
            // 开启：enable_http3=true → 优先 HTTP/3，http3_fallback=true → 服务器不支持
            // QUIC 时自动回退 HTTP/2（下载器默认回退行为）。
            enable_http3,
            http3_fallback: true,
            ..Default::default()
        },
        DOWNLOAD_CONCURRENCY,
    ));
    spawn_downloader_log_forward(&dm);
    dm
}

/// 下载器日志事件（重试/看门狗/降级等）转发进日志体系：qomicex-downloader
/// 不直接输出，事件只发给订阅者；这里对每个 manager 订阅一次，`DownloadEvent::Log`
/// 按级别写入 trace 缓冲 + 落盘。
fn spawn_downloader_log_forward(dm: &Arc<DownloadManager>) {
    let dm = dm.clone();
    tokio::spawn(async move {
        let mut rx = dm.subscribe();
        loop {
            match rx.recv().await {
                Ok(qomicex_downloader::DownloadEvent::Log { level, message }) => {
                    let line = format!("[downloader:{level:?}] {message}");
                    crate::services::trace::trace_append(line);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });
}

/// Fallback CurseForge API key read from the (embedded) `appsettings.json`
/// `CurseForge:ApiKey`, matching the previous C# backend's configuration
/// source. The repo-default value is a placeholder that CurseForge rejects; a
/// real key is injected via `CURSEFORGE_API_KEY` (or by deploying a real
/// appsettings).
fn embedded_cf_api_key() -> String {
    const APP_SETTINGS: &str = include_str!("../appsettings.json");
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

/// Fallback Microsoft OAuth client id from the embedded `appsettings.json`
/// `Microsoft:ClientId` (matches the previous C# `Microsoft:ClientId`, required
/// for the device-code login flow). Overridable via `MICROSOFT_CLIENT_ID`.
fn embedded_ms_client_id() -> String {
    const APP_SETTINGS: &str = include_str!("../appsettings.json");
    serde_json::from_str::<serde_json::Value>(APP_SETTINGS)
        .ok()
        .and_then(|v| {
            v.get("Microsoft")
                .and_then(|c| c.get("ClientId"))
                .and_then(|k| k.as_str())
                .map(String::from)
        })
        .unwrap_or_default()
}

pub type SharedState = Arc<AppState>;
