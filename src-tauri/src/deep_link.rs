//! `qomicex-launcher://` 深链（OS 级 URL 协议唤起）的接收与分发。
//!
//! # 与 `ipc.rs` 的 `qomicex://` 无关
//!
//! `ipc.rs` 里的 `qomicex` 是 **webview 内部自定义协议**，经
//! `register_asynchronous_uri_scheme_protocol` 注册，作用是把前端 fetch 转发进 QIPC
//! 管道（ADR-040）。本模块处理的是 **操作系统级 URL 协议**（Windows 注册表
//! `HKCU\Software\Classes\...` / Linux `.desktop` + `xdg-mime` / macOS
//! `Info.plist` CFBundleURLTypes），由浏览器等外部程序唤起。
//!
//! 两者机制不同但同名会在 macOS（CFBundleURLTypes vs WKURLSchemeHandler）与 Linux
//! （xdg-mime vs webkit custom scheme）上产生真实歧义，故 OS 协议名取
//! `qomicex-launcher`，内部协议 `qomicex` 零改动（见 ADR-087）。
//!
//! # 两条接收路径
//!
//! - **冷启动**：进程由 URL 拉起 → `get_current()` 读取本次 argv（此时 `.setup()` 里的
//!   `on_open_url` 监听器尚未注册，插件在自身 setup 阶段就已消费过 argv，故必须主动取）。
//! - **热路径**：已有实例在跑 → 第二次启动被 `single-instance` 拦截（带 `deep-link`
//!   feature 时它会把 argv 转交给 deep-link 插件）→ 插件 emit `deep-link://new-url`
//!   → 本模块的 `on_open_url` 回调。
//!
//! 两条路径统一写入 [`PendingDeepLink`] 并向主窗口 emit [`EVENT_NAME`]；前端挂载时用
//! `take_pending_deep_link` 取走**全部**待处理项，处理完每条后再用
//! [`complete_deep_link`] 逐条回执——Rust 侧核对回执与队列里的 URL 一致才移除。
//!
//! 为什么是「取走全部 + 逐条回执」而不是「取出即清空」：前端可能因为后端尚未就绪、
//! 动作被取消、组件重挂等任何原因没真正处理完。清空太早会**丢链接**（#7/#8/#11 的
//! 共同根因），而只靠事件推送不清理又会**重复执行**同一个 URL。回执让前端成为
//! 「这条已处理」的唯一裁决者，Rust 只负责去重与保留。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// 转发给前端的深链事件名（payload：URL 字符串数组）。
pub const EVENT_NAME: &str = "deep-link://action";

/// OS 协议名（不含 `://`）。与内部协议 `qomicex` 区分，见模块头注释。
pub const SCHEME: &str = "qomicex-launcher";

/// 已接收但前端尚未回执的深链 URL。
///
/// 语义：**待处理集合**（不是「待投递一次」的队列）。
/// - `push` 去重后加入（同一 URL 重复到达只留一份，避免重复执行）；
/// - `take_pending` 返回全部但**不清空**（前端重挂时可再次拿到）；
/// - `complete` 按 URL 移除（前端确认处理完毕）。
#[derive(Default)]
pub struct PendingDeepLink(Mutex<Vec<String>>);

impl PendingDeepLink {
    fn push(&self, urls: Vec<String>) {
        if urls.is_empty() {
            return;
        }
        // 中毒锁不影响功能：仅是一个 URL 列表，取回内部值继续用即可。
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for url in urls {
            if !guard.iter().any(|existing| existing == &url) {
                guard.push(url);
            }
        }
    }

    fn take_pending(&self) -> Vec<String> {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    }

    /// 前端回执：仅在 URL 确实还在待处理集合里时移除，返回是否移除成功。
    fn complete(&self, url: &str) -> bool {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match guard.iter().position(|existing| existing == url) {
            Some(idx) => {
                guard.remove(idx);
                true
            }
            None => false,
        }
    }
}

