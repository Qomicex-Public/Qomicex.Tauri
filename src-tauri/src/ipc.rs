//! qomicex:// 自定义协议 → QIPC 管道转发器 + 流式命令。
//!
//! 普通请求：webview fetch(qomicex://...) → 协议处理器 → 管道帧 → 后端 axum。
//! 流式端点（SSE/下载进度/日志/proxyStream）：invoke('ipc_stream') + Channel 逐块推送。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::http::{Request, Response};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 后端管道名（None = 未启用 IPC，前端回落 HTTP）
pub struct IpcPipe(pub std::sync::Arc<std::sync::Mutex<Option<String>>>);

impl IpcPipe {
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

/// 流式任务注册表：id → JoinHandle，供 abort。
/// Arc 内层使运行中的任务能在结束时自行移除条目（防止注册表随流次数无限增长）。
#[derive(Clone, Default)]
pub struct StreamRegistry(
    pub std::sync::Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
);

pub fn pipe_name_for_pid(pid: u32) -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\qomicex-backend-{pid}")
    }
    #[cfg(unix)]
    {
        let dir = super::user_temp_dir();
        format!("{}/backend-{pid}.sock", dir.display())
    }
}

// --- 连接 ---

enum IpcConn {
    #[cfg(windows)]
    Win(tokio::net::windows::named_pipe::NamedPipeClient),
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
}

async fn connect_pipe(name: &str) -> std::io::Result<IpcConn> {
    #[cfg(windows)]
    {
        for _ in 0..50 {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
                Ok(c) => return Ok(IpcConn::Win(c)),
                // ERROR_PIPE_BUSY：服务端实例重建间隙，重试
                Err(e) if e.raw_os_error() == Some(231) => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "pipe busy timeout",
        ))
    }
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(name)
            .await
            .map(IpcConn::Unix)
    }
}

macro_rules! delegate {
    ($conn:expr, $f:ident ($($arg:expr),*)) => {
        match $conn {
            #[cfg(windows)]
            IpcConn::Win(c) => c.$f($($arg),*),
            #[cfg(unix)]
            IpcConn::Unix(s) => s.$f($($arg),*),
        }
    };
}

async fn write_all(conn: &mut IpcConn, buf: &[u8]) -> std::io::Result<()> {
    delegate!(conn, write_all(buf)).await
}
async fn read_exact(conn: &mut IpcConn, buf: &mut [u8]) -> std::io::Result<()> {
    delegate!(conn, read_exact(buf)).await.map(|_| ())
}
async fn read_upto(conn: &mut IpcConn, buf: &mut [u8]) -> std::io::Result<usize> {
    delegate!(conn, read(buf)).await
}

// --- 帧编解码（与后端 src/ipc.rs 对应）---

fn encode_request(method: &str, path: &str, headers: &[(String, String)], body: &[u8]) -> Vec<u8> {
    let mut core = Vec::new();
    core.push(method.len() as u8);
    core.extend_from_slice(method.as_bytes());
    core.extend_from_slice(&(path.len() as u16).to_le_bytes());
    core.extend_from_slice(path.as_bytes());
    core.extend_from_slice(&(headers.len() as u16).to_le_bytes());
    for (k, v) in headers {
        core.extend_from_slice(&(k.len() as u16).to_le_bytes());
        core.extend_from_slice(k.as_bytes());
        core.extend_from_slice(&(v.len() as u16).to_le_bytes());
        core.extend_from_slice(v.as_bytes());
    }
    core.extend_from_slice(body);
    let mut out = (core.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&core);
    out
}

const HOP_BY_HOP: [&str; 5] = [
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
];

async fn read_head(conn: &mut IpcConn) -> std::io::Result<(u16, Vec<(String, String)>)> {
    let mut b2 = [0u8; 2];
    read_exact(conn, &mut b2).await?;
    let status = u16::from_le_bytes(b2);
    read_exact(conn, &mut b2).await?;
    let count = u16::from_le_bytes(b2);
    let mut headers = Vec::with_capacity(count as usize);
    for _ in 0..count {
        read_exact(conn, &mut b2).await?;
        let k_len = u16::from_le_bytes(b2) as usize;
        let mut kb = vec![0u8; k_len];
        read_exact(conn, &mut kb).await?;
        read_exact(conn, &mut b2).await?;
        let v_len = u16::from_le_bytes(b2) as usize;
        let mut vb = vec![0u8; v_len];
        read_exact(conn, &mut vb).await?;
        headers.push((
            String::from_utf8_lossy(&kb).into_owned(),
            String::from_utf8_lossy(&vb).into_owned(),
        ));
    }
    Ok((status, headers))
}

