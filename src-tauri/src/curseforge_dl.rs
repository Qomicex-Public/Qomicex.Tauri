// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 分发受限模组的应用内下载窗口（ADR-133）。
//!
//! 作者关闭第三方分发后没有可用的 API 下载地址，只能在 CurseForge 文件页上
//! 由用户自己点 Download。这个窗口把多张文件页做成标签队列：一次打开全部待补
//! 文件，逐个点 Download；每捕获到一个文件地址就关掉对应标签，标签清空时关窗。
//! 页面完整展示，作者的曝光与收益不变，不绕过任何开关。
//!
//! 窗口 label 不在 capabilities 里，外部页面没有任何 IPC 权限。工具栏按钮通过
//! 导航到 `qomicex-cfdl.invalid` 由 `on_navigation` 拦截，不需要页面调用命令。

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const WINDOW_LABEL: &str = "cf-download";
/// 工具栏按钮的伪导航目标：命中即取消导航并执行动作，不会真的发请求。
const ACTION_HOST: &str = "qomicex-cfdl.invalid";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowFile {
    pub file_id: i64,
    pub file_name: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRequested {
    instance_id: String,
    file_id: i64,
    url: String,
}

struct Tab {
    file_id: i64,
    file_name: String,
    url: String,
}

struct Session {
    instance_id: String,
    tabs: Vec<Tab>,
    active: usize,
    total: usize,
    /// 会话代次：异步任务（导航/关窗）执行前核对，避免上一批的收尾动作作用到新窗口。
    generation: u64,
}

fn session() -> &'static Mutex<Option<Session>> {
    static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

fn generation_counter() -> &'static std::sync::atomic::AtomicU64 {
    static GENERATION: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();
    GENERATION.get_or_init(|| std::sync::atomic::AtomicU64::new(0))
}

fn next_generation() -> u64 {
    generation_counter().fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

fn current_generation() -> u64 {
    generation_counter().load(std::sync::atomic::Ordering::SeqCst)
}

/// 一键下载开关：用户点工具栏按钮后才自动点文件页的 Download。
fn auto_flag() -> &'static std::sync::atomic::AtomicBool {
    static AUTO: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();
    AUTO.get_or_init(|| std::sync::atomic::AtomicBool::new(false))
}

fn auto_enabled() -> bool {
    auto_flag().load(std::sync::atomic::Ordering::SeqCst)
}

fn set_auto(value: bool) {
    auto_flag().store(value, std::sync::atomic::Ordering::SeqCst)
}

fn with_session<R>(f: impl FnOnce(&mut Session) -> R) -> Option<R> {
    let mut guard = session().lock().ok()?;
    guard.as_mut().map(f)
}

/// 只接受 https 的 CurseForge 主域：这个窗口会把页面内容当成可信上下文来触发
/// 自动补全，放开到任意站点等于给任意网页一个「往实例里塞文件」的入口。
fn is_curseforge_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("www.curseforge.com") | Some("curseforge.com")
    )
}

/// CF 的下载确认页倒计时结束后请求的是 CDN 域（edge/mediafilez 等）。
fn is_forge_cdn(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| h == "forgecdn.net" || h.ends_with(".forgecdn.net"))
}

fn is_curseforge_file_page(url: &Url) -> bool {
    url.scheme() == "https" && is_curseforge_host(url) && url.path().contains("/files/")
}