/// 记录 URL 并唤醒前端。
fn dispatch(app: &AppHandle, urls: Vec<tauri::Url>) {
    let list: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
    if list.is_empty() {
        return;
    }
    app.state::<PendingDeepLink>().push(list.clone());
    if let Some(win) = app.get_webview_window("main") {
        if let Err(e) = win.emit(EVENT_NAME, list) {
            crate::tauri_log!("deep-link", "emit failed: {e}");
        }
    } else {
        crate::tauri_log!("deep-link", "main window missing, kept pending");
    }
}

/// 注册协议关联并把监听器接到当前应用上（在 `.setup()` 里调用）。
pub fn init(app: &AppHandle) {
    let dl = app.deep_link();

    // 冷启动：本次进程就是被这个 URL 拉起的。
    match dl.get_current() {
        Ok(Some(urls)) => {
            crate::tauri_log!("deep-link", "cold start with {} url(s)", urls.len());
            dispatch(app, urls);
        }
        Ok(None) => crate::tauri_log!("deep-link", "cold start without url"),
        Err(e) => crate::tauri_log!("deep-link", "get_current failed: {e}"),
    }

    // 热路径：已有实例被再次唤起（single-instance 转发 argv 后插件 emit 该事件）。
    let handle = app.clone();
    dl.on_open_url(move |event| dispatch(&handle, event.urls()));

    register_scheme(app);
}

/// 确保本可执行文件是 `qomicex-launcher://` 的处理器——**默认自动写**。
///
/// 为什么默认就写：协议关联是用户装这个启动器时期望拿到的能力（否则网页/快捷方式里的
/// `qomicex-launcher://` 链接一律无效，等于该功能不存在）。关联写入限于当前用户
/// （Windows `HKCU`、Linux 用户级 `.desktop`），不需要管理员权限，且随时可在
/// 「设置 → 系统集成」里关掉——所以默认开、可关，而不是每次启动弹窗问一遍。
///
/// **用户意图与实际关联状态必须分开看**：用户关掉开关后我们调用 `unregister()`，
/// 下次启动 `is_registered()` 自然是 false——若只看它就会**又注册回去**，开关形同虚设。
/// 故先读 [`DeepLinkPreference`]（缺省 `auto_register = true`），只有用户显式关过才不写。
///
/// 失败只记日志：注册不了不应让启动器起不来。
fn register_scheme(app: &AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    {
        let preference = DeepLinkPreference::load();

        // 先查「当前是否真的关联到本构建」——Linux 上要比对 desktop 的 Exec（见下）。
        #[cfg(target_os = "linux")]
        let associated = app.deep_link().is_registered(SCHEME).unwrap_or(false)
            && linux_handler_exec_matches(SCHEME);
        #[cfg(windows)]
        let associated = match app.deep_link().is_registered(SCHEME) {
            Ok(v) => v,
            Err(e) => {
                crate::tauri_log!("deep-link", "is_registered failed: {e}");
                false
            }
        };

        match startup_action(preference.auto_register, associated) {
            StartupAction::LeaveDisabled => {
                crate::tauri_log!("deep-link", "auto-register disabled by user; skipping");
                app.state::<DeepLinkRegistration>().set_disabled();
            }
            StartupAction::KeepRegistered => {
                crate::tauri_log!("deep-link", "scheme '{SCHEME}' already associated");
                app.state::<DeepLinkRegistration>().set_registered();
            }
            StartupAction::Register => {
                // 未关联（全新安装 / 关联被别的程序抢走 / 指向已删除的旧构建）→ 写入。
                match app.deep_link().register_all() {
                    Ok(()) => {
                        crate::tauri_log!("deep-link", "scheme '{SCHEME}' auto-registered");
                        app.state::<DeepLinkRegistration>().set_registered();
                    }
                    Err(e) => {
                        crate::tauri_log!("deep-link", "auto-register failed: {e}");
                        app.state::<DeepLinkRegistration>().set_failed();
                    }
                }
            }
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        // macOS 只支持构建期由 Info.plist 注册（crate 层返回 UnsupportedPlatform）。
        // 装机即有，无需也无法在运行时改。
        app.state::<DeepLinkRegistration>().set_registered();
    }
}

/// 启动时该对协议关联做什么。
#[derive(Debug, PartialEq, Eq)]
enum StartupAction {
    /// 用户显式关过 → 什么都不做（**不因为「检测到未关联」就注册回去**）。
    LeaveDisabled,
    /// 已关联到本构建 → 保持。
    KeepRegistered,
    /// 应当写入关联。
    Register,
}

/// 启动决策（纯函数，便于测试）。
///
/// 这是本次改动最容易写错的一处：把「用户意图」与「实际关联状态」两个布尔组合成正确动作。
/// 尤其**不能**写成「未关联就注册」——用户主动关掉后 `associated` 必然是 false，
/// 那样写会让开关在下次启动时被自动撤销。
fn startup_action(auto_register: bool, associated: bool) -> StartupAction {
    if !auto_register {
        StartupAction::LeaveDisabled
    } else if associated {
        StartupAction::KeepRegistered
    } else {
        StartupAction::Register
    }
}

/// 用户对协议关联的**意图**（与「当前是否真的关联」是两件事）。
///
/// 持久化在 `{BaseDir}/deep-link.json`，与 `updater` 把交接文件放在 `{data_dir}/updates/`
/// 同一思路——放数据目录而不是 localStorage，因为**启动阶段的 Rust 侧要能读到它**
/// （前端那时还没跑起来）。缺省 `auto_register = true`：全新安装与老用户都默认开。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct DeepLinkPreference {
    #[serde(default = "auto_register_default")]
    auto_register: bool,
}

