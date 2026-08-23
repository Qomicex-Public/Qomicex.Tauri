use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[macro_use]
mod logger;
mod dialog_cmd;
mod ipc;
mod plugin_gateway;

#[cfg(all(windows, not(debug_assertions)))]
const BACKEND: &[u8] = include_bytes!("../binaries/backend.exe");
#[cfg(all(unix, not(debug_assertions)))]
const BACKEND: &[u8] = include_bytes!("../binaries/backend");

#[cfg(debug_assertions)]
const BACKEND: &[u8] = &[];

// easytier 的 faketcp 在 Windows 需要 npcap 的 Packet.dll，必须与后端 exe 同目录
// （缺失时 qomicex-backend.exe 以 0xC0000135 退出）。随后端一并嵌入并解压。
#[cfg(all(windows, not(debug_assertions)))]
const PACKET_DLL: &[u8] = include_bytes!("../binaries/Packet.dll");
#[cfg(not(all(windows, not(debug_assertions))))]
const PACKET_DLL: &[u8] = &[];

// easytier TUN 模式（管理员运行）在 Windows 需要 wintun.dll（运行时动态加载）。
#[cfg(all(windows, not(debug_assertions)))]
const WINTUN_DLL: &[u8] = include_bytes!("../binaries/wintun.dll");
#[cfg(not(all(windows, not(debug_assertions))))]
const WINTUN_DLL: &[u8] = &[];

#[cfg(windows)]
const BACKEND_EXE: &str = "qomicex-backend.exe";
#[cfg(unix)]
const BACKEND_EXE: &str = "qomicex-backend";

struct BackendChild(Mutex<Option<std::process::Child>>);

pub(crate) fn user_temp_dir() -> std::path::PathBuf {
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
        Ok(()) => {
            extract_sidecar_dlls(&base);
            return Some(primary);
        }
        Err(e) => tauri_log!("backend", "write to {} failed: {e}", primary.display()),
    }

    // Fallback: unique per-process file if the primary path is not writable.
    let unique = base.join(format!("{}-{}", std::process::id(), BACKEND_EXE));
    match std::fs::write(&unique, BACKEND) {
        Ok(()) => {
            extract_sidecar_dlls(&base);
            Some(unique)
        }
        Err(e) => {
            tauri_log!("backend", "write to {} failed: {e}", unique.display());
            None
        }
    }
}

/// 写出后端运行时需要的同目录 DLL（Windows：Packet.dll + wintun.dll）。
#[cfg(windows)]
fn extract_sidecar_dlls(base: &std::path::Path) {
    if !PACKET_DLL.is_empty() {
        if let Err(e) = std::fs::write(base.join("Packet.dll"), PACKET_DLL) {
            tauri_log!("backend", "write Packet.dll failed: {e}");
        }
    }
    if !WINTUN_DLL.is_empty() {
        if let Err(e) = std::fs::write(base.join("wintun.dll"), WINTUN_DLL) {
            tauri_log!("backend", "write wintun.dll failed: {e}");
        }
    }
}

#[cfg(not(windows))]
fn extract_sidecar_dlls(_base: &std::path::Path) {}

fn spawn_backend(app: &tauri::App, pipe_name: &Option<String>) {
    if std::env::var("QOMICEX_LAUNCHER_MANAGED").is_ok() {
        tauri_log!("backend", "launcher-managed, skipping spawn");
        return;
    }
    if BACKEND.len() < 1024 {
        tauri_log!("backend", "placeholder ({} bytes), skipping", BACKEND.len());
        return;
    }
    let exe_path = match extract_backend() {
        Some(p) => p,
        None => {
            tauri_log!(
                "backend",
                "failed to extract backend to a writable location"
            );
            return;
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe_path, std::fs::Permissions::from_mode(0o755));
    }
    let mut cmd = std::process::Command::new(&exe_path);
    // IPC 模式：release 由启动器注入管道名。保留 TCP 监听作兜底——
    // 部分环境的 WebView2 对 custom protocol（含 Tauri 内建 ipc://）fetch
    // 整体返回 net::ERR_FAILED，若关闭 TCP 且探测失败将直接无法启动。
    if let Some(name) = pipe_name {
        cmd.env("QOMICEX_IPC_PIPE", name);
        tauri_log!("backend", "ipc pipe: {name} (tcp fallback kept)");
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // 注意：不要给 backend 注入 QOMICEX_HOME=app_data_dir()——三平台上该目录
    // （identifier 目录 / Windows Roaming）与 backend 默认解析目录（{LocalAppData}/
    // qomicex-launcher）不一致，注入会导致老用户配置"搬家"丢失，且与 Tauri 主进程
    // 自身的 logger/plugin_gateway 解析结果分裂。backend 的 resolve_base_dir 不依赖
    // cwd，无需注入即可稳定解析（51d6529 曾因此回滚）。
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tauri_log!("backend", "spawn failed: {e}");
            let _ = std::fs::remove_file(&exe_path);
            return;
        }
    };
    let _tag = BACKEND_EXE;
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                tauri_log!("backend:out", "{line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                tauri_log!("backend:err", "{line}");
            }
        });
    }
    let state = app.state::<BackendChild>();
    *state.0.lock().unwrap() = Some(child);
    tauri_log!(
        "backend",
        "spawned: {} ({} bytes)",
        exe_path.display(),
        BACKEND.len()
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 管道名来源优先级：显式 env > release 内嵌后端默认启用；debug 占位/外部管理回落 None（前端走 HTTP）
    let pipe_name: Option<String> = std::env::var("QOMICEX_IPC_PIPE").ok().or_else(|| {
        if BACKEND.len() >= 1024 {
            Some(ipc::pipe_name_for_pid(std::process::id()))
        } else {
            None
        }
    });
    let pipe_shared = std::sync::Arc::new(std::sync::Mutex::new(pipe_name.clone()));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BackendChild(Mutex::new(None)))
        .manage(ipc::IpcPipe(pipe_shared.clone()))
        .manage(ipc::StreamRegistry::default())
        .register_asynchronous_uri_scheme_protocol(
            "qomicex",
            ipc::make_protocol_handler(pipe_shared),
        )
        .setup(move |app| {
            if let Some(w) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                let _ = w.set_decorations(false);
                let win = w.clone();
                let emitter = w.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(drag) = event {
                        match drag {
                            tauri::DragDropEvent::Enter { .. } => {
                                let _ = emitter.emit("file-drop-hover", true);
                            }
                            tauri::DragDropEvent::Leave => {
                                let _ = emitter.emit("file-drop-hover", false);
                            }
                            tauri::DragDropEvent::Drop { paths, .. } => {
                                let _ = emitter.emit("file-drop-hover", false);
                                let _ = emitter.emit("file-drop", paths);
                            }
                            _ => {}
                        }
                    }
                });
            }
            spawn_backend(app, &pipe_name);
            let mut runtime = plugin_gateway::loader::PluginRuntime::new().unwrap();
            let _ = runtime.scan_and_load();
            tauri::async_runtime::spawn(async move {
                match plugin_gateway::server::start_gateway(runtime).await {
                    Ok(port) => tauri_log!("gateway", "ready on 127.0.0.1:{port}"),
                    Err(e) => tauri_log!("gateway", "start failed: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dialog_cmd::pick_dialog,
            ipc::ipc_ping,
            ipc::ipc_stream,
            ipc::ipc_stream_abort
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
                tauri_log!("backend", "killed");
            }
        }
    });
}
