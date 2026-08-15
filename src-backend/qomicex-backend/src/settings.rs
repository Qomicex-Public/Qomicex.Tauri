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
    pub max_connections_per_server: i32,
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
    /// 是否已完成首次启动初始化向导。`Some(false)` = 新安装待初始化；
    /// 老配置文件缺失该字段时在 [`load_settings`] 中视为已初始化（`Some(true)`），
    /// 避免老用户升级后被迫重走向导。
    pub initialized: Option<bool>,
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
            max_connections_per_server: 64,
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
            initialized: Some(false),
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
