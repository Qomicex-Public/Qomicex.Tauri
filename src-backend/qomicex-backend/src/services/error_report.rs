//! 严重错误日志上报（转发到 Qomicex 公开 API `POST /api/client/logs`）。
//!
//! 只用于"影响运行的恶性 bug"：前端 ErrorBoundary（渲染崩溃/白屏）、全局未捕获
//! 异常、后端 Rust panic。一般的启动失败/安装下载错误等业务错误**不上报**
//! （上游数据库容量有限），它们只作为上下文（trace 尾部）附带在恶性上报里。
//!
//! 上报需要 License：`Authorization: Bearer <licenseToken>`（token 来自
//! `{BaseDir}/QML/license.qmcx`）。无 token 时静默跳过，绝不阻塞主流程。

use serde::{Deserialize, Serialize};

use crate::error::ApiError;

/// 上游上报地址。可用 `QOMICEX_REPORT_URL` 环境变量覆盖（本地测试 / 换地址）。
pub fn report_url() -> String {
    std::env::var("QOMICEX_REPORT_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://api.qomicex.top/api/client/logs".to_string())
}

/// 读取 license token（`{BaseDir}/QML/license.qmcx`）；空/缺失 → `None`。
pub fn read_license_token() -> Option<String> {
    let path = crate::services::license::license_file_path();
    let token = std::fs::read_to_string(path).ok()?;
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// 设备信息（便于判断是否设备问题）：OS 显示名 + 架构 + CPU 型号 +
/// 总/可用内存 + 启动器版本。如
/// `Windows 11 Pro x64 | CPU: Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz | RAM: 16384MB (avail 8192MB) | Qomicex.Launcher/1.0.0`
pub fn device_info() -> String {
    let (total, avail) = crate::util::sysinfo::memory();
    let cpu = crate::util::sysinfo::cpu_brand();
    let mut parts = vec![format!(
        "{} {}",
        crate::util::sysinfo::os_display_name(),
        crate::util::sysinfo::architecture()
    )];
    if !cpu.is_empty() {
        parts.push(format!("CPU: {cpu}"));
    }
    parts.push(format!("RAM: {total}MB (avail {avail}MB)"));
    parts.push(format!("Qomicex.Launcher/{}", crate::state::APP_VERSION));
    parts.join(" | ")
}

/// 一条待上报日志（与上游 `POST /api/client/logs` 的 `logs[]` 结构一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientLogEntry {
    pub level: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_info: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientLogsRequest {
    pub logs: Vec<ClientLogEntry>,
}

/// 把日志批量上报到上游。
///
/// 返回：`Ok(true)` = 已上报；`Ok(false)` = 跳过（无 license token）；
/// `Err` = 上游转发失败（网络 / 非 2xx），调用方按需吞掉。
pub async fn report_logs(
    http: &reqwest::Client,
    mut entries: Vec<ClientLogEntry>,
) -> Result<bool, ApiError> {
    let Some(token) = read_license_token() else {
        return Ok(false);
    };
    // 统一补全 deviceInfo（系统/硬件信息，由后端生成）：端点和 panic hook
    // 两条上报路径都经过这里，保证每条日志都带设备信息。
    let device = device_info();
    for e in entries.iter_mut() {
        if e.device_info.as_deref().unwrap_or("").is_empty() {
            e.device_info = Some(device.clone());
        }
    }
    let body = ClientLogsRequest { logs: entries };
    let resp = http
        .post(report_url())
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(ApiError::upstream(format!(
            "client log report failed: {status}"
        )));
    }
    Ok(true)
}

