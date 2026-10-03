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

/// 确保本可执行文件是 `qomicex-launcher://` 的处理器——**只在需要时写**。
///
/// 为什么不是无条件 `register_all()`：Windows 上它把 `HKCU\Software\Classes\qomicex-launcher`
/// 的处理器改写成「当前 exe」。启动器同时存在 NSIS 安装版与免安装/解压版，无条件重写会让
/// 后运行的任意一份构建（含临时目录里的 dev 产物）抢走整个系统的协议关联，那份文件一被
/// 删除，链接就彻底打不开。故先用 `is_registered()` 查：已是当前 exe 就什么都不做。
///
/// 不满足时**不在这里补注册**，而是置一个「需要注册」标记，由前端在初始化向导（OOBE）
/// 阶段或启动时提示用户确认——注册表写入属用户可见的系统改动，不该在无人知情时发生。
/// 失败只记日志：注册不了不应让启动器起不来。
fn register_scheme(app: &AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    {
        match app.deep_link().is_registered(SCHEME) {
            Ok(true) => {
                crate::tauri_log!("deep-link", "scheme '{SCHEME}' already associated");
                app.state::<DeepLinkRegistration>().set_registered();
            }
            Ok(false) => {
                crate::tauri_log!(
                    "deep-link",
                    "scheme '{SCHEME}' not associated; awaiting user"
                );
                app.state::<DeepLinkRegistration>().set_pending();
            }
            Err(e) => {
                crate::tauri_log!("deep-link", "is_registered failed: {e}");
                app.state::<DeepLinkRegistration>().set_pending();
            }
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        // macOS 只支持构建期由 Info.plist 注册（crate 层返回 UnsupportedPlatform）。
        app.state::<DeepLinkRegistration>().set_registered();
    }
}

/// 协议关联状态，供前端决定是否在 OOBE / 启动时提示注册。
#[derive(Default)]
pub struct DeepLinkRegistration(Mutex<bool>);

impl DeepLinkRegistration {
    fn set_registered(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }

    fn set_pending(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }

    fn is_registered(&self) -> bool {
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

/// 查询协议关联状态（false = 需要用户确认后注册）。
#[tauri::command]
pub fn deep_link_registration_status(state: tauri::State<'_, DeepLinkRegistration>) -> bool {
    state.is_registered()
}

/// 写入协议关联（前端在 OOBE / 提示确认后调用）。返回是否成功。
#[cfg(any(windows, target_os = "linux"))]
#[tauri::command]
pub fn register_deep_link(app: AppHandle) -> bool {
    match app.deep_link().register_all() {
        Ok(()) => {
            app.state::<DeepLinkRegistration>().set_registered();
            // 成功路径同样不记 argv / 不记额外信息，只记结果。
            crate::tauri_log!("deep-link", "scheme '{SCHEME}' registration confirmed");
            true
        }
        Err(e) => {
            crate::tauri_log!("deep-link", "register_all failed: {e}");
            false
        }
    }
}

/// macOS 无运行时注册能力（由 Info.plist 在打包期声明），恒返回 false。
#[cfg(not(any(windows, target_os = "linux")))]
#[tauri::command]
pub fn register_deep_link(_app: AppHandle) -> bool {
    false
}
