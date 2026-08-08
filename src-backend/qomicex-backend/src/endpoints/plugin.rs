//! Plugin endpoints (source: Endpoints/PluginEndpoints.cs).
//!
//! All 25 routes live under `/api/plugins`:
//!   list/get/rescan/install/delete/upload/state, static files, settings,
//!   cache, cors proxy (SSE-capable), WASM gateway bridge, file read/write/
//!   authorize/delete (FS_AUTHORIZATION_REQUIRED flow), download management
//!   (tasks go to the shared DownloadManager so they surface in the download
//!   center), and shell execution (win: powershell, other: /bin/sh).
//!
//! Permission gating is NOT done here: like the C# original, the backend only
//! validates input; the frontend bridge enforces manifest permissions.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::multipart::Multipart;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use qomicex_downloader::{DownloadEvent, DownloadManager, DownloadTask, TaskId, TaskState};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::error::{ApiError, ApiResult};
use crate::services::plugin::{install_from_package, FileAuthService, PluginInfo};
use crate::settings;
use crate::state::SharedState;

// =====================================================================
// DTOs
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRequest {
    source_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RescanResponse {
    scanned: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPluginStateRequest {
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorsProxyRequest {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    headers: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<i64>,
    #[serde(default)]
    stream: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CorsProxyResponse {
    status: u16,
    headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileRequest {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    length: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileWriteRequest {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_base64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileResponse {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_base64: Option<String>,
    is_binary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileAuthorizeRequest {
    path: String,
    allow: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginAuthorizeResponse {
    path: String,
    allowed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginShellRequest {
    command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginShellResponse {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDownloadStartRequest {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    extract: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginDownloadStartResponse {
    task_id: String,
    status: String,
    target_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    status: String,
}

/// SessionSnapshot-shaped progress payload for plugin downloads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSnapshotJson {
    session_id: String,
    #[serde(rename = "type")]
    type_: String,
    status: String,
    stage: String,
    progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_file: Option<String>,
    total_files: i32,
    completed_files: i32,
    failed_files: i32,
    speed: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    is_paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_path: Option<String>,
    downloaded_bytes: i64,
    total_bytes: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmInvokeRequest {
    #[serde(default)]
    export: Option<String>,
}

// =====================================================================
// Plugin download sessions (shared DownloadManager-backed)
// =====================================================================

struct PluginSession {
    session_id: String,
    download_id: TaskId,
    url: String,
    target_path: String,
    status: String,
    stage: String,
    progress: f64,
    current_file: Option<String>,
    total_files: i32,
    completed_files: i32,
    failed_files: i32,
    speed: f64,
    error: Option<String>,
    is_paused: bool,
    downloaded_bytes: i64,
    total_bytes: i64,
}

fn sessions() -> &'static Mutex<HashMap<String, PluginSession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, PluginSession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn update_session(session_id: &str, f: impl FnOnce(&mut PluginSession)) {
    if let Ok(mut g) = sessions().lock() {
        if let Some(s) = g.get_mut(session_id) {
            f(s);
        }
    }
}

fn session_json(s: &PluginSession) -> SessionSnapshotJson {
    SessionSnapshotJson {
        session_id: s.session_id.clone(),
        type_: "resource".to_string(),
        status: s.status.clone(),
        stage: s.stage.clone(),
        progress: s.progress,
        current_file: s.current_file.clone(),
        total_files: s.total_files,
        completed_files: s.completed_files,
        failed_files: s.failed_files,
        speed: s.speed,
        error: s.error.clone(),
        is_paused: s.is_paused,
        instance_id: None,
        url: Some(s.url.clone()),
        target_path: Some(s.target_path.clone()),
        downloaded_bytes: s.downloaded_bytes,
        total_bytes: s.total_bytes,
    }
}

/// Plugin download sessions as JSON values for the download-center SSE stream.
pub(crate) fn download_sessions_json() -> Vec<serde_json::Value> {
    let guard = match sessions().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    guard
        .values()
        .map(|s| serde_json::to_value(session_json(s)).unwrap_or(serde_json::Value::Null))
        .collect()
}

/// Look up a plugin download session by its string task id (used as a fallback
/// by the resource-download progress endpoint for plugin-started downloads).
pub(crate) fn session_progress_json(task_id: &str) -> Option<serde_json::Value> {
    let guard = match sessions().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let s = guard.get(task_id)?;
    let progress = if s.total_bytes > 0 {
        s.downloaded_bytes as f64 / s.total_bytes as f64 * 100.0
    } else if s.status == "completed" {
        100.0
    } else {
        0.0
    };
    Some(serde_json::json!({
        "progress": progress,
        "downloadedBytes": s.downloaded_bytes,
        "totalBytes": s.total_bytes,
        "status": s.status,
        "error": s.error,
        "fileName": s.current_file,
    }))
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/plugins", get(list_plugins))
        .route("/plugins/", get(list_plugins))
        .route("/plugins/{id}", get(get_plugin).delete(delete_plugin))
        .route("/plugins/rescan", post(rescan))
        .route("/plugins/install", post(install))
        .route("/plugins/upload", post(upload))
        .route("/plugins/{id}/state", put(set_state))
        .route("/plugins/{id}/files/{*path}", get(plugin_file))
        .route("/plugins/settings/{id}", get(get_settings).post(set_settings))
        .route("/plugins/cache/{id}", get(get_cache).post(set_cache))
        .route("/plugins/proxy", post(proxy))
        .route("/plugins/wasm", get(list_wasm))
        .route("/plugins/wasm/{id}", get(wasm_info))
        .route("/plugins/wasm/{id}/invoke", post(wasm_invoke))
        .route("/plugins/files/{id}/read", post(file_read))
        .route("/plugins/files/{id}/write", post(file_write))
        .route("/plugins/files/{id}/authorize", post(file_authorize))
        .route("/plugins/files/{id}/delete", post(file_delete))
        .route("/plugins/download/start", post(download_start))
        .route("/plugins/download/list", get(download_list))
        .route("/plugins/download/{taskId}/progress", get(download_progress))
        .route("/plugins/download/{taskId}/cancel", post(download_cancel))
        .route("/plugins/shell/{id}", post(shell))
}

// =====================================================================
// Plugin store / package
// =====================================================================

/// GET /api/plugins/  (also /api/plugins)
async fn list_plugins(State(state): State<SharedState>) -> Json<Vec<PluginInfo>> {
    Json(state.plugin_store.list_plugins())
}

/// GET /api/plugins/{id}
async fn get_plugin(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match state.plugin_store.get_plugin(&id) {
        Some(p) => Json(p).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// POST /api/plugins/rescan
async fn rescan(State(state): State<SharedState>) -> Json<RescanResponse> {
    state.plugin_store.invalidate_cache();
    Json(RescanResponse {
        scanned: state.plugin_store.list_plugins().len(),
    })
}

/// POST /api/plugins/install — install from a local directory (dev path).
async fn install(
    State(state): State<SharedState>,
    Json(req): Json<InstallRequest>,
) -> ApiResult<Response> {
    let plugin = state
        .plugin_store
        .install_from_dir(std::path::Path::new(&req.source_dir))?
        .ok_or_else(|| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "Invalid plugin package"))?;
    Ok(Json(plugin).into_response())
}

/// DELETE /api/plugins/{id}
async fn delete_plugin(State(state): State<SharedState>, AxumPath(id): AxumPath<String>) -> Response {
    state.plugin_store.uninstall(&id);
    StatusCode::NO_CONTENT.into_response()
}

/// POST /api/plugins/upload — multipart form, field name `plugin`.
async fn upload(
    State(state): State<SharedState>,
    mut multipart: Multipart,
) -> ApiResult<Json<PluginInfo>> {
    let mut plugin_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad_request("INVALID_MULTIPART", "Expected multipart form"))?
    {
        if field.name() == Some("plugin") {
            let bytes = field
                .bytes()
                .await
                .map_err(|_| ApiError::bad_request("INVALID_MULTIPART", "Expected multipart form"))?;
            plugin_bytes = Some(bytes.to_vec());
            break;
        }
    }
    let bytes = plugin_bytes.ok_or_else(|| {
        ApiError::bad_request("NO_PLUGIN_FILE", "No plugin file uploaded")
    })?;

    let plugin = install_from_package(&bytes)?
        .ok_or_else(|| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "Invalid plugin package"))?;
    state.plugin_store.invalidate_cache();
    Ok(Json(plugin))
}

/// PUT /api/plugins/{id}/state
async fn set_state(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<SetPluginStateRequest>,
) -> ApiResult<Response> {
    let mut plugin = state
        .plugin_store
        .get_plugin(&id)
        .ok_or_else(|| ApiError::not_found("PLUGIN_NOT_FOUND", "Plugin not found"))?;
    state.plugin_store.set_state(&id, &req.state);
    plugin.state = req.state;
    Ok(Json(plugin).into_response())
}

/// GET /api/plugins/{id}/files/{*path} — static plugin assets (no-cache).
async fn plugin_file(
    AxumPath((id, path)): AxumPath<(String, String)>,
) -> ApiResult<Response> {
    let plugins_root = settings::plugins_dir();
    let base = plugins_root.join(&id);
    if !base.starts_with(&plugins_root) {
        return Err(ApiError::not_found("PLUGIN_FILE_NOT_FOUND", "File not found"));
    }
    let file_path = resolve_plugin_asset(&base, &path);
    let Some(file_path) = file_path else {
        return Err(ApiError::not_found("PLUGIN_FILE_NOT_FOUND", "File not found"));
    };
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|_| ApiError::not_found("PLUGIN_FILE_NOT_FOUND", "File not found"))?;
    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let content_type = content_type_for(&ext);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(bytes))
        .unwrap())
}

/// Resolve a plugin asset under `base`, refusing any traversal outside it.
fn resolve_plugin_asset(base: &std::path::Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let rel_path = PathBuf::from(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let joined = base.join(rel_path);
    if !joined.starts_with(base) {
        return None;
    }
    if !joined.is_file() {
        return None;
    }
    Some(joined)
}

fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

// =====================================================================
// Settings / cache
// =====================================================================

async fn get_settings(AxumPath(id): AxumPath<String>) -> Response {
    let settings_file = settings::plugins_dir().join(&id).join("settings.json");
    let body = match std::fs::read_to_string(&settings_file) {
        Ok(json) => json,
        Err(_) => "{}".to_string(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

async fn set_settings(
    AxumPath(id): AxumPath<String>,
    Json(body): Json<serde_json::Value>,
) -> ApiResult<StatusCode> {
    let obj = body
        .as_object()
        .filter(|o| o.contains_key("key"))
        .ok_or_else(|| ApiError::bad_request("INVALID_SETTINGS_BODY", "Expected { key, value }"))?;
    let key = obj
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let value = obj.get("value").cloned().unwrap_or(serde_json::Value::Null);

    let dir = settings::plugins_dir().join(&id);
    let _ = std::fs::create_dir_all(&dir);
    let settings_file = dir.join("settings.json");

    let mut settings: serde_json::Value = read_json_file(&settings_file).unwrap_or_else(|| serde_json::json!({}));
    let map = settings
        .as_object_mut()
        .ok_or_else(|| ApiError::bad_request("INVALID_SETTINGS_BODY", "settings.json is not an object"))?;
    map.insert(key, value);
    write_json_file(&settings_file, &settings)?;
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
struct CacheKeyQuery {
    key: Option<String>,
}

async fn set_cache(
    AxumPath(id): AxumPath<String>,
    Json(body): Json<serde_json::Value>,
) -> ApiResult<StatusCode> {
    let obj = body
        .as_object()
        .filter(|o| o.contains_key("key") && o.contains_key("value"))
        .ok_or_else(|| {
            ApiError::bad_request("INVALID_CACHE_BODY", "Expected { key, value, ttlSeconds? }")
        })?;
    let key = obj
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if key.trim().is_empty() {
        return Err(ApiError::bad_request("CACHE_KEY_EMPTY", "key 不能为空"));
    }
    if key.len() > 512 {
        return Err(ApiError::bad_request("CACHE_KEY_TOO_LONG", "key 过长"));
    }
    let value = obj.get("value").cloned().unwrap_or(serde_json::Value::Null);
    let ttl_seconds: Option<i64> = obj
        .get("ttlSeconds")
        .and_then(|v| v.as_i64())
        .filter(|t| *t > 0);

    let dir = settings::plugins_dir().join(&id);
    let _ = std::fs::create_dir_all(&dir);
    let cache_file = dir.join("cache.json");

    let mut cache: serde_json::Value = read_json_file(&cache_file).unwrap_or_else(|| serde_json::json!({}));
    let map = cache
        .as_object_mut()
        .ok_or_else(|| ApiError::bad_request("INVALID_CACHE_BODY", "cache.json is not an object"))?;
    let expires = ttl_seconds.map(|t| chrono::Utc::now().timestamp() + t);
    map.insert(
        key,
        serde_json::json!({
            "v": value,
            "e": expires,
        }),
    );
    write_json_file(&cache_file, &cache)?;
    Ok(StatusCode::OK)
}

async fn get_cache(
    AxumPath(id): AxumPath<String>,
    Query(q): Query<CacheKeyQuery>,
) -> ApiResult<Response> {
    let key = q.key.unwrap_or_default();
    if key.trim().is_empty() {
        return Err(ApiError::bad_request("CACHE_KEY_REQUIRED", "key 不能为空"));
    }
    let cache_file = settings::plugins_dir().join(&id).join("cache.json");
    let cache: serde_json::Value = read_json_file(&cache_file).unwrap_or_else(|| serde_json::json!({}));

    let mut response = serde_json::json!({ "value": null });
    if let Some(entry) = cache.get(&key) {
        let expires_at = entry.get("e").and_then(|e| e.as_i64());
        let expired = matches!(expires_at, Some(ts) if chrono::Utc::now().timestamp() > ts);
        if !expired {
            if let Some(v) = entry.get("v") {
                response = serde_json::json!({ "value": v });
            }
        } else if let Some(obj) = cache.as_object() {
            let mut obj = obj.clone();
            obj.remove(&key);
            let _ = write_json_file(&cache_file, &serde_json::Value::Object(obj));
        }
    }
    Ok(Json(response).into_response())
}

fn read_json_file(path: &std::path::Path) -> Option<serde_json::Value> {
    if !path.is_file() {
        return None;
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn write_json_file(path: &std::path::Path, value: &serde_json::Value) -> Result<(), ApiError> {
    let json = serde_json::to_string(value).map_err(|e| ApiError::internal(e.to_string()))?;
    std::fs::write(path, json).map_err(ApiError::from)
}

// =====================================================================
// CORS proxy
// =====================================================================

async fn proxy(State(state): State<SharedState>, Json(req): Json<CorsProxyRequest>) -> ApiResult<Response> {
    if req.url.trim().is_empty() {
        return Err(ApiError::bad_request("PROXY_URL_REQUIRED", "url 不能为空"));
    }
    let parsed = url::Url::parse(&req.url)
        .map_err(|_| ApiError::bad_request("PROXY_INVALID_URL", "无效的代理 URL"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::bad_request("PROXY_SCHEME_NOT_ALLOWED", "仅支持 http/https 协议"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::bad_request("PROXY_INVALID_URL", "无效的代理 URL"))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(80);
    validate_target(&host, port).await?;

    let method_str = req
        .method
        .clone()
        .unwrap_or_else(|| "GET".to_string());
    let method = reqwest::Method::from_bytes(method_str.to_uppercase().as_bytes())
        .unwrap_or(reqwest::Method::GET);

    let mut request = state.proxy_client.request(method, &req.url);
    let mut content_type = "application/json".to_string();
    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            if k.is_empty() {
                continue;
            }
            if k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("content-length") {
                continue;
            }
            if k.eq_ignore_ascii_case("content-type") {
                content_type = v.clone();
                continue;
            }
            if let (Ok(kn), Ok(kv)) = (
                k.parse::<reqwest::header::HeaderName>(),
                v.parse::<reqwest::header::HeaderValue>(),
            ) {
                request = request.header(kn, kv);
            }
        }
    }
    let body = req.body.clone().unwrap_or_default();
    let is_get_or_head = matches!(method_str.to_uppercase().as_str(), "GET" | "HEAD");
    if !body.is_empty() && !is_get_or_head {
        request = request
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body);
    }

    let timeout_ms = req.timeout_ms.unwrap_or(15000).clamp(1000, 60000);
    request = request.timeout(Duration::from_millis(timeout_ms as u64));

    let resp = request
        .send()
        .await
        .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "PROXY_UPSTREAM_FAILED", "上游响应中断"))?;

    if req.stream {
        let stream = resp.bytes_stream();
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(Body::from_stream(stream))
            .unwrap());
    }

    let status = resp.status().as_u16();
    let mut out_headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(v) = v.to_str() {
            out_headers
                .entry(k.as_str().to_string())
                .and_modify(|existing: &mut String| {
                    existing.push_str(", ");
                    existing.push_str(v);
                })
                .or_insert_with(|| v.to_string());
        }
    }
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body_bytes = resp
        .bytes()
        .await
        .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "PROXY_UPSTREAM_FAILED", "上游响应中断"))?;

    let is_text = is_text_response(&content_type, &body_bytes);
    let body_out = if is_text {
        Some(if body_bytes.is_empty() {
            String::new()
        } else {
            String::from_utf8_lossy(&body_bytes).into_owned()
        })
    } else {
        None
    };
    let body_base64 = if is_text { None } else { Some(b64_encode(&body_bytes)) };

    Ok(Json(CorsProxyResponse {
        status,
        headers: out_headers,
        body: body_out,
        body_base64,
    })
    .into_response())
}

async fn validate_target(host: &str, port: u16) -> Result<(), ApiError> {
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| ApiError::bad_request("PROXY_DNS_FAILED", "无法解析目标主机"))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if is_private_address(addr.ip()) {
            return Err(ApiError::bad_request(
                "PROXY_PRIVATE_ADDRESS",
                "禁止访问内网或保留地址",
            ));
        }
    }
    if !any {
        return Err(ApiError::bad_request("PROXY_DNS_FAILED", "无法解析目标主机"));
    }
    Ok(())
}

fn is_private_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                return true;
            }
            let b = v4.octets();
            if b[0] == 0 {
                return true; // 0.0.0.0/8
            }
            if b[0] == 10 {
                return true; // 10.0.0.0/8
            }
            if b[0] == 100 && b[1] >= 64 && b[1] <= 127 {
                return true; // 100.64.0.0/10 CGNAT
            }
            if b[0] == 127 {
                return true; // loopback
            }
            if b[0] == 169 && b[1] == 254 {
                return true; // 169.254.0.0/16
            }
            if b[0] == 172 && b[1] >= 16 && b[1] <= 31 {
                return true; // 172.16.0.0/12
            }
            if b[0] == 192 && b[1] == 168 {
                return true; // 192.168.0.0/16
            }
            if b[0] == 192 && b[1] == 0 {
                return true; // 192.0.0.0/24 + 192.0.2.0/24
            }
            // NOTE: 198.18.0.0/15 (RFC 2544 CEN benchmark) is intentionally NOT
            // blocked — Clash/Surge fake-ip pools resolve every public hostname
            // into 198.18.x.x, so blocking it breaks proxyFetch for all users
            // behind a proxy tool.
            if b[0] == 198 && b[1] == 51 {
                return true; // 198.51.100.0/24
            }
            if b[0] == 203 && b[1] == 0 && b[2] == 113 {
                return true; // 203.0.113.0/24
            }
            if b[0] >= 224 {
                return true; // multicast + reserved
            }
            false
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_address(IpAddr::V4(v4));
            }
            if v6.is_loopback() || v6.is_multicast() {
                return true;
            }
            if v6.segments()[0] & 0xfe00 == 0xfc00 {
                return true; // fc00::/7 unique local
            }
            false
        }
    }
}

fn is_text_response(content_type: &str, body: &[u8]) -> bool {
    let lower = content_type.to_lowercase();
    lower.starts_with("text/")
        || lower.contains("json")
        || lower.contains("xml")
        || lower.contains("javascript")
        || lower.contains("x-www-form-urlencoded")
        || lower.contains("svg")
        || body.is_empty()
}

// =====================================================================
// WASM gateway bridge
// =====================================================================

async fn list_wasm(State(state): State<SharedState>) -> Json<serde_json::Value> {
    // The frontend expects `{ plugins: [...] }` (the C# list-wasm contract is
    // buggy there); the Tauri gateway itself returns that shape too.
    Json(serde_json::json!({ "plugins": state.plugin_gateway.loaded_plugins().await }))
}

async fn wasm_info(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Response> {
    match state.plugin_gateway.plugin_info(&id).await {
        Some(info) => Ok(Json(info).into_response()),
        None => Err(ApiError::not_found("WASM_PLUGIN_NOT_FOUND", "WASM plugin not found")),
    }
}

async fn wasm_invoke(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<WasmInvokeRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let export = req
        .export
        .clone()
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| "on_load".to_string());
    match state.plugin_gateway.invoke(&id, &export).await {
        Some(result) => Ok(Json(result)),
        None => Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "WASM_INVOKE_FAILED",
            "WASM 插件调用失败",
        )),
    }
}

