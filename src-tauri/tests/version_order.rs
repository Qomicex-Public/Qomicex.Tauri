//! #46 回归防护：QML 版本号（betaN 序数进位）在朴素 semver 比较下会倒退，
//! 必须经由 version_order 的数值感知比较器。
//!
//! 旧 Tauri updater 链路（RemoteRelease 反序列化形状兼容）已随插件移除而
//! 删除；存量旧版客户端的 manifest 兼容由 release CI 继续产出 latest.json。

use qomicex_launcher_lib::version_order::is_update_available;

fn v(s: &str) -> semver::Version {
    s.trim_start_matches('v').parse().unwrap()
}

#[test]
fn update_available_semantics() {
    // 注意：不能直接用 semver 原生比较——betaN 序数进位在 semver
    // 字典序下是倒退（beta10 < beta9），这正是 #46 的第二层问题，
    // 必须经由 version_order 的数值感知比较器。
    let current = v("0.1.0-beta9.0");
    assert!(!is_update_available(&current, &v("0.1.0-beta9.0")));
    assert!(is_update_available(&current, &v("0.1.0-beta10.0")));
}

#[test]
fn v_prefix_stripped_before_compare() {
    // release 资产曾带 v 前缀（见 update.rs 归一化兜底注释），语义不变。
    let current = v("v0.1.0-beta9.0");
    assert!(is_update_available(&current, &v("v0.1.0-beta10.0")));
    assert!(!is_update_available(&current, &v("v0.1.0-beta9.0")));
}
