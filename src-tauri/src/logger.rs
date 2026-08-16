//! Tauri 主进程日志：`{BaseDir}/logs/qomicex-tauri.log` 追加写入。
//!
//! 后端有自己的 tracing + 文件日志；这里只覆盖 Tauri 主进程自身的
//! 生命周期日志（后端 spawn/杀掉/提取失败、插件网关、WASM 插件等），
//! 保证启动失败这类信息有落盘，而不是只进 eprintln 的终端。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// 全局日志文件句柄（首次使用时惰性打开）。
static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);
/// 已解析的日志目录（进程内缓存一次）。
static LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 解析数据目录：`QOMICEX_HOME` 环境变量优先，否则 `{LocalAppData}/qomicex-launcher`
/// （与后端 settings.rs 的 `resolve_base_dir` 对齐；不读 bootstrap 文件）。
fn base_dir() -> PathBuf {
    if let Ok(env) = std::env::var("QOMICEX_HOME") {
        if !env.trim().is_empty() {
            return PathBuf::from(env);
        }
    }
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
            home.join(".local/share")
        });
    local.join("qomicex-launcher")
}

fn log_dir() -> PathBuf {
    let mut guard = LOG_DIR.lock().unwrap();
    if let Some(dir) = guard.as_ref() {
        return dir.clone();
    }
    let dir = base_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    *guard = Some(dir.clone());
    dir
}

/// 写一行到 `{BaseDir}/logs/qomicex-tauri.log`，同时回显 stderr。
pub fn log_line(tag: &str, msg: &str) {
    let line = format!(
        "{} [{tag}] {msg}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f")
    );
    let mut guard = LOG_FILE.lock().unwrap();
    if guard.is_none() {
        let path = log_dir().join("qomicex-tauri.log");
        *guard = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
    }
    if let Some(f) = guard.as_mut() {
        let _ = writeln!(f, "{line}");
    }
    eprintln!("{line}");
}

/// 便捷宏：`tauri_log!("backend", "spawn failed: {e}")`。
#[macro_export]
macro_rules! tauri_log {
    ($tag:expr, $($arg:tt)*) => {
        $crate::logger::log_line($tag, &format!($($arg)*))
    };
}
