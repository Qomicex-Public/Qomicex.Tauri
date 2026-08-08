//! System 端点（对应源 Endpoints/SystemEndpoints.cs）。
//! 自包含切片：无需额外服务注入，用于验证框架/错误封装/设置持久化/CORS/HTTP ping。

use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::error::{ApiError, ApiResult};
use crate::models::*;
use crate::settings;
use crate::settings::SettingsResponse;
use crate::state::SharedState;

const PING_TIMEOUT: Duration = Duration::from_secs(5);

const DOWNLOAD_SOURCES: &[(i32, &str, &str)] = &[
    (0, "官方源", "https://libraries.minecraft.net"),
    (1, "BMCLAPI 镜像", "https://bmclapi2.bangbang93.com"),
];

const MOD_SOURCES: &[(i32, &str, &str)] = &[
    (0, "Modrinth 官方", "https://api.modrinth.com/v2/statistics"),
    (1, "MCIM 镜像", "https://mod.mcimirror.top/statistics?modrinth=true"),
];

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/health", get(health))
        .route("/diagnostics/health", get(diagnostics_health))
        .route("/diagnostics/trace", get(diagnostics_trace))
        .route("/diagnostics/dump", post(diagnostics_dump))
        .route("/system/info", get(sysinfo))
        .route("/systeminfo", get(sysinfo))
        .route("/system/open-url", post(open_url))
        .route("/settings", get(get_settings).put(put_settings))
        .route("/settings/data-dir", get(get_data_dir).put(put_data_dir))
        .route("/settings/open-folder", post(open_folder))
        .route("/settings/open-backgrounds", post(open_backgrounds))
        .route("/settings/backgrounds", get(list_backgrounds))
        .route("/settings/backgrounds/{name}", get(get_background))
        .route("/settings/download-sources/ping", get(ping_download_sources))
        .route("/settings/mod-sources/ping", get(ping_mod_sources))
        .route(
            "/settings/download-source/auto-select",
            get(auto_select_download_source),
        )
        .route(
            "/settings/mod-source/auto-select",
            get(auto_select_mod_source),
        )
}

async fn health() -> ApiResult<Json<HealthResponse>> {
    Ok(Json(HealthResponse {
        status: "OK".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    }))
}

async fn diagnostics_health(State(state): State<SharedState>) -> ApiResult<Json<DiagnosticsHealthResponse>> {
    let (modrinth_ok, modrinth_lat) = ping_get(&state.http_client, "https://api.modrinth.com/v2/statistics").await;
    let (cf_ok, cf_lat) = ping_get(&state.http_client, "https://api.curseforge.com").await;
    Ok(Json(DiagnosticsHealthResponse {
        backend: true,
        modrinth: PingResult { ok: modrinth_ok, latency: modrinth_lat },
        curseforge: PingResult { ok: cf_ok, latency: cf_lat },
    }))
}

/// GET /api/diagnostics/trace — 返回内存 trace 缓冲快照（对应 C# TraceBufferStore.Snapshot）。
async fn diagnostics_trace(State(state): State<SharedState>) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(state.trace_buffer.snapshot()))
}

/// POST /api/diagnostics/dump — 将缓冲 dump 到 `{BaseDir}/logs/backend-trace-*.log`，返回路径。
async fn diagnostics_dump(State(state): State<SharedState>) -> ApiResult<Json<OpenPathResponse>> {
    let path = state
        .trace_dump
        .dump("manual")
        .map_err(ApiError::from)?;
    Ok(Json(OpenPathResponse {
        path: path.to_string_lossy().into_owned(),
    }))
}

async fn sysinfo() -> ApiResult<Json<SystemInfoResponse>> {
    let (total, avail) = crate::util::sysinfo::memory();
    let git_commit = option_env!("QOMICEX_GIT_HASH").unwrap_or("unknown").to_string();
    Ok(Json(SystemInfoResponse {
        os: crate::util::sysinfo::os_name().to_string(),
        architecture: crate::util::sysinfo::architecture(),
        os_name: crate::util::sysinfo::os_description(),
        os_version: crate::util::sysinfo::os_version(),
        os_version_id: crate::util::sysinfo::os_version_id(),
        os_display_name: crate::util::sysinfo::os_display_name(),
        git_commit,
        memory: total as i64,
        available_memory: avail as i64,
    }))
}

async fn open_url(Json(body): Json<OpenUrlRequest>) -> ApiResult<StatusCode> {
    let url = body.url.trim();
    if url.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ApiError::bad_request("BAD_REQUEST", "Invalid URL"));
    }
    open::that_detached(url).map_err(|_| ApiError::bad_request("BAD_REQUEST", "Failed to open URL"))?;
    Ok(StatusCode::OK)
}

async fn get_settings() -> ApiResult<Json<SettingsResponse>> {
    Ok(Json(settings::load_settings()))
}

