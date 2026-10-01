//! Windows 原生拖放接管：让「文本拖拽」也能进来。
//!
//! ## 为什么需要这个模块
//!
//! tauri/wry 在 Windows 上会注册自己的 `IDropTarget`，而它**只请求 `CF_HDROP`（文件）**：
//! `wry-0.57 src/webview2/drag_drop.rs` 的 `iterate_filenames` 在拿不到该格式时走
//! `DV_E_FORMATETC` 分支并直接返回（注释原文 *"item is not a file"*），**不发任何事件**。
//! 同时 wry 会对 WebView2 控制器调用 `SetAllowExternalDrop(false)`，于是 DOM 的
//! HTML5 `drop` 也不再派发 —— 两条路都断。
//!
//! authlib-injector 的「拖动卡片到启动器」走的正是 **`text/plain` 文本**
//! （见其启动器技术规范：`authlib-injector:yggdrasil-server:{编码后的 API 地址}`），
//! 既不是文件、也不会落成 `.url` 快捷方式，所以在 Windows 上毫无反应（issue #136）。
//!
//! ## 做法
//!
//! 在 WebView2 的子窗口上**撤销 wry 的注册并注册我们自己的** `IDropTarget`，
//! 同时接受两种格式（`DragEnter`/`DragOver` 只用 `QueryGetData` 探测，取数在 `Drop` 时做）：
//!
//! - `CF_HDROP`  → 发 `file-drop`（保持原有「拖入文件一键安装」不变）
//! - `CF_UNICODETEXT` → 经 `extract_candidate` 过滤后发 `ygg-server-drop`，前端再解析/确认
//!
//! 接管后 tauri 的 `WindowEvent::DragDrop` 不再触发（事件原本就由 wry 的处理器转发），
//! 因此 `file-drop-hover` 也由这里补发，拖拽遮罩的既有行为得以保留。
//! 覆盖方式是在子窗口上 `RevokeDragDrop` + `RegisterDragDrop`，**无需**改
//! `dragDropEnabled`（保持 wry 的其余行为不变）。

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr;

use tauri::{AppHandle, Emitter};
use windows::core::implement;
use windows::Win32::Foundation::{HWND, LPARAM, POINTL};
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP,
    CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragFinish, DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

/// 给 WebView2 子窗口装一个能读文本的拖放目标。
///
/// 必须在 WebView2 创建之后调用（wry 已在此时注册了它自己的目标，我们要覆盖它）。
pub fn install(app: &AppHandle, window: &tauri::WebviewWindow) {
    let hwnd = match window.hwnd() {
        Ok(h) => h,
        Err(e) => {
            crate::tauri_log!("dnd", "获取窗口句柄失败，跳过拖放接管: {e}");
            return;
        }
    };

    let app = app.clone();
    // 与 wry 相同的做法：枚举子窗口，找到 WebView2 的窗口并逐个覆盖。
    let mut ctx = InstallCtx {
        app,
        installed: Vec::new(),
    };
    let ctx_ptr: *mut InstallCtx = &mut ctx;
    unsafe {
        let _ = EnumChildWindows(
            Some(HWND(hwnd.0)),
            Some(enum_child_proc),
            LPARAM(ctx_ptr as isize),
        );
    }
    if ctx.installed.is_empty() {
        crate::tauri_log!(
            "dnd",
            "未找到可接管的 WebView2 子窗口（文本拖拽可能不可用）"
        );
    } else {
        crate::tauri_log!(
            "dnd",
            "已接管 {} 个 WebView2 子窗口的拖放（文件 + 文本）",
            ctx.installed.len()
        );
    }
    // 让注册的 COM 对象活到进程结束：OLE 仍持有其引用，drop 掉会被调用到已释放内存。
    std::mem::forget(ctx.installed);
}

struct InstallCtx {
    app: AppHandle,
    installed: Vec<IDropTarget>,
}

unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let ctx = &mut *(lparam.0 as *mut InstallCtx);
    let target: IDropTarget = DragDropTarget::new(hwnd, ctx.app.clone()).into();
    // 先撤销既有目标（wry 或 WebView2 自己注册的），再装我们的。
    let _ = RevokeDragDrop(hwnd);
    if RegisterDragDrop(hwnd, &target).is_ok() {
        ctx.installed.push(target);
    }
    windows::core::BOOL(1) // 继续枚举
}

#[implement(IDropTarget)]
pub struct DragDropTarget {
    app: AppHandle,
    cursor_effect: std::cell::UnsafeCell<DROPEFFECT>,
    enter_is_valid: std::cell::UnsafeCell<bool>,
}

impl DragDropTarget {
    fn new(_hwnd: HWND, app: AppHandle) -> Self {
        Self {
            app,
            cursor_effect: DROPEFFECT_NONE.into(),
            enter_is_valid: false.into(),
        }
    }

    /// 该拖动对象是否提供某种剪贴板格式（只探测，**不取数据**）。
    ///
    /// OLE 拖放里 `DragEnter` 阶段应只用 `QueryGetData` 判断可否接受；真正取数据
    /// 留到 `Drop`，取完立刻释放。早期实现直接在 `DragEnter` 里 `GetData`+`DragFinish`，
    /// 等于在拖动过程中就把拖放源的数据消耗掉一次。
    unsafe fn has_format(data_obj: &IDataObject, cf: u16) -> bool {
        let fmt = FORMATETC {
            cfFormat: cf,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        data_obj.QueryGetData(&fmt).is_ok()
    }

    /// 读取 `CF_HDROP`（拖入的文件路径）。没有该格式时返回 `None`。
    unsafe fn read_paths(data_obj: &IDataObject) -> Option<Vec<PathBuf>> {
        let fmt = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        // windows 0.61 的 GetData 直接返回 STGMEDIUM（不是 out 参数）。
        let medium = match data_obj.GetData(&fmt) {
            Ok(m) => m,
            Err(_) => return None,
        };
        let hdrop = HDROP(medium.u.hGlobal.0 as _);
        let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, None) as usize;
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len + 1];
            let written = DragQueryFileW(hdrop, i, Some(&mut buf));
            if written == 0 {
                continue;
            }
            paths.push(PathBuf::from(OsString::from_wide(
                &buf[0..written as usize],
            )));
        }
        // CF_HDROP 用 DragFinish 释放；**不能**再调 ReleaseStgMedium，
        // 否则同一个 HGLOBAL 被释放两次（wry 的实现同样只用 DragFinish）。
        DragFinish(hdrop);
        Some(paths)
    }

    /// 读取 `CF_UNICODETEXT`（拖入的文本）。
    unsafe fn read_text(data_obj: &IDataObject) -> Option<String> {
        let fmt = FORMATETC {
            cfFormat: CF_UNICODETEXT.0,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let mut medium = match data_obj.GetData(&fmt) {
            Ok(m) => m,
            Err(_) => return None,
        };
        let locked = GlobalLock(medium.u.hGlobal);
        let text = if locked.is_null() {
            None
        } else {
            let p = locked as *const u16;
            // 扫描 NUL 结尾的宽字符串，但**必须用 GlobalSize 限界**：
            // 外部拖放源可以给出畸形/恶意的、不带 NUL 的 CF_UNICODETEXT，
            // 无界扫描会越界读取甚至崩溃进程（COM 回调里 panic 无法展开）。
            let max_units = GlobalSize(medium.u.hGlobal) / std::mem::size_of::<u16>();
            let mut len = 0usize;
            while len < max_units && *p.add(len) != 0 {
                len += 1;
            }
            if len == 0 {
                None
            } else {
                let slice = std::slice::from_raw_parts(p, len);
                let s = String::from_utf16_lossy(slice);
                Some(s)
            }
        };
        // 只在确实加锁成功时解锁（失败时 GlobalUnlock 也会报错，没必要调）。
        if !locked.is_null() {
            let _ = GlobalUnlock(medium.u.hGlobal);
        }
        ReleaseStgMedium(&mut medium);
        text.filter(|s| !s.trim().is_empty())
    }

    /// 拖动源里是否含可处理的数据（文件或文本）。
    ///
    /// 只用 `QueryGetData` 探测格式，**不取数据**：`DragEnter`/`DragOver` 可能被
    /// 高频调用，且取数会消耗拖放源的数据。
    unsafe fn probe(data_obj: &IDataObject) -> (bool, bool) {
        if Self::has_format(data_obj, CF_HDROP.0) {
            return (true, false);
        }
        (false, Self::has_format(data_obj, CF_UNICODETEXT.0))
    }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DragDropTarget_Impl {
    fn DragEnter(
        &self,
        pDataObj: windows::core::Ref<'_, IDataObject>,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let Some(obj) = pDataObj.as_ref() else {
            unsafe { *pdwEffect = DROPEFFECT_NONE };
            return Ok(());
        };
        let (has_files, has_text) = unsafe { DragDropTarget::probe(obj) };
        // 文本拖拽同样接受（authlib-injector 的卡片就是文本），否则光标会显示禁止。
        let valid = has_files || has_text;
        unsafe {
            *self.enter_is_valid.get() = valid;
            let effect = if valid {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
            *self.cursor_effect.get() = effect;
            *pdwEffect = effect;
        }
        // 只有拖文件时才显示「拖到这里安装」的全屏遮罩，避免拖文本时误报。
        if has_files {
            let _ = self.app.emit("file-drop-hover", true);
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe { *pdwEffect = *self.cursor_effect.get() };
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if unsafe { *self.enter_is_valid.get() } {
            let _ = self.app.emit("file-drop-hover", false);
        }
        Ok(())
    }

    fn Drop(
        &self,
        pDataObj: windows::core::Ref<'_, IDataObject>,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        _pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if !unsafe { *self.enter_is_valid.get() } {
            return Ok(());
        }
        let Some(obj) = pDataObj.as_ref() else {
            return Ok(());
        };
        let _ = self.app.emit("file-drop-hover", false);

        // 文件优先：保持「拖入文件一键安装」的既有语义。
        let paths: Vec<String> = unsafe { DragDropTarget::read_paths(obj) }
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if !paths.is_empty() {
            crate::logger::log_line("dnd", &format!("文件拖拽 -> {} 个文件", paths.len()));
            let _ = self.app.emit("file-drop", paths);
            return Ok(());
        }

        // 否则按文本处理：先过滤出「看起来是验证服务器地址」的候选，
        // 再交给前端。不过滤的话，任何文本拖拽都会弹确认框。
        if let Some(text) = unsafe { DragDropTarget::read_text(obj) } {
            match extract_candidate(&text) {
                Some(candidate) => {
                    crate::logger::log_line("dnd", &format!("文本拖拽 -> {candidate}"));
                    let _ = self.app.emit("ygg-server-drop", candidate);
                }
                None => {
                    crate::logger::log_line(
                        "dnd",
                        &format!(
                            "文本拖拽被忽略（非验证服务器地址）：{}",
                            truncate(&text, 80)
                        ),
                    );
                }
            }
        }
        Ok(())
    }
}

/// 日志里截断过长文本，避免把用户的剪贴内容整段写进日志。
fn truncate(s: &str, max: usize) -> String {
    let cut: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        format!("{cut}…")
    } else {
        cut
    }
}

