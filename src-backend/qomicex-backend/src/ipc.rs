// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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

/// 单帧读取上限（导出包等大文件场景），防御异常连接撑爆内存。
const MAX_FRAME_BODY: u32 = 1 << 30;

/// 帧读取的**空闲**超时：两次读到数据之间允许的最大间隔。
///
/// 不能对整个 `read_exact` 施加总时限。此前用「30s 总超时」覆盖整帧，
/// 与 1 GiB 的 `MAX_FRAME_BODY` 直接冲突：要在 30s 内读完 1 GiB 需要持续
/// ≈34 MB/s 的管道吞吐，而请求体由用户可控（`.qplugin` 上传、整合包导入，
/// GTNH 包 595MB），慢机器/杀软扫描/慢盘很容易掉到该阈值以下 —— 表现是
/// 「上传到一半断开」，且错误只报超时，与「体积超限」无法区分。
///
/// 改为按字节空闲超时后：持续有数据在流动就不会超时（只受总吞吐限制），
/// 真正卡死的连接（声明长度后一个字节都不再发）仍在此时限内被回收。
const FRAME_READ_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 每块读取大小：既让空闲超时能频繁重置，又避免为 1 GiB 帧发起兆级次系统调用。
const FRAME_READ_CHUNK: usize = 1 << 20;

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

#[derive(Debug)]
struct QipcRequest {
    method: Method,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<QipcRequest>> {
    read_frame_with(r, FRAME_READ_IDLE_TIMEOUT, FRAME_READ_CHUNK).await
}

/// [`read_frame`] 的可注入版本：`idle_timeout` / `chunk_size` 可调，供回归测试
/// 用毫秒级时限覆盖**完整的**帧解析路径（而不是只测其中一段 helper）。
async fn read_frame_with<R: AsyncRead + Unpin>(
    r: &mut R,
    idle_timeout: std::time::Duration,
    chunk_size: usize,
) -> std::io::Result<Option<QipcRequest>> {
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
    // 分块读取 + 每块重置空闲超时：只要数据在持续流动就不会超时，避免大帧
    // 在整帧总时限下被误杀（见 FRAME_READ_IDLE_TIMEOUT 注释）。
    read_frame_body_with(r, &mut buf, idle_timeout, chunk_size).await?;
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

/// 分块把整帧读入 `buf`，**每块之间**重置空闲超时。
///
/// 语义：单次停顿超过 `idle_timeout` 即判超时断开；持续有数据流动则不限总时长
/// （大帧只受吞吐限制）。参数化超时与块大小便于用毫秒级时限做回归测试。
async fn read_frame_body_with<R: AsyncRead + Unpin>(
    r: &mut R,
    buf: &mut [u8],
    idle_timeout: std::time::Duration,
    chunk_size: usize,
) -> std::io::Result<()> {
    let chunk_size = chunk_size.max(1);
    let mut filled = 0usize;
    while filled < buf.len() {
        let end = (filled + chunk_size).min(buf.len());
        let chunk = &mut buf[filled..end];
        let n = tokio::time::timeout(idle_timeout, r.read(chunk))
            .await
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "frame read idle timeout")
            })??;
        if n == 0 {
            // 对端在帧中途关闭
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "frame truncated: peer closed mid-frame",
            ));
        }
        filled += n;
    }
    Ok(())
}

