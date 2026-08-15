//! Log endpoints (translated from Endpoints/LogEndpoints.cs).
//!
//! The C# source operates purely on files under `{BaseDir}/logs`: listing,
//! export (copy / zip / download), delete and open / open-dir. The C# file has
//! NO trace-snapshot, mclo.gs upload or log-level route, so none are added here
//! (this is a faithful translation of the source only).
//!
//! Routes are declared relative to the "/api" nest (see app.rs). The C# group
//! prefix is `/api/logs`, hence every route below starts with `/logs`.
//!
//! Dependencies note: the workspace has no `zip`/`base64` crates and this slice
//! must not add any, so a minimal STORE-method ZIP builder and a base64 decoder
//! are implemented inline (see the TODO notes). axum's Query extractor already
//! percent-decodes the `path` parameter, matching C# `Uri.UnescapeDataString`.

use std::io::{Result as IoResult, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

use chrono::{DateTime, Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::models::{OpenPathRequest, OpenPathResponse};
use crate::state::SharedState;

const ZIP_SIG_LOCAL: u32 = 0x0403_4b50;
const ZIP_SIG_CENTRAL: u32 = 0x0201_4b50;
const ZIP_SIG_EOCD: u32 = 0x0605_4b50;

/// Approximate the C# `SessionStart` (process start time). We capture the first
/// time `LogEndpoints` is exercised rather than the true process start; close
/// enough for the `isCurrentSession` flag. TODO: use an actual start timestamp.
fn session_start() -> SystemTime {
    static START: OnceLock<SystemTime> = OnceLock::new();
    *START.get_or_init(SystemTime::now)
}

/// GET /api/logs
async fn list_logs(State(state): State<SharedState>) -> ApiResult<Json<Vec<LogEntry>>> {
    let log_dir = state.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let start = session_start();
    let mut entries: Vec<LogEntry> = Vec::new();
    for e in std::fs::read_dir(&log_dir)? {
        let e = match e {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let path = e.path();
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let dt: DateTime<Local> = modified.into();
        entries.push(LogEntry {
            path: path.to_string_lossy().into_owned(),
            name: e.file_name().to_string_lossy().into_owned(),
            size: meta.len() as i64,
            last_modified: dt.to_rfc3339(),
            is_current_session: modified >= start,
        });
    }
    entries.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(Json(entries))
}

/// GET /api/logs/export?path=<base64-or-path>  ->  download a log file
async fn export_log(
    State(state): State<SharedState>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Response> {
    let log_dir = state.data_dir.join("logs");
    let decoded = decode_export_path(&q.path);
    let resolved = resolve_log_path(&log_dir, &decoded);
    let Some(path) = resolved else {
        return Err(ApiError::not_found("LOG_NOT_FOUND", "Log file not found"));
    };
    let bytes = std::fs::read(&path)?;
    let mut disposition = String::from("attachment");
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.is_ascii() {
            disposition = format!("attachment; filename=\"{name}\"");
        }
    }
    let mut resp = (StatusCode::OK, bytes).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );
    Ok(resp)
}

/// POST /api/logs/export-to  { path, dest }  ->  copy one log file to dest
async fn export_to(
    State(state): State<SharedState>,
    Json(body): Json<ExportRequest>,
) -> ApiResult<Json<OpenPathResponse>> {
    let log_dir = state.data_dir.join("logs");
    let resolved = resolve_log_path(&log_dir, &body.path);
    let Some(path) = resolved else {
        return Err(ApiError::not_found("LOG_NOT_FOUND", "Log file not found"));
    };
    if let Some(parent) = Path::new(&body.dest).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Err(ApiError::bad_request("COPY_FAILED", e.to_string()));
            }
        }
    }
    if let Err(e) = std::fs::copy(&path, &body.dest) {
        return Err(ApiError::bad_request("COPY_FAILED", e.to_string()));
    }
    Ok(Json(OpenPathResponse { path: body.dest }))
}