/// 「自动注册」的默认值——**唯一事实源**。
///
/// 两个调用点共用它：serde 反序列化缺字段时（`#[serde(default = ...)]`）与
/// [`DeepLinkPreference::default`]（文件缺失/损坏时）。二者若各写一个字面量 `true`，
/// 改一处就会漏掉另一处、导致「缺字段」与「文件损坏」行为不一致
/// （实测：把 `default_true` 改成 false 时，只有「缺字段」那条测试失败）。
const fn auto_register_default() -> bool {
    true
}

impl Default for DeepLinkPreference {
    fn default() -> Self {
        Self {
            auto_register: auto_register_default(),
        }
    }
}

impl DeepLinkPreference {
    fn path() -> std::path::PathBuf {
        crate::logger::base_dir().join("deep-link.json")
    }

    /// 读取偏好。文件缺失/损坏一律回落到默认（true）——默认开是期望行为，
    /// 不能因为一个坏文件就让功能静默失效。
    fn load() -> Self {
        Self::load_from(&Self::path())
    }

    /// 写入偏好。失败只记日志：关不掉开关比启动失败轻得多。
    fn save(&self) {
        if let Err(e) = self.save_to(&Self::path()) {
            crate::tauri_log!("deep-link", "write preference failed: {e}");
        }
    }

