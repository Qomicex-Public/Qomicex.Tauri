// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
///
/// 可用内存经 [`normalize_available`] 归一：sysinfo 在 macOS 上把 available 算成
/// `free + inactive + purgeable - compressor`，压缩内存高时 `saturating_sub` 会
/// 直接饱和到 0，表现为「48GB 机器显示共 48GB / 已用 48GB / 剩余 0」（#375 同批反馈）。
pub fn memory() -> (u64, u64) {
    let mut sys = System::new();
    sys.refresh_memory();
    let total = sys.total_memory();
    let raw_available = sys.available_memory();
    let used = sys.used_memory();
    let free = sys.free_memory();
    let available = normalize_available(total, raw_available, used, free);
    if total > 0 && available != raw_available {
        log_implausible_memory(total, raw_available, used, free, available);
    }
    (total / (1024 * 1024), available / (1024 * 1024))
}

/// 把平台给出的 available 收敛成可信值（字节）。
///
/// 顺序：原值可信（0 < available <= total）→ 用原值；否则用 `total - used`
/// （同一批 vm 统计的另一侧，macOS 上仍有效）→ 再退到 `free` → 最后退到
/// **total / 2**。
///
/// 最后一级不是"报全空闲"：拿不到任何内存统计时按「可用不超过一半物理内存」估计。
/// 报 `total` 会让自动 `-Xmx` 取到 70% 物理内存（如 48GB 机器给 33GB），大概率
/// 直接把游戏 OOM 掉；宁可偏保守、让用户手动调高，并留一条 WARN 说明是估算值。
fn normalize_available(total: u64, available: u64, used: u64, free: u64) -> u64 {
    if total == 0 {
        return available;
    }
    if available > 0 && available <= total {
        return available;
    }
    if used > 0 && used < total {
        return total - used;
    }
    if free > 0 && free <= total {
        return free;
    }
    total / 2
}

/// 每个进程只记一次：这是平台数据异常，不是正常分支，重复刷屏没有信息增量。
fn log_implausible_memory(total: u64, raw: u64, used: u64, free: u64, fixed: u64) {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        tracing::warn!(
            event = "memory_stats_implausible",
            total_bytes = total,
            raw_available_bytes = raw,
            used_bytes = used,
            free_bytes = free,
            normalized_available_bytes = fixed,
            "平台返回的可用内存不可信，已归一"
        );
    });
}

/// 第一颗 CPU 的型号名（如 "Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz"）。
/// 采集有开销，用 `OnceLock` 缓存一次。失败返回空串（调用方拼接时忽略）。
pub fn cpu_brand() -> String {
    use std::sync::OnceLock;
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut sys = System::new();
            sys.refresh_cpu_usage();
            sys.cpus()
                .first()
                .map(|c| c.brand().trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_default()
        })
        .clone()
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

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn plausible_available_is_kept() {
        assert_eq!(
            normalize_available(48 * GIB, 20 * GIB, 28 * GIB, 1 * GIB),
            20 * GIB
        );
    }

    #[test]
    fn zero_available_falls_back_to_total_minus_used() {
        // macOS：available 被 compressor 减到 0，used 仍有效
        assert_eq!(
            normalize_available(48 * GIB, 0, 31 * GIB, 2 * GIB),
            17 * GIB
        );
    }

    #[test]
    fn available_above_total_is_rejected() {
        assert_eq!(
            normalize_available(16 * GIB, 40 * GIB, 12 * GIB, 1 * GIB),
            4 * GIB
        );
    }

    #[test]
    fn falls_back_to_free_then_half_of_total_when_nothing_is_usable() {
        assert_eq!(normalize_available(16 * GIB, 0, 0, 3 * GIB), 3 * GIB);
        // 什么都拿不到时按一半物理内存估：报 total 会让自动 -Xmx 取到 70% 物理内存。
        assert_eq!(normalize_available(16 * GIB, 0, 0, 0), 8 * GIB);
    }

    #[test]
    fn memory_is_in_megabytes_and_consistent() {
        let (total_mb, available_mb) = memory();
        if total_mb > 0 {
            assert!(available_mb > 0, "可用内存不应为 0（{total_mb} MB 总内存）");
            assert!(
                available_mb <= total_mb,
                "可用 {available_mb} MB 不应超过总量 {total_mb} MB"
            );
        }
    }
}