// =====================================================================
// File read/write/authorize/delete
// =====================================================================

async fn file_read(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginFileRequest>,
) -> ApiResult<Json<PluginFileResponse>> {
    let normalized = FileAuthService::normalize_path(&req.path)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效路径"))?;
    if !normalized.is_file() {
        return Err(ApiError::not_found("FS_FILE_NOT_FOUND", "文件不存在"));
    }
    if state.plugin_auth.find_grant(&plugin_id, &req.path).is_none() {
        return Err(ApiError::forbidden("FS_AUTHORIZATION_REQUIRED", "未授权访问该路径"));
    }

    let bytes = read_file_segment(&normalized, req.start, req.length)?;
    let is_byte = req
        .mode
        .as_deref()
        .map(|m| m.eq_ignore_ascii_case("byte"))
        .unwrap_or(false);
    let path_str = normalized.to_string_lossy().into_owned();
    if is_byte {
        Ok(Json(PluginFileResponse {
            path: path_str,
            mode: Some("byte".to_string()),
            content: None,
            content_base64: Some(b64_encode(&bytes)),
            is_binary: true,
        }))
    } else {
        Ok(Json(PluginFileResponse {
            path: path_str,
            mode: Some("text".to_string()),
            content: Some(String::from_utf8_lossy(&bytes).into_owned()),
            content_base64: None,
            is_binary: false,
        }))
    }
}

