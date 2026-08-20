//! 设置持久化 + 数据目录解析（对应源 Common/AppPaths.cs + JsonContext/SettingsResponse）。
//!
//! BaseDir 解析顺序（与源 ResolveBaseDir 一致）：
//!   1. `QOMICEX_HOME` 环境变量
//!   2. 引导文件 `{LocalAppData}/qomicex-launcher/.qomicex-bootstrap` 内容
//!   3. 默认 `{LocalAppData}/qomicex-launcher`

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const APP_DIR: &str = "qomicex-launcher";
const BOOTSTRAP_FILE: &str = ".qomicex-bootstrap";

/// 代理模式默认值：使用系统代理（与旧版 reqwest 默认行为一致）。
/// 供 `#[serde(default)]` 在老配置文件缺失字段时使用。
fn default_proxy_mode() -> String {
    "system".to_string()
}

fn local_app_data_root() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| std::env::temp_dir())
}

fn default_dir() -> PathBuf {
    local_app_data_root().join(APP_DIR)
}

fn bootstrap_file() -> PathBuf {
    default_dir().join(BOOTSTRAP_FILE)
}

/// 解析数据目录（header 注释顺序）。
pub fn resolve_base_dir() -> PathBuf {
    if let Ok(env) = std::env::var("QOMICEX_HOME") {
        if !env.trim().is_empty() {
            return PathBuf::from(env);
        }
    }
    if let Ok(content) = std::fs::read_to_string(bootstrap_file()) {
        let custom = content.trim();
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    default_dir()
}

/// 通过写引导文件修改数据目录（对应 SetBaseDir）。
pub fn set_base_dir(path: impl AsRef<std::path::Path>) -> std::io::Result<()> {
    let bootstrap = bootstrap_file();
    if let Some(parent) = bootstrap.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        bootstrap,
        path.as_ref().as_os_str().to_string_lossy().as_bytes(),
    )
}

