//! 系统信息采集（对应源 SystemEndpoints 的 SysInfo 辅助 + SystemMemoryHelper）。
//!
//! ⚠️ 技术债：Windows 版本号（build/major）与发行版名（Windows 10/11 细分）当前为
//! 近似值；精确解析需引入平台 API（winreg / uname），留待后续批次对齐。

use sysinfo::System;

pub fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "unknown"
    }
}

pub fn architecture() -> String {
    std::env::consts::ARCH.to_string()
}

/// 对应 RuntimeInformation.OSDescription（尽力而为的近似）。
pub fn os_description() -> String {
    if let Ok(uname) = std::env::var("OS") {
        return uname;
    }
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

pub fn os_version() -> String {
    match (os_name(), std::env::consts::OS) {
        ("windows", "windows") => "Windows NT".to_string(),
        _ => os_description(),
    }
}

pub fn os_version_id() -> String {
    "unknown".to_string()
}

pub fn os_display_name() -> String {
    if os_name() == "linux" {
        if let Some(name) = linux_pretty_name() {
            return name;
        }
    }
    os_description()
}

fn linux_pretty_name() -> Option<String> {
    for path in ["/etc/os-release", "/usr/lib/os-release"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines() {
                if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
                    let val = val.trim_matches(|c| c == '"' || c == '\'');
                    if !val.is_empty() {
                        return Some(val.to_string());
                    }
                }
            }
        }
    }
    None
}

/// 返回 (总物理内存, 可用物理内存)，单位 **MB**（与 C# SystemMemoryHelper 一致：
/// 源为字节 / (1024*1024)）。
pub fn memory() -> (u64, u64) {
    let mut sys = System::new();
    sys.refresh_memory();
    (sys.total_memory() / (1024 * 1024), sys.available_memory() / (1024 * 1024))
}