async fn file_write(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginFileWriteRequest>,
) -> ApiResult<Json<PluginFileResponse>> {
    let normalized = FileAuthService::normalize_path(&req.path)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效路径"))?;
    if state.plugin_auth.find_grant(&plugin_id, &req.path).is_none() {
        return Err(ApiError::forbidden("FS_AUTHORIZATION_REQUIRED", "未授权访问该路径"));
    }
    if let Some(parent) = normalized.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = if let Some(b64) = req.content_base64.as_deref().filter(|s| !s.is_empty()) {
        b64_decode(b64)
            .ok_or_else(|| ApiError::bad_request("FS_INVALID_BASE64", "无效的 base64 内容"))?
    } else {
        req.content.as_deref().unwrap_or("").as_bytes().to_vec()
    };
    std::fs::write(&normalized, bytes)?;
    Ok(Json(PluginFileResponse {
        path: normalized.to_string_lossy().into_owned(),
        mode: None,
        content: None,
        content_base64: None,
        is_binary: false,
    }))
}

async fn file_authorize(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginFileAuthorizeRequest>,
) -> ApiResult<Json<PluginAuthorizeResponse>> {
    let normalized = FileAuthService::normalize_path(&req.path)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效路径"))?;
    if req.allow {
        state.plugin_auth.grant(&plugin_id, &req.path);
    } else {
        state.plugin_auth.revoke(&plugin_id, &req.path);
    }
    Ok(Json(PluginAuthorizeResponse {
        path: normalized.to_string_lossy().into_owned(),
        allowed: req.allow,
    }))
}

