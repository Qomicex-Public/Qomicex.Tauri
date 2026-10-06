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

/// 「文件下载源」默认值：系统时区为 UTC+8（中国大陆及周边）时取镜像源（1），
/// 其余时区官方源（0）。供 serde default（老配置缺字段）与全新安装共用。
fn default_file_download_source() -> i32 {
    if is_china_timezone() {
        1
    } else {
        0
    }
}

/// 系统时区偏移是否为 UTC+8。只用于下载源默认值的地域判断：无网络探测、
/// 不做指纹，仅取本地时钟偏移。
fn is_china_timezone() -> bool {
    chrono::Local::now().offset().local_minus_utc() == 8 * 3600
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
    /// 资源（mod 文件 CDN）下载源：0 = 官方源（直连原 CDN）；1 = 镜像源（MCIM 优先：
    /// `cdn.modrinth.com`/`edge.forgecdn.net` → `mod.mcimirror.top`，MCIM 不覆盖的
    /// `cdn-alt.modrinth.com`/`mediafilez.forgecdn.net` 走 QML Mirror；运行期 MCIM
    /// 失败自动回退 QML 节点、官方 CDN 兜底）。旧值 2（QML Mirror HK）已并入 1。
    /// 默认值见 [`default_file_download_source`]（国内时区 → 1）。
    #[serde(default = "default_file_download_source")]
    pub file_download_source: i32,
    /// 自动选择资源（文件 CDN）下载源：`true` = 自动选当前延迟最低的可用源。
    pub auto_select_file_download_source: Option<bool>,
    /// 一次性迁移标记：镜像源改版（MCIM 优先 + 国内默认）后，把「值为旧默认 0 且
    /// 处于 UTC+8 时区」的存量用户提升为 1。显式标记防止用户主动选回官方源后被
    /// 每次启动反复改回。`None`/`Some(true)` = 已处理。
    #[serde(default)]
    pub file_download_source_migrated: Option<bool>,
    pub download_timeout: i32,
    pub animations_enabled: Option<bool>,
    pub animation_speed: Option<i32>,
    /// GPU 硬件加速动画（GSAP force3D，动画元素提升到独立 GPU 合成层）。
    /// `None`/`Some(true)` = 开启（默认开）；`Some(false)` = 关闭（2D 渲染，低端设备兜底）。
    #[serde(default)]
    pub gpu_acceleration: Option<bool>,
    pub max_frame_rate: Option<i32>,
    pub background_image: Option<String>,
    pub background_random: Option<bool>,
    /// 播放背景动图（GIF/APNG/动态 WebP）。`None`/`Some(true)` = 开启（默认开）；
    /// `Some(false)` = 只显示动图首帧（静态渲染）。
    #[serde(default)]
    pub background_animations_enabled: Option<bool>,
    /// 播放背景视频（MP4/WebM）。`None`/`Some(false)` = 关闭（默认关，省资源）；
    /// `Some(true)` = 用 `<video autoplay muted loop>` 播放。
    #[serde(default)]
    pub background_video_enabled: Option<bool>,
    pub bg_overlay_opacity: Option<i32>,
    pub bg_blur: Option<i32>,
    pub watermark_enabled: Option<bool>,
    pub watermark_text: Option<String>,
    pub watermark_subtext: Option<String>,
    pub directories: Option<Vec<String>>,
    pub custom_java_runtimes: Option<Vec<CustomJavaEntryDto>>,
    /// 自定义联机（EasyTier）中继节点列表（issue #112）。
    ///
    /// 语义：**自定义节点在前、官方节点在后**。为空/None = 只用官方节点（默认行为，
    /// 与引入本功能前完全一致）。用户可用自己的中继服务规避公共节点故障。
    ///
    /// 每项必须是 easytier 可直接连接的协议 URI（`tcp://host:port` / `udp://` /
    /// `quic://` / `wss://`）——`https://` 之类不被 easytier 接受（见 connector 库
    /// `relay/nodes.rs` 的踩坑注释），故写入前经 [`validate_relay_nodes`] 强校验。
    #[serde(default)]
    pub relay_nodes: Option<Vec<String>>,
    /// 主题模式：`"dark"` / `"light"` / `"system"`（跟随系统 prefers-color-scheme）。
    pub theme: Option<String>,
    #[serde(default)]
    pub theme_preset: Option<String>,
    pub log_level: Option<String>,
    pub translation_provider: String,
    pub bing_api_key: Option<String>,
    pub corner_radius: i32,
    pub window_corners: bool,
    pub curseforge_version_fetch_concurrency: i32,
    pub curseforge_version_cache_ttl_seconds: i32,
    /// 全局 UI 自定义字体家族名；None/空 = 系统默认字体。
    pub font_family: Option<String>,
    /// 全局主题强调色（hex，如 `#22c55e`）。`None`/空 = 使用默认配色（绿）。
    /// 前端把它转成 HSL 覆盖 `--primary`/`--ring`，并据此自动计算前景对比色。
    #[serde(default)]
    pub theme_color: Option<String>,
    /// 组件材质：`""`（或 `None`）= 默认；`"frosted"` = 毛玻璃；`"acrylic"` = 亚克力玻璃；`"aero"` = Aero；`"liquid"` = 液态玻璃。
    /// 前端经 `document.documentElement[data-material]` 应用对应的表面材质。
    #[serde(default)]
    pub component_material: Option<String>,
    /// 毛玻璃/液态玻璃模糊强度（像素）。材质为默认时忽略；`None` = 前端默认 18px。
    #[serde(default)]
    pub glass_blur: Option<i32>,
    /// 默认材质卡片透明度（0-100，100 = 不透明）。仅 `component_material` 为默认时生效；
    /// `None` = 前端默认 50（半透明）。
    #[serde(default)]
    pub card_opacity: Option<i32>,
    /// 默认材质卡片边框颜色（hex，如 `#333333`）。仅默认材质生效；`None`/空 = 使用主题边框色。
    #[serde(default)]
    pub card_border_color: Option<String>,
    /// 默认材质卡片边框厚度（像素，0 = 无边框）。仅默认材质生效；`None` = 前端默认 1。
    #[serde(default)]
    pub card_border_width: Option<i32>,
    /// 对话框透明度（0-100，100 = 不透明）。所有组件材质通用；`None` = 前端默认 75。
    #[serde(default)]
    pub dialog_opacity: Option<i32>,
    /// 是否已完成首次启动初始化向导。`Some(false)` = 新安装待初始化；
    /// 老配置文件缺失该字段时在 [`load_settings`] 中视为已初始化（`Some(true)`），
    /// 避免老用户升级后被迫重走向导。
    pub initialized: Option<bool>,
    /// issue #133 一次性迁移标记：`download_timeout` 的旧值 15 从未生效过，
    /// 首次读到 `15` 时提升为新默认值并置 true；此后用户若**主动**再选 15，
    /// 因标记已为 true 而保留用户选择（不会被每次启动反复改回）。
    #[serde(default)]
    pub download_timeout_migrated: Option<bool>,
    /// 自动上报严重错误日志（崩溃类恶性 bug）。`None` 视为开启（默认开）；
    /// 关闭时前后端都不上报。
    pub auto_report_errors: Option<bool>,
    /// 匿名插件错误遥测（opt-in）。`None`/`Some(false)` = 关闭（默认，绝不默认收集）；
    /// `Some(true)` = 前端在插件加载/运行出错时上报匿名错误类别
    /// （仅插件 id + 版本 + launcher 版本 + error_type 白名单，无路径/堆栈/隐私数据）。
    pub telemetry_enabled: Option<bool>,
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
    /// 跳过实例扫描的 JAR 级探测。`None`/`Some(false)` = 关闭（默认）：`/versions/scan`
    /// 的 `mode=full` 会为未命中缓存的版本打开 `{name}.jar` 读版本号（最准，但首次冷扫
    /// 要读几十秒）。`Some(true)` = 一律按 JSON 链推断（`clientVersion` →
    /// `minecraftVersion` → `inheritsFrom` → `--fml.mcVersion` → id 正则），
    /// **不再打开任何 jar**。
    ///
    /// 作用范围：只影响 `/api/versions/scan`，且开启后请求里的 `mode=full` 会被
    /// 静默降级为 fast、`refineRequired` 恒为 false。**不影响**启动实例、
    /// 安装/卸载、整合包导入导出、联机等任何其它路径。已有指纹缓存继续复用
    /// （缓存命中不打开 jar，是纯赚），只是不再计算新的 jar 级结果。
    ///
    /// 影响：对于 JSON 字段齐全的版本（现代 Forge/Fabric/NeoForge、vanilla）结果
    /// 完全一致；对于 JSON 缺字段的版本（部分手工整合包、GTNH 类）gameVersion 可能
    /// 退回成 `inheritsFrom` 或目录名 —— **并且这个值会被写进 `instances.json`**。
    /// 机制：`refineRequired` 恒为 false 让前端跳过 full 段、直接拿 fast 段的结果
    /// 调 `syncScan`，而后端 `sync_scan` → `list_existing` → `sync_from_disk`
    /// 会把扫描到的 `game_version` 落盘（`save_to_file`）。这正是开启该开关想要的
    /// 语义（JSON 链的值就是最终值），但要清楚：ADR-082「fast 段猜测值不落盘」的
    /// 前提（前端只在 full 后 sync）在这里被有意打破。关掉开关即恢复原语义。
    pub scan_skip_jar_probe: Option<bool>,
    /// 自动下载并安装更新。`None`/`Some(true)` = 开启（默认）：
    /// 后台发现更新后**自动下载**，下载完成弹可点击的 Toast，用户不点击则下次
    /// 启动时自动安装完成。`Some(false)` = 关闭，恢复为原有的「发现新版本 → 弹
    /// 更新对话框，等用户点『立即更新』」行为。
    ///
    /// 只对普通更新生效：`required`（强制更新，有"必须更新才能继续使用"语义）与
    /// `channelSwitch`（跨通道切换，需用户明确知晓）一律仍走对话框。
    #[serde(default)]
    pub update_auto_install: Option<bool>,
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
            file_download_source: default_file_download_source(),
            auto_select_file_download_source: None,
            file_download_source_migrated: Some(true),
            download_timeout: 60,
            animations_enabled: None,
            animation_speed: None,
            gpu_acceleration: None,
            max_frame_rate: None,
            background_image: None,
            background_random: None,
            background_animations_enabled: None,
            background_video_enabled: None,
            bg_overlay_opacity: None,
            bg_blur: None,
            watermark_enabled: None,
            watermark_text: None,
            watermark_subtext: None,
            directories: None,
            custom_java_runtimes: None,
            relay_nodes: None,
            theme: None,
            theme_preset: None,
            log_level: Some("info".to_string()),
            translation_provider: "mymemory".to_string(),
            bing_api_key: None,
            corner_radius: 8,
            window_corners: true,
            curseforge_version_fetch_concurrency: 10,
            curseforge_version_cache_ttl_seconds: 300,
            font_family: None,
            theme_color: None,
            component_material: None,
            glass_blur: None,
            card_opacity: None,
            card_border_color: None,
            card_border_width: None,
            dialog_opacity: None,
            initialized: Some(false),
            // 全新安装直接落地新默认值，标记为已迁移：这样用户之后主动选 15 会被尊重。
            download_timeout_migrated: Some(true),
            auto_report_errors: Some(true),
            telemetry_enabled: None,
            enable_http3: None,
            proxy_mode: "system".to_string(),
            proxy_host: String::new(),
            ignore_ssl_cert: None,
            http1_parallel: false,
            scan_skip_jar_probe: None,
            // 默认开启自动下载并安装更新（None 亦视为开启，见字段注释）。
            update_auto_install: Some(true),
        }
    }
}

