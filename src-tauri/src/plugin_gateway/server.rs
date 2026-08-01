use std::sync::Arc;
use crate::plugin_gateway::loader::PluginRuntime;
use crate::plugin_gateway::config;

pub struct GatewayState {
    pub runtime: tokio::sync::Mutex<PluginRuntime>,
}

pub async fn start_gateway(runtime: PluginRuntime) -> anyhow::Result<u16> {
    let state = Arc::new(GatewayState { runtime: tokio::sync::Mutex::new(runtime) });

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    let port_path = config::plugins_dir().join(config::PORT_FILE);
    if let Some(parent) = port_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&port_path, port.to_string())?;
    eprintln!("[gateway] listening on 127.0.0.1:{port}");

    tokio::spawn(async move {
        let state = state.clone();
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let state = state.clone();
            tokio::spawn(async move {
                handle_connection(stream, state).await;
            });
        }
    });

    Ok(port)
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    state: Arc<GatewayState>,
) {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let mut reader = BufReader::new(&mut stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await.is_err() { return; }

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    }
    let method = parts[0];
    let path = parts[1];

    let mut body = String::new();
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.is_err() { return; }
        if line.trim().is_empty() { break; }
        if let Some(len) = line.strip_prefix("Content-Length:").or_else(|| line.strip_prefix("content-length:")) {
            content_length = len.trim().parse().unwrap_or(0);
        }
    }
    if content_length > 0 {
        let mut buf = vec![0u8; content_length];
        if reader.read_exact(&mut buf).await.is_ok() {
            body = String::from_utf8_lossy(&buf).to_string();
        }
    }

    let response = match (method, path) {
        ("GET", "/plugins") => {
            let runtime = state.runtime.lock().await;
            let ids: Vec<&str> = runtime.plugin_ids().collect();
            json_response(&serde_json::json!({ "plugins": ids }))
        }

        ("GET", p) if p.starts_with("/plugins/") && p.ends_with("/info") => {
            let id = p.trim_start_matches("/plugins/").trim_end_matches("/info");
            let runtime = state.runtime.lock().await;
            match runtime.get_plugin(id) {
                Some(plugin) => json_response(&serde_json::json!({
                    "id": plugin.id,
                    "name": plugin.name,
                    "version": plugin.version,
                    "permissions": plugin.permissions,
                    "status": "loaded"
                })),
                None => json_response(&serde_json::json!({ "error": "plugin not found" })),
            }
        }

        ("POST", p) if p.starts_with("/plugins/") && p.ends_with("/invoke") => {
            let id = p.trim_start_matches("/plugins/").trim_end_matches("/invoke");
            let export_name = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["export"].as_str().map(String::from))
                .unwrap_or_else(|| "on_load".to_string());
            let mut runtime = state.runtime.lock().await;
            match runtime.call_export(id, &export_name) {
                Ok(result) => json_response(&serde_json::json!({ "ok": true, "result": result })),
                Err(e) => json_response(&serde_json::json!({ "error": e.to_string() })),
            }
        }

        ("GET", "/health") => {
            json_response(&serde_json::json!({ "status": "ok" }))
        }

        _ => {
            json_response(&serde_json::json!({ "error": "not found" }))
        }
    };

    let _ = stream.write_all(response.as_bytes()).await;
}

fn json_response(value: &serde_json::Value) -> String {
    let body = serde_json::to_string(value).unwrap_or_default();
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
}
