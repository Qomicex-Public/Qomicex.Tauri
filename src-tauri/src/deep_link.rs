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
//! `take_pending_deep_link` 取走并清空——否则前端尚未挂载时的事件会丢失（冷启动必然如此）。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// 转发给前端的深链事件名（payload：URL 字符串数组）。
pub const EVENT_NAME: &str = "deep-link://action";

/// OS 协议名（不含 `://`）。与内部 IPC 协议 `qomicex` 区分，见模块头注释。
pub const SCHEME: &str = "qomicex-launcher";

/// 已接收但前端尚未消费的深链 URL。
///
/// 前端首次挂载时经 `take_pending_deep_link` 一次性取走（take 语义 = 读取即清空），
/// 因此「冷启动 URL」与「挂载前到达的 URL」都不会丢，也不会被重复处理。
#[derive(Default)]
pub struct PendingDeepLink(Mutex<Vec<String>>);

impl PendingDeepLink {
    fn push(&self, urls: Vec<String>) {
        if urls.is_empty() {
            return;
        }
        // 中毒锁不影响功能：仅是一个 URL 队列，取回内部值继续用即可。
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.extend(urls);
    }

    fn take(&self) -> Vec<String> {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *guard)
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

/// 确保本可执行文件是 `qomicex-launcher://` 的处理器。
///
/// 官方 bundler 会在安装包里写注册表/desktop 文件，但 dev 构建与 AppImage 等
/// 未安装形态不会——`register_all` 即为此提供自愈（官方文档推荐的写法）。
/// 失败只记日志：注册不了不应让启动器起不来。
fn register_scheme(app: &AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    {
        if let Err(e) = app.deep_link().register_all() {
            crate::tauri_log!("deep-link", "register_all failed: {e}");
        } else {
            crate::tauri_log!("deep-link", "scheme '{SCHEME}' registered");
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        // macOS 只支持构建期由 Info.plist 注册（crate 层返回 UnsupportedPlatform）。
        let _ = app;
    }
}

/// 第二次启动被拦截时的回调：把已有主窗口拉到前台。
///
/// URL 本身已由 single-instance（`deep-link` feature）转交给 deep-link 插件并触发
/// `on_open_url`，这里只负责窗口激活，不重复解析 argv。
pub fn handle_second_instance(app: &AppHandle, argv: &[String]) {
    crate::tauri_log!("deep-link", "second instance: {argv:?}");
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 取走挂起队列（读取即清空）。前端挂载时调用一次。
#[tauri::command]
pub fn take_pending_deep_link(state: tauri::State<'_, PendingDeepLink>) -> Vec<String> {
    state.take()
}