async fn file_delete(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginFileRequest>,
) -> ApiResult<Json<PluginFileResponse>> {
    let normalized = FileAuthService::normalize_path(&req.path)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效路径"))?;
    if !normalized.is_file() {
        return Err(ApiError::not_found("FS_FILE_NOT_FOUND", "文件不存在"));
    }
    if state.plugin_auth.find_grant(&plugin_id, &req.path).is_none() {
        return Err(ApiError::forbidden("FS_AUTHORIZATION_REQUIRED", "未授权访问该路径"));
    }
    std::fs::remove_file(&normalized)?;
    Ok(Json(PluginFileResponse {
        path: normalized.to_string_lossy().into_owned(),
        mode: None,
        content: None,
        content_base64: None,
        is_binary: false,
    }))
}

fn read_file_segment(path: &std::path::Path, start: Option<i64>, length: Option<i64>) -> Result<Vec<u8>, ApiError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let file_len = f.metadata()?.len() as i64;
    let start = start.unwrap_or(0).max(0).min(file_len);
    f.seek(SeekFrom::Start(start as u64))?;
    let remaining = file_len - start;
    let len = match length {
        Some(l) if l >= 0 => l.min(remaining),
        _ => remaining,
    };
    let mut buf = vec![0u8; len as usize];
    let mut read_total = 0;
    while read_total < len as usize {
        let n = f.read(&mut buf[read_total..])?;
        if n == 0 {
            break;
        }
        read_total += n;
    }
    buf.truncate(read_total);
    Ok(buf)
}

