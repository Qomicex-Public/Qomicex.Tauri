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

pub(crate) fn extract_updater() -> Option<std::path::PathBuf> {
    let base = crate::user_temp_dir();
    let _ = std::fs::create_dir_all(&base);
    let path = base.join(UPDATER_EXE);

    let bytes: &[u8] = if UPDATER_BIN.is_empty() {
        // Dev fallback: local updater build from the sibling repository.
        let dev = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Qomicex.Updater/target/release/"
        ))
        .join(UPDATER_EXE);
        if dev.exists() {
            return Some(dev);
        }
        let dev_dbg = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Qomicex.Updater/target/debug/"
        ))
        .join(UPDATER_EXE);
        if dev_dbg.exists() {
            return Some(dev_dbg);
        }
        tauri_log!(
            "updater",
            "updater binary not embedded and not found (set QOMICEX_UPDATER_PATH)"
        );
        if let Ok(p) = std::env::var("QOMICEX_UPDATER_PATH") {
            let p = std::path::PathBuf::from(p);
            if p.exists() {
                return Some(p);
            }
        }
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
    let updater = extract_updater().ok_or("UPDATER_BINARY_MISSING")?;
    if !std::path::Path::new(&package_path).exists() {
        return Err("UPDATE_PACKAGE_NOT_FOUND".into());
    }

    let base = crate::user_temp_dir();
    let _ = std::fs::create_dir_all(&base);
    let sig_path = base.join(format!("qomicex-update-{version}.sig"));
    std::fs::write(&sig_path, &signature).map_err(|e| format!("SIG_WRITE_FAILED: {e}"))?;

    let (strategy, mut extra) = detect_strategy();
    extra.push(("launch", launch_target()));

    let mut cmd = std::process::Command::new(&updater);
    cmd.arg("--package")
        .arg(&package_path)
        .arg("--signature")
        .arg(&sig_path)
        .arg("--strategy")
        .arg(&strategy)
        .arg("--wait-pid")
        .arg(std::process::id().to_string());
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

    cmd.spawn()
        .map_err(|e| format!("UPDATER_SPAWN_FAILED: {e}"))?;
    tauri_log!(
        "updater",
        "spawned (strategy={strategy}, package={package_path})"
    );

    // Give the OS a beat to start the child, then close: RunEvent::Exit kills
    // the backend, the updater waits for our pid before touching files.
    std::thread::sleep(std::time::Duration::from_millis(300));
    app.exit(0);
    Ok(())
}