    /// 路径参数化的读取（供测试注入临时目录）。
    fn load_from(path: &std::path::Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// 路径参数化的写入（供测试注入临时目录）。
    fn save_to(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json =
            serde_json::to_string_pretty(self).map_err(|e| std::io::Error::other(e.to_string()))?;
        std::fs::write(path, json)
    }
}

/// Linux：确认 `x-scheme-handler/<scheme>` 对应的 desktop 文件 `Exec=` 指向**当前可执行文件**。
///
/// 找不到文件/读不出 Exec 时返回 `false`（宁可重新写一次关联，也不要让一个指向别处的
/// 关联被当成「已就绪」）。
#[cfg(target_os = "linux")]
fn linux_handler_exec_matches(scheme: &str) -> bool {
    use std::process::Command;

    let mime = format!("x-scheme-handler/{scheme}");
    let out = match Command::new("xdg-mime")
        .args(["query", "default", &mime])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    let desktop_name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if desktop_name.is_empty() {
        return false;
    }

    // 按 XDG 规范顺序找 desktop 文件（用户目录优先）。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("XDG_DATA_HOME") {
        candidates.push(std::path::PathBuf::from(home).join("applications"));
    } else if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            std::path::PathBuf::from(home)
                .join(".local/share")
                .join("applications"),
        );
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for dir in data_dirs.split(':').filter(|d| !d.trim().is_empty()) {
        candidates.push(std::path::PathBuf::from(dir).join("applications"));
    }

    for dir in candidates {
        let Ok(content) = std::fs::read_to_string(dir.join(&desktop_name)) else {
            continue;
        };
        let Some(exec) = content
            .lines()
            .find_map(|l| l.strip_prefix("Exec="))
            .map(str::trim)
        else {
            continue;
        };
        // Exec 形如 `"/path/to/app" %u`：取出第一段（可能带引号）与当前 exe 比路径。
        let program = exec
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches('"');
        let Ok(current) = std::env::current_exe() else {
            return false;
        };
        // 用 canonicalize 消掉符号链接差异；失败时退回字面比较。
        let same = match (std::fs::canonicalize(program), current.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => std::path::Path::new(program) == current.as_path(),
        };
        if same {
            return true;
        }
        crate::tauri_log!(
            "deep-link",
            "desktop handler Exec points elsewhere; will ask user to re-associate"
        );
        return false;
    }
    false
}

/// 协议关联状态：供前端渲染「设置 → 系统集成」开关的初始态。
///
/// 三态而非布尔：`Failed` 是「想注册但写失败了」，UI 应显示为未启用并允许重试，
/// 不能与「用户主动关掉」混为一谈（后者不该被自动纠正回来）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationState {
    /// 已关联（或 macOS 这种构建期即关联）。
    #[default]
    Registered,
    /// 用户显式关闭，且已（尝试）注销。
    Disabled,
    /// 想注册但失败（权限/系统限制），可重试。
    Failed,
}

#[derive(Default)]
pub struct DeepLinkRegistration(Mutex<RegistrationState>);

impl DeepLinkRegistration {
    fn set_registered(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = RegistrationState::Registered;
    }

    fn set_disabled(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = RegistrationState::Disabled;
    }

    fn set_failed(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = RegistrationState::Failed;
    }

