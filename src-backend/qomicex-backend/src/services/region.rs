// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 区域判定：只为「中国大陆合规提示」与离线登录的风口期开关服务。
//!
//! 只看系统时区名，不发网络请求：避免把用户 IP 交给第三方，也避免网络不可用时
//! 阻塞启动。时区可被手动篡改，所以结论只当提示依据；若日后需要强约束（把
//! `RESTRICT_OFFLINE_LOGIN_IN_CN` 打开），应补网络侧判定，见 ADR-117。

/// 中国大陆时区名（IANA tz database，含历史别名）。
const CHINA_MAINLAND_TIMEZONES: &[&str] = &[
    "Asia/Shanghai",
    "Asia/Chongqing",
    "Asia/Harbin",
    "Asia/Urumqi",
    "PRC",
];

/// 时区名是否属于中国大陆。
pub fn is_china_mainland_timezone(timezone: &str) -> bool {
    CHINA_MAINLAND_TIMEZONES
        .iter()
        .any(|tz| tz.eq_ignore_ascii_case(timezone.trim()))
}

/// 本机是否位于中国大陆。
///
/// 取不到时区时返回 `false`：该判定只驱动一条提示和一个默认关闭的开关，
/// 误报打扰正常用户，漏报不改变功能行为。
pub fn machine_is_china_mainland() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| match iana_time_zone::get_timezone() {
        Ok(tz) => is_china_mainland_timezone(&tz),
        Err(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_mainland_timezones() {
        for tz in CHINA_MAINLAND_TIMEZONES {
            assert!(is_china_mainland_timezone(tz), "{tz}");
        }
        assert!(is_china_mainland_timezone(" asia/shanghai "));
    }

    #[test]
    fn rejects_other_timezones() {
        for tz in ["Asia/Taipei", "Asia/Hong_Kong", "Asia/Tokyo", "UTC", ""] {
            assert!(!is_china_mainland_timezone(tz), "{tz}");
        }
    }
}
