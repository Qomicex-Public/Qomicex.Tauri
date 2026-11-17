// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 插件系统要求判定（manifest.systemRequirements）。
//!
//! 规则：
//! - 没有 `systemRequirements` 或 `os` 为空 → 全部支持；
//! - 只有 allow=true 条目 → 白名单，未命中的系统不支持；
//! - 只有 allow=false 条目 → 黑名单，未命中的系统支持；
//! - 两种都有 → 按条目声明，命中的 false 优先否决，其余未命中按支持。
//!
//! 条目内缺 `version`/`arch` 视为 `"*"`。版本比较与依赖版本共用
//! `plugin::version_satisfies`（数值段比较，空格表示 AND）。

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use super::plugin::version_satisfies;
use crate::error::ApiError;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSystemRequirements {
    #[serde(default)]
    pub os: Vec<PluginOsRequirement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOsRequirement {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    /// 缺省按允许处理：只有显式 false 才表示不支持。
    #[serde(default = "allow_by_default")]
    pub allow: bool,
}

fn allow_by_default() -> bool {
    true
}

#[derive(Debug, Clone)]
pub struct SystemSnapshot {
    pub os: String,
    pub arch: String,
    pub version: String,
}

pub fn current() -> &'static SystemSnapshot {
    static SNAPSHOT: OnceLock<SystemSnapshot> = OnceLock::new();
    SNAPSHOT.get_or_init(|| SystemSnapshot {
        os: normalize_os(std::env::consts::OS),
        arch: normalize_arch(std::env::consts::ARCH),
        version: sysinfo::System::os_version().unwrap_or_default(),
    })
}

/// 描述当前系统，供拒绝安装时的错误信息使用。
pub fn describe_current() -> String {
    let sys = current();
    if sys.version.is_empty() {
        format!("{} {}", sys.os, sys.arch)
    } else {
        format!("{} {} {}", sys.os, sys.arch, sys.version)
    }
}

pub fn manifest_supported(requirements: Option<&PluginSystemRequirements>) -> bool {
    is_supported(requirements, current())
}

/// 安装入口的统一拦截：不满足系统要求时拒绝写入磁盘。
pub fn ensure_supported(requirements: Option<&PluginSystemRequirements>) -> Result<(), ApiError> {
    if manifest_supported(requirements) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "PLUGIN_UNSUPPORTED_SYSTEM",
            format!("该插件不支持当前系统（{}）", describe_current()),
        ))
    }
}

pub fn is_supported(requirements: Option<&PluginSystemRequirements>, sys: &SystemSnapshot) -> bool {
    let Some(requirements) = requirements else {
        return true;
    };
    if requirements.os.is_empty() {
        return true;
    }

    let has_allow = requirements.os.iter().any(|r| r.allow);
    let has_deny = requirements.os.iter().any(|r| !r.allow);

    if requirements
        .os
        .iter()
        .any(|r| !r.allow && entry_matches(r, sys))
    {
        return false;
    }
    if requirements
        .os
        .iter()
        .any(|r| r.allow && entry_matches(r, sys))
    {
        return true;
    }
    // 只有白名单条目时，未声明 = 不支持；混有黑名单时未声明按支持。
    !has_allow || has_deny
}

fn entry_matches(entry: &PluginOsRequirement, sys: &SystemSnapshot) -> bool {
    if normalize_os(&entry.name) != sys.os {
        return false;
    }
    let arch_matches = match entry.arch.as_deref().map(str::trim) {
        None | Some("") | Some("*") => true,
        Some(arch) => normalize_arch(arch) == sys.arch,
    };
    arch_matches && version_matches(&sys.version, entry.version.as_deref())
}

fn version_matches(actual: &str, constraint: Option<&str>) -> bool {
    let Some(constraint) = constraint.map(str::trim).filter(|c| !c.is_empty()) else {
        return true;
    };
    let rest: Vec<&str> = constraint
        .split_whitespace()
        .filter(|part| *part != "*")
        .collect();
    if rest.is_empty() {
        return true;
    }
    // sysinfo 在 Windows 返回 `10 (19045)`，把构建号并入版本段后再做数值比较。
    let actual = actual.trim().replace(" (", ".").replace(')', "");
    version_satisfies(&actual, Some(&rest.join(" ")))
}

