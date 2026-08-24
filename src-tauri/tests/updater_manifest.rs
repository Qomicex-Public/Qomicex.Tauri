//! #46 回归防护：本地后端 `/api/update/manifest` 返回的 Tauri manifest JSON
//! 必须能被 tauri-plugin-updater 的 `RemoteRelease` 成功反序列化。
//!
//! 背景：updater 插件对 204 直接短路返回"无更新"，而远端
//! api.qomicex.top manifest 端点曾恒 204 导致检查更新永远"已是最新"。
//! 修复后将 updater 主端点切到本地后端透传的 latest.json 形状，
//! 此测试锁定该形状与插件解析器的兼容性（含 version 的 v 前缀剥离、
//! RFC3339 pub_date、platforms 映射）。

use serde_json::json;
use tauri_plugin_updater::RemoteRelease;

/// 与 release 资产 latest.json 相同的关键形状（截取 changelog 无关字段）。
fn latest_json() -> serde_json::Value {
    json!({
        "version": "v0.1.0-beta9.0",
        "required": true,
        "notes": "## Qomicex Launcher v0.1.0-beta9.0",
        "pub_date": "2026-08-24T11:23:19Z",
        "platforms": {
            "windows-x86_64": {
                "url": "https://github.com/Qomicex-Public/Qomicex.Tauri/releases/download/v0.1.0-beta9.0/Qomicex%20Launcher_0.1.0-beta9.0_x64-setup.exe",
                "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK"
            },
            "darwin-aarch64": {
                "url": "https://github.com/Qomicex-Public/Qomicex.Tauri/releases/download/v0.1.0-beta9.0/qomicex-launcher_v0.1.0-beta9.0_arm64.dmg",
                "signature": "sig"
            }
        }
    })
}

#[test]
fn backend_manifest_parses_as_remote_release() {
    let release: RemoteRelease =
        serde_json::from_value(latest_json()).expect("backend manifest must deserialize");

    // v 前缀被剥掉且 semver 正确解析（pre-release 保留）
    assert_eq!(release.version.to_string(), "0.1.0-beta9.0");
    assert_eq!(
        release.notes.as_deref(),
        Some("## Qomicex Launcher v0.1.0-beta9.0")
    );
    assert!(release.pub_date.is_some());
}

#[test]
fn update_available_semantics() {
    use qomicex_launcher_lib::version_order::is_update_available;

    // 注意：不能直接用 semver 原生比较——betaN 序数进位在 semver
    // 字典序下是倒退（beta10 < beta9），这正是 #46 的第二层问题，
    // 必须经由 version_order 的数值感知比较器。
    let current: semver::Version = "0.1.0-beta9.0".parse().unwrap();

    let same: RemoteRelease = serde_json::from_value(latest_json()).unwrap();
    assert!(!is_update_available(&current, &same));

    let mut newer = latest_json();
    newer["version"] = json!("v0.1.0-beta10.0");
    let newer: RemoteRelease = serde_json::from_value(newer).unwrap();
    assert!(is_update_available(&current, &newer));
}

#[test]
fn dynamic_single_platform_shape_still_supported() {
    // 后端在 platforms 缺失/为空时返回 204，不会走到这；但锁一下插件
    // 对单平台动态形状的兼容性，防止未来误改后端返回结构。
    let single = json!({
        "version": "v0.2.0",
        "notes": null,
        "pub_date": "2026-08-24T11:23:19Z",
        "url": "https://example.com/setup.exe",
        "signature": "sig"
    });
    let release: RemoteRelease = serde_json::from_value(single).expect("dynamic shape parses");
    assert_eq!(release.version.to_string(), "0.2.0");
}