/// 顶部工具栏：刷新 / 浏览器打开 / 标签队列 / 进度。
///
/// 整段脚本在 `on_page_load`（Finished）时 eval，而不是 `initialization_script`：
/// 外部页面下初始化脚本的执行时机/环境不受我们控制，实测会出现脚本没生效但页面
/// 正常加载的情况；Finished 时 body 已存在，DOM 操作最稳。重复 eval 是幂等的
/// （`__QM_CLICK_BOUND__` 只绑一次，工具栏节点复用）。
///
/// 用 DOM API 建节点而不是 innerHTML：文件名来自上游，拼字符串会带来注入面。
/// 只追加一个 fixed 定位的容器，不改页面布局，避免干扰 CF 自己的 React。
/// 失败时把异常经伪地址回传，写入 `[cf-download]` 日志。
const TOOLBAR_SCRIPT: &str = r#"
(function () {
  var HOST = '__QM_HOST__';
  var STATE = __QM_STATE__;
  try {
    var NS = 'http://www.w3.org/2000/svg';
    var ICON_REFRESH = ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v5h-5'];
    var ICON_BROWSER = ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3'];
    var ICON_DOWNLOAD = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'];

    function svgIcon(paths) {
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      // 内联宽高：站点自己的 `svg { width: ... }` 规则会盖过 HTML 属性，
      // 图标会被拉到铺满按钮。
      svg.setAttribute('style',
        'width:16px;height:16px;min-width:16px;min-height:16px;max-width:16px;max-height:16px;' +
        'flex:0 0 auto;display:inline-block;pointer-events:none;');
      paths.forEach(function (d) {
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
      });
      return svg;
    }

    function iconButton(paths, title, act) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-qm-act', act);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.setAttribute('style',
        'flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;' +
        'border:none;border-radius:8px;background:transparent;color:#d4d4d8;cursor:pointer;padding:0;');
      b.appendChild(svgIcon(paths));
      b.addEventListener('mouseenter', function () { b.style.background = '#27272a'; b.style.color = '#fff'; });
      b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; b.style.color = '#d4d4d8'; });
      return b;
    }

    function primaryButton(paths, label, act) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-qm-act', act);
      b.setAttribute('style',
        'flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;' +
        'border:none;border-radius:8px;background:transparent;color:#22c55e;cursor:pointer;font:600 12px system-ui;');
      b.appendChild(svgIcon(paths));
      var span = document.createElement('span');
      span.textContent = label;
      b.appendChild(span);
      b.addEventListener('mouseenter', function () { b.style.background = 'rgba(34,197,94,.12)'; });
      b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; });
      return b;
    }

    function tabButton(t) {
      var name = String(t.name || t.id);
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-qm-act', 'tab');
      b.setAttribute('data-qm-id', String(t.id));
      b.textContent = name.length > 24 ? name.slice(0, 22) + '...' : name;
      b.title = name;
      b.setAttribute('style',
        'flex:0 0 auto;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'height:28px;padding:0 10px;border-radius:999px;cursor:pointer;font:12px system-ui;' +
        'border:1px solid ' + (t.active ? '#2563eb' : '#3f3f46') + ';' +
        'background:' + (t.active ? '#2563eb' : 'transparent') + ';color:' + (t.active ? '#fff' : '#d4d4d8') + ';');
      return b;
    }

    function separator() {
      var sep = document.createElement('span');
      sep.setAttribute('style', 'flex:0 0 auto;width:1px;height:22px;background:#3f3f46;margin:0 4px;');
      return sep;
    }

    function render(state) {
      var root = document.getElementById('qm-toolbar');
      if (!root) {
        var parent = document.body || document.documentElement;
        // 文档正在销毁（导航切换中）：直接跳过，不要触发任何导航，否则会被
        // 取消成空白文档、再被下一次 eval 撞上，形成黑屏循环。
        if (!parent) return;
        root = document.createElement('div');
        root.id = 'qm-toolbar';
        root.setAttribute('style',
          'position:fixed;top:0;left:0;right:0;height:52px;z-index:2147483647;display:flex;align-items:center;' +
          'gap:4px;padding:0 12px;background:#18181b;border-bottom:1px solid #2a2a2e;' +
          'font:12px system-ui,-apple-system,"Segoe UI",sans-serif;overflow-x:auto;' +
          'scrollbar-width:none;-ms-overflow-style:none;box-shadow:0 2px 8px rgba(0,0,0,.5);');
        parent.appendChild(root);
      }
      root.textContent = '';
      root.appendChild(primaryButton(ICON_DOWNLOAD, '快速下载', 'auto'));
      root.appendChild(separator());
      root.appendChild(iconButton(ICON_REFRESH, '刷新', 'refresh'));
      root.appendChild(iconButton(ICON_BROWSER, '在浏览器打开', 'browser'));
      root.appendChild(separator());
      (state.tabs || []).forEach(function (t) { root.appendChild(tabButton(t)); });
      var counter = document.createElement('span');
      counter.textContent = String(state.done || 0) + '/' + String(state.total || 0);
      counter.setAttribute('style', 'flex:0 0 auto;margin-left:auto;padding-left:10px;opacity:.65;color:#e4e4e7;');
      root.appendChild(counter);
    }

    if (!window.__QM_CLICK_BOUND__) {
      window.__QM_CLICK_BOUND__ = true;
      document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-qm-act]') : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        var act = el.getAttribute('data-qm-act');
        var id = el.getAttribute('data-qm-id');
        // 用 window.open（新窗口请求）而不是 location.href：后者会先销毁当前
        // 文档再被 on_navigation 取消，留下空白页，正是黑屏的来源。
        window.open('https://' + HOST + '/' + act + (id ? '/' + id : ''), '_blank');
      }, true);
    }

    render(STATE);
  } catch (err) {
    // 每个文档只报一次；用 window.open 上报，避免导航把文档换掉。
    if (!window.__QM_ERR_SENT__) {
      window.__QM_ERR_SENT__ = true;
      try {
        window.open('https://' + HOST + '/err/' + encodeURIComponent(String(err)), '_blank');
      } catch (ignored) {}
    }
  }
})();
"#;