// =====================================================================
// Plugin downloads (shared DownloadManager; tasks surface in download center)
// =====================================================================

async fn download_start(
    State(state): State<SharedState>,
    Json(req): Json<PluginDownloadStartRequest>,
) -> ApiResult<Json<PluginDownloadStartResponse>> {
    if req.url.trim().is_empty() {
        return Err(ApiError::bad_request("DOWNLOAD_URL_REQUIRED", "url 不能为空"));
    }

    let (target_dir, file_name) = resolve_download_target(&state, &req)?;
    std::fs::create_dir_all(&target_dir)?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let full_path = target_dir.join(&file_name);
    let target_path = full_path.to_string_lossy().into_owned();

    let mut task = DownloadTask::new(req.url.clone(), full_path.clone());
    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            if !k.is_empty() {
                task = task.with_header(k.clone(), v.clone());
            }
        }
    }

    // Subscribe before adding so completion cannot race past the worker.
    let manager = state.download_manager.clone();
    let download_id = manager.add(task);

    {
        let mut g = match sessions().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.insert(
            session_id.clone(),
            PluginSession {
                session_id: session_id.clone(),
                download_id,
                url: req.url.clone(),
                target_path: target_path.clone(),
                status: "queued".to_string(),
                stage: "queued".to_string(),
                progress: 0.0,
                current_file: Some(file_name.clone()),
                total_files: 1,
                completed_files: 0,
                failed_files: 0,
                speed: 0.0,
                error: None,
                is_paused: false,
                downloaded_bytes: 0,
                total_bytes: 0,
            },
        );
    }

    tokio::spawn(download_worker(
        manager,
        session_id.clone(),
        download_id,
        target_dir,
        file_name.clone(),
        req.extract,
    ));

    Ok(Json(PluginDownloadStartResponse {
        task_id: session_id,
        status: "queued".to_string(),
        target_path,
    }))
}