async fn handle_conn<S>(app: Router, mut io: S) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Some(req) = read_frame(&mut io).await? else {
        return Ok(());
    };
    let uri: Uri = req.path.parse().map_err(|e| bad("uri", e))?;
    // 逐跳头由传输层重建，请求/响应两个方向都不透传：帧里本来就没有 content-length
    // （客户端 encode_request 会过滤），若调用方硬塞过期值会导致提取器读错长度。
    //
    // 除固定的四个外，RFC 9110 要求把 `Connection` 里**点名**的字段也视为逐跳
    // （如 `Connection: x-ipc-only` 表示 x-ipc-only 只对当前连接有意义），否则它们
    // 会越过 IPC 重建边界泄漏给后端路由。
    const HOP_BY_HOP: [&str; 4] = [
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
    ];
    let nominated: Vec<String> = req
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, v)| v.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    let mut builder = Request::builder().method(req.method.clone()).uri(uri);
    for (k, v) in &req.headers {
        let lower = k.to_lowercase();
        if HOP_BY_HOP.contains(&lower.as_str()) || nominated.contains(&lower) {
            continue;
        }
        builder = builder.header(k.as_str(), v.as_str());
    }
    // 按实际 body 长度补齐：帧协议本身携带长度，但重建的 HTTP 请求需要显式声明。
    // 非零长度才补，避免 GET 之类空 body 请求多出一个 content-length: 0。
    if !req.body.is_empty() {
        builder = builder.header("content-length", req.body.len());
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

    /// 回归（#235）：慢速但**持续有数据**的大帧不得因整帧总超时被误杀。
    ///
    /// 旧实现用 30s 覆盖整个 `read_exact`：1 GiB 需要 ≈34 MB/s，慢管道必然超时。
    /// 这里用「时限 200ms + 分 10 块、每块间隔 40ms」模拟：总耗时约 400ms
    /// （> 200ms 总时限），但每块间隔 < 200ms 空闲时限 → 修复后应成功。
    #[tokio::test]
    async fn slow_but_progressing_frame_is_not_timed_out() {
        use tokio::io::AsyncWriteExt;

        let (mut client, mut server) = tokio::io::duplex(1024);
        // 构造一个合法的完整请求帧（长度前缀 + method/path/headers/body），
        // 通过 read_frame_with 走**真实**的帧解析路径（而非只测其中的 helper），
        // 这样即便有人把 read_frame 改回整帧总超时，本测试也会失败。
        let frame = build_request("GET", "/api/ping", &[], b"");
        let expect = frame.clone();

        tokio::spawn(async move {
            // 逐字节、每字节间隔 40ms：总耗时远超下面的总时限，但每次间隔都短于空闲时限
            for b in frame {
                client.write_all(&[b]).await.unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            }
        });

        let r = read_frame_with(
            &mut server,
            std::time::Duration::from_millis(200),
            1, // 每字节一次 read，逐块重置空闲超时
        )
        .await;
        let req = r.expect("持续有数据的慢帧不应超时").expect("应有请求");
        assert_eq!(req.path, "/api/ping");
        assert!(expect.len() > 9, "帧应足够长以跨越总时限");
    }

    /// 反向护栏：真正卡死的连接（声明长度后不再发字节）必须被空闲超时回收。
    #[tokio::test]
    async fn stalled_frame_is_timed_out() {
        use tokio::io::AsyncWriteExt;
        let (mut client, mut server) = tokio::io::duplex(64);
        tokio::spawn(async move {
            // 声明 16 字节的帧，但只发长度前缀后就挂起
            client.write_all(&16u32.to_le_bytes()).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });

        let r = read_frame_with(&mut server, std::time::Duration::from_millis(150), 1).await;
        let err = r.expect_err("卡死的帧必须超时");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    }

    /// 对端在帧中途关闭 → 立即报截断，不等超时。
    #[tokio::test]
    async fn peer_closed_mid_frame_is_truncated() {
        use tokio::io::AsyncWriteExt;
        let (mut client, mut server) = tokio::io::duplex(64);
        tokio::spawn(async move {
            client.write_all(&16u32.to_le_bytes()).await.unwrap();
            client.write_all(&[1, 2, 3]).await.unwrap();
            drop(client); // 关闭
        });

        let r = read_frame_with(&mut server, std::time::Duration::from_millis(5000), 1).await;
        let err = r.expect_err("中途关闭必须报错");
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    /// 正向护栏：正常快帧仍应被完整解析（method / path / headers / body）。
    #[tokio::test]
    async fn complete_frame_round_trips_through_real_parser() {
        use tokio::io::AsyncWriteExt;
        let (mut client, mut server) = tokio::io::duplex(4096);
        let frame = build_request(
            "POST",
            "/api/x",
            &[("content-type", "application/json")],
            b"{}",
        );
        tokio::spawn(async move {
            client.write_all(&frame).await.unwrap();
        });

        let req = read_frame_with(&mut server, std::time::Duration::from_secs(5), 1 << 20)
            .await
            .expect("应解析成功")
            .expect("应有请求");
        assert_eq!(req.method, axum::http::Method::POST);
        assert_eq!(req.path, "/api/x");
        assert_eq!(req.headers.len(), 1);
        assert_eq!(req.body, b"{}");
    }

    fn test_app() -> Router {
        async fn ping() -> Json<serde_json::Value> {
            Json(serde_json::json!({ "pong": true }))
        }
        // 与 /plugins/proxy 同构：用 Json 提取器读请求体。IPC 帧里没有 Content-Length
        // 时 Axum 直接 415（issue #262 的失败路径）。
        async fn echo(Json(v): Json<serde_json::Value>) -> Json<serde_json::Value> {
            Json(v)
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
            .route("/api/echo", axum::routing::post(echo))
            .route("/api/sse", get(sse))
    }

    /// 每个测试独立 pipe 名。
    ///
    /// 这些测试都通过 `serve()` 监听真实命名管道。cargo 默认并行跑测试，若共用
    /// 「进程 id」这一份名字，多个 `#[tokio::test]` 会互相抢同一个管道：客户端连接到
    /// 另一个测试的 server 上，表现为 `early eof` / `open pipe failed` 的随机失败。
    /// 用原子计数保证唯一。
    fn pipe_name() -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        #[cfg(windows)]
        {
            format!(r"\\.\pipe\qomicex-qipc-test-{}-{seq}", std::process::id())
        }
        #[cfg(unix)]
        {
            std::env::temp_dir()
                .join(format!(
                    "qomicex-qipc-test-{}-{seq}.sock",
                    std::process::id()
                ))
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
                // 重试两种「服务端尚未就绪」的错误码：
                //   2  = ERROR_FILE_NOT_FOUND（server 还没创建首实例）
                //   231 = ERROR_PIPE_BUSY（实例重建间隙）
                // 只重试 231 会让「测试先连接、server 后启动」的竞态直接 panic。
                for _ in 0..100 {
                    match tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
                        Ok(c) => return Conn::Win(c),
                        Err(e) if matches!(e.raw_os_error(), Some(2) | Some(231)) => {
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        }
                        Err(e) => panic!("open pipe failed: {e}"),
                    }
                }
                panic!("open pipe timeout: {name}");
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

    /// 回归（issue #262）：缺 Content-Type 时 Json 提取器返回 415。
    ///
    /// 这条锁定**真实根因**：`ipcStream` 不透传默认 `Content-Type`，而 `httpStream`
    /// 会补。前端 `proxyFetchStream` 调 `openStream` 时没给 headers，于是 IPC 模式下
    /// 请求到后端没有 content-type，`Json` 提取器直接 415 —— 与 Content-Length 无关。
    #[tokio::test]
    async fn missing_content_type_reaches_json_extractor_as_415() {
        let app = test_app();
        let name = pipe_name();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(serve(app, name.clone(), shutdown_rx));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = Conn::open(&name).await;
        conn.write_all(&build_request(
            "POST",
            "/api/echo",
            &[], // 完全没有 content-type
            br#"{"a":1}"#,
        ))
        .await
        .unwrap();
        let (status, _, _) = read_response(&mut conn).await;
        assert_eq!(
            status, 415,
            "缺 content-type 时 Json 提取器应返回 415（issue #262 的真实根因）"
        );

        server.abort();
    }

    /// 回归（issue #262 评审）：`Connection` 里点名的字段属于逐跳头，不得越过 IPC 边界。
    ///
    /// RFC 9110 §7.6.1：`Connection: x-foo` 表示 x-foo 只对当前连接有意义，转发时必须
    /// 一并删除。只过滤 `Connection` 本身会让 x-foo 泄漏给后端路由。
    #[tokio::test]
    async fn connection_nominated_headers_are_not_forwarded() {
        use std::sync::{Arc, Mutex};

        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_in_handler = seen.clone();
        let app = Router::new().route(
            "/api/headers",
            axum::routing::get(move |headers: axum::http::HeaderMap| {
                let seen = seen_in_handler.clone();
                async move {
                    let names: Vec<String> = headers
                        .keys()
                        .map(|k| k.as_str().to_ascii_lowercase())
                        .collect();
                    *seen.lock().unwrap() = names;
                    Json(serde_json::json!({ "ok": true }))
                }
            }),
        );

        let name = pipe_name();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(serve(app, name.clone(), shutdown_rx));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = Conn::open(&name).await;
        conn.write_all(&build_request(
            "GET",
            "/api/headers",
            &[
                ("x-ipc-only", "leak"),
                ("x-kept", "yes"),
                ("connection", "x-ipc-only"),
            ],
            b"",
        ))
        .await
        .unwrap();
        let (status, _, _) = read_response(&mut conn).await;
        assert_eq!(status, 200);

        let forwarded = seen.lock().unwrap().clone();
        assert!(
            !forwarded.contains(&"x-ipc-only".to_string()),
            "Connection 点名的头不应转发，实际: {forwarded:?}"
        );
        assert!(
            !forwarded.contains(&"connection".to_string()),
            "Connection 本身不应转发，实际: {forwarded:?}"
        );
        assert!(
            forwarded.contains(&"x-kept".to_string()),
            "未点名的头应正常转发，实际: {forwarded:?}"
        );

        server.abort();
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

    /// 回归（issue #262）：IPC 帧里没有 Content-Length 时，POST + Json 提取器必须
    /// 仍能读到 body。
    ///
    /// 前端 `proxyFetchStream` 只把调用方显式给的头放进帧（Content-Type、
    /// Authorization），Content-Length 是逐跳头，客户端 encode_request 会过滤掉。
    /// handle_conn 重建 Axum 请求时若不按实际 body 长度补回，`Json` 提取器拿不到
    /// 长度直接返回 415 —— 所有插件的流式能力静默失效。
    #[tokio::test]
    async fn post_body_without_content_length_reaches_json_extractor() {
        let app = test_app();
        let name = pipe_name();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(serve(app, name.clone(), shutdown_rx));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let body = br#"{"model":"x","stream":true}"#;
        let mut conn = Conn::open(&name).await;
        // 关键：headers 里只有 content-type，没有 content-length（与前端 IPC 一致）
        conn.write_all(&build_request(
            "POST",
            "/api/echo",
            &[("content-type", "application/json")],
            body,
        ))
        .await
        .unwrap();
        let (status, _, resp_body) = read_response(&mut conn).await;
        assert_eq!(
            status, 200,
            "缺 Content-Length 时 Json 提取器应仍能读 body，实际得到 {status}"
        );
        let json: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
        assert_eq!(json["stream"], true);

        server.abort();
    }

    /// 回归（issue #262）：调用方自带的 Content-Length 必须被以实际 body 长度覆盖。
    ///
    /// 前端有可能传入过期或被篡改的长度（例如按 UTF-16 计数的字符串长度、代理层
    /// 改写等）。若直接透传，提取器会按错误长度读取导致 400/415 或读到截断 body。
    #[tokio::test]
    async fn stale_content_length_is_replaced_by_actual_body_length() {
        let app = test_app();
        let name = pipe_name();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(serve(app, name.clone(), shutdown_rx));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let body = br#"{"a":1}"#;
        let mut conn = Conn::open(&name).await;
        // 声称 999 字节，实际 7 字节
        conn.write_all(&build_request(
            "POST",
            "/api/echo",
            &[
                ("content-type", "application/json"),
                ("content-length", "999"),
            ],
            body,
        ))
        .await
        .unwrap();
        let (status, _, resp_body) = read_response(&mut conn).await;
        assert_eq!(
            status, 200,
            "过期 Content-Length 应被实际长度覆盖，实际 {status}"
        );
        let json: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
        assert_eq!(json["a"], 1);

        server.abort();
    }
}
