//! QIPC 管道传输层：Windows 命名管道 / Unix domain socket。
//!
//! 协议（一连接一请求，全部小端长度前缀）：
//! ```text
//! REQ : u32 total_len | u8 method_len | method | u16 path_len | path
//!       | u16 header_count { u16 k_len k u16 v_len v }* | 其余为 body
//! RESP: u16 status | u16 header_count { ... }*
//!       后接数据块 [u32 chunk_len | chunk]* ，以 u32 0 结束，随后关闭连接
//! ```
//! 请求经 `Router::call` 直接进入现有 axum 路由（endpoint 层零改动）；
//! 响应 body 逐帧透传，SSE 流式端点天然工作。

use axum::body::Body;
use axum::http::{Method, Request, Uri};
use axum::Router;
use http_body_util::BodyExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tower::Service;

/// 单请求 body 上限（导出包等大文件场景），防御异常连接撑爆内存。
const MAX_FRAME_BODY: u32 = 1 << 30;

/// 单帧读取超时：防御慢速/恶意客户端只发长度前缀后挂起（read_exact 永久等待
/// 剩余字节会占用一个连接直到客户端断开）。正常请求远快于此阈值。
const FRAME_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[cfg(windows)]
pub async fn serve(
    app: Router,
    pipe_name: String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)?;
    tracing::info!("qipc listening on named pipe {pipe_name}");
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                tracing::info!("qipc shutting down");
                return Ok(());
            }
            r = server.connect() => r?,
        }
        let client = server;
        server = ServerOptions::new().create(&pipe_name)?;
        let app = app.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(app, client).await {
                tracing::warn!("qipc connection error: {e}");
            }
        });
    }
}

#[cfg(unix)]
pub async fn serve(
    app: Router,
    sock_path: String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    use tokio::net::UnixListener;
    let _ = std::fs::remove_file(&sock_path); // 清理上次残留
    if let Some(parent) = std::path::Path::new(&sock_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = UnixListener::bind(&sock_path)?;
    tracing::info!("qipc listening on unix socket {sock_path}");
    loop {
        let (stream, _) = tokio::select! {
            _ = shutdown.changed() => {
                tracing::info!("qipc shutting down");
                return Ok(());
            }
            r = listener.accept() => r?,
        };
        let app = app.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(app, stream).await {
                tracing::warn!("qipc connection error: {e}");
            }
        });
    }
}

struct QipcRequest {
    method: Method,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<QipcRequest>> {
    // total_len 为 0 或 EOF：客户端未发请求即断开，静默结束
    let total = match read_u32(r).await? {
        None => return Ok(None),
        Some(0) => return Ok(None),
        Some(n) => n,
    };
    if total > MAX_FRAME_BODY {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut buf = vec![0u8; total as usize];
    // 超时防御：客户端声明长度后不发送剩余字节（截断帧）时，read_exact 会
    // 永久挂起占用连接。加超时后超时即断开，释放连接。
    tokio::time::timeout(FRAME_READ_TIMEOUT, r.read_exact(&mut buf))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "frame read timeout"))??;
    let mut cur = &buf[..];

    let method_len = read_u8(&mut cur)? as usize;
    let method =
        Method::from_bytes(take(&mut cur, method_len, "method")?).map_err(|e| bad("method", e))?;
    let path_len = read_u16(&mut cur)? as usize;
    let path = std::str::from_utf8(take(&mut cur, path_len, "path")?)
        .map_err(|e| bad("path", e))?
        .to_string();
    let header_count = read_u16(&mut cur)?;
    let mut headers = Vec::with_capacity(header_count as usize);
    for _ in 0..header_count {
        let k_len = read_u16(&mut cur)? as usize;
        let k = std::str::from_utf8(take(&mut cur, k_len, "header name")?)
            .map_err(|e| bad("header name", e))?;
        let v_len = read_u16(&mut cur)? as usize;
        let v = std::str::from_utf8(take(&mut cur, v_len, "header value")?)
            .map_err(|e| bad("header value", e))?;
        headers.push((k.to_string(), v.to_string()));
    }

    Ok(Some(QipcRequest {
        method,
        path,
        headers,
        body: cur.to_vec(),
    }))
}

fn bad(what: &str, e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, format!("bad {what}: {e}"))
}