/// 从拖拽文本里取出候选地址（纯函数，便于单测）。
///
/// 规范里的形式是 `authlib-injector:yggdrasil-server:{encodeURIComponent(API 地址)}`；
/// 但实际站点不一定遵守前缀（例如直接把 API 地址作为拖拽数据），因此裸 `http(s)://`
/// 地址也一并接受——后续由既有的 ALI 解析补齐/校验，不会比手输更宽松。
pub fn extract_candidate(text: &str) -> Option<String> {
    const PREFIX: &str = "authlib-injector:yggdrasil-server:";
    let raw = text.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix(PREFIX) {
        let rest = rest.trim();
        // 规范要求 URL 编码；解不开就按原样试（部分站点不编码）。
        let decoded = percent_decode(rest).unwrap_or_else(|| rest.to_string());
        let decoded = decoded.trim().to_string();
        return if decoded.is_empty() {
            None
        } else {
            Some(decoded)
        };
    }
    // 用**字节**前缀比较，不要 `raw[..8]`：str 索引必须落在 UTF-8 字符边界上，
    // 对非 ASCII（如「你好世界你好」）切片会 panic；而这里跑在 COM 的 `Drop`
    // 回调里，panic 无法跨 `extern "system"` 展开，会直接终止启动器进程。
    // 大小写不敏感与旧行为一致。
    let b = raw.as_bytes();
    let is_scheme = (b.len() >= 7 && b[..7].eq_ignore_ascii_case(b"http://"))
        || (b.len() >= 8 && b[..8].eq_ignore_ascii_case(b"https://"));
    if is_scheme {
        return Some(raw.to_string());
    }
    None
}

