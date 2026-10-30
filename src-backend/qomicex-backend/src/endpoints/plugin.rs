// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Plugin endpoints.
//!
//! All 25 routes live under `/api/plugins`:
//!   list/get/rescan/install/delete/upload/state, static files, settings,
//!   cache, cors proxy (SSE-capable), WASM gateway bridge, file read/write/
//!   authorize/delete (FS_AUTHORIZATION_REQUIRED flow), download management
//!   (tasks go to the shared DownloadManager so they surface in the download
//!   center), and shell execution (win: pwsh 7 when installed, else the bundled
//!   Windows PowerShell 5.1; other: /bin/sh).
//!
//! Permission gating is NOT done here: like the C# original, the backend only
//! validates input; the frontend bridge enforces manifest permissions.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::multipart::Multipart;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures::StreamExt;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginLogRequest {
    plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    level: Option<String>,
    message: String,
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

// ---------------------------------------------------------------------
// 受管进程（issue #295：插件常驻进程管理）
// ---------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginProcessSpawnRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginProcessSpawnResponse {
    pid: u32,
    started_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginProcessStdinRequest {
    data: String,
    #[serde(default = "default_true")]
    append_newline: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PluginProcessLogsQuery {
    #[serde(default)]
    after: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginProcessLogsResponse {
    lines: Vec<crate::services::plugin_process::ProcLogLine>,
    next_seq: u64,
    oldest_seq: u64,
    alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginProcessKillResponse {
    message: String,
}

// ---------------------------------------------------------------------
// 文件解压 / 目录列举（issue #295：导入服务端压缩包需要的能力）
// ---------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileExtractRequest {
    archive_path: String,
    dest_path: String,
    /// 只解压该前置目录下的条目（如整合包的 `overrides/`）；省略则解整包。
    #[serde(default)]
    prefix: Option<String>,
    /// 与 `prefix` 搭配：解压时剥掉前缀，让 `overrides/mods/a.jar` 落到 `mods/a.jar`。
    #[serde(default)]
    strip_prefix: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileExtractResponse {
    dest_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileListRequest {
    path: String,
    #[serde(default)]
    recursive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_entries: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_ms: Option<u64>,
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
        .route("/plugins/install-url", post(install_url))
        .route("/plugins/upload", post(upload))
        .route("/plugins/log", post(plugin_log))
        .route("/plugins/{id}/state", put(set_state))
        .route("/plugins/{id}/rollback", post(rollback))
        .route("/plugins/{id}/files/{*path}", get(plugin_file))
        .route(
            "/plugins/settings/{id}",
            get(get_settings).post(set_settings),
        )
        .route("/plugins/cache/{id}", get(get_cache).post(set_cache))
        .route("/plugins/proxy", post(proxy))
        .route("/plugins/wasm", get(list_wasm))
        .route("/plugins/wasm/{id}", get(wasm_info))
        .route("/plugins/wasm/{id}/invoke", post(wasm_invoke))
        .route("/plugins/files/{id}/read", post(file_read))
        .route("/plugins/files/{id}/write", post(file_write))
        .route("/plugins/files/{id}/authorize", post(file_authorize))
        .route("/plugins/files/{id}/delete", post(file_delete))
        .route("/plugins/files/{id}/rename", post(file_rename))
        .route("/plugins/files/{id}/extract", post(file_extract))
        .route("/plugins/files/{id}/list", post(file_list))
        .route("/plugins/process/{id}/spawn", post(process_spawn))
        .route("/plugins/process/{id}/list", get(process_list))
        .route("/plugins/process/{id}/{pid}/stdin", post(process_stdin))
        .route("/plugins/process/{id}/{pid}/kill", post(process_kill))
        .route("/plugins/process/{id}/{pid}/alive", get(process_alive))
        .route("/plugins/process/{id}/{pid}/logs", get(process_logs))
        .route("/plugins/download/start", post(download_start))
        .route("/plugins/download/batch", post(download_batch_start))
        .route(
            "/plugins/download/batch/{batchId}",
            get(download_batch_status),
        )
        .route("/plugins/download/list", get(download_list))
        .route(
            "/plugins/download/{taskId}/progress",
            get(download_progress),
        )
        .route("/plugins/download/{taskId}/cancel", post(download_cancel))
        .route("/plugins/tasks/register", post(task_register))
        .route("/plugins/tasks/{taskId}/update", post(task_update))
        .route("/plugins/tasks/{taskId}/complete", post(task_complete))
        .route("/plugins/tasks/{taskId}", get(task_progress))
        .route("/plugins/cf/files", post(cf_files_lookup))
        .route("/plugins/archive/entry", post(archive_read_entry))
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
async fn get_plugin(State(state): State<SharedState>, AxumPath(id): AxumPath<String>) -> Response {
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
async fn delete_plugin(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    state.plugin_store.uninstall(&id);
    StatusCode::NO_CONTENT.into_response()
}

/// POST /api/plugins/upload — multipart form, field name `plugin`.
/// query `allowUnsigned=true` 时跳过强制签名校验（前端确认风险后重试；无签名放行，有签名仍须有效）。
async fn upload(
    State(state): State<SharedState>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> ApiResult<Json<PluginInfo>> {
    let mut plugin_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad_request("INVALID_MULTIPART", "Expected multipart form"))?
    {
        if field.name() == Some("plugin") {
            let bytes = field.bytes().await.map_err(|_| {
                ApiError::bad_request("INVALID_MULTIPART", "Expected multipart form")
            })?;
            plugin_bytes = Some(bytes.to_vec());
            break;
        }
    }
    let bytes = plugin_bytes
        .ok_or_else(|| ApiError::bad_request("NO_PLUGIN_FILE", "No plugin file uploaded"))?;

    let plugin = install_from_package(&bytes, true, query.allow_unsigned)?
        .ok_or_else(|| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "Invalid plugin package"))?;
    state.plugin_store.invalidate_cache();
    Ok(Json(plugin))
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(default)]
    allow_unsigned: bool,
}

/// 深链快捷安装的下载体积上限（64 MiB）。插件包是 zip，正常量级在个位数 MiB；
/// 设上限是为了让「外部 URL 触发的下载」不能靠超大响应打爆内存。
const INSTALL_URL_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 插件单次批量调用的条目上限。
///
/// 存在的理由不是业务限制，而是分配安全：`Vec::with_capacity(req.files.len())`
/// 等按请求长度预分配的地方，长度完全由插件（= 不受信输入）决定。没有上限时
/// 一个超大数组就能让后端先分配一大块内存再逐个校验。上限远高于真实用量
/// （整合包最多几千个文件）。
const MAX_PLUGIN_BATCH_ITEMS: usize = 20_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallUrlRequest {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallUrlQuery {
    #[serde(default)]
    allow_unsigned: bool,
}

/// POST /api/plugins/install-url — 从 URL 下载 `.qplugin` 并安装（issue #127 深链快捷安装）。
///
/// 与 `/plugins/upload` 的差别仅是「字节从哪来」；校验与安装走同一条
/// `install_from_package` 路径，签名策略也一致：默认 `require_signature = true`，
/// 只有显式 `allowUnsigned=true`（前端风险确认后）才放宽。
///
/// SSRF：复用 `/plugins/proxy` 的 `validate_target`（DNS 解析后逐 IP 拒内网/保留地址），
/// 不另起一套判断——否则两处规则迟早漂移，留下绕过面。
async fn install_url(
    State(state): State<SharedState>,
    Query(query): Query<InstallUrlQuery>,
    Json(req): Json<InstallUrlRequest>,
) -> ApiResult<Json<PluginInfo>> {
    let raw = req.url.trim();
    if raw.is_empty() {
        return Err(ApiError::bad_request(
            "INSTALL_URL_REQUIRED",
            "url 不能为空",
        ));
    }
    let parsed = url::Url::parse(raw)
        .map_err(|_| ApiError::bad_request("INSTALL_URL_INVALID", "无效的下载 URL"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::bad_request(
            "INSTALL_URL_SCHEME_NOT_ALLOWED",
            "仅支持 http/https 协议",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::bad_request("INSTALL_URL_INVALID", "无效的下载 URL"))?
        .to_string();
    validate_target(&host, parsed.port_or_known_default().unwrap_or(80)).await?;

    // 专用客户端禁用了重定向（见 AppState::plugin_download_client 注释）：3xx 不跟随，
    // 报成明确错误而不是把未校验的重定向目标当成下载失败。
    let resp = state
        .plugin_download_client
        .get(parsed.as_str())
        .send()
        .await
        .map_err(|e| ApiError::upstream(format!("插件包下载失败: {e}")))?;
    if resp.status().is_redirection() {
        return Err(ApiError::bad_request(
            "INSTALL_URL_REDIRECT_NOT_ALLOWED",
            "下载地址返回了重定向；出于安全考虑不跟随，请提供直链",
        ));
    }
    if !resp.status().is_success() {
        return Err(ApiError::upstream(format!(
            "插件包下载失败: HTTP {}",
            resp.status()
        )));
    }
    if let Some(len) = resp.content_length() {
        if len > INSTALL_URL_MAX_BYTES {
            return Err(ApiError::bad_request(
                "INSTALL_URL_TOO_LARGE",
                "插件包超过大小上限",
            ));
        }
    }

    // 逐块累加、边收边判：`resp.bytes()` 会先把整个响应体读进内存再检查，chunked
    // 编码（无 Content-Length）时超限判断来得太晚，外部深链可借此把进程内存打爆。
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::upstream(format!("插件包下载失败: {e}")))?;
        if bytes.len() as u64 + chunk.len() as u64 > INSTALL_URL_MAX_BYTES {
            return Err(ApiError::bad_request(
                "INSTALL_URL_TOO_LARGE",
                "插件包超过大小上限",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    let plugin = install_from_package(&bytes, true, query.allow_unsigned)?
        .ok_or_else(|| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "Invalid plugin package"))?;
    state.plugin_store.invalidate_cache();
    Ok(Json(plugin))
}

/// POST /api/plugins/log — 插件日志写入 trace 缓冲 + 落盘（debug SSE / 诊断导出可见）。
/// 权限由前端桥 enforce（plugin:log），后端仅做输入校验。
async fn plugin_log(Json(body): Json<PluginLogRequest>) -> ApiResult<StatusCode> {
    let plugin_id = body.plugin_id.trim();
    if plugin_id.is_empty() {
        return Err(ApiError::bad_request("BAD_REQUEST", "pluginId is required"));
    }
    let level = body.level.unwrap_or_else(|| "info".to_string());
    for line in body.message.lines() {
        crate::services::trace::trace_append(format!("[plugin:{plugin_id}:{level}] {line}"));
    }
    Ok(StatusCode::NO_CONTENT)
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

/// POST /api/plugins/{id}/rollback — 用最新 `.bak-*` 升级快照恢复插件目录。
async fn rollback(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Response> {
    let plugin = state
        .plugin_store
        .rollback(&id)?
        .ok_or_else(|| ApiError::not_found("PLUGIN_NOT_FOUND", "Plugin not found"))?;
    Ok(Json(plugin).into_response())
}

/// GET /api/plugins/{id}/files/{*path} — static plugin assets (no-cache).
async fn plugin_file(AxumPath((id, path)): AxumPath<(String, String)>) -> ApiResult<Response> {
    let plugins_root = settings::plugins_dir();
    if !is_plugin_dir_name(&id) {
        return Err(ApiError::not_found(
            "PLUGIN_FILE_NOT_FOUND",
            "File not found",
        ));
    }
    let base = plugins_root.join(&id);
    // 注意：不能用 `base.parent()` / `starts_with` 做边界判定 —— 二者都是**词法**
    // （组件）比较，不解析 `..`：`plugins_root.join("..").parent()` 仍返回
    // plugins_root，`starts_with` 也仍为真，两类守卫都会对 `id=".."` 失效。
    // 唯一可靠的判据是 id 本身必须是单个普通文件名（`is_plugin_dir_name`）。
    let file_path = resolve_plugin_asset(&base, &path);
    let Some(file_path) = file_path else {
        return Err(ApiError::not_found(
            "PLUGIN_FILE_NOT_FOUND",
            "File not found",
        ));
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

/// 插件目录名必须恰好是 `plugins/` 下的一个普通文件名：拒绝空、`.`、`..`
/// 以及任何分隔符 / 盘符 / 绝对路径形态。
///
/// 不能改用 `Path::starts_with` 判定：它按**组件**比较前缀，`plugins_root.join("..")`
/// 在组件层面仍以 `plugins_root` 的组件序列开头（`..` 是末位组件，不会回退），
/// 于是 `id=".."` 恒为真，守卫形同虚设。
fn is_plugin_dir_name(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains(':')
}

/// Resolve a plugin asset under `base`, refusing any traversal outside it.
fn resolve_plugin_asset(base: &std::path::Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let rel_path = PathBuf::from(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let joined = base.join(rel_path);
    // rel_path 已排除绝对路径与 ParentDir，此处 starts_with 只需再挡住带盘符前缀
    // 的形态（Windows 下 `C:foo` 不是绝对路径，但 join 会替换掉 base）。
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

    let mut settings: serde_json::Value =
        read_json_file(&settings_file).unwrap_or_else(|| serde_json::json!({}));
    let map = settings.as_object_mut().ok_or_else(|| {
        ApiError::bad_request("INVALID_SETTINGS_BODY", "settings.json is not an object")
    })?;
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

    let mut cache: serde_json::Value =
        read_json_file(&cache_file).unwrap_or_else(|| serde_json::json!({}));
    let map = cache.as_object_mut().ok_or_else(|| {
        ApiError::bad_request("INVALID_CACHE_BODY", "cache.json is not an object")
    })?;
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
    let cache: serde_json::Value =
        read_json_file(&cache_file).unwrap_or_else(|| serde_json::json!({}));

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

async fn proxy(
    State(state): State<SharedState>,
    Json(req): Json<CorsProxyRequest>,
) -> ApiResult<Response> {
    if req.url.trim().is_empty() {
        return Err(ApiError::bad_request("PROXY_URL_REQUIRED", "url 不能为空"));
    }
    let parsed = url::Url::parse(&req.url)
        .map_err(|_| ApiError::bad_request("PROXY_INVALID_URL", "无效的代理 URL"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::bad_request(
            "PROXY_SCHEME_NOT_ALLOWED",
            "仅支持 http/https 协议",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::bad_request("PROXY_INVALID_URL", "无效的代理 URL"))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(80);
    validate_target(&host, port).await?;

    let method_str = req.method.clone().unwrap_or_else(|| "GET".to_string());
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

    let resp = request.send().await.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "PROXY_UPSTREAM_FAILED",
            "上游响应中断",
        )
    })?;

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
    let body_bytes = resp.bytes().await.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "PROXY_UPSTREAM_FAILED",
            "上游响应中断",
        )
    })?;

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
    let body_base64 = if is_text {
        None
    } else {
        Some(b64_encode(&body_bytes))
    };

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
        return Err(ApiError::bad_request(
            "PROXY_DNS_FAILED",
            "无法解析目标主机",
        ));
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
            // fdfe:dcba:9876::/48 是 Clash/Surge 的 fake-ip IPv6 池（同 198.18.0.0/15）：
            // 代理工具把公网域名解析成该段地址，拦截会导致 proxyFetch 对代理用户全挂。
            if v6.segments()[0] == 0xfdfe
                && v6.segments()[1] == 0xdcba
                && v6.segments()[2] == 0x9876
            {
                return false;
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
        None => Err(ApiError::not_found(
            "WASM_PLUGIN_NOT_FOUND",
            "WASM plugin not found",
        )),
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
    if state
        .plugin_auth
        .find_grant(&plugin_id, &req.path)
        .is_none()
    {
        return Err(ApiError::forbidden(
            "FS_AUTHORIZATION_REQUIRED",
            "未授权访问该路径",
        ));
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
    if state
        .plugin_auth
        .find_grant(&plugin_id, &req.path)
        .is_none()
    {
        return Err(ApiError::forbidden(
            "FS_AUTHORIZATION_REQUIRED",
            "未授权访问该路径",
        ));
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
    if state
        .plugin_auth
        .find_grant(&plugin_id, &req.path)
        .is_none()
    {
        return Err(ApiError::forbidden(
            "FS_AUTHORIZATION_REQUIRED",
            "未授权访问该路径",
        ));
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFileRenameRequest {
    from: String,
    to: String,
}

/// POST /plugins/files/{id}/rename — 移动/重命名文件或目录。
///
/// 为什么需要：插件已有读/写/删，唯独没有「移动」。而很多操作天然是移动而不是
/// 复制（把 jar 隔离到另一个目录、把解压出的子目录提到根目录）。没有它，插件只能
/// readBytes + writeBytes + deleteFile 三倍搬运大文件。
///
/// 两端都要有读+写授权（源可读、目标可写），避免借 rename 把文件推进未授权目录。
async fn file_rename(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginFileRenameRequest>,
) -> ApiResult<Json<PluginFileResponse>> {
    let from = FileAuthService::normalize_path(&req.from)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效源路径"))?;
    let to = FileAuthService::normalize_path(&req.to)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效目标路径"))?;
    if !from.exists() {
        return Err(ApiError::not_found("FS_FILE_NOT_FOUND", "源文件不存在"));
    }
    for p in [&req.from, &req.to] {
        if state.plugin_auth.find_grant(&plugin_id, p).is_none() {
            return Err(ApiError::forbidden(
                "FS_AUTHORIZATION_REQUIRED",
                "未授权访问该路径",
            ));
        }
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    Ok(Json(PluginFileResponse {
        path: to.to_string_lossy().into_owned(),
        mode: None,
        content: None,
        content_base64: None,
        is_binary: false,
    }))
}

fn read_file_segment(
    path: &std::path::Path,
    start: Option<i64>,
    length: Option<i64>,
) -> Result<Vec<u8>, ApiError> {
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
// File extract / list (issue #295: 服务端压缩包导入所需)
// =====================================================================

/// POST /api/plugins/files/{id}/extract — 把本地 zip 解压到目标目录。
/// 走 FileAuthService：压缩包路径需读授权、目标目录需写授权（均按前缀）。
async fn file_extract(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginFileExtractRequest>,
) -> ApiResult<Json<PluginFileExtractResponse>> {
    let archive = FileAuthService::normalize_path(&req.archive_path)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效的压缩包路径"))?;
    let dest = FileAuthService::normalize_path(&req.dest_path)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效的目标路径"))?;
    if state
        .plugin_auth
        .find_grant(&plugin_id, &req.archive_path)
        .is_none()
        || state
            .plugin_auth
            .find_grant(&plugin_id, &req.dest_path)
            .is_none()
    {
        return Err(ApiError::forbidden(
            "FS_AUTHORIZATION_REQUIRED",
            "未授权访问该路径",
        ));
    }
    if !archive.is_file() {
        return Err(ApiError::not_found("FS_FILE_NOT_FOUND", "压缩包不存在"));
    }
    tokio::fs::create_dir_all(&dest).await?;
    let dest_display = dest.to_string_lossy().into_owned();
    let (archive, dest) = (archive.clone(), dest.clone());
    let prefix = req.prefix.clone();
    let strip_prefix = req.strip_prefix;
    tokio::task::spawn_blocking(move || {
        crate::services::archive::extract_zip_file_filtered(
            &archive,
            &dest,
            prefix.as_deref(),
            strip_prefix,
        )
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(|e| ApiError::bad_request("EXTRACT_FAILED", e))?;
    Ok(Json(PluginFileExtractResponse {
        dest_path: dest_display,
    }))
}

/// POST /api/plugins/files/{id}/list — 列举目录条目（名称/类型/大小/mtime）。
/// 只做一层或递归（栈式遍历，目录优先），条目数上限默认 1000。
async fn file_list(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginFileListRequest>,
) -> ApiResult<Json<Vec<PluginFileEntry>>> {
    let root = FileAuthService::normalize_path(&req.path)
        .ok_or_else(|| ApiError::bad_request("FS_INVALID_PATH", "无效路径"))?;
    if state
        .plugin_auth
        .find_grant(&plugin_id, &req.path)
        .is_none()
    {
        return Err(ApiError::forbidden(
            "FS_AUTHORIZATION_REQUIRED",
            "未授权访问该路径",
        ));
    }
    if !root.is_dir() {
        return Err(ApiError::not_found("FS_DIR_NOT_FOUND", "目录不存在"));
    }
    let cap = req.max_entries.unwrap_or(1000).clamp(1, 10000);
    let recursive = req.recursive;
    let entries = tokio::task::spawn_blocking(move || list_dir_entries(&root, recursive, cap))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::bad_request("FS_LIST_FAILED", e))?;
    Ok(Json(entries))
}

fn list_dir_entries(
    root: &Path,
    recursive: bool,
    cap: usize,
) -> Result<Vec<PluginFileEntry>, String> {
    let mut out: Vec<PluginFileEntry> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd =
            std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败 {}: {e}", dir.display()))?;
        // 目录先入栈后输出会打乱「目录优先」排序，这里统一收集后在末尾整体排序。
        for entry in rd {
            let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let is_dir = meta.is_dir();
            out.push(PluginFileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified_ms: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
            });
            if recursive && is_dir {
                if out.len() + stack.len() < cap + root_ancestor_budget(cap) {
                    stack.push(path);
                }
            }
            if out.len() >= cap {
                out.truncate(cap);
                sort_entries(&mut out);
                return Ok(out);
            }
        }
    }
    sort_entries(&mut out);
    Ok(out)
}

/// 递归模式下允许栈里比上限多保留一部分目录，避免浅层目录把配额吃光后
/// 子目录全被跳过（栈深与输出量同量级即可）。
fn root_ancestor_budget(cap: usize) -> usize {
    (cap / 4).max(64)
}

fn sort_entries(out: &mut [PluginFileEntry]) {
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
}

// =====================================================================
// Managed processes (issue #295: 插件常驻进程管理)
// =====================================================================

/// POST /api/plugins/process/{id}/spawn — 拉起常驻进程（piped stdio）。
async fn process_spawn(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
    Json(req): Json<PluginProcessSpawnRequest>,
) -> ApiResult<Json<PluginProcessSpawnResponse>> {
    if req.command.trim().is_empty() {
        return Err(ApiError::bad_request(
            "PROCESS_COMMAND_REQUIRED",
            "command 不能为空",
        ));
    }
    let pid = state
        .plugin_processes
        .spawn(
            &plugin_id,
            crate::services::plugin_process::SpawnOptions {
                command: req.command,
                args: req.args,
                cwd: req.cwd,
                env: req.env,
            },
        )
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "PROCESS_SPAWN_FAILED", e))?;
    let snap = state
        .plugin_processes
        .snapshot(&plugin_id, pid)
        .map_err(|e| ApiError::internal(e))?;
    Ok(Json(PluginProcessSpawnResponse {
        pid,
        started_at_ms: snap.started_at_ms,
    }))
}

/// GET /api/plugins/process/{id}/list — 该插件的全部受管进程快照。
async fn process_list(
    State(state): State<SharedState>,
    AxumPath(plugin_id): AxumPath<String>,
) -> Json<Vec<crate::services::plugin_process::ProcSnapshot>> {
    Json(state.plugin_processes.list(&plugin_id))
}

/// POST /api/plugins/process/{id}/{pid}/stdin — 向进程标准输入写入。
async fn process_stdin(
    State(state): State<SharedState>,
    AxumPath((plugin_id, pid)): AxumPath<(String, u32)>,
    Json(req): Json<PluginProcessStdinRequest>,
) -> ApiResult<StatusCode> {
    state
        .plugin_processes
        .write_stdin(&plugin_id, pid, &req.data, req.append_newline)
        .await
        .map_err(|e| ApiError::bad_request("PROCESS_STDIN_FAILED", e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/plugins/process/{id}/{pid}/kill — 终止进程树（复用核心 kill 逻辑）。
/// 幂等：进程已退出时返回 200。
async fn process_kill(
    State(state): State<SharedState>,
    AxumPath((plugin_id, pid)): AxumPath<(String, u32)>,
) -> ApiResult<Json<PluginProcessKillResponse>> {
    let snap = state
        .plugin_processes
        .snapshot(&plugin_id, pid)
        .map_err(|e| ApiError::not_found("PROCESS_NOT_FOUND", e))?;
    if !snap.alive {
        return Ok(Json(PluginProcessKillResponse {
            message: format!("进程 {pid} 已退出"),
        }));
    }
    let killed = state
        .core
        .launch()
        .kill(pid as i32)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if !killed {
        // 兜底：core kill 可能因平台细节返回 false（进程已在退出中等），
        // 直接再来一次进程树终止，而不是把「停止失败」抛回给用户。
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
    }
    Ok(Json(PluginProcessKillResponse {
        message: format!("进程 {pid} 已终止"),
    }))
}

/// GET /api/plugins/process/{id}/{pid}/alive — 进程存活状态。
async fn process_alive(
    State(state): State<SharedState>,
    AxumPath((plugin_id, pid)): AxumPath<(String, u32)>,
) -> ApiResult<Json<crate::services::plugin_process::ProcSnapshot>> {
    let snap = state
        .plugin_processes
        .snapshot(&plugin_id, pid)
        .map_err(|e| ApiError::not_found("PROCESS_NOT_FOUND", e))?;
    Ok(Json(snap))
}

/// GET /api/plugins/process/{id}/{pid}/logs?after=seq — 游标式增量日志。
async fn process_logs(
    State(state): State<SharedState>,
    AxumPath((plugin_id, pid)): AxumPath<(String, u32)>,
    Query(query): Query<PluginProcessLogsQuery>,
) -> ApiResult<Json<PluginProcessLogsResponse>> {
    let (lines, snap) = state
        .plugin_processes
        .logs(&plugin_id, pid, query.after.unwrap_or(0))
        .map_err(|e| ApiError::not_found("PROCESS_NOT_FOUND", e))?;
    Ok(Json(PluginProcessLogsResponse {
        lines,
        next_seq: snap.next_seq,
        oldest_seq: snap.oldest_seq,
        alive: snap.alive,
        exit_code: snap.exit_code,
    }))
}

// =====================================================================
// Plugin downloads (shared DownloadManager; tasks surface in download center)
// =====================================================================

async fn download_start(
    State(state): State<SharedState>,
    Json(req): Json<PluginDownloadStartRequest>,
) -> ApiResult<Json<PluginDownloadStartResponse>> {
    if req.url.trim().is_empty() {
        return Err(ApiError::bad_request(
            "DOWNLOAD_URL_REQUIRED",
            "url 不能为空",
        ));
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
    let manager = state.download_manager.load_full();
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

async fn download_progress(AxumPath(task_id): AxumPath<String>) -> Json<serde_json::Value> {
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
        let _ = state.download_manager.load_full().cancel(download_id).await;
    }
    update_session(&task_id, |s| {
        s.status = "cancelled".to_string();
        s.stage = "cancelled".to_string();
    });
    Json(StatusResponse {
        status: "cancelled".to_string(),
    })
}

// =====================================================================
// 插件通用任务 / 批量下载 / 元数据代理
//
// 这些接口的存在意义：让「一键开服」这类功能完整地由插件实现，而不是在启动器
// 里为单个功能开专用管线。插件缺少的从来不是某个功能端点，而是四件通用能力：
//   1. 一次下载几百个文件、只占一张卡片（/plugins/download/batch）
//   2. 自己编排分步任务并上报进度（/plugins/tasks/*）
//   3. 查询 CurseForge 文件信息而不持有 API key（/plugins/cf/files）
//   4. 不解压整包就读 zip 内单个条目（/plugins/archive/entry）
// 权限校验同样不在后端（见模块头注释），由前端 bridge 统一执行。
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginBatchDownloadRequest {
    /// 目标文件列表：每项一个 URL + 落盘路径。
    files: Vec<PluginBatchFile>,
    /// 归属的外部驱动任务 id（`/plugins/tasks/register` 的返回值）。
    /// 提供时进度写进该任务的步骤；省略则自建一个只含单步的任务。
    #[serde(default)]
    task_id: Option<String>,
    /// 推进哪个步骤的百分比（省略则不推步骤，只推任务总进度）。
    #[serde(default)]
    step_id: Option<String>,
    /// 卡片标题（自建任务时使用）。
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginBatchFile {
    url: String,
    dest_path: String,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginBatchDownloadResponse {
    task_id: String,
    /// 批次 id：`/plugins/download/batch/{batchId}` 查询完成状态。
    batch_id: String,
    total_files: usize,
}

/// 批量下载批次状态（异步下载，插件按 batchId 轮询）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginBatchState {
    status: String,
    total_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn batches() -> &'static Mutex<HashMap<String, PluginBatchState>> {
    static BATCHES: OnceLock<Mutex<HashMap<String, PluginBatchState>>> = OnceLock::new();
    BATCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// POST /plugins/download/batch — 批量下载到多目标路径，进度挂到任务步骤上。
///
/// 与 `/plugins/download/start`（单文件、单会话、一张卡）的区别：这里是「一个任务
/// 一张卡」，几百个 mod 不会把下载中心刷成几百条。底层复用安装管线同一套
/// `download_batch`（并发、去重、镜像回退、`.part` 原子改名）。
async fn download_batch_start(
    State(state): State<SharedState>,
    Json(req): Json<PluginBatchDownloadRequest>,
) -> ApiResult<Json<PluginBatchDownloadResponse>> {
    if req.files.is_empty() {
        return Err(ApiError::bad_request(
            "DOWNLOAD_FILES_REQUIRED",
            "files 不能为空",
        ));
    }
    if req.files.len() > MAX_PLUGIN_BATCH_ITEMS {
        return Err(ApiError::bad_request(
            "DOWNLOAD_TOO_MANY_FILES",
            format!(
                "单次批量下载最多 {} 个文件（收到 {}）",
                MAX_PLUGIN_BATCH_ITEMS,
                req.files.len()
            ),
        ));
    }

    let tracker = state.install_tracker.clone();
    let (task_id, step_id, handle) = match req.task_id.as_deref() {
        Some(tid) => {
            let handle = tracker
                .get_handle(tid)
                .ok_or_else(|| ApiError::not_found("TASK_NOT_FOUND", "任务不存在"))?;
            (tid.to_string(), req.step_id.clone(), handle)
        }
        None => {
            let tid = format!("plugin-batch-{}", uuid::Uuid::new_v4());
            let step = req
                .step_id
                .clone()
                .unwrap_or_else(|| "download".to_string());
            let handle = tracker
                .register_external(
                    tid.clone(),
                    "plugin",
                    req.title.clone(),
                    &[(step.clone(), 100.0)],
                    100.0,
                )
                .map_err(|e| ApiError::conflict("TASK_BUSY", format!("已有进行中的任务: {e}")))?;
            (tid, Some(step), handle)
        }
    };

    // 不用 with_capacity(req.files.len())：容量来自请求体（不受信），CodeQL 会
    // 判为「按用户值预分配」并可能真的在超长请求上先吃掉一大块内存。上限校验
    // 已在入口处做过，这里让 Vec 按实际 push 增长即可。
    let mut targets: Vec<crate::services::install_service::DownloadTarget> = Vec::new();
    for f in &req.files {
        if f.url.trim().is_empty() || f.dest_path.trim().is_empty() {
            return Err(ApiError::bad_request(
                "DOWNLOAD_TARGET_INVALID",
                "url / destPath 不能为空",
            ));
        }
        let dest = PathBuf::from(f.dest_path.trim());
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let headers = f
            .headers
            .as_ref()
            .map(|h| h.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        targets.push((f.url.clone(), dest, headers));
    }

    let total = targets.len();
    let batch_id = uuid::Uuid::new_v4().to_string();
    {
        let mut g = batches().lock().unwrap_or_else(|p| p.into_inner());
        g.insert(
            batch_id.clone(),
            PluginBatchState {
                status: "running".to_string(),
                total_files: total,
                error: None,
            },
        );
    }
    let mgr = state.download_manager.load_full();
    let tracker2 = tracker.clone();
    let task_for_worker = task_id.clone();
    let step_for_worker = step_id.clone();
    let batch_for_worker = batch_id.clone();
    let owns_task = req.task_id.is_none();
    tokio::spawn(async move {
        let result = crate::services::install_service::download_batch(
            &handle,
            &mgr,
            targets,
            step_for_worker.as_deref(),
        )
        .await;
        // 自建任务才由这里收尾；调用方传入的 taskId 由其自己 complete
        if owns_task {
            tracker2.finish_external(&task_for_worker, result.clone().err());
        } else if let Err(e) = &result {
            let msg = e.clone();
            let _ = tracker2.update_progress(&task_for_worker, |f| {
                f.set_status(crate::services::install_tracker::InstallStatus::Failed);
                f.error = Some(msg);
                f.finish_steps(false);
            });
        }
        let mut g = batches().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(b) = g.get_mut(&batch_for_worker) {
            match result {
                Ok(()) => b.status = "completed".to_string(),
                Err(e) => {
                    b.status = "failed".to_string();
                    b.error = Some(e);
                }
            }
        }
    });

    Ok(Json(PluginBatchDownloadResponse {
        task_id,
        batch_id,
        total_files: total,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginTaskRegisterRequest {
    /// 插件自定义任务 id（建议带插件前缀避免冲突）；省略则生成。
    #[serde(default)]
    task_id: Option<String>,
    title: String,
    /// 步骤列表：id + 权重。权重只影响合成总进度，任意正数。
    steps: Vec<PluginTaskStepSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginTaskStepSpec {
    id: String,
    #[serde(default = "default_step_weight")]
    weight: f64,
    #[serde(default)]
    label: Option<String>,
}

fn default_step_weight() -> f64 {
    1.0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginTaskRegisterResponse {
    task_id: String,
}

/// POST /plugins/tasks/register — 注册一个由插件自己推进的分步任务。
///
/// 任务进 `InstallTracker`，因此**自动出现在下载中心**（SSE 与轮询两路都覆盖），
/// 与内置安装任务同一套卡片渲染。插件随后用 `/update` 推步骤、`/complete` 收尾。
async fn task_register(
    State(state): State<SharedState>,
    Json(req): Json<PluginTaskRegisterRequest>,
) -> ApiResult<Json<PluginTaskRegisterResponse>> {
    if req.steps.is_empty() {
        return Err(ApiError::bad_request(
            "TASK_STEPS_REQUIRED",
            "steps 不能为空",
        ));
    }
    if req.steps.len() > 256 {
        return Err(ApiError::bad_request(
            "TASK_TOO_MANY_STEPS",
            format!("单个任务最多 256 个步骤（收到 {}）", req.steps.len()),
        ));
    }
    let task_id = req
        .task_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("plugin-task-{}", uuid::Uuid::new_v4()));

    let specs: Vec<(String, f64)> = req
        .steps
        .iter()
        .map(|s| (s.id.clone(), if s.weight > 0.0 { s.weight } else { 1.0 }))
        .collect();

    state
        .install_tracker
        .register_external(task_id.clone(), "plugin", Some(req.title), &specs, 100.0)
        .map_err(|e| ApiError::conflict("TASK_BUSY", format!("已有进行中的任务: {e}")))?;

    // 步骤自定义标签（可选）：后端不硬编码任何文案，由插件自带。
    for s in &req.steps {
        if let Some(label) = &s.label {
            state
                .install_tracker
                .update_progress(&task_id, |f| f.set_step_label(&s.id, label));
        }
    }

    Ok(Json(PluginTaskRegisterResponse { task_id }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginTaskUpdateRequest {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    step_id: Option<String>,
    /// pending | active | done | failed
    #[serde(default)]
    step_status: Option<String>,
    #[serde(default)]
    step_percent: Option<f64>,
    #[serde(default)]
    step_label: Option<String>,
    #[serde(default)]
    current_file: Option<String>,
    #[serde(default)]
    error: Option<String>,
    /// 受限文件数（不落 completed，转 awaiting-files）
    #[serde(default)]
    blocked_files: Option<i32>,
}

/// POST /plugins/tasks/{taskId}/update — 推进外部任务的状态/步骤。
///
/// 所有字段可选，只更新提供的部分；插件按自己的编排节奏调用。
async fn task_update(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
    Json(req): Json<PluginTaskUpdateRequest>,
) -> ApiResult<Json<StatusResponse>> {
    let ok = state.install_tracker.update_progress(&task_id, |f| {
        if let Some(s) = &req.status {
            f.status = s.clone();
            f.stage = s.clone();
        }
        if let Some(s) = &req.stage {
            f.stage = s.clone();
        }
        if let Some(sid) = &req.step_id {
            if let Some(status) = &req.step_status {
                f.mark_step(sid, status);
            } else if let Some(pct) = req.step_percent {
                f.set_step_percent(sid, pct);
            }
            if let Some(label) = &req.step_label {
                f.set_step_label(sid, label);
            }
        }
        if let Some(cf) = &req.current_file {
            f.current_file = cf.clone();
        }
        if let Some(e) = &req.error {
            f.error = Some(e.clone());
        }
        if let Some(b) = req.blocked_files {
            f.blocked_files = b;
        }
        f.recompute_progress();
    });
    if !ok {
        return Err(ApiError::not_found("TASK_NOT_FOUND", "任务不存在"));
    }
    Ok(Json(StatusResponse {
        status: "ok".to_string(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginTaskCompleteRequest {
    #[serde(default)]
    error: Option<String>,
}

/// POST /plugins/tasks/{taskId}/complete — 外部任务收尾（成功/失败/取消）。
async fn task_complete(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
    Json(req): Json<PluginTaskCompleteRequest>,
) -> ApiResult<Json<StatusResponse>> {
    if !state.install_tracker.finish_external(&task_id, req.error) {
        return Err(ApiError::not_found("TASK_NOT_FOUND", "任务不存在"));
    }
    Ok(Json(StatusResponse {
        status: "ok".to_string(),
    }))
}

/// GET /plugins/download/batch/{batchId} — 批量下载批次状态。
async fn download_batch_status(
    AxumPath(batch_id): AxumPath<String>,
) -> ApiResult<Json<PluginBatchState>> {
    let g = batches().lock().unwrap_or_else(|p| p.into_inner());
    g.get(&batch_id)
        .cloned()
        .map(Json)
        .ok_or_else(|| ApiError::not_found("BATCH_NOT_FOUND", "批次不存在或已回收"))
}

/// GET /plugins/tasks/{taskId} — 任务进度（与安装管线同一 DTO）。
async fn task_progress(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<crate::services::install_tracker::InstallProgress>> {
    state
        .install_tracker
        .get_state(&task_id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found("TASK_NOT_FOUND", "任务不存在"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginCfFilesRequest {
    /// `[projectId, fileId]` 对；projectId 仅用于回填，查询按 fileId。
    files: Vec<PluginCfFileRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginCfFileRef {
    #[serde(default)]
    project_id: Option<i64>,
    file_id: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginCfFileInfo {
    project_id: i64,
    file_id: i64,
    file_name: String,
    /// 为空表示作者关闭第三方分发（受限文件），调用方应转「待补全」流程。
    download_url: Option<String>,
    file_length: i64,
    /// 阻塞原因（受限/未找到）；成功时省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<String>,
}

/// POST /plugins/cf/files — 批量查询 CurseForge 文件信息（元数据代理）。
///
/// CurseForge 的 files 端点要 `x-api-key`，插件不可能持有；但「整合包清单里只有
/// projectID:fileID，需要换下载直链」是任何整合包相关插件都要做的事。这里只暴露
/// 「查询 → 直链」这一个语义，key 始终留在启动器进程内。
async fn cf_files_lookup(
    State(state): State<SharedState>,
    Json(req): Json<PluginCfFilesRequest>,
) -> ApiResult<Json<Vec<PluginCfFileInfo>>> {
    if req.files.is_empty() {
        return Ok(Json(Vec::new()));
    }
    if req.files.len() > MAX_PLUGIN_BATCH_ITEMS {
        return Err(ApiError::bad_request(
            "CF_TOO_MANY_FILES",
            format!(
                "单次最多查询 {} 个文件（收到 {}）",
                MAX_PLUGIN_BATCH_ITEMS,
                req.files.len()
            ),
        ));
    }
    let file_ids: Vec<i64> = req.files.iter().map(|f| f.file_id).collect();
    let cf = state
        .core
        .create_curseforge_source(&state.curse_forge_api_key);
    let infos = cf
        .get_files_batch(&file_ids)
        .await
        .map_err(|e| ApiError::upstream(format!("批量查询 CurseForge 文件失败: {e}")))?;

    // 同上：容量不取自请求体长度，避免按用户值预分配。
    let mut out = Vec::new();
    for f in &req.files {
        let project_id = f.project_id.unwrap_or(0);
        match infos.get(&f.file_id) {
            Some(info) => {
                let url = info
                    .download_url
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string());
                out.push(PluginCfFileInfo {
                    project_id,
                    file_id: f.file_id,
                    file_name: info.file_name.clone().unwrap_or_default(),
                    blocked_reason: if url.is_none() {
                        Some("作者关闭了第三方分发".to_string())
                    } else {
                        None
                    },
                    download_url: url,
                    file_length: info.file_length.unwrap_or(0),
                });
            }
            None => out.push(PluginCfFileInfo {
                project_id,
                file_id: f.file_id,
                file_name: String::new(),
                download_url: None,
                file_length: 0,
                blocked_reason: Some("上游未返回该文件".to_string()),
            }),
        }
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginArchiveEntryRequest {
    archive_path: String,
    /// zip 内条目路径（正斜杠）。
    entry_path: String,
    /// 读取上限（字节）；超限报错而非截断，避免静默拿到半个 JSON。
    #[serde(default = "default_entry_limit")]
    max_bytes: u64,
}

fn default_entry_limit() -> u64 {
    4 * 1024 * 1024
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginArchiveEntryResponse {
    content: String,
    size: u64,
}

/// POST /plugins/archive/entry — 不经解压直接读 zip 内单个条目的文本内容。
///
/// 为什么需要：整合包/模组 jar 的元数据都在包里（`fabric.mod.json`、
/// `META-INF/mods.toml`、`modrinth.index.json`）。让插件先 `extractArchive`
/// 解压几百个 jar 只为读一个 JSON 不现实；而「读包内某个条目」本身与业务无关，
/// 是通用能力。
async fn archive_read_entry(
    Json(req): Json<PluginArchiveEntryRequest>,
) -> ApiResult<Json<PluginArchiveEntryResponse>> {
    let archive_path = PathBuf::from(req.archive_path.trim());
    if !archive_path.is_file() {
        return Err(ApiError::not_found("ARCHIVE_NOT_FOUND", "压缩包不存在"));
    }
    let max = req.max_bytes.clamp(1, 32 * 1024 * 1024);
    let file = std::fs::File::open(&archive_path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| ApiError::bad_request("ARCHIVE_INVALID", format!("不是有效的 zip: {e}")))?;
    let mut entry = zip
        .by_name(&req.entry_path)
        .map_err(|_| ApiError::not_found("ARCHIVE_ENTRY_NOT_FOUND", "包内条目不存在"))?;
    if entry.size() > max {
        return Err(ApiError::bad_request(
            "ARCHIVE_ENTRY_TOO_LARGE",
            format!("条目大小 {} 超过上限 {max}", entry.size()),
        ));
    }
    let mut buf = Vec::with_capacity(entry.size() as usize);
    std::io::Read::read_to_end(&mut entry, &mut buf)?;
    let size = buf.len() as u64;
    let content = String::from_utf8_lossy(&buf).into_owned();
    Ok(Json(PluginArchiveEntryResponse { content, size }))
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

async fn extract_zip_into(
    zip_path: &std::path::Path,
    out_dir: &std::path::Path,
) -> std::io::Result<()> {
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
            // zip 9：`name()` 返回 `ZipResult<Cow<str>>`（8 之前直接是 &str）
            let rel: PathBuf = PathBuf::from(entry.name()?.as_ref());
            if rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
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
            .or_else(|| full.file_name().map(|s| s.to_string_lossy().into_owned()))
            .filter(|n| !n.trim().is_empty())
            .ok_or_else(|| {
                ApiError::bad_request(
                    "DOWNLOAD_FILE_NAME_REQUIRED",
                    "无法确定文件名，请提供 fileName",
                )
            })?;
        return Ok((target_dir, name));
    }

    if let Some(instance_id) = req.instance_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let inst = state
            .instance
            .get_by_id(instance_id)
            .ok_or_else(|| ApiError::not_found("INSTANCE_NOT_FOUND", "实例不存在"))?;
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
                ApiError::bad_request(
                    "DOWNLOAD_FILE_NAME_REQUIRED",
                    "无法确定文件名，请提供 fileName",
                )
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
        .and_then(|mut segments| segments.rfind(|s| !s.is_empty()))
        .map(|s| s.to_string())
}

// =====================================================================
// Shell execution
// =====================================================================

/// Windows 上优先使用 PowerShell 7（`pwsh`），未安装时回退到系统自带的 5.1。
///
/// 只在启动时探测一次并缓存：探测要访问文件系统，没必要每条命令都做；插件若在
/// 运行期间新装了 pwsh，重启后端即可生效（安装本身通常需要重启终端）。
///
/// 决策逻辑见 [`pick_shell_program`]（纯函数，可单测）。
#[cfg(windows)]
fn windows_shell_program() -> &'static str {
    static PROGRAM: OnceLock<String> = OnceLock::new();
    PROGRAM.get_or_init(|| {
        let custom = std::env::var("QOMICEX_PWSH_PATH").ok();
        let msi = std::env::var_os("ProgramFiles")
            .map(|pf| Path::new(&pf).join("PowerShell").join("7").join("pwsh.exe"))
            .filter(|p| p.is_file())
            .map(|p| p.to_string_lossy().into_owned());
        let on_path = find_pwsh_exe_on_path();
        pick_shell_program(custom.as_deref(), on_path.as_deref(), msi.as_deref())
    })
}

/// 解释器选择（纯函数，便于单测）。
///
/// 优先级：显式 `QOMICEX_PWSH_PATH` → `PATH` 里的 `pwsh.exe` → MSI 安装位置 → 5.1。
///
/// **一律返回可用于启动的完整路径或可执行名**，且返回什么就启动什么：此前探测
/// `PATH` 时接受了 `.cmd` / `.bat`，实际却启动裸名 `pwsh` —— Rust 的进程创建按
/// 可执行程序解析裸名，不会套用脚本扩展名，结果是明明探测成功却 `SHELL_START_FAILED`。
/// 因此探测只认 `pwsh.exe`，并把命中路径原样返回。
///
/// 5.1 的回退用**绝对路径**而不是裸命令名：`powershell` 依赖 `PATH` 含 System32，
/// 而 PATH 被裁剪/损坏时裸名会直接 `program not found` —— 那样连最基本的命令执行
/// 都不可用，比版本不理想严重得多。
#[cfg(windows)]
fn pick_shell_program(
    custom: Option<&str>,
    pwsh_exe_on_path: Option<&str>,
    msi_path: Option<&str>,
) -> String {
    if let Some(c) = custom {
        if !c.is_empty() {
            return c.to_string();
        }
    }
    if let Some(p) = pwsh_exe_on_path {
        return p.to_string();
    }
    if let Some(p) = msi_path {
        return p.to_string();
    }
    windows_powershell_51().unwrap_or_else(|| "powershell".to_string())
}

/// 系统自带 Windows PowerShell 5.1 的绝对路径。
///
/// 位置随系统目录变化（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`）。
#[cfg(windows)]
fn windows_powershell_51() -> Option<String> {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(PathBuf::from)?;
    let exe = root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    exe.is_file().then(|| exe.to_string_lossy().into_owned())
}

/// 在 `PATH` 里查找可直接启动的 `pwsh.exe`，返回其完整路径。
///
/// 只认 `.exe`：进程创建不会按 `.cmd` / `.bat` 的语义套用解释器，探测到脚本却用裸名
/// 启动必然会失败。Store 版在 `WindowsApps` 下的执行别名文件读取方式与常规文件不同，
/// 因此 `is_file()` 失败时再试一次 `metadata()`。
#[cfg(windows)]
fn find_pwsh_exe_on_path() -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join("pwsh.exe");
        let exists = candidate.is_file() || std::fs::metadata(&candidate).is_ok();
        exists.then(|| candidate.to_string_lossy().into_owned())
    })
}

async fn shell(
    AxumPath(_id): AxumPath<String>,
    Json(req): Json<PluginShellRequest>,
) -> ApiResult<Json<PluginShellResponse>> {
    if req.command.trim().is_empty() {
        return Err(ApiError::bad_request(
            "SHELL_COMMAND_REQUIRED",
            "command 不能为空",
        ));
    }
    let timeout_ms = req.timeout_ms.unwrap_or(15000).clamp(1000, 120000);

    #[cfg(windows)]
    let program = windows_shell_program();
    #[cfg(not(windows))]
    let program = "/bin/sh";

    let mut cmd = tokio::process::Command::new(program);
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

    let mut child = cmd.spawn().map_err(|e| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SHELL_START_FAILED",
            format!("无法启动 shell: {e}"),
        )
    })?;
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

    /// 回归（#226）：`plugin_file` 的路径守卫原先用 `base.starts_with(&plugins_root)`，
    /// 而该 API 按**组件**比较前缀 —— `join("..")` 的结果在组件层面仍以 plugins_root
    /// 开头，于是 `id=".."` 恒为真，守卫不生效。
    #[test]
    fn plugin_file_guard_rejects_parent_dir_id() {
        let root = std::path::Path::new("/tmp/qomicex-plugins");
        // 组件语义：这正是旧实现被绕过的原因，先固定这个前提
        assert!(root.join("..").starts_with(root));
        assert!(root.join("../..").starts_with(root));
        // 新守卫必须拒绝
        assert!(!is_plugin_dir_name(".."));
        assert!(!is_plugin_dir_name("../.."));
        assert!(!is_plugin_dir_name("a/b"));
        assert!(!is_plugin_dir_name("a\\b"));
        assert!(!is_plugin_dir_name("C:\\Windows"));
        assert!(!is_plugin_dir_name(""));
        assert!(!is_plugin_dir_name("."));
        // 合法插件目录名仍放行
        assert!(is_plugin_dir_name("com.qomicex.demo"));
        assert!(is_plugin_dir_name("my_plugin-1.0"));
    }

    /// 回归（#226）：记录「词法路径守卫对 `..` 无效」这一事实，防止日后重新引入
    /// `base.parent()` / `base.starts_with(root)` 这类看似正确、实则恒真的伪守卫。
    #[test]
    fn lexical_path_guards_do_not_stop_parent_dir() {
        let root = std::path::Path::new("/tmp/qomicex-plugins");
        for id in ["..", "../..", "a/../.."] {
            let base = root.join(id);
            assert!(base.starts_with(root), "id={id}: starts_with 对 .. 恒真");
        }
        // parent() 同样不可靠：单个 `..` 会被词法消解回 root，多级则留在 root 之下
        assert_eq!(root.join("..").parent(), Some(root));
        assert_ne!(root.join("../..").parent(), Some(root));
        // 唯一可靠的判据是 id 形态本身
        assert!(is_plugin_dir_name("com.qomicex.demo"));
    }

    #[test]
    fn proxy_fake_ip_is_allowed() {
        // Clash/Surge fake-ip pools resolve public hostnames into 198.18.0.0/15.
        assert!(!is_private("198.18.0.87"));
        assert!(!is_private("198.19.255.255"));
        // fake-ip IPv6 池（fdfe:dcba:9876::/48）同样放行
        assert!(!is_private("fdfe:dcba:9876::9a"));
        // 真实 ULA 仍拦截
        assert!(is_private("fd12:3456:7890::1"));
    }

    #[test]
    fn public_addresses_are_allowed() {
        assert!(!is_private("1.1.1.1"));
        assert!(!is_private("8.8.8.8"));
        assert!(!is_private("114.114.114.114"));
        assert!(!is_private("2606:4700:4700::1111"));
    }

    /// 回归（execCommand 解释器）：Windows 上必须优先用 PowerShell 7（`pwsh`），
    /// 未安装时回退 5.1。
    ///
    /// 直接测 [`pick_shell_program`] 而不是探测结果：CI 与开发机上 pwsh 的有无不同，
    /// 断言具体命中哪个会变成环境探测；这里锁的是**优先级语义**。
    #[cfg(windows)]
    #[test]
    fn shell_program_prefers_pwsh_over_windows_powershell() {
        let pwsh = r"C:\Program Files\PowerShell\7\pwsh.exe";
        // PATH 命中 → 用它（且必须是探测到的**完整路径**，不是裸名）
        assert_eq!(pick_shell_program(None, Some(pwsh), None), pwsh);
        // 没有 pwsh → 回退 5.1，且必须是可执行的绝对路径，不能是裸名
        let fallback = pick_shell_program(None, None, None);
        assert!(
            fallback.to_lowercase().ends_with("powershell.exe"),
            "回退应为 powershell.exe，实际 {fallback}"
        );
        assert!(
            std::path::Path::new(&fallback).is_absolute(),
            "回退必须是绝对路径（不依赖 PATH），实际 {fallback}"
        );
        // PATH 未命中但 MSI 存在 → 用 MSI 的绝对路径
        assert_eq!(pick_shell_program(None, None, Some(pwsh)), pwsh);
        // PATH 与 MSI 都有时优先 PATH 命中项
        assert_eq!(
            pick_shell_program(None, Some(r"D:\pwsh\pwsh.exe"), Some(pwsh)),
            r"D:\pwsh\pwsh.exe"
        );
    }

    /// `QOMICEX_PWSH_PATH` 显式指定时压过一切自动探测（绿色版/自定义目录场景）。
    #[cfg(windows)]
    #[test]
    fn explicit_pwsh_path_overrides_autodetect() {
        assert_eq!(
            pick_shell_program(
                Some(r"D:\tools\pwsh\pwsh.exe"),
                Some(r"C:\Program Files\PowerShell\7\pwsh.exe"),
                Some(r"C:\msi\pwsh.exe")
            ),
            r"D:\tools\pwsh\pwsh.exe"
        );
        // 空值视为未设置，不能当成有效路径
        assert_eq!(
            pick_shell_program(Some(""), Some(r"D:\pwsh\pwsh.exe"), None),
            r"D:\pwsh\pwsh.exe"
        );
        assert!(
            pick_shell_program(Some(""), None, None)
                .to_lowercase()
                .ends_with("powershell.exe"),
            "空值应回退到 powershell.exe"
        );
    }

    /// 探测与启动必须指向同一个程序：`PATH` 里只有脚本（`.cmd`/`.bat`）时不能当作可用。
    ///
    /// 只看路径是否存在会把 `pwsh.cmd` 当成 pwsh，而进程创建不套用脚本语义，最终
    /// `SHELL_START_FAILED`。函数只返回 `.exe` 路径这一契约由此固定。
    #[cfg(windows)]
    #[test]
    fn pwsh_detection_only_returns_executables() {
        if let Some(found) = find_pwsh_exe_on_path() {
            assert!(
                found.to_lowercase().ends_with("pwsh.exe"),
                "探测结果必须是 pwsh.exe，实际 {found}"
            );
            assert!(
                std::path::Path::new(&found).is_absolute(),
                "探测结果必须是完整路径，实际 {found}"
            );
        }
    }

    /// 真实环境下选出来的程序名必须落在 PowerShell 家族内。
    ///
    /// 防的是回归成 `cmd`、`pwsh7` 这类拼写错误 —— 那种错误会让 `-NoProfile` 直接
    /// 失败，插件调用 execCommand 时只看到 shell 启动失败。
    #[cfg(windows)]
    #[test]
    fn detected_shell_program_is_powershell_family() {
        let program = windows_shell_program();
        let name = std::path::Path::new(program)
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        assert!(
            matches!(
                name.as_str(),
                "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe"
            ),
            "unexpected shell program: {program}"
        );
    }
}
