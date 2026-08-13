pub mod config;
pub mod loader;
pub mod permission;
pub mod server;

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试夹具根目录：`src-tauri/tests/fixtures`（由 Cargo 提供 CARGO_MANIFEST_DIR）。
    fn fixtures_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
    }

    /// 部署 `dev.test.wasm` 夹具到临时 QOMICEX_HOME，返回其 home 目录。
    /// 插件目录结构与 loader.rs 的 `scan_and_load` 期望一致：
    /// `{home}/plugins/{pluginId}/manifest.json + plugin.wasm`。
    ///
    /// 用 OnceLock 保证只部署一次：两个测试并行运行时共享同一
    /// QOMICEX_HOME，重复删除/复制会与另一个测试的读取冲突（Windows
    /// 文件占用），也会让 scan 结果不稳定。
    fn deploy_test_plugin() -> std::path::PathBuf {
        static DEPLOYED: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        DEPLOYED
            .get_or_init(|| {
                let home = std::env::temp_dir().join("opencode/wasmtest/home");
                let dest = home.join("plugins/dev.test.wasm");
                let src = fixtures_dir().join("dev.test.wasm");
                std::fs::create_dir_all(&dest).unwrap();
                std::fs::copy(src.join("plugin.wasm"), dest.join("plugin.wasm")).unwrap();
                std::fs::copy(src.join("manifest.json"), dest.join("manifest.json")).unwrap();
                home
            })
            .clone()
    }

    #[test]
    fn loader_loads_and_invokes() {
        std::env::set_var("QOMICEX_HOME", deploy_test_plugin());
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
        std::env::set_var("QOMICEX_HOME", deploy_test_plugin());
        let mut runtime = loader::PluginRuntime::new().unwrap();
        runtime.scan_and_load().unwrap();
        let port = server::start_gateway(runtime).await.unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
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
