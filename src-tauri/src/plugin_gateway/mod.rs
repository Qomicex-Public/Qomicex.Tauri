pub mod config;
pub mod loader;
pub mod permission;
pub mod server;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loader_loads_and_invokes() {
        std::env::set_var("QOMICEX_HOME", std::env::temp_dir().join("opencode/wasmtest/home"));
        let mut runtime = loader::PluginRuntime::new().unwrap();
        runtime.scan_and_load().unwrap();
        let ids: Vec<&str> = runtime.plugin_ids().collect();
        assert_eq!(ids, vec!["dev.test.wasm"]);
        let res = runtime.call_export("dev.test.wasm", "on_load").unwrap();
        assert_eq!(res["ok"], serde_json::json!(true));
        let res2 = runtime.call_export("dev.test.wasm", "db_set_test").unwrap();
        assert_eq!(res2["ok"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn gateway_http_invoke() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        std::env::set_var("QOMICEX_HOME", std::env::temp_dir().join("opencode/wasmtest/home"));
        let mut runtime = loader::PluginRuntime::new().unwrap();
        runtime.scan_and_load().unwrap();
        let port = server::start_gateway(runtime).await.unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let body = r#"{"export":"on_load"}"#;
        let req = format!(
            "POST /plugins/dev.test.wasm/invoke HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("\"ok\":true"), "unexpected response: {text}");
    }
}