/// 生成一次工具栏渲染脚本；会话为空时返回 `None`。
fn toolbar_script() -> Option<String> {
    let snapshot = with_session(|s| {
        let tabs: Vec<serde_json::Value> = s
            .tabs
            .iter()
            .enumerate()
            .map(|(i, t)| {
                serde_json::json!({
                    "id": t.file_id,
                    "name": t.file_name,
                    "active": i == s.active,
                })
            })
            .collect();
        serde_json::json!({
            "tabs": tabs,
            "done": s.total.saturating_sub(s.tabs.len()),
            "total": s.total,
        })
        .to_string()
    })?;
    Some(
        TOOLBAR_SCRIPT
            .replace("__QM_HOST__", ACTION_HOST)
            .replace("__QM_STATE__", &snapshot),
    )
}

fn window_title() -> String {
    with_session(|s| match s.tabs.get(s.active) {
        Some(tab) => format!(
            "{}/{} - {}",
            s.total.saturating_sub(s.tabs.len()) + 1,
            s.total,
            tab.file_name
        ),
        None => "CurseForge".to_string(),
    })
    .unwrap_or_else(|| "CurseForge".to_string())
}

/// 同一个文件地址在短时间内可能被页面重复请求（CF 的 307 链路/重试）：
/// 重复事件只取消下载，不再弹标签，否则会误伤队列里的下一条。
///
/// 去重只在一批（会话代次）内有效：上一批的记录不能挡住新一批对同一 URL 的请求。
fn is_duplicate_capture(url: &str) -> bool {
    static LAST: OnceLock<Mutex<Option<(u64, String, std::time::Instant)>>> = OnceLock::new();
    let mut guard = match LAST.get_or_init(|| Mutex::new(None)).lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let generation = current_generation();
    let now = std::time::Instant::now();
    if let Some((last_gen, last, at)) = guard.as_ref() {
        if *last_gen == generation
            && last == url
            && now.duration_since(*at) < std::time::Duration::from_secs(3)
        {
            return true;
        }
    }
    *guard = Some((generation, url.to_string(), now));
    false
}

/// 取出当前标签并切到下一个；返回 (instanceId, fileId, 下一个地址, 会话代次)。
///
/// 没有剩余标签时清空会话并返回 `None` 的下一个地址（调用方关窗）。
fn pop_active_tab() -> Option<(String, i64, Option<String>, u64)> {
    let mut guard = session().lock().ok()?;
    let (instance_id, file_id, next, generation) = {
        let s = guard.as_mut()?;
        if s.tabs.is_empty() {
            return None;
        }
        let active = s.active.min(s.tabs.len() - 1);
        let tab = s.tabs.remove(active);
        let instance_id = s.instance_id.clone();
        if s.active >= s.tabs.len() {
            s.active = s.tabs.len().saturating_sub(1);
        }
        let next = s.tabs.get(s.active).map(|t| t.url.clone());
        let generation = s.generation;
        (instance_id, tab.file_id, next, generation)
    };
    if next.is_none() {
        *guard = None;
    }
    Some((instance_id, file_id, next, generation))
}

fn active_url() -> Option<String> {
    with_session(|s| s.tabs.get(s.active).map(|t| t.url.clone())).flatten()
}

