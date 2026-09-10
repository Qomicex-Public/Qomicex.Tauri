//! `run_updater` Tauri command: prepare and spawn Qomicex.Updater, then let
//! the caller exit the app. The updater binary is embedded at build time
//! (release) or resolved from `QOMICEX_UPDATER_PATH` (dev).

use tauri::AppHandle;

#[cfg(all(not(debug_assertions), windows))]
const UPDATER_BIN: &[u8] = include_bytes!("../binaries/updater.exe");
#[cfg(all(not(debug_assertions), unix))]
const UPDATER_BIN: &[u8] = include_bytes!("../binaries/updater");

#[cfg(debug_assertions)]
const UPDATER_BIN: &[u8] = &[];

#[cfg(windows)]
const UPDATER_EXE: &str = "qomicex-updater.exe";
#[cfg(unix)]
const UPDATER_EXE: &str = "qomicex-updater";

pub(crate) fn extract_updater(updates_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let _ = std::fs::create_dir_all(updates_dir);
    let path = updates_dir.join(UPDATER_EXE);

    let bytes: &[u8] = if UPDATER_BIN.is_empty() {
        // Dev override wins over sibling-repo builds: explicit selection must
        // not be silently shadowed by a stale local build.
        if let Ok(p) = std::env::var("QOMICEX_UPDATER_PATH") {
            let p = std::path::PathBuf::from(p);
            if p.exists() {
                // 统一落位：复制到 updates 目录，诊断时 exe 与包/日志同处。
                if std::fs::copy(&p, &path).is_ok() {
                    return Some(path);
                }
                return Some(p);
            }
        }
        // Dev fallback: local updater build from the sibling repository.
        let dev = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Qomicex.Updater/target/release/"
        ))
        .join(UPDATER_EXE);
        if dev.exists() {
            if std::fs::copy(&dev, &path).is_ok() {
                return Some(path);
            }
            return Some(dev);
        }
        let dev_dbg = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Qomicex.Updater/target/debug/"
        ))
        .join(UPDATER_EXE);
        if dev_dbg.exists() {
            if std::fs::copy(&dev_dbg, &path).is_ok() {
                return Some(path);
            }
            return Some(dev_dbg);
        }
        tauri_log!(
            "updater",
            "updater binary not embedded and not found (set QOMICEX_UPDATER_PATH)"
        );
        return None;
    } else {
        UPDATER_BIN
    };

    match std::fs::write(&path, bytes) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
            }
            Some(path)
        }
        Err(e) => {
            tauri_log!("updater", "write updater to {} failed: {e}", path.display());
            None
        }
    }
}

/// Install root / strategy inputs per platform.
///
/// - windows: `dir`  — NSIS currentUser layout, exe sits in the install root
/// - linux  : `appimage` when $APPIMAGE is set, else `system` (deb/rpm → /)
/// - macos  : `app`  — bundle root derived from Contents/MacOS/<exe>
fn detect_strategy() -> (String, Vec<(&'static str, String)>) {
    if cfg!(windows) {
        let dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        return ("dir".into(), vec![("install-dir", dir)]);
    }
    if cfg!(target_os = "macos") {
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|p| {
                // <bundle>.app/Contents/MacOS/exe → <bundle>.app
                p.ancestors().nth(3).map(|p| p.to_path_buf())
            })
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        return ("app".into(), vec![("app-bundle", bundle)]);
    }
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        return ("appimage".into(), vec![("appimage", appimage)]);
    }
    ("system".into(), vec![])
}