/// 插件目录（对应 AppPaths.PluginsDir）。
pub fn plugins_dir() -> PathBuf {
    resolve_base_dir().join("plugins")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    pub game_dir: String,
    pub download_threads: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_chunk_threads: Option<i32>,
    pub version_isolation: bool,
    pub close_after_launch: bool,
    pub memory_mode: Option<String>,
    pub default_max_memory: i32,
    pub jvm_args: String,
    pub language: String,
    pub default_java_path: String,
    pub download_source: i32,
    pub auto_select_download_source: Option<bool>,
    pub mod_mirror: i32,
    pub auto_select_mod_mirror: Option<bool>,
    /// 资源（mod 文件 CDN）下载源：0 = 官方源（直连原 CDN）；1 = QML Mirror（把
    /// `cdn.modrinth.com`/`cdn-alt.modrinth.com` → `modrinth.lenmei233.dpdns.org`、
    /// `mediafilez.forgecdn.net` → `mirror.lenmei233.dpdns.org`）。老配置缺失时默认 0。
    #[serde(default)]
    pub file_download_source: i32,
    /// 自动选择资源（文件 CDN）下载源：`true` = 自动选当前延迟最低的可用源。
    pub auto_select_file_download_source: Option<bool>,
    pub download_timeout: i32,
    pub animations_enabled: Option<bool>,
    pub animation_speed: Option<i32>,
    pub max_frame_rate: Option<i32>,
    pub background_image: Option<String>,
    pub background_random: Option<bool>,
    pub bg_overlay_opacity: Option<i32>,
    pub bg_blur: Option<i32>,
    pub watermark_enabled: Option<bool>,
    pub watermark_text: Option<String>,
    pub watermark_subtext: Option<String>,
    pub directories: Option<Vec<String>>,
    pub custom_java_runtimes: Option<Vec<CustomJavaEntryDto>>,
    pub theme: Option<String>,
    pub log_level: Option<String>,
    pub translation_provider: String,
    pub bing_api_key: Option<String>,
    pub corner_radius: i32,
    pub window_corners: bool,
    pub curseforge_version_fetch_concurrency: i32,
    pub curseforge_version_cache_ttl_seconds: i32,
    /// 全局 UI 自定义字体家族名；None/空 = 系统默认字体。
    pub font_family: Option<String>,
    /// 是否已完成首次启动初始化向导。`Some(false)` = 新安装待初始化；
    /// 老配置文件缺失该字段时在 [`load_settings`] 中视为已初始化（`Some(true)`），
    /// 避免老用户升级后被迫重走向导。
    pub initialized: Option<bool>,
    /// 自动上报严重错误日志（崩溃类恶性 bug）。`None` 视为开启（默认开）；
    /// 关闭时前后端都不上报。
    pub auto_report_errors: Option<bool>,
    /// 启用 HTTP/3 文件下载（实验性）。`None`/`Some(false)` = 关闭（默认，走 HTTP/2）；
    /// `Some(true)` = 下载强制走 HTTP/3 且不支持回退（服务器不支持则下载失败）。
    /// 需后端以 `http3` feature + `--cfg reqwest_unstable` 编译才真正生效。
    pub enable_http3: Option<bool>,
    /// 代理模式：`"off"` = 不使用代理；`"system"` = 使用系统代理（环境变量，reqwest 默认行为）；
    /// `"http"` = 自定义 HTTP(S) 代理；`"socks5"` = SOCKS5 代理。
    /// 老配置文件缺失时默认 `"system"`（与旧版默认行为一致，`#[serde(default)]`）。
    #[serde(default = "default_proxy_mode")]
    pub proxy_mode: String,
    /// 代理地址（`host:port`，如 `127.0.0.1:7890`）。`proxy_mode` 为 `"http"`/`"socks5"` 时生效。
    /// 老配置文件缺失时默认为空（`#[serde(default)]`）。
    #[serde(default)]
    pub proxy_host: String,
    /// 忽略 SSL 证书校验（跳过 TLS 证书验证）。`None`/`Some(false)` = 校验（默认安全）；
    /// `Some(true)` = 不校验（仅用于自签/内网代理等场景，慎用）。
    pub ignore_ssl_cert: Option<bool>,
    /// 强制所有下载走 HTTP/1.1 并行连接（每个文件独立 TCP 连接）。
    /// `true` = 强制 H1（所有来源）；`false`（默认）= 按来源自动路由：Modrinth 等
    /// 按连接限速的 CDN 自动走 H1 并行，其余源（Mojang/BMCLAPI/CurseForge 等）走 HTTP/2。
    #[serde(default)]
    pub http1_parallel: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomJavaEntryDto {
    pub name: String,
    pub path: String,
    pub version: String,
    pub version_id: i32,
    #[serde(rename = "type")]
    pub type_: String,
    pub arch: String,
    pub state: String,
}

impl Default for SettingsResponse {
    fn default() -> Self {
        let default_dir = dirs::home_dir()
            .map(|h| h.join(".minecraft").to_string_lossy().into_owned())
            .unwrap_or_else(|| ".minecraft".to_string());
        Self {
            game_dir: default_dir,
            download_threads: 64,
            file_chunk_threads: None,
            version_isolation: true,
            close_after_launch: false,
            memory_mode: Some("auto".to_string()),
            default_max_memory: 4096,
            jvm_args: String::new(),
            language: "zh-CN".to_string(),
            default_java_path: String::new(),
            download_source: 0,
            auto_select_download_source: None,
            mod_mirror: 0,
            auto_select_mod_mirror: None,
            file_download_source: 0,
            auto_select_file_download_source: None,
            download_timeout: 15,
            animations_enabled: None,
            animation_speed: None,
            max_frame_rate: None,
            background_image: None,
            background_random: None,
            bg_overlay_opacity: None,
            bg_blur: None,
            watermark_enabled: None,
            watermark_text: None,
            watermark_subtext: None,
            directories: None,
            custom_java_runtimes: None,
            theme: None,
            log_level: Some("info".to_string()),
            translation_provider: "mymemory".to_string(),
            bing_api_key: None,
            corner_radius: 8,
            window_corners: true,
            curseforge_version_fetch_concurrency: 10,
            curseforge_version_cache_ttl_seconds: 300,
            font_family: None,
            initialized: Some(false),
            auto_report_errors: Some(true),
            enable_http3: None,
            proxy_mode: "system".to_string(),
            proxy_host: String::new(),
            ignore_ssl_cert: None,
            http1_parallel: false,
        }
    }
}

fn settings_path() -> PathBuf {
    resolve_base_dir().join("QML").join("settings.json")
}

/// CurseForge 版本拉取相关的取值范围。与前端 Settings 页面的 min/max 保持一致。
pub const CF_FETCH_CONCURRENCY_RANGE: (i32, i32) = (1, 20);
pub const CF_CACHE_TTL_SECONDS_RANGE: (i32, i32) = (0, 3600);

impl SettingsResponse {
    /// 把数值型设置钳到合法区间。
    ///
    /// 必须在落盘与投入使用之前调用：这些值会被拿去构造 `Semaphore` 和 `Duration`，
    /// 而负的 i32 转成 usize 是个天文数字，会让 `Semaphore::new` 直接 panic。
    /// 前端虽然也钳了，但 settings.json 可手改、本地 HTTP API 也能被插件直接调用。
    pub fn clamp_numeric_ranges(&mut self) {
        let (lo, hi) = CF_FETCH_CONCURRENCY_RANGE;
        self.curseforge_version_fetch_concurrency =
            self.curseforge_version_fetch_concurrency.clamp(lo, hi);
        let (lo, hi) = CF_CACHE_TTL_SECONDS_RANGE;
        self.curseforge_version_cache_ttl_seconds =
            self.curseforge_version_cache_ttl_seconds.clamp(lo, hi);
    }

    /// 导出 CurseForge 拉取服务的配置。取值已按 [`Self::clamp_numeric_ranges`] 的
    /// 区间理解，但这里仍做一次下界保护，避免调用方漏钳。
    pub fn curseforge_fetch_config(
        &self,
    ) -> crate::services::curseforge_fetch::CurseForgeFetchConfig {
        crate::services::curseforge_fetch::CurseForgeFetchConfig {
            concurrency: self.curseforge_version_fetch_concurrency.max(1) as usize,
            cache_ttl: std::time::Duration::from_secs(
                self.curseforge_version_cache_ttl_seconds.max(0) as u64,
            ),
        }
    }
}

/// 加载设置（对应 SystemEndpoints.LoadSettings：文件缺失/解析失败 → 默认值）。
pub fn load_settings() -> SettingsResponse {
    let path = settings_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(mut parsed) = serde_json::from_str::<SettingsResponse>(&content) {
                // 磁盘上的值可能被手改成越界数值，读入即钳位。
                parsed.clamp_numeric_ranges();
                // 老版本 settings.json 没有 initialized 字段（None）：视为已完成初始化，
                // 避免升级后被迫重走首次启动向导。仅全新安装（文件不存在 → Default）为 false。
                if parsed.initialized.is_none() {
                    parsed.initialized = Some(true);
                }
                return parsed;
            }
        }
    }
    SettingsResponse::default()
}

pub fn save_settings(settings: &SettingsResponse) -> std::io::Result<()> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, json)
}

/// 全局版本隔离开关（对应 SystemEndpoints.GetGlobalVersionIsolation）。
pub fn get_global_version_isolation() -> bool {
    load_settings().version_isolation
}

/// 全局「资源下载源」（mod 文件 CDN 镜像）：0 = 官方，1 = QML Mirror。
pub fn get_global_file_download_source() -> i32 {
    load_settings().file_download_source
}