/// 在文件页上自动点**该文件**的 Download 按钮（只点页面自己的入口，不拼下载地址）。
///
/// 选择器必须带 fileId：页面上还有「下载 CurseForge 客户端」等同名按钮，
/// 按文案匹配会点错。找不到时回传 auto/missing，由 Rust 关掉自动模式并写日志。
const AUTO_CLICK_SCRIPT: &str = r#"
(function () {
  var HOST = '__QM_HOST__';
  var ID = '__QM_FILE__';
  function matchDownload(href) {
    // 完整路径段比较：/download/42 不能命中 ID=420 的链接。
    var m = /\/download\/(\d+)(?:[\/?#]|$)/.exec(href || '');
    return !!m && m[1] === ID;
  }
  try {
    var el = null;
    var nodes = document.querySelectorAll('a[href]');
    for (var i = 0; i < nodes.length; i++) {
      if (matchDownload(nodes[i].getAttribute('href'))) { el = nodes[i]; break; }
    }
    if (el) {
      el.click();
    } else if (!window.__QM_AUTO_MISSING__) {
      // 每个文档只报一次；window.open 不会破坏当前文档。
      window.__QM_AUTO_MISSING__ = true;
      window.open('https://' + HOST + '/auto/missing', '_blank');
    }
  } catch (err) {
    if (!window.__QM_ERR_SENT__) {
      window.__QM_ERR_SENT__ = true;
      try {
        window.open('https://' + HOST + '/auto/err/' + encodeURIComponent(String(err)), '_blank');
      } catch (ignored) {}
    }
  }
})();
"#;

fn is_file_page(url: &Url) -> bool {
    url.path().contains("/files/")
}

/// 自动模式下的点按：只在精确文件页上动作，倒计时页（/download/）不重复点。
fn schedule_auto_click(app: AppHandle, delay_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        if !auto_enabled() {
            return;
        }
        let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        let Ok(url) = win.url() else {
            return;
        };
        if !is_file_page(&url) {
            return;
        }
        // 只点队列里当前标签对应的页面：页面被手动导航到别的文件时不自动点。
        let Some(file_id) = with_session(|s| s.tabs.get(s.active).map(|t| t.file_id)).flatten()
        else {
            return;
        };
        let url_file_id = url
            .path()
            .rsplit('/')
            .next()
            .and_then(|s| s.parse::<i64>().ok());
        if url_file_id != Some(file_id) {
            return;
        }
        let script = AUTO_CLICK_SCRIPT
            .replace("__QM_HOST__", ACTION_HOST)
            .replace("__QM_FILE__", &file_id.to_string());
        let _ = win.eval(&script);
    });
}

/// 兜底渲染：页面加载事件在外部站点上不保证按时到达，创建/切换标签后再补几次。
/// eval 幂等（同一节点复用、点击只绑一次），多跑几次没有副作用。
fn schedule_toolbar(app: AppHandle) {
    std::thread::spawn(move || {
        for delay in [800u64, 1600, 3200] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
                return;
            };
            if let Some(script) = toolbar_script() {
                let _ = win.eval(&script);
            }
        }
    });
}

/// 工具栏动作。由 `on_new_window` 拦截伪地址（window.open）后调用。
fn handle_action(app: &AppHandle, url: &Url) {
    if url.host_str() != Some(ACTION_HOST) {
        return;
    }
    let action = url.path().trim_matches('/');
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    match action {
        "refresh" => {
            // 用 eval 而不是 navigate：reload 不产生新的导航链，避免和拦截器重入。
            let _ = win.eval("location.reload()");
        }
        "browser" => {
            if let Some(target) = active_url() {
                let _ = app.opener().open_url(target, None::<&str>);
            }
        }
        "auto" => {
            set_auto(true);
            tauri_log!("cf-download", "auto download enabled");
            schedule_auto_click(app.clone(), 200);
        }
        _ if action.starts_with("auto/") => {
            set_auto(false);
            tauri_log!(
                "cf-download",
                "auto download stopped: {}",
                action.strip_prefix("auto/").unwrap_or(action)
            );
        }
        _ if action.starts_with("err/") => {
            // 工具栏脚本自报的异常：只进日志，别让用户看到白条。
            tauri_log!("cf-download", "toolbar error: {}", &action[4..]);
        }
        _ => {
            let Some(id) = action.strip_prefix("tab/") else {
                return;
            };
            let Ok(file_id) = id.parse::<i64>() else {
                return;
            };
            let next = with_session(|s| {
                let idx = s.tabs.iter().position(|t| t.file_id == file_id)?;
                s.active = idx;
                s.tabs.get(idx).map(|t| t.url.clone())
            })
            .flatten();
            if let Some(target) = next {
                if let Ok(url) = Url::parse(&target) {
                    let _ = win.navigate(url);
                    let _ = win.set_title(&window_title());
                    if let Some(script) = toolbar_script() {
                        let _ = win.eval(&script);
                    }
                }
            }
        }
    }
}