fn launch_target() -> String {
    if cfg!(target_os = "linux") {
        if let Ok(appimage) = std::env::var("APPIMAGE") {
            return appimage;
        }
    }
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Spawn the updater detached; the frontend closes the app right after.
///
/// `package_path`: downloaded update zip; `signature`: minisign armor text.
#[tauri::command]
pub fn run_updater(
    app: AppHandle,
    package_path: String,
    signature: String,
    version: String,
) -> Result<(), String> {
    // 每步实际求值都落日志（非模板），app.exit 前强制 flush——这是
    // detached updater 的唯一前置观测面。
    macro_rules! step {
        ($($arg:tt)*) => {{
            tauri_log!("updater", $($arg)*);
            crate::logger::flush_log();
        }};
    }

    let package = std::path::PathBuf::from(&package_path);
    let updates_dir = package
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or("UPDATE_PACKAGE_NOT_FOUND")?;

    step!("stage1 extract: package={package_path}");
    let updater = extract_updater(&updates_dir).ok_or("UPDATER_BINARY_MISSING")?;
    step!("stage1 extract ok: updater={}", updater.display());
    if !package.exists() {
        step!("stage1 abort: package missing");
        return Err("UPDATE_PACKAGE_NOT_FOUND".into());
    }

    // 信任边界：version 来自更新计划响应，未校验前不进文件名（防路径穿越
    // 把签名写到预期临时目录之外）。签名无效时 updater 的 minisign 校验
    // 会拒绝包本体——这里只挡文件系统副作用。
    let parsed = semver::Version::parse(version.trim().trim_start_matches('v')).map_err(|e| {
        step!("stage2 semver reject: version={version} err={e}");
        "INVALID_VERSION".to_string()
    })?;
    step!("stage2 semver ok: version={parsed}");

    let sig_path = updates_dir.join(format!("qomicex-update-{parsed}.sig"));
    match std::fs::write(&sig_path, &signature) {
        Ok(()) => step!(
            "stage3 sig written: {} ({} bytes)",
            sig_path.display(),
            signature.len()
        ),
        Err(e) => {
            step!("stage3 sig write failed: {} err={e}", sig_path.display());
            return Err(format!("SIG_WRITE_FAILED: {e}"));
        }
    }

    let (strategy, mut extra) = detect_strategy();
    extra.push(("launch", launch_target()));
    step!(
        "stage4 strategy={strategy} extras={:?}",
        extra
            .iter()
            .map(|(f, v)| format!("--{f}={v}"))
            .collect::<Vec<_>>()
    );

    let log_path = updates_dir.parent().unwrap_or(&updates_dir).join("log");
    let _ = std::fs::create_dir_all(&log_path);
    let log_file = log_path.join(format!("qomicex-updater-{}.log", std::process::id()));

    let mut cmd = std::process::Command::new(&updater);
    cmd.arg("--package")
        .arg(&package)
        .arg("--signature")
        .arg(&sig_path)
        .arg("--strategy")
        .arg(&strategy)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .arg("--log")
        .arg(&log_file);
    for (flag, value) in extra {
        cmd.arg(format!("--{flag}")).arg(value);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008 | 0x00000200 | 0x08000000); // DETACHED | NEW_GROUP | NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // 记录实际求值的完整命令行（argv 形式，非拼接字符串，无歧义）。
    let argv: Vec<String> = std::iter::once(updater.to_string_lossy().into_owned())
        .chain(
            cmd.get_args()
                .map(|a| {
                    let a = a.to_string_lossy();
                    if a.contains(' ') {
                        format!("\"{a}\"")
                    } else {
                        a.into_owned()
                    }
                })
                .collect::<Vec<_>>(),
        )
        .collect();
    step!("stage5 cmd: {}", argv.join(" "));

    if let Err(e) = cmd.spawn() {
        step!("stage5 spawn failed: {e}");
        return Err(format!("UPDATER_SPAWN_FAILED: {e}"));
    }
    step!("stage6 exiting: sleep 300ms then app.exit(0), RunEvent::Exit kills embedded backend");

    // Give the OS a beat to start the child, then close: RunEvent::Exit kills
    // the backend, the updater waits for our pid before touching files.
    std::thread::sleep(std::time::Duration::from_millis(300));
    crate::logger::flush_log();
    app.exit(0);
    Ok(())
}