/// 从缓冲区取出 n 字节；不足时返回 InvalidData（防御恶意/截断帧的越界切片）。
fn take<'a>(b: &mut &'a [u8], n: usize, what: &str) -> std::io::Result<&'a [u8]> {
    if b.len() < n {
        return Err(bad(what, "truncated"));
    }
    let (head, rest) = b.split_at(n);
    *b = rest;
    Ok(head)
}

fn read_u8(b: &mut &[u8]) -> std::io::Result<u8> {
    if b.is_empty() {
        return Err(bad("u8", "truncated"));
    }
    let v = b[0];
    *b = &b[1..];
    Ok(v)
}

fn read_u16(b: &mut &[u8]) -> std::io::Result<u16> {
    if b.len() < 2 {
        return Err(bad("u16", "truncated"));
    }
    let v = u16::from_le_bytes([b[0], b[1]]);
    *b = &b[2..];
    Ok(v)
}

async fn read_u32<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<u32>> {
    let mut b = [0u8; 4];
    match r.read_exact(&mut b).await {
        Ok(_) => Ok(Some(u32::from_le_bytes(b))),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

async fn handle_conn<S>(app: Router, mut io: S) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Some(req) = read_frame(&mut io).await? else {
        return Ok(());
    };
    let uri: Uri = req.path.parse().map_err(|e| bad("uri", e))?;
    let mut builder = Request::builder().method(req.method.clone()).uri(uri);
    for (k, v) in &req.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    let request = builder
        .body(Body::from(req.body))
        .expect("static request build");

    // Router 的 Service Error = Infallible，此处 unwrap 安全
    let response = app
        .clone()
        .call(request)
        .await
        .unwrap_or_else(|e| match e {});

    let (parts, mut body) = response.into_parts();
    const HOP_BY_HOP: [&str; 4] = [
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
    ];
    let headers: Vec<(String, String)> = parts
        .headers
        .iter()
        .filter(|(k, _)| !HOP_BY_HOP.contains(&k.as_str()))
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|vs| (k.as_str().to_string(), vs.to_string()))
        })
        .collect();

    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&parts.status.as_u16().to_le_bytes());
    out.extend_from_slice(&(headers.len() as u16).to_le_bytes());
    for (k, v) in &headers {
        out.extend_from_slice(&(k.len() as u16).to_le_bytes());
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(&(v.len() as u16).to_le_bytes());
        out.extend_from_slice(v.as_bytes());
    }
    io.write_all(&out).await?;

    while let Some(frame) = BodyExt::frame(&mut body).await {
        // trailer 帧直接丢弃；当前无端点使用 HTTP trailers
        if let Ok(data) = frame.map_err(|e| bad("body", e))?.into_data() {
            io.write_all(&(data.len() as u32).to_le_bytes()).await?;
            io.write_all(&data).await?;
        }
    }
    io.write_all(&0u32.to_le_bytes()).await?;
    io.flush().await?;
    // 等客户端读完并断开再关本端：
    // Windows 命名管道在服务端关闭实例时会丢弃对端尚未读走的缓冲数据
    // （TCP 无此语义），直接返回会导致客户端读到截断响应。
    let mut sink = [0u8; 64];
    while matches!(io.read(&mut sink).await, Ok(n) if n > 0) {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::routing::get;
    use axum::Json;
    use futures::stream;

    fn test_app() -> Router {
        async fn ping() -> Json<serde_json::Value> {
            Json(serde_json::json!({ "pong": true }))
        }
        // 模拟 SSE：多 chunk 流式 body
        async fn sse() -> axum::response::Response {
            let body = Body::from_stream(stream::iter(vec![
                Ok::<_, std::io::Error>("data: 1\n\n".to_string()),
                Ok::<_, std::io::Error>("data: 2\n\n".to_string()),
                Ok::<_, std::io::Error>("data: 3\n\n".to_string()),
            ]));
            axum::http::Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(body)
                .unwrap()
        }
        Router::new()
            .route("/api/ping", get(ping))
            .route("/api/sse", get(sse))
    }

    fn pipe_name() -> String {
        #[cfg(windows)]
        {
            format!(r"\\.\pipe\qomicex-qipc-test-{}", std::process::id())
        }
        #[cfg(unix)]
        {
            std::env::temp_dir()
                .join(format!("qomicex-qipc-test-{}.sock", std::process::id()))
                .to_string_lossy()
                .into_owned()
        }
    }

    enum Conn {
        #[cfg(windows)]
        Win(tokio::net::windows::named_pipe::NamedPipeClient),
        #[cfg(unix)]
        Unix(tokio::net::UnixStream),
    }

    impl Conn {
        async fn open(name: &str) -> Self {
            #[cfg(windows)]
            {
                let _ = name;
                loop {
                    match tokio::net::windows::named_pipe::ClientOptions::new().open(pipe_name()) {
                        Ok(c) => {
                            return Conn::Win(c);
                        }
                        // ERROR_PIPE_BUSY：服务端实例重建间隙，重试
                        Err(e) if e.raw_os_error() == Some(231) => {
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        }
                        Err(e) => panic!("open pipe failed: {e}"),
                    }
                }
            }
            #[cfg(unix)]
            {
                for _ in 0..50 {
                    if let Ok(s) = tokio::net::UnixStream::connect(name).await {
                        return Conn::Unix(s);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                panic!("connect failed: {name}");
            }
        }

        async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
            match self {
                #[cfg(windows)]
                Conn::Win(c) => c.write_all(buf).await,
                #[cfg(unix)]
                Conn::Unix(s) => s.write_all(buf).await,
            }
        }

        async fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
            match self {
                #[cfg(windows)]
                Conn::Win(c) => c.read_exact(buf).await.map(|_| ()),
                #[cfg(unix)]
                Conn::Unix(s) => s.read_exact(buf).await.map(|_| ()),
            }
        }
    }

    fn build_request(method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
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
        out.extend_from_slice(&(core.len() as u32).to_le_bytes());
        out.extend_from_slice(&core);
        out
    }

    async fn read_response(conn: &mut Conn) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut b2 = [0u8; 2];
        conn.read_exact(&mut b2).await.unwrap();
        let status = u16::from_le_bytes(b2);
        conn.read_exact(&mut b2).await.unwrap();
        let count = u16::from_le_bytes(b2);
        let mut headers = Vec::with_capacity(count as usize);
        for _ in 0..count {
            conn.read_exact(&mut b2).await.unwrap();
            let k_len = u16::from_le_bytes(b2) as usize;
            let mut kb = vec![0u8; k_len];
            conn.read_exact(&mut kb).await.unwrap();
            conn.read_exact(&mut b2).await.unwrap();
            let v_len = u16::from_le_bytes(b2) as usize;
            let mut vb = vec![0u8; v_len];
            conn.read_exact(&mut vb).await.unwrap();
            headers.push((
                String::from_utf8(kb).unwrap(),
                String::from_utf8(vb).unwrap(),
            ));
        }
        let mut body = Vec::new();
        loop {
            let mut b4 = [0u8; 4];
            conn.read_exact(&mut b4).await.unwrap();
            let chunk = u32::from_le_bytes(b4) as usize;
            if chunk == 0 {
                break;
            }
            let mut cb = vec![0u8; chunk];
            conn.read_exact(&mut cb).await.unwrap();
            body.extend_from_slice(&cb);
        }
        (status, headers, body)
    }

    #[tokio::test]
    async fn request_response_roundtrip() {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .try_init()
            .ok();
        let app = test_app();
        let name = pipe_name();
        // sender 必须保活：全部 drop 时 watch 的 changed() 立即就绪，serve 会直接退出
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(serve(app, name.clone(), shutdown_rx));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // 缓冲 JSON 响应
        let mut conn = Conn::open(&name).await;
        conn.write_all(&build_request("GET", "/api/ping", &[], b""))
            .await
            .unwrap();
        let (status, headers, body) = read_response(&mut conn).await;
        assert_eq!(status, 200);
        assert!(headers
            .iter()
            .any(|(k, v)| k == "content-type" && v.starts_with("application/json")));
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["pong"], true);

        // 流式 SSE 响应（chunk 边界还原）
        let mut conn = Conn::open(&name).await;
        conn.write_all(&build_request("GET", "/api/sse", &[], b""))
            .await
            .unwrap();
        let (status, headers, body) = read_response(&mut conn).await;
        assert_eq!(status, 200);
        assert!(headers
            .iter()
            .any(|(k, v)| k == "content-type" && v == "text/event-stream"));
        assert_eq!(
            String::from_utf8(body).unwrap(),
            "data: 1\n\ndata: 2\n\ndata: 3\n\n"
        );

        server.abort();
    }
}