/// 仅解码 `%XX`（不把 `+` 当空格）：authlib URI 里走的是 `encodeURIComponent`。
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::extract_candidate;

    /// 规范形式：带前缀 + URL 编码。
    #[test]
    fn parses_spec_prefixed_uri() {
        assert_eq!(
            extract_candidate(
                "authlib-injector:yggdrasil-server:https%3A%2F%2Flittleskin.cn%2Fapi%2Fyggdrasil"
            )
            .as_deref(),
            Some("https://littleskin.cn/api/yggdrasil")
        );
    }

    /// 部分站点不编码、或带首尾空白：都要能取到地址。
    #[test]
    fn parses_unjncoded_and_padded_prefixed_uri() {
        assert_eq!(
            extract_candidate(
                "  authlib-injector:yggdrasil-server:https://littleskin.cn/api/yggdrasil\n"
            )
            .as_deref(),
            Some("https://littleskin.cn/api/yggdrasil")
        );
    }

    /// 裸地址（站点直接拖 API 地址）也要接受——issue #136 里 LittleSkin 卡片确实
    /// 把地址放在 `data-clipboard-text`，不能假设一定带前缀。
    #[test]
    fn accepts_bare_url() {
        assert_eq!(
            extract_candidate("https://littleskin.cn/api/yggdrasil").as_deref(),
            Some("https://littleskin.cn/api/yggdrasil")
        );
        assert_eq!(
            extract_candidate("HTTPS://Example.com/api/yggdrasil").as_deref(),
            Some("HTTPS://Example.com/api/yggdrasil")
        );
    }

    /// 无关文本一律不认，避免把普通拖拽误当成验证服务器地址。
    ///
    /// 其中 `"你好世界你好"` 是**回归用例**：它 12 字节、字符边界在 0/3/6/9/12，
    /// 早期实现用 `raw[..8]` 按字节切片判前缀，会 panic（"byte index 8 is not a
    /// char boundary"）。该函数跑在 COM 的 `Drop` 回调里，panic 无法跨
    /// `extern "system"` 展开，等于拖入任意中文文本即可让启动器进程终止。
    #[test]
    fn rejects_unrelated_text() {
        for bad in [
            "",
            "   ",
            "你好世界你好",
            "hello world",
            "authlib-injector:yggdrasil-server:",
            "ftp://example.com/x",
            "file:///C:/x.txt",
            "littleskin.cn/api/yggdrasil",
        ] {
            assert_eq!(extract_candidate(bad), None, "不应接受: {bad:?}");
        }
    }
}