/// 打开受限文件的应用内下载窗口（多标签队列）。
///
/// 必须是 async：同步命令在 Windows 的 WebView2 IPC 回调线程（即 UI 线程）上直接
/// 执行，`WebviewWindowBuilder::build()` 会在那里等消息循环返回，窗口白屏、关不掉，
/// 整个启动器一起假死。async 命令派发到 tokio 线程建窗，主线程只负责收消息。
#[tauri::command]
pub async fn open_blocked_download_window(
    app: AppHandle,
    instance_id: String,
    files: Vec<WindowFile>,
    title: String,
) -> Result<(), String> {
    let mut tabs = Vec::new();
    for file in files {
        let parsed = Url::parse(file.url.trim()).map_err(|e| format!("下载链接无效: {e}"))?;
        if !is_curseforge_file_page(&parsed) {
            return Err(format!("只支持 CurseForge 文件页: {}", file.url));
        }
        tabs.push(Tab {
            file_id: file.file_id,
            file_name: file.file_name,
            url: parsed.to_string(),
        });
    }
    if tabs.is_empty() {
        return Err("没有可打开的下载页面".to_string());
    }

    // 新一批从手动开始；一键下载由工具栏按钮显式开启。
    set_auto(false);

    let first = tabs[0].url.clone();
    let total = tabs.len();
    let generation = next_generation();
    {
        let mut guard = session().lock().map_err(|_| "下载会话不可用")?;
        *guard = Some(Session {
            instance_id,
            tabs,
            active: 0,
            total,
            generation,
        });
    }

    // 已有窗口：换掉会话直接复用，避免同 label 的关旧建新竞态。
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        if let Ok(url) = Url::parse(&first) {
            let _ = win.navigate(url);
        }
        let _ = win.set_title(&window_title());
        let _ = win.set_focus();
        if let Some(script) = toolbar_script() {
            let _ = win.eval(&script);
        }
        schedule_toolbar(app.clone());
        return Ok(());
    }

    let nav_app = app.clone();
    let done_app = app.clone();
    let page_app = app.clone();

    let win = WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        WebviewUrl::External(Url::parse(&first).map_err(|e| format!("下载链接无效: {e}"))?),
    )
    .title(title)
    .inner_size(1100.0, 820.0)
    .center()
    // 页面加载完成后再渲染工具栏：这时 body 一定存在，DOM 操作最稳。
    .on_page_load(move |webview, payload| {
        tauri_log!(
            "cf-download",
            "page load {:?} {}",
            payload.event(),
            payload.url()
        );
        if payload.event() == PageLoadEvent::Finished {
            if let Some(script) = toolbar_script() {
                let _ = webview.eval(&script);
            }
            let _ = webview.set_title(&window_title());
            // 自动模式：进入下一个文件页后，等页面稳定再点它的 Download。
            if auto_enabled() {
                schedule_auto_click(page_app.clone(), 900);
            }
        }
    })
    // 工具栏动作走 `window.open` 到伪地址：只产生新窗口请求，不会卸载当前文档
    // （用 location.href 会先销毁文档再被取消，留下空白页 → 黑屏）。
    .on_new_window(move |url, _| {
        if url.host_str() == Some(ACTION_HOST) {
            let app = nav_app.clone();
            let target = url.clone();
            tauri::async_runtime::spawn(async move {
                handle_action(&app, &target);
            });
            return NewWindowResponse::Deny;
        }
        // 文件页的 Download 可能是 target=_blank：改在同窗导航。CF 下载页倒计时
        // 结束后打开的是 forgecdn 域的文件地址，同样放行；站外弹窗一律拒绝。
        let allowed = is_curseforge_host(&url) || is_forge_cdn(&url);
        tauri_log!(
            "cf-download",
            "popup {} => {}",
            url,
            if allowed { "navigate" } else { "deny" }
        );
        if allowed {
            if let Some(win) = nav_app.get_webview_window(WINDOW_LABEL) {
                let _ = win.navigate(url);
            }
        }
        NewWindowResponse::Deny
    })
    // WebView2 自己的下载栈在 CF 的 CORS fetch 流程里只走到 Requested，
    // 既不落盘也不回调失败（窗口一直挂着）。这里取消它的下载，把地址交给
    // 后端用启动器下载器拉取：有进度、有 SHA-1 校验。
    .on_download(move |_webview, event| {
        match event {
            DownloadEvent::Requested { url, .. } => {
                tauri_log!("cf-download", "download requested: {url}");
                // 页面上的「下载客户端 / Install Via App」等同名入口也会触发下载：
                // 非 CDN 地址一律取消，且不消耗标签页。
                if !is_forge_cdn(&url) {
                    tauri_log!("cf-download", "ignored non-cdn download: {url}");
                    return false;
                }
                if is_duplicate_capture(url.as_str()) {
                    tauri_log!("cf-download", "duplicate capture ignored: {url}");
                    return false;
                }
                let Some((instance_id, file_id, next, generation)) = pop_active_tab() else {
                    return false;
                };
                let _ = done_app.emit_to(
                    "main",
                    "blocked-download-requested",
                    DownloadRequested {
                        instance_id,
                        file_id,
                        url: url.to_string(),
                    },
                );
                // 地址已交给后端；切到下一个标签，没有剩余标签时关窗。异步任务开跑前
                // 核对会话代次：这一批已经被新一批替换时不再动窗口。
                let app = done_app.clone();
                tauri::async_runtime::spawn(async move {
                    if current_generation() != generation {
                        return;
                    }
                    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
                        return;
                    };
                    match next.and_then(|u| Url::parse(&u).ok()) {
                        Some(target) => {
                            let _ = win.navigate(target);
                            let _ = win.set_title(&window_title());
                            schedule_toolbar(app.clone());
                        }
                        None => {
                            let _ = win.close();
                        }
                    }
                });
                false
            }
            DownloadEvent::Finished { path, success, .. } => {
                tauri_log!(
                    "cf-download",
                    "download finished success={success} path={:?}",
                    path
                );
                true
            }
            _ => true,
        }
    })
    .build()
    .map_err(|e| format!("打开下载窗口失败: {e}"))?;

    let _ = win.set_title(&window_title());
    schedule_toolbar(app.clone());
    Ok(())
}