/// POST /api/logs/export-all-to  { dest }  ->  zip the whole logs dir to dest
async fn export_all_to(
    State(state): State<SharedState>,
    Json(body): Json<ExportAllRequest>,
) -> ApiResult<Json<OpenPathResponse>> {
    let log_dir = state.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    if let Some(parent) = Path::new(&body.dest).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Err(ApiError::bad_request("ZIP_FAILED", e.to_string()));
            }
        }
    }
    let zip_bytes = match build_zip(&log_dir) {
        Ok(b) => b,
        Err(e) => return Err(ApiError::bad_request("ZIP_FAILED", e.to_string())),
    };
    if let Err(e) = std::fs::write(&body.dest, zip_bytes) {
        return Err(ApiError::bad_request("ZIP_FAILED", e.to_string()));
    }
    Ok(Json(OpenPathResponse { path: body.dest }))
}

/// GET /api/logs/export-all  ->  download a zip of the whole logs dir
async fn export_all(State(state): State<SharedState>) -> ApiResult<Response> {
    let log_dir = state.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let zip_bytes = match build_zip(&log_dir) {
        Ok(b) => b,
        Err(_) => {
            return Err(ApiError::not_found("LOG_NOT_FOUND", "No log files"));
        }
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/zip"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"logs.zip\"",
            ),
        ],
        zip_bytes,
    )
        .into_response())
}

