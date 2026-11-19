// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 启动期硬件策略：Windows 独立显卡偏好、macOS 系统游戏模式、游戏进程优先级。
//!
//! 全部 best-effort：权限不足、工具缺失、注册表被策略锁死都只记日志，绝不让启动失败。
//! 调用点在两条 launch 路径（实例启动 / 联机启动），见 `endpoints::instance`、
//! `endpoints::connector`。

use std::path::PathBuf;

use crate::settings::{resolve_base_dir, SettingsResponse};

/// 用户独显偏好的注册表位置（Windows「设置 → 显示 → 图形」同一份数据）。
#[cfg(windows)]
const GPU_PREF_KEY: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";

/// Xcode 自带的私有工具；只有它能把系统游戏模式强制打开。
#[cfg(target_os = "macos")]
const GAMEPOLICYCTL: &str = "/Applications/Xcode.app/Contents/Developer/usr/bin/gamepolicyctl";

fn qml_dir() -> PathBuf {
    resolve_base_dir().join("QML")
}

fn settings_snapshot() -> SettingsResponse {
    crate::settings::load_settings()
}

fn boost_enabled(settings: &SettingsResponse) -> bool {
    settings.launch_hardware_boost.unwrap_or(true)
}

/// 归一未知档位：`None`/手改出的脏值都按 `normal`（不改动进程）。
pub fn normalize_priority(value: Option<&str>) -> &'static str {
    match value {
        Some("below_normal") => "below_normal",
        Some("above_normal") => "above_normal",
        Some("high") => "high",
        _ => "normal",
    }
}

/// 落盘值是否是已知档位（`settings.rs` 读盘归一用）。
pub fn is_known_priority(value: &str) -> bool {
    normalize_priority(Some(value)) == value
}

/// 启动前调用：按平台写入独显偏好 / 打开系统游戏模式。
pub fn prepare_launch(java_path: &str) {
    if !boost_enabled(&settings_snapshot()) {
        return;
    }
    #[cfg(windows)]
    windows::apply_gpu_preference(java_path);
    #[cfg(target_os = "macos")]
    macos::enable_game_mode();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = java_path;
}

/// 进程起来之后调用：按设置项调整优先级。
pub fn apply_priority(pid: i32) {
    if pid <= 0 {
        return;
    }
    let level = normalize_priority(settings_snapshot().process_priority.as_deref());
    set_priority(pid, level);
}

fn set_priority(pid: i32, level: &'static str) {
    #[cfg(windows)]
    {
        if !windows::set_priority_class(pid, level) {
            tracing::warn!(pid, level, "设置游戏进程优先级失败");
        }
    }
    #[cfg(unix)]
    {
        // shortcut: 负 nice 需要 root，非 Windows 平台只提供「正常 / 低于正常」两档；
        // 手改 settings.json 写出提升档位时按 normal 执行。要支持提权再引入 polkit/sudo 助手。
        if level == "above_normal" || level == "high" {
            tracing::warn!(
                pid,
                level,
                "非 Windows 平台提升进程优先级需要 root，按 normal 执行"
            );
            return;
        }
        let nice = if level == "below_normal" { 10 } else { 0 };
        let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, nice) };
        if rc != 0 {
            tracing::warn!(pid, level, "设置游戏进程优先级失败");
        }
    }
}

/// 游戏进程退出：复位系统级副作用（macOS 游戏模式是全局状态，必须还原）。
pub fn on_game_exit(_pid: i32) {
    #[cfg(target_os = "macos")]
    macos::disable_game_mode();
}

/// 启动流程失败（没拉起进程）：与退出同样复位，避免游戏模式一直挂着。
pub fn abort_launch() {
    #[cfg(target_os = "macos")]
    macos::disable_game_mode();
}

/// 用户在设置页关掉开关时立即回滚已写入的系统状态。
pub fn disable_boost() {
    #[cfg(windows)]
    windows::restore_gpu_preferences();
    #[cfg(target_os = "macos")]
    macos::disable_game_mode();
}