async fn read_chunks<F>(conn: &mut IpcConn, mut on_chunk: F) -> std::io::Result<()>
where
    F: FnMut(Vec<u8>) -> std::io::Result<()>,
{
    loop {
        let mut b4 = [0u8; 4];
        read_exact(conn, &mut b4).await?;
        let len = u32::from_le_bytes(b4) as usize;
        if len == 0 {
            return Ok(());
        }
        let mut chunk = vec![0u8; len];
        read_exact(conn, &mut chunk).await?;
        on_chunk(chunk)?;
    }
}

// --- 转发 ---

/// CORS 预检本地应答（协议响应天然跨域，srcdoc iframe 也依赖这些头）
fn preflight() -> Response<std::borrow::Cow<'static, [u8]>> {
    Response::builder()
        .status(204)
        .header("access-control-allow-origin", "*")
        .header(
            "access-control-allow-methods",
            "GET,POST,PUT,DELETE,PATCH,OPTIONS",
        )
        .header("access-control-allow-headers", "*")
        .body(std::borrow::Cow::Borrowed(&b""[..]))
        .unwrap()
}

fn error_response(
    status: u16,
    code: &str,
    message: &str,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let body = serde_json::json!({
        "code": code,
        "message": message,
        "detail": null,
        "traceId": "",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "status": status,
    })
    .to_string();
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(std::borrow::Cow::Owned(body.into_bytes()))
        .unwrap()
}

async fn forward(
    pipe_name: &str,
    req: Request<Vec<u8>>,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let method = req.method().as_str().to_string();
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| req.uri().path().to_string());
    let headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .filter(|(k, _)| !HOP_BY_HOP.contains(&k.as_str()))
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|vs| (k.as_str().to_string(), vs.to_string()))
        })
        .collect();
    let body = req.into_body();

    let mut conn = match connect_pipe(pipe_name).await {
        Ok(c) => c,
        Err(e) => {
            return error_response(502, "IPC_CONNECT_FAILED", &format!("{e}"));
        }
    };
    if write_all(
        &mut conn,
        &encode_request(&method, &path_and_query, &headers, &body),
    )
    .await
    .is_err()
    {
        return error_response(502, "IPC_WRITE_FAILED", "failed to send request over pipe");
    }
    let (status, resp_headers) = match read_head(&mut conn).await {
        Ok(h) => h,
        Err(e) => {
            return error_response(502, "IPC_READ_FAILED", &format!("{e}"));
        }
    };
    let mut buf = Vec::new();
    if read_chunks(&mut conn, |c| {
        buf.extend_from_slice(&c);
        Ok(())
    })
    .await
    .is_err()
    {
        return error_response(502, "IPC_READ_FAILED", "truncated response body");
    }

    // ponytail: 响应整体缓冲（导出大文件一次性进内存）；流式消费走 ipc_stream 命令
    let mut builder = Response::builder().status(status);
    for (k, v) in resp_headers {
        // CORS 头由本层统一注入：后端 CorsLayer 已带一份，叠加会出现重复
        // Access-Control-Allow-Origin，WebView2 视为非法 CORS 响应导致 fetch
        // 直接 ERR_FAILED（启动器卡死在启动失败页的根因）。
        if k.eq_ignore_ascii_case("access-control-allow-origin")
            || k.eq_ignore_ascii_case("access-control-expose-headers")
        {
            continue;
        }
        builder = builder.header(k, v);
    }
    builder
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "*")
        .body(std::borrow::Cow::Owned(buf))
        .unwrap()
}

