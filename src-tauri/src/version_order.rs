//! QML 版本排序键（#46 第二层修复）。
//!
//! semver 规范中字母数字 pre-release 标识符按 ASCII 字典序比较，
//! 导致 `0.1.0-beta10.0 < 0.1.0-beta9.0`（'1' < '9'），Tauri updater
//! 默认比较器会把 beta 序数进位误判为"无更新/倒退"。这里把版本映射
//! 成数值感知的排序键：标识符拆成（字母前缀, 数字段列表），数字按值比较。
//!
//! 排序规则示例：
//! - `0.1.0-alpha20260823.0 > 0.1.0-alpha20260822.2`（日期数值比）
//! - `0.1.0-beta10.0 > 0.1.0-beta9.0`（序数数值比）
//! - `0.1.0-beta9.0 > 0.1.0-alpha20260823.0`（"beta" > "alpha"）
//! - `0.1.1 > 0.1.1-anything`、`0.1.0-beta9.0 > 0.1.0` 同版不提示

use tauri_plugin_updater::RemoteRelease;

/// (major, minor, patch, stable标记, [(标识符字母前缀, 数字段...)])
///
/// stable 标记放 pre-release 键之前：正式版永远大于任何 pre-release。
type SortKey = (u64, u64, u64, u8, Vec<(String, Vec<u64>)>);

fn sort_key(v: &semver::Version) -> SortKey {
    let pre = v.pre.as_str();
    let identifiers: Vec<(String, Vec<u64>)> = if pre.is_empty() {
        Vec::new()
    } else {
        pre.split('.')
            .map(|seg| {
                let digits_start = seg.find(|c: char| c.is_ascii_digit()).unwrap_or(seg.len());
                let prefix = seg[..digits_start].to_string();
                let numbers: Vec<u64> = if digits_start < seg.len() {
                    seg[digits_start..]
                        .split(|c: char| !c.is_ascii_digit())
                        .filter_map(|n| n.parse().ok())
                        .collect()
                } else {
                    Vec::new()
                };
                (prefix, numbers)
            })
            .collect()
    };
    let stable_mark = u8::from(pre.is_empty());
    (v.major, v.minor, v.patch, stable_mark, identifiers)
}

/// updater 版本比较器入口：manifest 版本是否比当前版本新。
pub fn is_update_available(current: &semver::Version, release: &RemoteRelease) -> bool {
    sort_key(&release.version) > sort_key(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> semver::Version {
        s.trim_start_matches('v').parse().unwrap()
    }

    #[test]
    fn beta_ordinal_does_not_regress() {
        assert!(is_update_available(
            &v("0.1.0-beta9.0"),
            &release("0.1.0-beta10.0")
        ));
        assert!(!is_update_available(
            &v("0.1.0-beta10.0"),
            &release("0.1.0-beta9.0")
        ));
    }

    #[test]
    fn alpha_dates_compare_numerically() {
        assert!(is_update_available(
            &v("0.1.0-alpha20260822.2"),
            &release("0.1.0-alpha20260823.0")
        ));
        assert!(is_update_available(
            &v("0.1.0-alpha20260822.9"),
            &release("0.1.0-alpha20260822.10")
        ));
    }

    #[test]
    fn beta_beats_alpha_same_base() {
        assert!(is_update_available(
            &v("0.1.0-alpha20260823.0"),
            &release("0.1.0-beta9.0")
        ));
    }

    #[test]
    fn same_version_and_downgrade_are_not_updates() {
        assert!(!is_update_available(
            &v("0.1.0-beta9.0"),
            &release("0.1.0-beta9.0")
        ));
        assert!(!is_update_available(
            &v("0.1.0-beta10.0"),
            &release("0.1.0-beta9.0")
        ));
        // 同 base 去掉 pre-release = 正式版，semver 规范视为更大（与
        // Tauri 默认比较器行为一致）
        assert!(is_update_available(&v("0.1.0-beta9.0"), &release("0.1.0")));
    }

    #[test]
    fn stable_newer_than_prerelease_of_same_base() {
        // beta 渠道收到正式版 → 提示更新；正式版收到 beta → 不提示
        assert!(is_update_available(&v("0.1.0-beta9.0"), &release("0.1.1")));
        assert!(!is_update_available(&v("0.1.1"), &release("0.1.1-beta1.0")));
    }

    fn release(version: &str) -> RemoteRelease {
        serde_json::from_value(serde_json::json!({
            "version": format!("v{version}"),
            "pub_date": "2026-08-24T11:23:19Z",
            "platforms": {
                "windows-x86_64": {
                    "url": "https://example.com/setup.exe",
                    "signature": "sig"
                }
            }
        }))
        .expect("test manifest parses")
    }
}