/// 启动器启动时调用：清掉上次崩溃残留（游戏模式没复位、开关关掉但注册表还没还原）。
pub fn recover_stale_state() {
    #[cfg(target_os = "macos")]
    macos::disable_game_mode();
    #[cfg(windows)]
    if !boost_enabled(&settings_snapshot()) {
        windows::restore_gpu_preferences();
    }
}

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    use super::{qml_dir, GPU_PREF_KEY};

    /// 偏好值文件名 = 可执行文件绝对路径；值 = 写入前的原始数据（`None` = 原本不存在）。
    type Backups = std::collections::BTreeMap<String, Option<String>>;

    /// 多实例几乎同时启动时备份文件会互相覆盖，串行化写路径。
    static BACKUP_LOCK: Mutex<()> = Mutex::new(());

    fn backup_path() -> PathBuf {
        qml_dir().join("gpu-pref-backup.json")
    }

    fn load_backups(backup_file: &Path) -> Backups {
        std::fs::read_to_string(backup_file)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default()
    }

    fn save_backups(backup_file: &Path, backups: &Backups) {
        if backups.is_empty() {
            let _ = std::fs::remove_file(backup_file);
            return;
        }
        if let Some(parent) = backup_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(backups) {
            Ok(json) => {
                if let Err(e) = std::fs::write(backup_file, json) {
                    tracing::warn!(error = %e, "写入独显偏好备份失败");
                }
            }
            Err(e) => tracing::warn!(error = %e, "序列化独显偏好备份失败"),
        }
    }

    pub(super) fn pref_key(root: &str) -> std::io::Result<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(root)
            .map(|(key, _)| key)
    }

    /// 只替换 `GpuPreference=` 这一个 token，保留用户原有的 `AutoHDREnable=` 等设置。
    ///
    /// 纯函数，便于单测；输入/输出都带结尾分号（Windows 自身格式）。
    pub(super) fn with_high_performance(current: Option<&str>) -> String {
        let mut tokens: Vec<String> = Vec::new();
        let mut replaced = false;
        for token in current.unwrap_or("").split(';') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            if token.to_ascii_lowercase().starts_with("gpupreference=") {
                tokens.push("GpuPreference=2".to_string());
                replaced = true;
            } else {
                tokens.push(token.to_string());
            }
        }
        if !replaced {
            tokens.push("GpuPreference=2".to_string());
        }
        format!("{};", tokens.join(";"))
    }

    /// 写入独显偏好；首次写入前把原值备份到 `QML/gpu-pref-backup.json`。
    pub(super) fn apply_gpu_preference(java_path: &str) {
        // 注册表值名必须与实际 exe 路径同一写法：Java 扫描结果里可能混有 '/'。
        let normalized = java_path.replace('/', "\\");
        let exe = Path::new(&normalized);
        if !exe.is_absolute() {
            tracing::warn!(java = %java_path, "java 路径不是绝对路径，跳过独显偏好写入");
            return;
        }
        let _guard = BACKUP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        apply_at(GPU_PREF_KEY, &backup_path(), &normalized);
    }

    /// 把备份里的原值写回（原本不存在则删除该值），然后清理备份文件。
    pub(super) fn restore_gpu_preferences() {
        let _guard = BACKUP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        restore_at(GPU_PREF_KEY, &backup_path());
    }

    pub(super) fn apply_at(root: &str, backup_file: &Path, java_path: &str) {
        let exe = java_path.to_string();
        let key = match pref_key(root) {
            Ok(key) => key,
            Err(e) => {
                tracing::warn!(error = %e, "打开 UserGpuPreferences 失败，跳过独显偏好写入");
                return;
            }
        };
        let mut backups = load_backups(backup_file);
        if !backups.contains_key(&exe) {
            backups.insert(exe.clone(), key.get_value::<String, _>(&exe).ok());
            save_backups(backup_file, &backups);
        }
        let current = key.get_value::<String, _>(&exe).ok();
        let next = with_high_performance(current.as_deref());
        if let Err(e) = key.set_value(&exe, &next) {
            tracing::warn!(error = %e, java = %exe, "写入独显偏好失败");
        }
    }

    pub(super) fn restore_at(root: &str, backup_file: &Path) {
        let backups = load_backups(backup_file);
        if backups.is_empty() {
            return;
        }
        match pref_key(root) {
            Ok(key) => {
                for (exe, original) in &backups {
                    match original {
                        Some(value) => {
                            let _ = key.set_value(exe, value);
                        }
                        None => {
                            let _ = key.delete_value(exe);
                        }
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "打开 UserGpuPreferences 失败，独显偏好未还原"),
        }
        let _ = std::fs::remove_file(backup_file);
    }

    /// `SetPriorityClass`；进程已退出或权限不足返回 false。
    pub(super) fn set_priority_class(pid: i32, level: &str) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS,
            BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
            PROCESS_SET_INFORMATION,
        };

        let class = match level {
            "below_normal" => BELOW_NORMAL_PRIORITY_CLASS,
            "above_normal" => ABOVE_NORMAL_PRIORITY_CLASS,
            "high" => HIGH_PRIORITY_CLASS,
            _ => NORMAL_PRIORITY_CLASS,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid as u32);
            if handle == 0 {
                return false;
            }
            let ok = SetPriorityClass(handle, class) != 0;
            CloseHandle(handle);
            ok
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    use super::{qml_dir, GAMEPOLICYCTL};

    /// 存在即表示「是我们打开的全局游戏模式」，进程退出/异常路径据此复位。
    pub(super) fn marker() -> PathBuf {
        qml_dir().join("mac-game-mode.on")
    }

    fn run(args: &[&str]) -> bool {
        let tool = Path::new(GAMEPOLICYCTL);
        if !tool.is_file() {
            return false;
        }
        Command::new(tool)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub(super) fn enable_game_mode() {
        if !run(&["game-mode", "set", "on"]) {
            tracing::debug!("gamepolicyctl 不可用（未装 Xcode），跳过 macOS 游戏模式");
            return;
        }
        let _ = std::fs::create_dir_all(qml_dir());
        if let Err(e) = std::fs::write(marker(), b"on") {
            tracing::warn!(error = %e, "写入 macOS 游戏模式标记失败");
        }
    }

    pub(super) fn disable_game_mode() {
        if !marker().is_file() {
            return;
        }
        if run(&["game-mode", "set", "auto"]) {
            let _ = std::fs::remove_file(marker());
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::windows::with_high_performance;

    #[test]
    fn adds_preference_when_absent() {
        assert_eq!(with_high_performance(None), "GpuPreference=2;");
        assert_eq!(with_high_performance(Some("")), "GpuPreference=2;");
    }

    #[test]
    fn replaces_only_gpu_preference_token() {
        // 用户显式选过「节能」，其它 token 必须原样保留，只提升 GPU 偏好。
        assert_eq!(
            with_high_performance(Some("AutoHDREnable=1;GpuPreference=1;")),
            "AutoHDREnable=1;GpuPreference=2;"
        );
        assert_eq!(
            with_high_performance(Some("GpuPreference=1")),
            "GpuPreference=2;"
        );
    }

    #[test]
    fn is_idempotent() {
        let once = with_high_performance(Some("AutoHDREnable=1;GpuPreference=1;"));
        assert_eq!(with_high_performance(Some(&once)), once);
    }

    // 以下用例只操作 HKCU\Software\QomicexTest\<pid>-* 测试键，末尾自清理，
    // 不碰真实的 UserGpuPreferences。

    fn test_root(tag: &str) -> String {
        format!(
            r"Software\QomicexTest\{}-{tag}\UserGpuPreferences",
            std::process::id()
        )
    }

    fn test_backup(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "qomicex-gpu-pref-{}-{tag}.json",
            std::process::id()
        ))
    }

    #[test]
    fn registry_roundtrip_restores_original_preference() {
        use super::windows::{apply_at, pref_key, restore_at};
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let root = test_root("restore");
        let backup = test_backup("restore");
        let _ = std::fs::remove_file(&backup);
        let exe = r"C:\qomicex-test\java.exe";

        {
            let key = pref_key(&root).unwrap();
            key.set_value(exe, &"AutoHDREnable=1;GpuPreference=1;")
                .unwrap();
        }
        apply_at(&root, &backup, exe);
        {
            let key = pref_key(&root).unwrap();
            assert_eq!(
                key.get_value::<String, _>(exe).unwrap(),
                "AutoHDREnable=1;GpuPreference=2;"
            );
            assert!(backup.is_file(), "首次写入必须留下备份");
        }
        restore_at(&root, &backup);
        {
            let key = pref_key(&root).unwrap();
            assert_eq!(
                key.get_value::<String, _>(exe).unwrap(),
                "AutoHDREnable=1;GpuPreference=1;"
            );
        }
        assert!(!backup.exists(), "还原后必须删除备份文件");
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&root);
    }

    #[test]
    fn registry_roundtrip_removes_value_that_did_not_exist() {
        use super::windows::{apply_at, pref_key, restore_at};
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let root = test_root("absent");
        let backup = test_backup("absent");
        let _ = std::fs::remove_file(&backup);
        let exe = r"C:\qomicex-test\java-absent.exe";

        apply_at(&root, &backup, exe);
        restore_at(&root, &backup);
        {
            let key = pref_key(&root).unwrap();
            assert!(
                key.get_value::<String, _>(exe).is_err(),
                "原本不存在的值必须在还原时删除"
            );
        }
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&root);
    }

    /// 真实进程跑一遍 SetPriorityClass，确认它确实改变了优先级类
    /// （编译通过不代表 Win32 调用参数正确）。
    #[test]
    fn set_priority_class_applies_to_live_process() {
        use std::process::{Command, Stdio};
        use std::time::Duration;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetPriorityClass, OpenProcess, HIGH_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let mut child = Command::new("cmd")
            .args(["/c", "timeout", "/t", "10", "/nobreak"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn helper process");
        std::thread::sleep(Duration::from_millis(300));
        let pid = child.id() as i32;
        assert!(
            super::windows::set_priority_class(pid, "high"),
            "SetPriorityClass 应该成功"
        );
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            assert!(handle != 0, "OpenProcess 应该成功");
            let class = GetPriorityClass(handle);
            CloseHandle(handle);
            assert_eq!(class, HIGH_PRIORITY_CLASS, "优先级类应为 High");
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod priority_tests {
    use super::{is_known_priority, normalize_priority};

    #[test]
    fn unknown_priority_falls_back_to_normal() {
        assert_eq!(normalize_priority(None), "normal");
        assert_eq!(normalize_priority(Some("realtime")), "normal");
        assert_eq!(normalize_priority(Some("")), "normal");
        assert_eq!(normalize_priority(Some("high")), "high");
        assert!(is_known_priority("above_normal"));
        assert!(!is_known_priority("realtime"));
    }
}