fn normalize_os(raw: &str) -> String {
    let raw = raw.trim().to_ascii_lowercase();
    match raw.as_str() {
        "osx" | "darwin" | "mac" | "macos" => "macos".to_string(),
        "win" | "win32" | "windows" => "windows".to_string(),
        "linux" => "linux".to_string(),
        other => other.to_string(),
    }
}

fn normalize_arch(raw: &str) -> String {
    let raw = raw.trim().to_ascii_lowercase();
    match raw.as_str() {
        "x86_64" | "x64" | "amd64" => "x64".to_string(),
        "aarch64" | "arm64" => "arm64".to_string(),
        "x86" | "i386" | "i686" | "ia32" => "x86".to_string(),
        "arm" | "armv7" => "arm".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sys(os: &str, arch: &str, version: &str) -> SystemSnapshot {
        SystemSnapshot {
            os: os.to_string(),
            arch: arch.to_string(),
            version: version.to_string(),
        }
    }

    fn entry(
        name: &str,
        version: Option<&str>,
        arch: Option<&str>,
        allow: bool,
    ) -> PluginOsRequirement {
        PluginOsRequirement {
            name: name.to_string(),
            version: version.map(String::from),
            arch: arch.map(String::from),
            allow,
        }
    }

    fn req(os: Vec<PluginOsRequirement>) -> PluginSystemRequirements {
        PluginSystemRequirements { os }
    }

    #[test]
    fn absent_requirements_allow_every_system() {
        assert!(is_supported(None, &sys("linux", "x64", "6.8.0")));
        assert!(is_supported(
            Some(&req(vec![])),
            &sys("linux", "x64", "6.8.0")
        ));
    }

    #[test]
    fn allow_only_is_a_whitelist() {
        let r = req(vec![entry("windows", Some(">=10"), Some("x64"), true)]);
        assert!(is_supported(Some(&r), &sys("windows", "x64", "10 (19045)")));
        assert!(!is_supported(
            Some(&r),
            &sys("windows", "arm64", "10 (19045)")
        ));
        assert!(!is_supported(Some(&r), &sys("windows", "x64", "8.1")));
        assert!(!is_supported(Some(&r), &sys("linux", "x64", "6.8.0")));
    }

    #[test]
    fn deny_only_is_a_blacklist() {
        let r = req(vec![entry("macos", None, None, false)]);
        assert!(!is_supported(Some(&r), &sys("macos", "arm64", "14.5")));
        assert!(is_supported(Some(&r), &sys("windows", "x64", "10 (19045)")));
        assert!(is_supported(Some(&r), &sys("linux", "x64", "6.8.0")));
    }

    #[test]
    fn mixed_entries_honour_declarations_and_allow_the_rest() {
        let r = req(vec![
            entry("windows", Some(">=10"), None, true),
            entry("macos", None, Some("x64"), false),
        ]);
        assert!(is_supported(
            Some(&r),
            &sys("windows", "arm64", "11 (22631)")
        ));
        assert!(!is_supported(Some(&r), &sys("macos", "x64", "14.5")));
        assert!(is_supported(Some(&r), &sys("macos", "arm64", "14.5")));
        assert!(is_supported(Some(&r), &sys("linux", "x64", "6.8.0")));
    }

    #[test]
    fn deny_wins_over_allow_for_the_same_system() {
        let r = req(vec![
            entry("windows", None, None, true),
            entry("windows", Some("<11"), None, false),
        ]);
        assert!(!is_supported(
            Some(&r),
            &sys("windows", "x64", "10 (19045)")
        ));
        assert!(is_supported(Some(&r), &sys("windows", "x64", "11 (22631)")));
    }

    #[test]
    fn missing_version_and_arch_match_everything() {
        let r = req(vec![entry("linux", None, None, true)]);
        assert!(is_supported(Some(&r), &sys("linux", "arm64", "6.1.0")));
    }

    #[test]
    fn wildcard_version_matches_everything() {
        let r = req(vec![entry("windows", Some("*"), Some("*"), true)]);
        assert!(is_supported(Some(&r), &sys("windows", "x64", "6.1")));
    }

    #[test]
    fn architecture_aliases_are_normalized() {
        assert_eq!(normalize_arch("x86_64"), "x64");
        assert_eq!(normalize_arch("aarch64"), "arm64");
        assert_eq!(normalize_os("osx"), "macos");
        assert_eq!(normalize_os("win32"), "windows");
    }
}