fn settings_path() -> PathBuf {
    resolve_base_dir().join("QML").join("settings.json")
}

/// CurseForge 版本拉取相关的取值范围。与前端 Settings 页面的 min/max 保持一致。
pub const CF_FETCH_CONCURRENCY_RANGE: (i32, i32) = (1, 20);
pub const CF_CACHE_TTL_SECONDS_RANGE: (i32, i32) = (0, 3600);
/// 「下载超时」（秒）的取值范围：0 = 不设总超时；与前端 Settings 页面 min/max 一致。
pub const DOWNLOAD_TIMEOUT_RANGE: (i32, i32) = (0, 120);
/// issue #133 之前的默认值。该值从未影响任何行为，仅用于识别「用户没动过这一项」。
const LEGACY_DEFAULT_DOWNLOAD_TIMEOUT: i32 = 15;

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
        // settings.json 可手改、本地 API 也可被插件调用：越界值必须读入即钳，
        // 否则会以负时长形式传入前端超时计算（issue #133）。
        let (lo, hi) = DOWNLOAD_TIMEOUT_RANGE;
        self.download_timeout = self.download_timeout.clamp(lo, hi);
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

/// 镜像源改版一次性迁移：
/// - 旧值 2（QML Mirror HK，已废弃）→ 1（镜像源，行为被 MCIM 优先的镜像源覆盖，
///   HK 节点仍在运行期回退链里）。
/// - 值为旧默认 0 且系统时区 UTC+8 → 1（国内默认镜像源）。磁盘值 0 无法区分
///   「主动选官方」和「从没动过」，按确认的策略一次性迁移并用显式标记防反复；
///   迁移后用户改回 0 即被尊重。非 UTC+8 用户保持 0 不动。
fn apply_file_download_source_migration(s: &mut SettingsResponse) {
    if s.file_download_source_migrated == Some(true) {
        return;
    }
    let should_mirror =
        s.file_download_source == 2 || (s.file_download_source == 0 && is_china_timezone());
    if should_mirror {
        s.file_download_source = 1;
    }
    s.file_download_source_migrated = Some(true);
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
                // issue #133 一次性迁移：download_timeout 在旧版本里**从未被任何代码消费**
                // （既没驱动前端请求超时，也没传给下载器），磁盘上的 15 只是当年那个同样
                // 没生效的默认值，不是用户的有效选择。提升为新默认值，否则老用户升级后
                // 仍然踩着「15s 就报请求超时」的老问题。
                // 用显式标记而不是「值 == 15 就改」，否则用户日后主动选 15 会被每次启动改回。
                if parsed.download_timeout_migrated != Some(true) {
                    if parsed.download_timeout == LEGACY_DEFAULT_DOWNLOAD_TIMEOUT {
                        parsed.download_timeout = SettingsResponse::default().download_timeout;
                    }
                    parsed.download_timeout_migrated = Some(true);
                }
                // 镜像源改版一次性迁移（语义见 apply_file_download_source_migration）。
                apply_file_download_source_migration(&mut parsed);
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

/// 全局「资源下载源」（mod 文件 CDN 镜像）：0 = 官方，1 = 镜像源（MCIM 优先 + QML 回退）。
pub fn get_global_file_download_source() -> i32 {
    load_settings().file_download_source
}

// =====================================================================
// 自定义联机节点校验（issue #112）
// =====================================================================

/// easytier 支持的中继节点 scheme 全集。
///
/// 来源：easytier `easytier/src/tunnel/mod.rs` 的 `TunnelScheme` 枚举。
/// 校验必须对齐 easytier 的**真实能力**，而不是我们以为的子集 —— 早期版本这里只放
/// `tcp/udp/quic/wss/ws` 并拒绝 `https`，结果把「用 https 节点服务」这一官方用法
/// 本身挡在门外（官方节点服务就是返回 `https://etnode.../nodeN`）。
const RELAY_NODE_SCHEMES: &[&str] = &[
    // 直连协议（easytier `IpScheme`）
    "tcp", "udp", "wg", "quic", "ws", "wss", "faketcp",
    // manual endpoint（easytier `TunnelScheme`，注释标 `// Only for connector`）：
    // 这类地址由 easytier **自行 GET/解析**——请求该 URL，把返回体 trim 后当作真正的
    // 节点地址。官方节点服务正是此形态（`https://etnode.../nodeN` → 返回 `tcp://...`）。
    "http", "https", "txt", "srv", "ring",
];

/// manual endpoint 类 scheme：地址是「查询入口」而非最终 socket 地址。
/// 允许带路径、允许省略端口（由 easytier 自行解析）。
const RELAY_ENDPOINT_SCHEMES: &[&str] = &["http", "https", "txt", "srv", "ring"];

/// 校验单个中继节点地址，返回规范化后的值或可读错误。
///
/// 解析交给标准 `url::Url`（实测能拦住未闭合括号 `[::1:11010`、无左括号 `]:11010`、
/// 括号内非 IPv6 `[not-an-ip]`、多余分隔符 `a:b:11010`、端口越界 `99999`），
/// 但它**不拦两件事**，必须自己补：
/// - `url` 允许 `tcp://host/path`：直连协议带 path 是错的（path 属 manual endpoint 语义）；
/// - `url` 接受端口 `0`：端口下界需自行校验。
///
/// 两类形态：
/// - **直连协议**（tcp/udp/wg/quic/ws/wss/faketcp）：必须有 host:port，且不得带 path；
/// - **manual endpoint**（http/https/txt/srv/ring）：允许 path，端口可省（easytier 自解析）。
///
/// 校验范围对齐 easytier `tunnel/mod.rs` 的 `TunnelScheme` 全集，而不是我们以为的子集。
pub fn validate_relay_node(raw: &str) -> Result<String, String> {
    let node = raw.trim();
    if node.is_empty() {
        return Err("节点地址不能为空".to_string());
    }
    let scheme_end = node
        .find("://")
        .ok_or_else(|| "缺少协议前缀（应为 tcp://host:port 或 https://host/path）".to_string())?;
    let scheme_lc = node[..scheme_end].to_ascii_lowercase();
    if !RELAY_NODE_SCHEMES.contains(&scheme_lc.as_str()) {
        return Err(format!(
            "不支持的协议 `{}`（支持 {}）",
            &node[..scheme_end],
            RELAY_NODE_SCHEMES.join(" / ")
        ));
    }

    // 标准解析器统一处理 authority（含 IPv6 括号、非法字符、端口格式）。
    let parsed = url::Url::parse(node).map_err(|e| format!("地址格式无效（{e}）"))?;
    // 注意 `host_str()` 对 IPv6 返回**已带方括号**的形式（`[::1]`），不要再补一次，
    // 否则会得到 `[[::1]]`。
    let host = parsed
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "缺少主机名".to_string())?
        .to_string();

    if RELAY_ENDPOINT_SCHEMES.contains(&scheme_lc.as_str()) {
        // manual endpoint：URL 形态，原样保留 path/query（easytier 按原 URL 请求解析）。
        if parsed.port() == Some(0) {
            return Err("端口 0 无效（1-65535）".to_string());
        }
        return Ok(node.to_string());
    }

    // 直连协议：必须带端口，且不得有 path/query/fragment。
    let port = parsed
        .port()
        .ok_or_else(|| "缺少端口（应为 host:port）".to_string())?;
    if port == 0 {
        return Err("端口 0 无效（1-65535）".to_string());
    }
    if !parsed.path().is_empty() && parsed.path() != "/" {
        return Err(format!(
            "直连协议不支持路径（应为 {scheme_lc}://host:port）"
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(format!(
            "直连协议不支持查询或片段（应为 {scheme_lc}://host:port）"
        ));
    }
    Ok(format!("{scheme_lc}://{host}:{port}"))
}

/// 校验并规范化整份自定义节点列表：去空白、去重（保序）、逐项校验。
///
/// 空列表视为「未配置」（等价于只用官方节点），返回 `Ok(None)`。
///
/// **任一项非法即整体失败** —— 用于设置**写入**路径：用户当场得到反馈，
/// 不静默丢弃（否则会以为已生效）。
pub fn validate_relay_nodes(raw: Option<&[String]>) -> Result<Option<Vec<String>>, String> {
    let Some(list) = raw else {
        return Ok(None);
    };
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let node = validate_relay_node(item)?;
        if !out.contains(&node) {
            out.push(node);
        }
    }
    if out.is_empty() {
        return Ok(None);
    }
    Ok(Some(out))
}

/// 宽松校验：**逐项跳过**非法条目并记录告警，保留合法条目（去重保序）。
///
/// 用于**读取**已落盘配置的路径（`build_client` / `initial_client`）：settings.json
/// 可能被手工编辑而混入坏条目，此时整份丢弃会让用户「自定义节点全部失效」，
/// 而它们中多数是好的。写入路径仍走 [`validate_relay_nodes`] 严校验。
pub fn validate_relay_nodes_lenient(raw: Option<&[String]>) -> Option<Vec<String>> {
    let list = raw?;
    let mut out: Vec<String> = Vec::new();
    for item in list {
        match validate_relay_node(item) {
            Ok(node) => {
                if !out.contains(&node) {
                    out.push(node);
                }
            }
            Err(e) => {
                tracing::warn!(node = %item, error = %e, "跳过非法联机中继节点（其余节点仍生效）");
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod relay_node_tests {
    use super::*;

    #[test]
    fn accepts_supported_schemes_and_normalizes() {
        assert_eq!(
            validate_relay_node("tcp://relay.example.com:11010").unwrap(),
            "tcp://relay.example.com:11010"
        );
        // 大小写归一并去空白（host 原样保留——DNS 大小写不敏感）
        assert_eq!(
            validate_relay_node("  TCP://Relay.Example.com:11010  ").unwrap(),
            "tcp://Relay.Example.com:11010"
        );
        for s in ["udp", "quic", "wss", "ws", "wg", "faketcp"] {
            assert!(
                validate_relay_node(&format!("{s}://h.example.com:11010")).is_ok(),
                "{s} 应被接受"
            );
        }
        // IPv6 字面量
        assert_eq!(
            validate_relay_node("tcp://[::1]:11010").unwrap(),
            "tcp://[::1]:11010"
        );
    }

    /// **回归（曾判错）**：`http(s)://` 必须被**接受**。
    ///
    /// 早期版本这里拒绝 https，理由是「easytier 不支持 https peer scheme」——那是错的，
    /// 依据只来自 connector 库早期的一段踩坑注释。核实 easytier 源码
    /// （`easytier/src/tunnel/mod.rs` 的 `TunnelScheme`）后确认：
    ///
    /// ```rust
    /// pub enum TunnelScheme {
    ///     Ip(IpScheme),          // tcp/udp/wg/quic/ws/wss/faketcp
    ///     // Only for connector
    ///     Http, Https, Ring, Txt, Srv,
    /// }
    /// fn is_manual_endpoint_scheme(scheme: &str) -> bool {
    ///     matches!(scheme, "http" | "https" | "txt" | "srv")
    /// }
    /// ```
    ///
    /// `http(s)` 是 **manual endpoint**：easytier 自己去 GET、把响应体 trim 后当作真正
    /// 的节点地址。官方节点服务正是这个形态（`https://etnode.../nodeN` → `tcp://...`）。
    /// 拒绝它等于把官方支持的用法挡在门外。
    #[test]
    fn accepts_http_endpoint_schemes() {
        // 官方节点服务形态（带路径、无端口）
        assert_eq!(
            validate_relay_node("https://etnode.zkitefly.eu.org/node2").unwrap(),
            "https://etnode.zkitefly.eu.org/node2"
        );
        // 带端口与路径
        assert_eq!(
            validate_relay_node("https://relay.example.com:8443/api/nodes").unwrap(),
            "https://relay.example.com:8443/api/nodes"
        );
        // http / txt / srv / ring 同属 manual endpoint
        for s in ["http", "txt", "srv", "ring"] {
            assert!(
                validate_relay_node(&format!("{s}://h.example.com/x")).is_ok(),
                "{s} 应被接受（manual endpoint）"
            );
        }
        // manual endpoint 给了非法端口仍要拒绝
        assert!(validate_relay_node("https://h.example.com:0/x").is_err());
        assert!(validate_relay_node("https://h.example.com:99999/x").is_err());
    }

    /// manual endpoint 允许省略端口（URL 形态），直连协议不允许。
    #[test]
    fn endpoint_schemes_allow_missing_port_but_ip_schemes_do_not() {
        assert!(validate_relay_node("https://etnode.example.com/n1").is_ok());
        assert!(
            validate_relay_node("tcp://relay.example.com").is_err(),
            "直连协议必须带端口"
        );
    }

    #[test]
    fn rejects_malformed_nodes() {
        assert!(validate_relay_node("").is_err(), "空串");
        assert!(validate_relay_node("   ").is_err(), "纯空白");
        assert!(
            validate_relay_node("relay.example.com:11010").is_err(),
            "缺协议"
        );
        assert!(validate_relay_node("tcp://").is_err(), "协议后无内容");
        assert!(validate_relay_node("tcp://host").is_err(), "缺端口");
        assert!(validate_relay_node("tcp://:11010").is_err(), "缺主机");
        assert!(validate_relay_node("tcp://host:abc").is_err(), "端口非数字");
        assert!(validate_relay_node("tcp://host:0").is_err(), "端口 0");
        assert!(validate_relay_node("tcp://host:65536").is_err(), "端口越界");
        assert!(validate_relay_node("tcp://ho st:11010").is_err(), "含空白");
    }

    #[test]
    fn validates_list_dedups_and_treats_empty_as_none() {
        // 去重保序
        let got = validate_relay_nodes(Some(&[
            "tcp://a.example.com:1".to_string(),
            "tcp://a.example.com:1".to_string(),
            "udp://b.example.com:2".to_string(),
        ]))
        .unwrap();
        assert_eq!(
            got,
            Some(vec![
                "tcp://a.example.com:1".to_string(),
                "udp://b.example.com:2".to_string()
            ])
        );

        // None / 空列表 → 未配置（等价于只用官方节点）
        assert_eq!(validate_relay_nodes(None).unwrap(), None);
        assert_eq!(validate_relay_nodes(Some(&[])).unwrap(), None);
        // 纯空白项是用户误填，应报错而非静默当作「未配置」——静默会让用户
        // 以为自己填的节点已生效。
        assert!(
            validate_relay_nodes(Some(&["  ".to_string()])).is_err(),
            "纯空白项应报错"
        );

        // 任一项非法 → 整体失败（不静默丢弃，避免用户以为已生效）。
        // 用「直连协议缺端口」当非法样本 —— `https://` 现在是**合法**的
        // （manual endpoint），不能再用它当反例。
        assert!(validate_relay_nodes(Some(&[
            "tcp://ok.example.com:1".to_string(),
            "tcp://missing-port.example.com".to_string(),
        ]))
        .is_err());
    }

    /// 回归（评审 finding #3/#7）：畸形 host **必须**被拒绝。
    ///
    /// 旧实现用 `find(']')` / `rsplit_once(':')` 手写切分，以下输入**全部通过校验**
    /// 并被持久化、随后交给 easytier（实测旧实现 5 条全 Ok）。改用 `url::Url` 解析
    /// authority 后收紧。
    #[test]
    fn rejects_malformed_hosts() {
        // 未闭合方括号 / 无左括号 / 括号内非 IPv6（url crate 直接拒）
        assert!(
            validate_relay_node("tcp://[::1:11010").is_err(),
            "未闭合方括号应被拒"
        );
        assert!(
            validate_relay_node("tcp://]:11010").is_err(),
            "无左括号应被拒"
        );
        assert!(
            validate_relay_node("tcp://[not-an-ip]:11010").is_err(),
            "括号内非 IPv6 应被拒"
        );
        // 多余分隔符（url crate 拒：端口非数字）
        assert!(
            validate_relay_node("tcp://a:b:11010").is_err(),
            "多余分隔符应被拒"
        );
        // 直连协议带 path（url crate 本身允许，需我们额外拒绝）
        assert!(
            validate_relay_node("tcp://host/path:11010").is_err(),
            "直连协议带路径应被拒"
        );
        assert!(
            validate_relay_node("tcp://host:11010/x").is_err(),
            "直连协议带路径应被拒"
        );
        // 端口下界（url crate 接受 0，需我们额外拒绝）
        assert!(
            validate_relay_node("tcp://host:0").is_err(),
            "端口 0 应被拒"
        );
        // 合法 IPv6 仍必须通过，且规范化时补回方括号
        assert_eq!(
            validate_relay_node("tcp://[::1]:11010").unwrap(),
            "tcp://[::1]:11010"
        );
    }

    /// manual endpoint 允许路径与省略端口（与直连协议相反），但端口仍须合法。
    #[test]
    fn endpoint_schemes_allow_path_and_missing_port() {
        for s in ["http", "https", "txt", "srv", "ring"] {
            assert!(
                validate_relay_node(&format!("{s}://h.example.com/some/path")).is_ok(),
                "{s} 应允许路径"
            );
            assert!(
                validate_relay_node(&format!("{s}://h.example.com")).is_ok(),
                "{s} 应允许省略端口"
            );
        }
        assert!(
            validate_relay_node("https://h.example.com:0/x").is_err(),
            "端口 0 仍拒"
        );
        assert!(
            validate_relay_node("https://h.example.com:99999/x").is_err(),
            "端口越界仍拒"
        );
    }

    /// 宽松校验（读路径）：逐项跳过非法条目、保留合法节点。
    ///
    /// 场景：settings.json 被手工编辑混入坏条目。严格模式会让**全部**自定义节点失效
    /// （评审 finding），宽松模式只丢坏的那条。
    #[test]
    fn lenient_validation_keeps_valid_nodes_and_skips_bad() {
        let got = validate_relay_nodes_lenient(Some(&[
            "tcp://good.example.com:11010".to_string(),
            "tcp://missing-port.example.com".to_string(), // 非法：缺端口
            "https://etnode.example.com/node1".to_string(), // 合法 manual endpoint
            "tcp://bad.example.com:0".to_string(),        // 非法：端口 0
        ]));
        assert_eq!(
            got,
            Some(vec![
                "tcp://good.example.com:11010".to_string(),
                "https://etnode.example.com/node1".to_string(),
            ]),
            "应跳过非法条目并保留合法节点"
        );

        // 全部非法 → None（等价于未配置，回退官方节点）
        assert_eq!(
            validate_relay_nodes_lenient(Some(&[
                "tcp://bad1.example.com".to_string(),
                "tcp://bad2.example.com:0".to_string(),
            ])),
            None
        );
        // 无配置 / 空列表 → None
        assert_eq!(validate_relay_nodes_lenient(None), None);
        assert_eq!(validate_relay_nodes_lenient(Some(&[])), None);
    }

    /// 镜像源一次性迁移语义（issue：文件下载源改版）。用构造的 JSON 走 serde
    /// 反序列化验证缺字段/旧值的组合行为，不落盘、不依赖真实 settings.json。
    mod file_download_source_migration {
        use super::*;

        /// SettingsResponse 无 serde default 的必填字段合集（最小合法 settings.json）。
        const BASE_JSON: &str = r#""gameDir":".minecraft","downloadThreads":64,"versionIsolation":true,"closeAfterLaunch":false,"defaultMaxMemory":4096,"jvmArgs":"","language":"zh-CN","defaultJavaPath":"","downloadSource":0,"modMirror":0,"downloadTimeout":60,"translationProvider":"mymemory","cornerRadius":8,"windowCorners":true,"curseforgeVersionFetchConcurrency":10,"curseforgeVersionCacheTtlSeconds":300"#;

        fn parse(extra: &str) -> SettingsResponse {
            let json = if extra.is_empty() {
                format!("{{{BASE_JSON}}}")
            } else {
                format!("{{{BASE_JSON},{extra}}}")
            };
            serde_json::from_str(&json).expect("测试 JSON 必须可解析")
        }

        /// 老配置缺 file_download_source 字段：serde default 按当前系统时区取值
        /// （UTC+8 → 1 镜像源，其余 → 0 官方）。
        #[test]
        fn missing_field_uses_timezone_default() {
            let mut s = parse("");
            apply_file_download_source_migration(&mut s);
            let expected = if is_china_timezone() { 1 } else { 0 };
            assert_eq!(s.file_download_source, expected);
        }

        /// 旧值 2（QML Mirror HK，已废弃）→ 1：HK 节点仍在运行期回退链里，
        /// 迁移不丢已有镜像能力。
        #[test]
        fn legacy_value_2_migrates_to_1() {
            let mut s = parse(r#""fileDownloadSource":2,"fileDownloadSourceMigrated":false"#);
            apply_file_download_source_migration(&mut s);
            assert_eq!(s.file_download_source, 1);
        }

        /// 国内（UTC+8）用户旧默认 0 → 1；显式迁移标记防反复。
        /// 非 UTC+8 环境本用例退化为「保持 0」，断言按当前时区取分支。
        #[test]
        fn legacy_default_0_migrates_in_china_timezone() {
            let mut s = parse(r#""fileDownloadSource":0,"fileDownloadSourceMigrated":false"#);
            apply_file_download_source_migration(&mut s);
            let expected = if is_china_timezone() { 1 } else { 0 };
            assert_eq!(s.file_download_source, expected);
            assert_eq!(s.file_download_source_migrated, Some(true));
        }

        /// 已迁移的配置不再被改写：用户主动选回官方源 0 必须被尊重。
        #[test]
        fn migrated_flag_preserves_user_choice() {
            let mut s = parse(r#""fileDownloadSource":0,"fileDownloadSourceMigrated":true"#);
            apply_file_download_source_migration(&mut s);
            assert_eq!(s.file_download_source, 0);
        }
    }
}
