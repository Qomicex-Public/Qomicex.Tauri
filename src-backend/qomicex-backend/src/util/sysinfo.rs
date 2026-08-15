//! 系统信息采集（对应源 SystemEndpoints 的 SysInfo 辅助 + SystemMemoryHelper）。
//!
//! 系统显示名：Windows/macOS 经 sysinfo 读平台注册表/系统版本（Windows 自动区分
//! 10/11），Linux 读 os-release 的 PRETTY_NAME。

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
    match os_name() {
        // Linux：os-release 的 PRETTY_NAME（如 "Ubuntu 24.04.1 LTS"）比 sysinfo 的
        // "Linux <version> <name>" 更友好，保留现有逻辑。
        "linux" => linux_pretty_name().unwrap_or_else(os_description),
        // Windows/macOS：sysinfo 读注册表 ProductName（自动把 "Windows 10" 前缀映射为
        // Windows 11）返回如 "Windows 11 Pro"；macOS 返回 "MacOS 14.5 Sonoma"。
        "windows" | "osx" => System::long_os_version().unwrap_or_else(os_description),
        _ => os_description(),
    }
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
    (
        sys.total_memory() / (1024 * 1024),
        sys.available_memory() / (1024 * 1024),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_is_friendly() {
        let name = os_display_name();
        assert!(!name.is_empty());
        // Windows 上不应再裸显示环境变量 OS 的原始值（Windows_NT）
        #[cfg(target_os = "windows")]
        assert_ne!(name, "Windows_NT");
    }
}
