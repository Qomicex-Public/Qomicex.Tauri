use std::path::PathBuf;

pub const PORT_FILE: &str = ".gateway_port";

/// 数据根目录，与后端 AppPaths.BaseDir 保持一致：
/// 1. QOMICEX_HOME（便携模式）
/// 2. {LocalAppData}/qomicex-launcher
pub fn base_dir() -> PathBuf {
    if let Ok(home) = std::env::var("QOMICEX_HOME") {
        return PathBuf::from(home);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(appdata).join("qomicex-launcher");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join("Library/Application Support/qomicex-launcher");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return PathBuf::from(xdg).join("qomicex-launcher");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local/share/qomicex-launcher");
        }
    }
    PathBuf::from(".").join("qomicex-launcher")
}

pub fn plugins_dir() -> PathBuf {
    base_dir().join("plugins")
}

/// 插件数据库目录（db_get/db_set 使用），与后端 cache.json 同级但独立命名
pub fn plugin_db_dir() -> PathBuf {
    base_dir().join("plugin-wasm-db")
}