/// DELETE /api/logs?path=<path>  ->  delete one log file
async fn delete_log(
    State(state): State<SharedState>,
    Query(q): Query<PathQuery>,
) -> ApiResult<StatusCode> {
    let log_dir = state.data_dir.join("logs");
    let resolved = resolve_log_path(&log_dir, &q.path);
    let Some(path) = resolved else {
        return Err(ApiError::not_found("LOG_NOT_FOUND", "Log file not found"));
    };
    if let Err(e) = std::fs::remove_file(&path) {
        return Err(ApiError::bad_request("DELETE_FAILED", e.to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/logs/open  { path }  ->  open a file with the OS default app
async fn open(Json(body): Json<OpenPathRequest>) -> ApiResult<StatusCode> {
    let path = body.path.trim();
    if path.is_empty() || !Path::new(path).is_file() {
        return Err(ApiError::not_found("LOG_NOT_FOUND", "File not found"));
    }
    let _ = open::that_detached(path);
    Ok(StatusCode::OK)
}

/// POST /api/logs/open-dir  { path }  ->  open the containing directory
async fn open_dir(Json(body): Json<OpenPathRequest>) -> ApiResult<StatusCode> {
    let path = body.path.trim();
    if path.is_empty() {
        return Err(ApiError::not_found("LOG_NOT_FOUND", "Directory not found"));
    }
    let dir = if Path::new(path).is_file() {
        Path::new(path).parent().map(|p| p.to_path_buf())
    } else {
        Some(PathBuf::from(path))
    };
    let Some(dir) = dir else {
        return Err(ApiError::not_found("LOG_NOT_FOUND", "Directory not found"));
    };
    if !dir.is_dir() {
        return Err(ApiError::not_found("LOG_NOT_FOUND", "Directory not found"));
    }
    if dir.to_str().is_none() {
        return Err(ApiError::bad_request(
            "OPEN_FAILED",
            "Path is not valid UTF-8",
        ));
    }
    let _ = open::that_detached(&dir);
    Ok(StatusCode::OK)
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/logs", get(list_logs).delete(delete_log))
        .route("/logs/export", get(export_log))
        .route("/logs/export-to", post(export_to))
        .route("/logs/export-all-to", post(export_all_to))
        .route("/logs/export-all", get(export_all))
        .route("/logs/open", post(open))
        .route("/logs/open-dir", post(open_dir))
        .route("/logs/content", get(log_content))
        .route("/logs/frontend", post(frontend_log))
}

/// POST /api/logs/frontend — 前端 console 日志上报（构建版无控制台时仍可查看）。
/// body: `{ "level": "warn", "message": "..." }`，写入 trace 缓冲 + 落盘文件。
async fn frontend_log(
    Json(body): Json<FrontendLogRequest>,
) -> ApiResult<StatusCode> {
    let level = body.level.unwrap_or_else(|| "log".to_string());
    let message = body.message.unwrap_or_default();
    // 消息可含换行（多行 console），逐行写入便于查看器按行过滤
    for l in message.lines() {
        crate::services::trace::trace_append(format!("[frontend:{level}] {l}"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/logs/content?path=<path> — 读取日志文件内容（前端查看器用）。
/// 安全约束与 export 一致：只允许 logs 目录内的文件；超大文件截断尾部。
async fn log_content(
    State(state): State<SharedState>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<LogContentResponse>> {
    let log_dir = state.data_dir.join("logs");
    let resolved = resolve_log_path(&log_dir, &q.path).ok_or_else(|| {
        ApiError::not_found("LOG_NOT_FOUND", "Log file not found")
    })?;

    const MAX_CONTENT_BYTES: u64 = 2 * 1024 * 1024; // 前端查看器上限 2MB
    let bytes = std::fs::read(&resolved)?;
    let truncated = bytes.len() as u64 > MAX_CONTENT_BYTES;
    let content = if truncated {
        String::from_utf8_lossy(&bytes[bytes.len() - MAX_CONTENT_BYTES as usize..]).into_owned()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok(Json(LogContentResponse {
        path: resolved.to_string_lossy().into_owned(),
        content,
        truncated,
    }))
}

// ---------------------------------------------------------------------------
// Query / DTOs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathQuery {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    path: String,
    dest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAllRequest {
    dest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    path: String,
    name: String,
    size: i64,
    last_modified: String,
    is_current_session: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendLogRequest {
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogContentResponse {
    path: String,
    content: String,
    truncated: bool,
}

/// Mirrors C# `ResolveLogPath`: only existing files rooted inside the logs dir
/// are allowed. `log_dir` is the `{BaseDir}/logs` root.
fn resolve_log_path(log_dir: &Path, raw: &str) -> Option<PathBuf> {
    if raw.trim().is_empty() {
        return None;
    }
    let p = Path::new(raw);
    let full = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(p)
    };
    let full_c = full.canonicalize().ok()?;
    let log_c = log_dir
        .canonicalize()
        .unwrap_or_else(|_| log_dir.to_path_buf());
    if full_c.starts_with(&log_c) && full_c.is_file() {
        Some(full_c)
    } else {
        None
    }
}

/// Mirrors C# `/export`: first try to base64-decode the query value, falling
/// back to the already percent-decoded raw string (axum decodes query values).
fn decode_export_path(path: &str) -> String {
    if let Some(bytes) = base64_decode(path) {
        if let Ok(decoded) = String::from_utf8(bytes) {
            return decoded;
        }
    }
    path.to_string()
}

// ---------------------------------------------------------------------------
// Minimal base64 (standard alphabet, accepts padding). Inline because there is
// no `base64` crate in the workspace and this slice must not add dependencies.
// ---------------------------------------------------------------------------

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.trim().as_bytes();
    if b.is_empty() || b.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let mut i = 0;
    while i < b.len() {
        let end = (i + 4).min(b.len());
        let chunk = &b[i..end];
        let mut v = [0u32; 4];
        let mut n = 0;
        for &c in chunk {
            if c == b'=' {
                continue;
            }
            v[n] = b64_val(c)?;
            n += 1;
        }
        if n < 2 {
            return None;
        }
        out.push(((v[0] << 2) | (v[1] >> 4)) as u8);
        if n >= 3 {
            out.push((((v[1] & 0x0F) << 4) | (v[2] >> 2)) as u8);
        }
        if n >= 4 {
            out.push((((v[2] & 0x03) << 6) | v[3]) as u8);
        }
        i += 4;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Minimal STORE-method ZIP builder. Inline because there is no `zip` crate in
// the workspace and this slice must not add dependencies. Files are stored
// uncompressed (method 0), which is functionally valid ZIP. TODO: if Deflate
// compression is ever required, add a crate dependency.
// ---------------------------------------------------------------------------

fn zip_crc_table() -> &'static [u32; 256] {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        let mut i = 0;
        while i < 256 {
            let mut c = i as u32;
            let mut k = 0;
            while k < 8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
                k += 1;
            }
            table[i] = c;
            i += 1;
        }
        table
    })
}

fn crc32(data: &[u8]) -> u32 {
    let table = zip_crc_table();
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        let idx = ((crc ^ byte as u32) & 0xFF) as usize;
        crc = (crc >> 8) ^ table[idx];
    }
    crc ^ 0xFFFF_FFFF
}

fn dos_now() -> (u16, u16) {
    let now = Local::now();
    let year = now.year() as u16;
    let month = now.month() as u16;
    let day = now.day() as u16;
    let hour = now.hour() as u16;
    let minute = now.minute() as u16;
    let second = (now.second() / 2) as u16;
    let date = ((year.saturating_sub(1980) & 0x7F) << 9) | (month << 5) | day;
    let time = (hour << 11) | (minute << 5) | second;
    (time, date)
}

/// Recursively read every file under `dir` into memory with a `/`-relative name.
fn collect_zip_files(dir: &Path) -> IoResult<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d)? {
            let e = e?;
            let p = e.path();
            if let Ok(meta) = p.metadata() {
                if meta.is_dir() {
                    stack.push(p);
                    continue;
                }
            } else if p.is_dir() {
                stack.push(p);
                continue;
            }
            let rel = p
                .strip_prefix(dir)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            if !rel.is_empty() {
                out.push((rel, std::fs::read(&p)?));
            }
        }
    }
    Ok(out)
}

/// Build a STORE ZIP of the whole directory tree as bytes.
fn build_zip(dir: &Path) -> IoResult<Vec<u8>> {
    let files = collect_zip_files(dir)?;
    let (dos_time, dos_date) = dos_now();
    let mut body: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    let mut offset: u32 = 0;
    let count = files.len().min(0xFFFF) as u16;

    for (name, data) in files.iter() {
        let name_b = name.as_bytes();
        let size = data.len() as u32;
        let crc = crc32(data);

        // Local file header.
        let header_len = 30 + name_b.len() as u32;
        write_u32(&mut body, ZIP_SIG_LOCAL);
        write_u16(&mut body, 20); // version needed
        write_u16(&mut body, 0); // general purpose flag
        write_u16(&mut body, 0); // method: store
        write_u16(&mut body, dos_time);
        write_u16(&mut body, dos_date);
        write_u32(&mut body, crc);
        write_u32(&mut body, size); // compressed size
        write_u32(&mut body, size); // uncompressed size
        write_u16(&mut body, name_b.len() as u16);
        write_u16(&mut body, 0); // extra field length
        body.write_all(name_b)?;
        body.write_all(data)?;

        // Central directory record.
        write_u32(&mut central, ZIP_SIG_CENTRAL);
        write_u16(&mut central, 20); // version made by
        write_u16(&mut central, 20); // version needed
        write_u16(&mut central, 0); // flags
        write_u16(&mut central, 0); // method
        write_u16(&mut central, dos_time);
        write_u16(&mut central, dos_date);
        write_u32(&mut central, crc);
        write_u32(&mut central, size);
        write_u32(&mut central, size);
        write_u16(&mut central, name_b.len() as u16);
        write_u16(&mut central, 0); // extra len
        write_u16(&mut central, 0); // comment len
        write_u16(&mut central, 0); // disk number
        write_u16(&mut central, 0); // internal attrs
        write_u32(&mut central, 0); // external attrs
        write_u32(&mut central, offset);
        central.write_all(name_b)?;

        offset += header_len + size;
    }

    let central_offset = body.len() as u32;
    body.append(&mut central);

    // End of central directory record.
    write_u32(&mut body, ZIP_SIG_EOCD);
    write_u16(&mut body, 0); // disk number
    write_u16(&mut body, 0); // disk with central dir
    write_u16(&mut body, count);
    write_u16(&mut body, count);
    write_u32(&mut body, central.len() as u32);
    write_u32(&mut body, central_offset);
    write_u16(&mut body, 0); // comment length

    Ok(body)
}

fn write_u16(out: &mut Vec<u8>, v: u16) {
    out.write_all(&v.to_le_bytes()).unwrap();
}

fn write_u32(out: &mut Vec<u8>, v: u32) {
    out.write_all(&v.to_le_bytes()).unwrap();
}