/// 注册到 Builder 的协议处理器闭包
pub fn make_protocol_handler(
    pipe: std::sync::Arc<std::sync::Mutex<Option<String>>>,
) -> impl Fn(tauri::UriSchemeContext<'_, tauri::Wry>, Request<Vec<u8>>, tauri::UriSchemeResponder)
       + Send
       + Sync
       + 'static {
    move |_ctx, req, responder| {
        if req.method() == "OPTIONS" {
            responder.respond(preflight());
            return;
        }
        let pipe = pipe.clone();
        tauri::async_runtime::spawn(async move {
            let name = pipe.lock().unwrap().clone();
            let resp = match name {
                Some(n) => forward(&n, req).await,
                None => error_response(503, "IPC_UNAVAILABLE", "backend pipe not configured"),
            };
            responder.respond(resp);
        });
    }
}

// --- 命令 ---

#[derive(Deserialize)]
pub struct StreamRequest {
    pub method: Option<String>,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<Vec<u8>>,
}

/// 流式请求：head/chunk/end 三类事件经 Channel 推送（JSON 文本行）
/// 返回 stream id，可用 ipc_stream_abort 中止。
#[tauri::command]
pub async fn ipc_stream(
    state: tauri::State<'_, StreamRegistry>,
    pipe: tauri::State<'_, IpcPipe>,
    id: String,
    req: StreamRequest,
    on_event: Channel<String>,
) -> Result<String, String> {
    let pipe_name = pipe.get().ok_or("IPC_UNAVAILABLE")?;
    let registry = state.0.clone();
    let id2 = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |e: String| on_event.send(e);
        let result = run_stream(&pipe_name, req, &emit).await;
        if let Err(e) = result {
            let _ =
                on_event.send(serde_json::json!({ "t": "error", "d": e.to_string() }).to_string());
        }
        // 任务结束（完成/出错/被 abort）后移除注册表条目，防泄漏
        registry.lock().unwrap().remove(&id2);
    });
    state.0.lock().unwrap().insert(id.clone(), handle);
    Ok(id)
}

async fn run_stream(
    pipe_name: &str,
    req: StreamRequest,
    emit: &(impl Fn(String) -> Result<(), tauri::Error> + Sync),
) -> std::io::Result<()> {
    let method = req.method.unwrap_or_else(|| "GET".into());
    let headers: Vec<(String, String)> = req
        .headers
        .into_iter()
        .filter(|(k, _)| !HOP_BY_HOP.contains(&k.to_lowercase().as_str()))
        .collect();
    let body = req.body.unwrap_or_default();

    let mut conn = connect_pipe(pipe_name).await?;
    write_all(
        &mut conn,
        &encode_request(&method, &req.path, &headers, &body),
    )
    .await?;
    let (status, resp_headers) = read_head(&mut conn).await?;
    let head = serde_json::json!({
        "t": "head",
        "status": status,
        "h": resp_headers.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>(),
    });
    emit(head.to_string()).ok();
    read_chunks(&mut conn, |c| {
        // ponytail: 按 UTF-8 lossy 切块推送；多字节字符跨块的极端场景由前端行缓冲兜底
        let text = String::from_utf8_lossy(&c).into_owned();
        emit(serde_json::json!({ "t": "chunk", "d": text }).to_string())
            .map_err(|e| std::io::Error::other(e))?;
        Ok(())
    })
    .await?;
    emit(r#"{"t":"end"}"#.to_string()).ok();
    // 与后端约定：等对端断开再关（见后端 handle_conn 注释）
    let mut sink = [0u8; 64];
    while matches!(read_upto(&mut conn, &mut sink).await, Ok(n) if n > 0) {}
    Ok(())
}

#[tauri::command]
pub fn ipc_stream_abort(state: tauri::State<'_, StreamRegistry>, id: String) -> bool {
    if let Some(handle) = state.0.lock().unwrap().remove(&id) {
        handle.abort();
        true
    } else {
        false
    }
}

/// IPC 可用性探测（前端 initApiTransport 用）
#[tauri::command]
pub async fn ipc_ping(pipe: tauri::State<'_, IpcPipe>) -> Result<bool, String> {
    let name = match pipe.get() {
        Some(n) => n,
        None => return Ok(false),
    };
    let mut conn = match connect_pipe(&name).await {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };
    let frame = encode_request("GET", "/api/ping", &[], b"");
    if write_all(&mut conn, &frame).await.is_err() {
        return Ok(false);
    }
    Ok(matches!(read_head(&mut conn).await, Ok((200, _))))
}