async fn download_progress(
    AxumPath(task_id): AxumPath<String>,
) -> Json<serde_json::Value> {
    let guard = match sessions().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    match guard.get(&task_id) {
        Some(s) => serde_json::to_value(session_json(s))
            .unwrap_or_else(|_| serde_json::json!({ "status": "not_found" })),
        None => serde_json::json!({ "status": "not_found" }),
    }
    .into()
}

async fn download_list() -> Json<Vec<serde_json::Value>> {
    Json(download_sessions_json())
}

async fn download_cancel(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> Json<StatusResponse> {
    let download_id = {
        let guard = match sessions().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.get(&task_id).map(|s| s.download_id)
    };
    if let Some(download_id) = download_id {
        let _ = state.download_manager.cancel(download_id).await;
    }
    update_session(&task_id, |s| {
        s.status = "cancelled".to_string();
        s.stage = "cancelled".to_string();
    });
    Json(StatusResponse {
        status: "cancelled".to_string(),
    })
}

async fn download_worker(
    manager: Arc<DownloadManager>,
    session_id: String,
    download_id: TaskId,
    target_dir: PathBuf,
    file_name: String,
    extract: bool,
) {
    let mut rx = manager.subscribe();
    loop {
        match rx.recv().await {
            Ok(DownloadEvent::Progress {
                id,
                downloaded,
                total,
                speed_bps,
                ..
            }) if id == download_id => {
                update_session(&session_id, |s| {
                    s.status = "downloading".to_string();
                    s.stage = "downloading".to_string();
                    s.downloaded_bytes = downloaded as i64;
                    s.total_bytes = total as i64;
                    s.speed = speed_bps as f64;
                    s.progress = if total > 0 {
                        downloaded as f64 / total as f64 * 100.0
                    } else {
                        0.0
                    };
                });
            }
            Ok(DownloadEvent::StateChanged { id, state, detail }) if id == download_id => {
                match state {
                    TaskState::Completed => {
                        let full = target_dir.join(&file_name);
                        if extract && file_name.to_lowercase().ends_with(".zip") {
                            let _ = extract_zip_into(&full, &target_dir).await;
                            let _ = tokio::fs::remove_file(&full).await;
                        }
                        let _ = tokio::fs::remove_file(format!("{}.qdtmp", full.display())).await;
                        update_session(&session_id, |s| {
                            s.status = "completed".to_string();
                            s.stage = "completed".to_string();
                            s.progress = 100.0;
                        });
                        break;
                    }
                    TaskState::Failed => {
                        update_session(&session_id, |s| {
                            s.status = "failed".to_string();
                            s.stage = "failed".to_string();
                            s.error = detail.clone();
                        });
                        break;
                    }
                    TaskState::Cancelled => {
                        update_session(&session_id, |s| {
                            s.status = "cancelled".to_string();
                            s.stage = "cancelled".to_string();
                        });
                        break;
                    }
                    TaskState::Paused => {
                        update_session(&session_id, |s| {
                            s.status = "paused".to_string();
                            s.stage = "paused".to_string();
                            s.is_paused = true;
                        });
                    }
                    TaskState::Downloading => {
                        update_session(&session_id, |s| {
                            s.status = "downloading".to_string();
                            s.stage = "downloading".to_string();
                        });
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn extract_zip_into(zip_path: &std::path::Path, out_dir: &std::path::Path) -> std::io::Result<()> {
    let zip_path = zip_path.to_path_buf();
    let out_dir = out_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&zip_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            if entry.is_dir() {
                continue;
            }
            let rel: PathBuf = PathBuf::from(entry.name());
            if rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                continue;
            }
            let out_path = out_dir.join(&rel);
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())))
}

fn resolve_download_target(
    state: &SharedState,
    req: &PluginDownloadStartRequest,
) -> Result<(PathBuf, String), ApiError> {
    if let Some(tp) = req.target_path.as_deref().filter(|s| !s.trim().is_empty()) {
        let full = PathBuf::from(tp.trim());
        let target_dir = full
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let name = req
            .file_name
            .clone()
            .or_else(|| {
                full.file_name().map(|s| s.to_string_lossy().into_owned())
            })
            .filter(|n| !n.trim().is_empty())
            .ok_or_else(|| {
                ApiError::bad_request("DOWNLOAD_FILE_NAME_REQUIRED", "无法确定文件名，请提供 fileName")
            })?;
        return Ok((target_dir, name));
    }

    if let Some(instance_id) = req.instance_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let inst = state.instance.get_by_id(instance_id).ok_or_else(|| {
            ApiError::not_found("INSTANCE_NOT_FOUND", "实例不存在")
        })?;
        let isolation = inst
            .version_isolation
            .unwrap_or_else(settings::get_global_version_isolation);
        let game_dir = if isolation {
            PathBuf::from(&inst.game_dir)
        } else {
            PathBuf::from(inst.resolved_game_dir.as_deref().unwrap_or(&inst.game_dir))
        };
        let cat = req
            .category
            .as_deref()
            .map(|c| c.to_lowercase())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "mods".to_string());
        let target_dir = if isolation {
            game_dir.join("versions").join(&inst.name).join(cat)
        } else {
            game_dir.join(cat)
        };
        let name = req
            .file_name
            .clone()
            .or_else(|| basename_of_url(&req.url))
            .filter(|n| !n.trim().is_empty())
            .ok_or_else(|| {
                ApiError::bad_request("DOWNLOAD_FILE_NAME_REQUIRED", "无法确定文件名，请提供 fileName")
            })?;
        return Ok((target_dir, name));
    }

    Err(ApiError::bad_request(
        "DOWNLOAD_TARGET_REQUIRED",
        "必须提供 targetPath 或 instanceId",
    ))
}

/// Last path segment of a URL (C#: `new Uri(url).AbsolutePath` basename).
fn basename_of_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    parsed
        .path_segments()
        .and_then(|segments| segments.filter(|s| !s.is_empty()).last())
        .map(|s| s.to_string())
}

