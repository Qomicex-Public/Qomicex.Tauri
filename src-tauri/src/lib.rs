use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use tauri::Manager;
use tauri::ipc::Channel;
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
struct UpdateMetadata {
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    download_url: String,
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

// GitHub release 代理镜像前缀（与 EasyTier 一致，空串=直连）
const PROXY_PREFIXES: &[&str] = &[
    "",
    "https://edgeone.gh-proxy.org/",
    "https://cdn.gh-proxy.org/",
    "https://hk.gh-proxy.org/",
    "https://v6.gh-proxy.org/",
    "https://ghfast.top/",
];

/// 对原始 GitHub URL 顺序测试各代理的延迟，返回最快的前缀（空串=直连）
async fn pick_fastest_proxy(original_url: &str) -> String {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    let mut results: Vec<(&str, u128)> = Vec::new();

    for &prefix in PROXY_PREFIXES {
        let url = if prefix.is_empty() {
            original_url.to_string()
        } else {
            format!("{}{}", prefix, original_url)
        };
        let start = std::time::Instant::now();
        match client
            .get(&url)
            .header("Range", "bytes=0-0")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let ms = start.elapsed().as_millis();
                eprintln!("[updater] proxy {prefix}: {ms}ms");
                results.push((prefix, ms));
            }
            _ => {
                eprintln!("[updater] proxy {prefix} 不可用");
            }
        }
    }

    if results.is_empty() {
        eprintln!("[updater] 所有代理测速失败，回退直连");
        return String::new();
    }

    results.sort_by_key(|(_, ms)| *ms);
    let best = results[0].0.to_string();
    eprintln!("[updater] 最快代理前缀='{best}' ({}ms)", results[0].1);
    best
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
) -> Result<Option<UpdateMetadata>, String> {
    let target = current_os_arch();
    eprintln!("[updater] target={target} endpoint={endpoint}");

    // 0) 竞速测速选最快代理前缀
    let proxy_prefix = pick_fastest_proxy(&endpoint).await;
    eprintln!("[updater] 使用代理前缀='{proxy_prefix}'");

    // 1) 通过最快代理获取 JSON
    let fetch_url = if proxy_prefix.is_empty() {
        endpoint.clone()
    } else {
        format!("{}{}", proxy_prefix, endpoint)
    };
    let resp = reqwest::get(&fetch_url)
        .await
        .map_err(|e| format!("HTTP 请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应体失败: {e}"))?;
    let mut root: serde_json::Value =
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
        .unwrap_or("0.0.0")
        .to_string();
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

    // 5) 将 platforms.{target}.url 也替换为同一代理前缀，使新版本安装包走代理下载
    if !proxy_prefix.is_empty() {
        if let Some(platform) = root.get_mut("platforms").and_then(|p| p.get_mut(&target)) {
            if let Some(url_val) = platform.get_mut("url") {
                if let Some(url_str) = url_val.as_str() {
                    let proxied_url = format!("{}{}", proxy_prefix, url_str);
                    eprintln!("[updater] 替换下载 URL: {url_str} -> {proxied_url}");
                    *url_val = serde_json::Value::String(proxied_url);
                }
            }
        }
    }

    // 6) 提取下载 URL，直接返回元数据（不使用 updater 插件）
    let download_url = root
        .get("platforms")
        .and_then(|p| p.get(&target))
        .and_then(|p| p.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    eprintln!("[updater] download_url={download_url}");

    Ok(Some(UpdateMetadata {
        current_version: cur_ver.to_string(),
        version: raw_remote.clone(),
        date: None,
        body: root.get("notes").and_then(|n| n.as_str()).map(|s| s.to_string()),
        download_url,
        raw_json: root,
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    event: String,
    data: DownloadEventData,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadEventData {
    content_length: Option<u64>,
    chunk_length: Option<usize>,
}

#[tauri::command]
async fn download_and_install_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    eprintln!("[updater] 开始下载: {url}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let content_length = resp.content_length().unwrap_or(0);
    eprintln!("[updater] 文件大小: {content_length} bytes");

    let _ = on_event.send(DownloadEvent {
        event: "Started".to_string(),
        data: DownloadEventData {
            content_length: Some(content_length),
            chunk_length: None,
        },
    });

    let temp_dir = std::env::temp_dir().join("qomicex-updater");
    let _ = std::fs::create_dir_all(&temp_dir);

    // 根据 URL 确定文件扩展名
    let ext = if url.contains(".msi") {
        "msi"
    } else if url.contains(".exe") {
        "exe"
    } else if url.contains(".deb") {
        "deb"
    } else if url.contains(".rpm") {
        "rpm"
    } else if url.contains(".dmg") {
        "dmg"
    } else if url.contains(".tar.gz") || url.contains(".tgz") {
        "tar.gz"
    } else {
        "bin"
    };

    let file_path = temp_dir.join(format!("update.{ext}"));
    let mut file = std::fs::File::create(&file_path)
        .map_err(|e| format!("创建临时文件失败: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取下载数据失败: {e}"))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("写入文件失败: {e}"))?;
        downloaded += chunk.len() as u64;

        let _ = on_event.send(DownloadEvent {
            event: "Progress".to_string(),
            data: DownloadEventData {
                content_length: None,
                chunk_length: Some(chunk.len()),
            },
        });
    }

    eprintln!("[updater] 下载完成: {} bytes -> {}", downloaded, file_path.display());

    // 运行安装程序
    #[cfg(target_os = "windows")]
    {
        if ext == "msi" {
            let status = std::process::Command::new("msiexec")
                .args(["/i", file_path.to_str().unwrap(), "/quiet", "/norestart"])
                .status()
                .map_err(|e| format!("启动 msiexec 失败: {e}"))?;
            if !status.success() {
                return Err(format!("msiexec 安装失败: exit code {}", status.code().unwrap_or(-1)));
            }
        } else if ext == "exe" {
            let status = std::process::Command::new(&file_path)
                .status()
                .map_err(|e| format!("启动安装程序失败: {e}"))?;
            if !status.success() {
                return Err(format!("安装程序失败: exit code {}", status.code().unwrap_or(-1)));
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if ext == "deb" {
            let status = std::process::Command::new("pkexec")
                .args(["dpkg", "-i", file_path.to_str().unwrap()])
                .status()
                .map_err(|e| format!("启动 dpkg 失败: {e}"))?;
            if !status.success() {
                return Err(format!("dpkg 安装失败: exit code {}", status.code().unwrap_or(-1)));
            }
        } else if ext == "rpm" {
            let status = std::process::Command::new("pkexec")
                .args(["rpm", "-U", file_path.to_str().unwrap()])
                .status()
                .map_err(|e| format!("启动 rpm 失败: {e}"))?;
            if !status.success() {
                return Err(format!("rpm 安装失败: exit code {}", status.code().unwrap_or(-1)));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if ext == "dmg" {
            let status = std::process::Command::new("open")
                .arg(file_path.to_str().unwrap())
                .status()
                .map_err(|e| format!("打开 DMG 失败: {e}"))?;
            if !status.success() {
                return Err(format!("打开 DMG 失败: exit code {}", status.code().unwrap_or(-1)));
            }
        }
    }

    eprintln!("[updater] 安装完成，准备重启");
    // 重启应用（此调用不会返回）
    app.restart();
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
            check_update_with_endpoint,
            download_and_install_update
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
