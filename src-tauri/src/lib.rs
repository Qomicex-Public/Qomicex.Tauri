use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_updater::{RemoteRelease, UpdaterExt};
use url::Url;
#[cfg(windows)] use std::os::windows::process::CommandExt;

mod dialog_cmd;

#[cfg(all(windows, not(debug_assertions)))]
const BACKEND: &[u8] = include_bytes!("../binaries/backend.exe");
#[cfg(all(unix, not(debug_assertions)))]
const BACKEND: &[u8] = include_bytes!("../binaries/backend");

#[cfg(debug_assertions)]
const BACKEND: &[u8] = &[];

#[cfg(windows)]
const BACKEND_EXE: &str = "qomicex-backend.exe";
#[cfg(unix)]
const BACKEND_EXE: &str = "qomicex-backend";

struct BackendChild(Mutex<Option<std::process::Child>>);

fn user_temp_dir() -> std::path::PathBuf {
    #[cfg(unix)]
    {
        // Prefer the per-user runtime dir (private, 0700). Falls back to a
        // username-scoped folder under the shared /tmp so a file created by one
        // user never blocks another (e.g. normal user vs. sudo/root).
        if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
            if !runtime.is_empty() {
                return std::path::PathBuf::from(runtime).join("qomicex");
            }
        }
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "default".into());
        let mut dir = std::env::temp_dir();
        dir.push(format!("qomicex-{user}"));
        dir
    }
    #[cfg(not(unix))]
    {
        let mut dir = std::env::temp_dir();
        dir.push("qomicex");
        dir
    }
}

fn extract_backend() -> Option<std::path::PathBuf> {
    let base = user_temp_dir();
    let _ = std::fs::create_dir_all(&base);
    let primary = base.join(BACKEND_EXE);

    match std::fs::write(&primary, BACKEND) {
        Ok(()) => return Some(primary),
        Err(e) => eprintln!("[backend] write to {} failed: {e}", primary.display()),
    }

    // Fallback: unique per-process file if the primary path is not writable.
    let unique = base.join(format!("{}-{}", std::process::id(), BACKEND_EXE));
    match std::fs::write(&unique, BACKEND) {
        Ok(()) => Some(unique),
        Err(e) => {
            eprintln!("[backend] write to {} failed: {e}", unique.display());
            None
        }
    }
}

fn spawn_backend(app: &tauri::App) {
    if std::env::var("QOMICEX_LAUNCHER_MANAGED").is_ok() {
        eprintln!("[backend] launcher-managed, skipping spawn");
        return;
    }
    if BACKEND.len() < 1024 {
        eprintln!("[backend] placeholder ({} bytes), skipping", BACKEND.len());
        return;
    }
    let exe_path = match extract_backend() {
        Some(p) => p,
        None => {
            eprintln!("[backend] failed to extract backend to a writable location");
            return;
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe_path, std::fs::Permissions::from_mode(0o755));
    }
    let mut cmd = std::process::Command::new(&exe_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)] { const CREATE_NO_WINDOW: u32 = 0x08000000; cmd.creation_flags(CREATE_NO_WINDOW); }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[backend] spawn failed: {e}");
            let _ = std::fs::remove_file(&exe_path);
            return;
        }
    };
    let tag = BACKEND_EXE;
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                eprintln!("[{tag} out] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[{tag} err] {line}");
            }
        });
    }
    let state = app.state::<BackendChild>();
    *state.0.lock().unwrap() = Some(child);
    eprintln!("[backend] spawned: {} ({} bytes)", exe_path.display(), BACKEND.len());
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

fn current_os_arch() -> String {
    let os = if cfg!(target_os = "linux") { "linux" }
    else if cfg!(target_os = "macos") { "darwin" }
    else { "windows" };
    let arch = if cfg!(target_arch = "x86_64") { "x86_64" }
    else if cfg!(target_arch = "aarch64") { "aarch64" }
    else if cfg!(target_arch = "x86") { "i686" }
    else { "x86_64" };
    format!("{os}-{arch}")
}

fn transform_version(v: &str) -> String {
    let v = v.split(".build").next().unwrap_or(v);
    v.replace("-alpha", "-0.")
        .replace("-beta", "-1.")
        .replace("-release", "-2.")
}

#[tauri::command]
async fn check_update_with_endpoint<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    endpoint: String,
) -> Result<Option<UpdateInfo>, String> {
    let target = current_os_arch();
    eprintln!("[updater] target={target} endpoint={endpoint}");

    // 1) 用 reqwest 预取 JSON，避免插件 check() 内部因平台缺失报错
    let resp = reqwest::get(&endpoint)
        .await
        .map_err(|e| format!("HTTP 请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应体失败: {e}"))?;
    let root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败: {e}"))?;

    // 2) 检查当前目标平台在 platforms 中是否存在
    if root
        .get("platforms")
        .and_then(|p| p.get(&target))
        .is_none()
    {
        eprintln!("[updater] 当前平台 ({target}) 在 release 中无 artifact");
        return Ok(None);
    }

    // 3) 获取真实当前版本 & 远端版本
    let cur_ver = &webview.app_handle().package_info().version;
    let raw_remote = root
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");
    eprintln!(
        "[updater] current={} remote={raw_remote}",
        cur_ver.to_string()
    );

    // 4) 自定义版本比较
    let cur_t = transform_version(&cur_ver.to_string());
    let rel_t = transform_version(raw_remote.trim_start_matches('v'));
    let should_update =
        match (semver::Version::parse(&cur_t), semver::Version::parse(&rel_t)) {
            (Ok(c), Ok(r)) => r > c,
            _ => false,
        };
    eprintln!(
        "[updater] transformed cur={cur_t} rel={rel_t} should_update={should_update}"
    );

    if !should_update {
        return Ok(None);
    }

    // 5) 确定有更新 → 用插件 check() 获取 Update 资源（用于后续 downloadAndInstall）
    let url = Url::parse(&endpoint).map_err(|e| format!("URL 解析失败: {e}"))?;

    let version_comparator = move |current: semver::Version, release: RemoteRelease| {
        let cur = transform_version(&current.to_string());
        let rel = transform_version(&release.version.to_string());
        match (semver::Version::parse(&cur), semver::Version::parse(&rel)) {
            (Ok(c), Ok(r)) => r > c,
            _ => false,
        }
    };

    let updater = webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("endpoints 设置失败: {e}"))?
        .target(target)
        .version_comparator(version_comparator)
        .build()
        .map_err(|e| format!("Updater 构建失败: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("更新检查失败: {e}"))?;

    Ok(update.map(|u| {
        let current_version = u.current_version.clone();
        let version = u.version.clone();
        let body = u.body.clone();
        let raw_json = u.raw_json.clone();
        let rid = webview.resources_table().add(u);
        UpdateInfo { rid, current_version, version, date: None, body, raw_json }
    }))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendChild(Mutex::new(None)))
        .setup(|app| {
            #[cfg(desktop)]
            let _ = app.handle().plugin(tauri_plugin_updater::Builder::new().build());
            #[cfg(target_os = "windows")]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_decorations(false);
            }
            spawn_backend(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            dialog_cmd::pick_dialog,
            check_update_with_endpoint
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<BackendChild>();
            let mut guard = state.0.lock().unwrap();
            let child = guard.take();
            drop(guard);
            if let Some(mut child) = child {
                let _ = child.kill();
                let _ = child.wait();
                eprintln!("[backend] killed");
            }
        }
    });
}