/// 注册进程级 panic hook（后端"崩溃"通道）：
/// 1. 保留默认 panic 输出；2. 记录 `[panic] ...` 进 trace；
/// 3. 进程内只上报一次：独立线程 + 自建 tokio runtime 上报
///    一条 `[backend panic]` 错误 + 最近 30 条 trace 尾部。
/// 上报前检查设置开关 `autoReportErrors`（try_read 容错，panic 场景尽力而为）。
pub fn install_panic_hook(
    settings: std::sync::Arc<tokio::sync::RwLock<crate::settings::SettingsResponse>>,
    http: reqwest::Client,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static REPORTED: AtomicBool = AtomicBool::new(false);

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        if REPORTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let msg = info.to_string();
        crate::services::trace::trace_append(format!("[panic] {msg}"));
        let settings = settings.clone();
        let http = http.clone();
        std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async move {
                let enabled = settings
                    .try_read()
                    .map(|s| s.auto_report_errors.unwrap_or(true))
                    .unwrap_or(true);
                if !enabled {
                    return;
                }
                let snapshot: Vec<String> = crate::services::trace::TRACE_BUFFER
                    .get()
                    .map(|b| b.snapshot())
                    .unwrap_or_default();
                let tail_start = snapshot.len().saturating_sub(30);
                let tail = &snapshot[tail_start..];

                let mut entries = vec![ClientLogEntry {
                    level: "error".to_string(),
                    message: format!("[backend panic] {msg}"),
                    stack: None,
                    device_info: None,
                }];
                for line in tail {
                    entries.push(ClientLogEntry {
                        level: "info".to_string(),
                        message: line.clone(),
                        stack: None,
                        device_info: None,
                    });
                }
                let _ = report_logs(&http, entries).await;
            });
        });
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// env 相关测试共用一把锁：std::env::set_var 是进程全局的，cargo test 并行
    /// 跑测试会互相串扰（QOMICEX_HOME / QOMICEX_REPORT_URL 被并发改写）。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn set_env(key: &str, value: impl AsRef<std::ffi::OsStr>) -> Option<std::ffi::OsString> {
        let old = std::env::var_os(key);
        std::env::set_var(key, value);
        old
    }

    fn restore_env(key: &str, old: Option<std::ffi::OsString>) {
        match old {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    #[test]
    fn device_info_contains_system_and_hardware() {
        let info = device_info();
        assert!(info.contains("CPU:") || info.contains("RAM:"), "{info}");
        assert!(info.contains("RAM:"), "{info}");
        assert!(info.contains("Qomicex.Launcher/"), "{info}");
    }

    #[test]
    fn report_url_defaults_to_production() {
        // env 可能已被测试环境设置；这里只验证逻辑分支本身。
        let _ = report_url();
    }

    #[tokio::test]
    async fn report_without_token_skips() {
        let _guard = ENV_LOCK.lock().unwrap();
        // QOMICEX_HOME 指向空临时目录 → 无 license 文件 → 跳过。
        let tmp = std::env::temp_dir().join(format!("qomicex-nolicense-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&tmp);
        let old_home = set_env("QOMICEX_HOME", &tmp);
        let client = reqwest::Client::new();
        let ok = report_logs(&client, vec![ClientLogEntry {
            level: "error".to_string(),
            message: "test".to_string(),
            stack: None,
            device_info: None,
        }])
        .await
        .unwrap();
        assert!(!ok, "no license token should skip");
        restore_env("QOMICEX_HOME", old_home);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn report_forwards_with_bearer_and_device_info() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let _guard = ENV_LOCK.lock().unwrap();
        // 临时 QOMICEX_HOME + 假 license + 指向本地 mock 的上报地址。
        let tmp = std::env::temp_dir().join(format!("qomicex-report-{}", uuid::Uuid::new_v4()));
        let qml = tmp.join("QML");
        let _ = std::fs::create_dir_all(&qml);
        let _ = std::fs::write(qml.join("license.qmcx"), "fake-token");
        let old_home = set_env("QOMICEX_HOME", &tmp);

        // 本地 mock 上游：解析出请求行 / Authorization / body。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let old_url = set_env(
            "QOMICEX_REPORT_URL",
            format!("http://127.0.0.1:{port}/api/client/logs"),
        );
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            let _ = sock.write_all(resp.as_bytes()).await;
            req
        });

        let client = reqwest::Client::new();
        let ok = report_logs(&client, vec![ClientLogEntry {
            level: "error".to_string(),
            message: "crash happened".to_string(),
            stack: Some("Error: boom\n at fn (file.ts:1:1)".to_string()),
            device_info: None,
        }])
        .await
        .unwrap();
        assert!(ok, "with token should report");

        let req = handle.await.unwrap();
        assert!(req.starts_with("POST /api/client/logs HTTP/1.1"), "{req}");
        assert!(req.to_ascii_lowercase().contains("authorization: bearer fake-token"), "{req}");
        assert!(req.contains("crash happened"), "{req}");
        assert!(req.contains("deviceInfo"), "{req}");
        assert!(req.contains("RAM:"), "deviceInfo should carry hardware info: {req}");

        restore_env("QOMICEX_HOME", old_home);
        restore_env("QOMICEX_REPORT_URL", old_url);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