/// 关闭应用内下载窗口并作废当前队列（补全对话框关闭时调用）。
///
/// 窗口与对话框共享生命周期：对话框关掉后没人接收 `blocked-download-requested`，
/// 继续下载只会丢事件。关闭对话框即放弃这一批标签，下次重新「全部打开」。
#[tauri::command]
pub async fn close_blocked_download_window(app: AppHandle) -> Result<(), String> {
    *session().lock().map_err(|_| "下载会话不可用")? = None;
    set_auto(false);
    // 作废在飞的收尾任务（导航/关窗），避免它们作用到下一批。
    next_generation();
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_curseforge_file_page, is_forge_cdn};
    use tauri::Url;

    fn parse(url: &str) -> Url {
        Url::parse(url).unwrap()
    }

    #[test]
    fn accepts_curseforge_file_pages() {
        assert!(is_curseforge_file_page(&parse(
            "https://www.curseforge.com/minecraft/mc-mods/mmcr/files/9274793"
        )));
        assert!(is_curseforge_file_page(&parse(
            "https://curseforge.com/minecraft/mc-mods/mmcr/files/9274793"
        )));
    }

    /// 倒计时结束打开的是 CDN 文件地址：必须是放行名单，否则下载永远不开始。
    #[test]
    fn accepts_forge_cdn_download_hosts() {
        assert!(is_forge_cdn(&parse(
            "https://edge.forgecdn.net/files/5343/797/mod.jar"
        )));
        assert!(is_forge_cdn(&parse(
            "https://mediafilez.forgecdn.net/files/1/2/mod.jar"
        )));
        assert!(!is_forge_cdn(&parse("https://forgecdn.net.evil.com/a.jar")));
        assert!(!is_forge_cdn(&parse("http://edge.forgecdn.net/a.jar")));
    }

    #[test]
    fn rejects_other_hosts_and_paths() {
        assert!(!is_curseforge_file_page(&parse(
            "https://evil.example.com/minecraft/mc-mods/mmcr/files/1"
        )));
        assert!(!is_curseforge_file_page(&parse(
            "http://www.curseforge.com/minecraft/mc-mods/mmcr/files/1"
        )));
        assert!(!is_curseforge_file_page(&parse(
            "https://www.curseforge.com/minecraft/mc-mods/mmcr"
        )));
    }
}