// =====================================================================
// Shell execution
// =====================================================================

async fn shell(
    AxumPath(_id): AxumPath<String>,
    Json(req): Json<PluginShellRequest>,
) -> ApiResult<Json<PluginShellResponse>> {
    if req.command.trim().is_empty() {
        return Err(ApiError::bad_request("SHELL_COMMAND_REQUIRED", "command 不能为空"));
    }
    let timeout_ms = req.timeout_ms.unwrap_or(15000).clamp(1000, 120000);

    let mut cmd = tokio::process::Command::new(if cfg!(windows) {
        "powershell"
    } else {
        "/bin/sh"
    });
    if cfg!(windows) {
        cmd.arg("-NoProfile").arg("-Command").arg(&req.command);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    } else {
        cmd.arg("-c").arg(&req.command);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "SHELL_START_FAILED", format!("无法启动 shell: {e}")))?;
    let pid = child.id();

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdout_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut reader = tokio::io::BufReader::new(stdout);
        reader.read_to_string(&mut buf).await.unwrap_or_default();
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut reader = tokio::io::BufReader::new(stderr);
        reader.read_to_string(&mut buf).await.unwrap_or_default();
        buf
    });

    let timeout = Duration::from_millis(timeout_ms as u64);
    let result = tokio::time::timeout(timeout, child.wait()).await;

    match result {
        Ok(Ok(status)) => {
            let stdout = stdout_task.await.unwrap_or_default();
            let stderr = stderr_task.await.unwrap_or_default();
            Ok(Json(PluginShellResponse {
                exit_code: status.code().unwrap_or(-1),
                stdout,
                stderr,
            }))
        }
        Ok(Err(e)) => Err(ApiError::internal(e.to_string())),
        Err(_elapsed) => {
            if let Some(pid) = pid {
                kill_pid_tree(pid);
            }
            Err(ApiError::bad_request(
                "SHELL_TIMEOUT",
                format!("命令执行超时（>{timeout_ms}ms）"),
            ))
        }
    }
}

fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn();
    }
}

// =====================================================================
// Helpers
// =====================================================================

fn b64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn is_private(s: &str) -> bool {
        let ip: IpAddr = s.parse().unwrap();
        is_private_address(ip)
    }

    #[test]
    fn private_ranges_are_blocked() {
        assert!(is_private("127.0.0.1"));
        assert!(is_private("10.0.0.1"));
        assert!(is_private("172.16.0.1"));
        assert!(is_private("172.31.255.255"));
        assert!(is_private("192.168.1.1"));
        assert!(is_private("169.254.169.254"));
        assert!(is_private("0.0.0.1"));
        assert!(is_private("100.64.0.1"));
        assert!(is_private("::1"));
        assert!(is_private("fc00::1"));
    }

    #[test]
    fn proxy_fake_ip_is_allowed() {
        // Clash/Surge fake-ip pools resolve public hostnames into 198.18.0.0/15.
        assert!(!is_private("198.18.0.87"));
        assert!(!is_private("198.19.255.255"));
    }

    #[test]
    fn public_addresses_are_allowed() {
        assert!(!is_private("1.1.1.1"));
        assert!(!is_private("8.8.8.8"));
        assert!(!is_private("114.114.114.114"));
        assert!(!is_private("2606:4700:4700::1111"));
    }
}