    fn get(&self) -> RegistrationState {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 第二次启动被拦截时的回调：把已有主窗口拉到前台。
///
/// URL 本身已由 single-instance（`deep-link` feature）转交给 deep-link 插件并触发
/// `on_open_url`，这里只负责窗口激活，不重复解析 argv。
///
/// 只记参数个数：argv 里就是深链原文，含房间码；`tauri_log!` 会同时落盘到
/// `{BaseDir}/logs/qomicex-tauri.log` 并回显 stderr，记全文等于把房间码写进日志。
pub fn handle_second_instance(app: &AppHandle, argv: &[String]) {
    crate::tauri_log!("deep-link", "second instance: {} arg(s)", argv.len());
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 取走**全部**待处理深链（不清空；前端处理完需逐条回执）。前端挂载或后端就绪时调用。
#[tauri::command]
pub fn take_pending_deep_link(state: tauri::State<'_, PendingDeepLink>) -> Vec<String> {
    state.take_pending()
}

/// 前端回执：某条深链已处理完毕，可从待处理集合移除。返回是否确实移除。
#[tauri::command]
pub fn complete_deep_link(state: tauri::State<'_, PendingDeepLink>, url: String) -> bool {
    state.complete(&url)
}

/// 协议关联状态快照（设置页开关的初始值）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkStatus {
    /// 开关是否处于「已启用」。
    enabled: bool,
    /// 当前平台是否支持运行时开启/关闭。
    ///
    /// macOS 恒为 `false`：协议由打包期 `Info.plist` 的 `CFBundleURLTypes` 声明，
    /// crate 的 `register`/`unregister` 都返回 `UnsupportedPlatform`。UI 据此把开关
    /// 置灰只读并说明原因，而不是给一个点了没反应的开关。
    changeable: bool,
    /// 上一次自动注册是否失败（UI 可提示「重试」）。
    failed: bool,
}

/// 查询协议关联状态。
#[tauri::command]
pub fn deep_link_status(state: tauri::State<'_, DeepLinkRegistration>) -> DeepLinkStatus {
    let current = state.get();
    DeepLinkStatus {
        enabled: current == RegistrationState::Registered,
        changeable: cfg!(any(windows, target_os = "linux")),
        failed: current == RegistrationState::Failed,
    }
}

/// 开启/关闭协议关联（设置页开关）。返回操作后的状态快照。
///
/// 关闭时**同时**把用户意图写进 [`DeepLinkPreference`]，否则下次启动会因为
/// 「检测到未关联」而自动注册回去——开关就白关了。
#[tauri::command]
pub fn set_deep_link_enabled(app: AppHandle, enabled: bool) -> DeepLinkStatus {
    let state = app.state::<DeepLinkRegistration>();

    #[cfg(any(windows, target_os = "linux"))]
    {
        if enabled {
            match app.deep_link().register_all() {
                Ok(()) => {
                    DeepLinkPreference {
                        auto_register: true,
                    }
                    .save();
                    state.set_registered();
                    crate::tauri_log!("deep-link", "scheme '{SCHEME}' enabled by user");
                }
                Err(e) => {
                    crate::tauri_log!("deep-link", "enable failed: {e}");
                    // 注册失败不写偏好：意图仍是想开，下次启动应再试一次。
                    state.set_failed();
                }
            }
        } else {
            match app.deep_link().unregister(SCHEME) {
                Ok(()) => {
                    DeepLinkPreference {
                        auto_register: false,
                    }
                    .save();
                    state.set_disabled();
                    crate::tauri_log!("deep-link", "scheme '{SCHEME}' disabled by user");
                }
                Err(e) => {
                    // 注销失败就不改意图，也不谎报已关——否则用户以为关了、链接却还能唤起。
                    crate::tauri_log!("deep-link", "disable failed: {e}");
                    state.set_registered();
                }
            }
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        // macOS：协议写在 Info.plist，运行时改不了。这里不该被调用（changeable=false
        // 时前端已置灰），真被调用也保持原状、只记日志。
        let _ = enabled;
        crate::tauri_log!("deep-link", "runtime toggle unsupported on this platform");
    }

    let current = state.get();
    DeepLinkStatus {
        enabled: current == RegistrationState::Registered,
        changeable: cfg!(any(windows, target_os = "linux")),
        failed: current == RegistrationState::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        // 同一进程内多次调用要有区别：拼上纳秒时间戳。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("qmx-deeplink-{tag}-{}-{nanos}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// 本次改动的**核心不变量**：偏好文件缺失时必须默认「自动注册」。
    ///
    /// 若这里退化成 false，全新安装的用户会打不开链接，而且没有任何 UI 提示
    /// （开关会显示成关，用户不知道该开）——功能静默失效。
    #[test]
    fn preference_defaults_to_auto_register_when_missing() {
        let dir = temp_dir("missing");
        let path = dir.join("deep-link.json");
        assert!(!path.exists());
        assert!(
            DeepLinkPreference::load_from(&path).auto_register,
            "偏好文件缺失时应默认自动注册"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 用户关掉开关后写下的意图，必须在下次启动时被读到——否则
    /// `register_scheme` 会因为「检测到未关联」而重新注册，开关等于失效。
    #[test]
    fn disabled_intent_survives_roundtrip() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("deep-link.json");

        DeepLinkPreference {
            auto_register: false,
        }
        .save_to(&path)
        .expect("save");
        assert!(
            !DeepLinkPreference::load_from(&path).auto_register,
            "写下的「已关闭」意图必须能读回来"
        );

        // 再切回开启也要能往返
        DeepLinkPreference {
            auto_register: true,
        }
        .save_to(&path)
        .expect("save");
        assert!(DeepLinkPreference::load_from(&path).auto_register);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件损坏按默认处理（true），不能让一个坏 JSON 把功能关掉。
    #[test]
    fn corrupted_preference_falls_back_to_enabled() {
        let dir = temp_dir("corrupt");
        let path = dir.join("deep-link.json");
        std::fs::write(&path, "{ this is not json").expect("write");
        assert!(
            DeepLinkPreference::load_from(&path).auto_register,
            "损坏的偏好文件应回落为自动注册，而不是静默关闭功能"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 旧版本写的 JSON 缺字段时也按默认（true）。
    #[test]
    fn preference_missing_field_defaults_true() {
        let dir = temp_dir("partial");
        let path = dir.join("deep-link.json");
        std::fs::write(&path, "{}").expect("write");
        assert!(DeepLinkPreference::load_from(&path).auto_register);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 状态机三态互不混淆：Failed（想开但失败）不能被当成 Disabled（用户主动关），
    /// 否则 UI 会把「可重试的失败」显示成「已按你要求关闭」，用户无从恢复。
    #[test]
    fn registration_states_are_distinct() {
        let s = DeepLinkRegistration::default();
        s.set_failed();
        assert_eq!(s.get(), RegistrationState::Failed);
        s.set_disabled();
        assert_eq!(s.get(), RegistrationState::Disabled);
        s.set_registered();
        assert_eq!(s.get(), RegistrationState::Registered);
    }

    /// 启动决策的**核心不变量**：用户关掉后即便处于「未关联」，也绝不自动注册回去。
    ///
    /// 这一条是反向探针逼出来的——最初这段逻辑内联在需要 `AppHandle` 的
    /// `register_scheme` 里，把 `if !白名单` 改成 `if false` 后**全部测试照样通过**，
    /// 等于「开关会不会失效」这件事没有任何覆盖。抽成纯函数后才钉得住。
    ///
    /// 若这里退化成 `Register`：用户关掉开关 → unregister → 下次启动检测到未关联
    /// → 又注册回去 → 开关形同虚设（而 UI 上还会显示成「已关闭」，自相矛盾）。
    #[test]
    fn user_disabled_wins_over_unassociated() {
        assert_eq!(
            startup_action(false, false),
            StartupAction::LeaveDisabled,
            "用户已关闭时必须保持关闭，即便当前未关联"
        );
        // 用户关闭后关联被别的程序建起来，也不该去动它
        assert_eq!(
            startup_action(false, true),
            StartupAction::LeaveDisabled,
            "用户已关闭时不要插手关联状态"
        );
    }

    /// 默认（未关闭）时的决策矩阵。
    #[test]
    fn default_intent_registers_only_when_unassociated() {
        assert_eq!(
            startup_action(true, false),
            StartupAction::Register,
            "默认开启且未关联 → 应写入"
        );
        assert_eq!(
            startup_action(true, true),
            StartupAction::KeepRegistered,
            "默认开启且已关联 → 不该重复写"
        );
    }

    /// 默认值的两个入口必须一致（单一事实源）。
    #[test]
    fn default_value_has_single_source_of_truth() {
        assert!(auto_register_default());
        assert!(DeepLinkPreference::default().auto_register);
        // 经 serde 走「JSON 缺字段」路径也应与 Default 一致
        let from_empty: DeepLinkPreference = serde_json::from_str("{}").expect("parse {}");
        assert_eq!(
            from_empty.auto_register,
            DeepLinkPreference::default().auto_register,
            "serde 缺字段回落与 Default 必须同源，否则两条路径会漂移"
        );
    }
}