async fn put_settings(Json(body): Json<SettingsResponse>) -> ApiResult<StatusCode> {
    settings::save_settings(&body)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_data_dir(State(state): State<SharedState>) -> ApiResult<Json<DataDirResponse>> {
    Ok(Json(DataDirResponse {
        path: state.data_dir.to_string_lossy().into_owned(),
    }))
}

async fn put_data_dir(Json(body): Json<DataDirRequest>) -> ApiResult<Json<DataDirResponse>> {
    if body.path.trim().is_empty() {
        return Err(ApiError::bad_request("INVALID_PATH", "Data directory path cannot be empty"));
    }
    settings::set_base_dir(&body.path)?;
    Ok(Json(DataDirResponse { path: body.path }))
}

async fn open_folder(Json(body): Json<OpenPathRequest>) -> ApiResult<StatusCode> {
    let mut path = body.path.trim().to_string();
    if path.is_empty() {
        return Ok(StatusCode::BAD_REQUEST);
    }
    if std::path::Path::new(&path).is_relative() {
        path = std::env::current_dir()
            .map(|c| c.join(&path).to_string_lossy().into_owned())
            .unwrap_or(path);
    }
    let _ = std::fs::create_dir_all(&path);
    let _ = open::that_detached(&path);
    Ok(StatusCode::OK)
}

async fn open_backgrounds() -> ApiResult<StatusCode> {
    let dir = backgrounds_dir();
    std::fs::create_dir_all(&dir)?;
    let _ = open::that_detached(&dir);
    Ok(StatusCode::OK)
}

async fn list_backgrounds() -> ApiResult<Json<Vec<String>>> {
    let dir = backgrounds_dir();
    std::fs::create_dir_all(&dir)?;
    let mut files: Vec<String> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .collect();
    files.sort();
    Ok(Json(files))
}

async fn get_background(AxumPath(name): AxumPath<String>) -> ApiResult<Response> {
    let path = backgrounds_dir().join(&name);
    if !path.is_file() {
        return Err(ApiError::not_found("BACKGROUND_NOT_FOUND", "Background image not found"));
    }
    let bytes = std::fs::read(&path)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/png")],
        bytes,
    )
        .into_response())
}

async fn ping_download_sources() -> ApiResult<Json<Vec<DownloadSourcePing>>> {
    let mut results = Vec::with_capacity(DOWNLOAD_SOURCES.len());
    for (id, name, url) in DOWNLOAD_SOURCES {
        let (lat, ok) = ping_head(url).await;
        results.push(DownloadSourcePing {
            id: *id,
            name: name.to_string(),
            url: url.to_string(),
            latency: lat,
            ok,
        });
    }
    Ok(Json(results))
}

async fn ping_mod_sources() -> ApiResult<Json<Vec<ModSourcePing>>> {
    let mut results = Vec::with_capacity(MOD_SOURCES.len());
    for (id, name, url) in MOD_SOURCES {
        let (ok, lat) = ping_get_fast(url).await;
        results.push(ModSourcePing {
            id: *id,
            name: name.to_string(),
            url: url.to_string(),
            ok,
            latency: lat,
            can_connect: ok,
        });
    }
    Ok(Json(results))
}

async fn auto_select_download_source() -> ApiResult<Json<AutoSelectResponse>> {
    let mut best_id = 0;
    let mut best_latency = i64::MAX;
    for (id, _, url) in DOWNLOAD_SOURCES {
        let (lat, ok) = ping_head(url).await;
        if ok && lat < best_latency {
            best_latency = lat;
            best_id = *id;
        }
    }
    auto_select_update(|s| s.download_source = best_id);
    Ok(Json(AutoSelectResponse {
        id: best_id,
        latency_ms: if best_latency == i64::MAX { -1 } else { best_latency },
    }))
}

async fn auto_select_mod_source() -> ApiResult<Json<AutoSelectResponse>> {
    let mut best_id = 0;
    let mut best_latency = i64::MAX;
    for (id, _, url) in MOD_SOURCES {
        let (ok, lat) = ping_get_fast(url).await;
        if ok && lat < best_latency {
            best_latency = lat;
            best_id = *id;
        }
    }
    auto_select_update(|s| s.mod_mirror = best_id);
    Ok(Json(AutoSelectResponse {
        id: best_id,
        latency_ms: if best_latency == i64::MAX { -1 } else { best_latency },
    }))
}

fn auto_select_update(f: impl FnOnce(&mut SettingsResponse)) {
    let mut settings_now = settings::load_settings();
    f(&mut settings_now);
    let _ = settings::save_settings(&settings_now);
}

fn backgrounds_dir() -> std::path::PathBuf {
    settings::resolve_base_dir().join("QML").join("backgrounds")
}

async fn ping_head(url: &str) -> (i64, bool) {
    let client = match reqwest::Client::builder().timeout(PING_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => return (-1, false),
    };
    let sw = Instant::now();
    match client.head(url).send().await {
        Ok(resp) => (sw.elapsed().as_millis() as i64, resp.status().is_success()),
        Err(_) => (-1, false),
    }
}

async fn ping_get(client: &reqwest::Client, url: &str) -> (bool, i64) {
    let sw = Instant::now();
    match client.get(url).send().await {
        Ok(resp) => (resp.status().is_success(), sw.elapsed().as_millis() as i64),
        Err(_) => (false, -1),
    }
}

async fn ping_get_fast(url: &str) -> (bool, i64) {
    let client = match reqwest::Client::builder().timeout(PING_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => return (false, -1),
    };
    let sw = Instant::now();
    match client.get(url).send().await {
        Ok(resp) => (resp.status().is_success(), sw.elapsed().as_millis() as i64),
        Err(_) => (false, -1),
    }
}
