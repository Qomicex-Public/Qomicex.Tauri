//! System 端点（对应源 Endpoints/SystemEndpoints.cs）。
//! 自包含切片：无需额外服务注入，用于验证框架/错误封装/设置持久化/CORS/HTTP ping。

use std::convert::Infallible;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::StreamExt;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::error::{ApiError, ApiResult};
use crate::models::*;
use crate::settings;
use crate::settings::SettingsResponse;
use crate::state::SharedState;

/// ping 单源超时：所有 ping 端点并行执行，单个源 5s 内必须返回。
/// 实测 Modrinth 官方 API 约 3.1s，3s 超时会误判不可用。
const PING_TIMEOUT: Duration = Duration::from_secs(5);

/// 共享 ping client（短超时）。一次构建全局复用连接池，
/// 避免 `ping_head`/`ping_get_fast` 每次请求新建 client。
fn ping_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(PING_TIMEOUT)
            .user_agent(crate::state::USER_AGENT)
            .build()
            .expect("构建 ping client 失败")
    })
}

const DOWNLOAD_SOURCES: &[(i32, &str, &str)] = &[
    // 官方源 ping 目标用真实存在的库文件：根路径 HEAD 恒 404，会误判不可用
    (
        0,
        "官方源",
        "https://libraries.minecraft.net/org/ow2/asm/asm/9.6/asm-9.6.jar",
    ),
    (1, "BMCLAPI 镜像", "https://bmclapi2.bangbang93.com"),
];

const MOD_SOURCES: &[(i32, &str, &str)] = &[
    (0, "Modrinth 官方", "https://api.modrinth.com/v2/statistics"),
    (
        1,
        "MCIM 镜像",
        "https://mod.mcimirror.top/statistics?modrinth=true",
    ),
];

/// 资源（mod 文件 CDN）下载源。ping 目标用各自文件 CDN 的根地址；QML Mirror 是用户
/// 自建镜像（modrinth.lenmei233.dpdns.org 替换 cdn.modrinth.com / cdn-alt.modrinth.com，
/// mirror.lenmei233.dpdns.org 替换 mediafilez.forgecdn.net），QML Mirror HK 同但域名换成
/// modrinth.qomicex.dpdns.org / mirror.qomicex.dpdns.org。
const FILE_DOWNLOAD_SOURCES: &[(i32, &str, &str)] = &[
    (0, "官方源", "https://cdn.modrinth.com"),
    (1, "QML Mirror", "https://modrinth.lenmei233.dpdns.org"),
    (2, "QML Mirror HK", "https://modrinth.qomicex.dpdns.org"),
];

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/health", get(health))
        .route("/diagnostics/health", get(diagnostics_health))
        .route("/diagnostics/trace", get(diagnostics_trace))
        .route("/diagnostics/trace/stream", get(diagnostics_trace_stream))
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
        .route("/settings/fonts", get(list_system_fonts))
        .route(
            "/settings/download-sources/ping",
            get(ping_download_sources),
        )
        .route("/settings/mod-sources/ping", get(ping_mod_sources))
        .route(
            "/settings/file-download-sources/ping",
            get(ping_file_download_sources),
        )
        .route(
            "/settings/download-source/auto-select",
            get(auto_select_download_source),
        )
        .route(
            "/settings/mod-source/auto-select",
            get(auto_select_mod_source),
        )
        .route(
            "/settings/file-download-source/auto-select",
            get(auto_select_file_download_source),
        )
        .route(
            "/settings/clear-curseforge-cache",
            post(clear_curseforge_cache),
        )
        .route("/settings/clear-neoforge-cache", post(clear_neoforge_cache))
        .route("/settings/clear-cache", post(clear_cache_files))
        .route("/settings/clear-ftb-cache", post(clear_ftb_cache))
        .route(
            "/settings/clear-mods-list-cache",
            post(clear_mods_list_cache),
        )
        .route(
            "/settings/clear-mod-updates-cache",
            post(clear_mod_updates_cache),
        )
        .route("/settings/clear-modpack-temp", post(clear_modpack_temp))
        .route("/settings/cache-stats", get(cache_stats))
        .route(
            "/process/{pid}/resource-usage",
            get(get_process_resource_usage),
        )
}

async fn health() -> ApiResult<Json<HealthResponse>> {
    Ok(Json(HealthResponse {
        status: "OK".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    }))
}

async fn diagnostics_health() -> ApiResult<Json<DiagnosticsHealthResponse>> {
    // 并行 ping（tokio::join!），避免串行时慢源阻塞整个诊断端点
    let (modrinth, curseforge) = tokio::join!(
        ping_get_fast("https://api.modrinth.com/v2/statistics"),
        ping_get_fast("https://api.curseforge.com"),
    );
    Ok(Json(DiagnosticsHealthResponse {
        backend: true,
        modrinth: PingResult {
            ok: modrinth.0,
            latency: modrinth.1,
        },
        curseforge: PingResult {
            ok: curseforge.0,
            latency: curseforge.1,
        },
    }))
}

/// GET /api/diagnostics/trace — 返回内存 trace 缓冲快照（对应 C# TraceBufferStore.Snapshot）。
async fn diagnostics_trace(State(state): State<SharedState>) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(state.trace_buffer.snapshot()))
}

/// GET /api/diagnostics/trace/stream — SSE 实时 trace 流：先推当前缓冲快照（逐行），
/// 再推送新追加行（`trace_append` 广播）。供 `qomicex debug` / 日志面板实时查看后端日志。
async fn diagnostics_trace_stream(State(state): State<SharedState>) -> Response {
    let tx = crate::services::trace::trace_broadcast();
    let snapshot = state.trace_buffer.snapshot();
    let initial = futures::stream::iter(
        snapshot
            .into_iter()
            .map(|line| Ok::<Event, Infallible>(Event::default().data(line))),
    );
    let live = futures::stream::unfold(tx.subscribe(), |mut rx| async move {
        match rx.recv().await {
            Ok(line) => Some((Ok::<Event, Infallible>(Event::default().data(line)), rx)),
            Err(broadcast::error::RecvError::Lagged(_)) => Some((
                Ok::<Event, Infallible>(
                    Event::default().data("[trace] 日志过密，丢弃部分行".to_string()),
                ),
                rx,
            )),
            Err(broadcast::error::RecvError::Closed) => None,
        }
    });
    Sse::new(initial.chain(live))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

/// POST /api/diagnostics/dump — 将缓冲 dump 到 `{BaseDir}/logs/backend-trace-*.log`，返回路径。
async fn diagnostics_dump(State(state): State<SharedState>) -> ApiResult<Json<OpenPathResponse>> {
    let path = state.trace_dump.dump("manual").map_err(ApiError::from)?;
    Ok(Json(OpenPathResponse {
        path: path.to_string_lossy().into_owned(),
    }))
}

async fn sysinfo() -> ApiResult<Json<SystemInfoResponse>> {
    let (total, avail) = crate::util::sysinfo::memory();
    let git_commit = option_env!("QOMICEX_GIT_HASH")
        .unwrap_or("unknown")
        .to_string();
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
    open::that_detached(url)
        .map_err(|_| ApiError::bad_request("BAD_REQUEST", "Failed to open URL"))?;
    Ok(StatusCode::OK)
}

async fn get_settings() -> ApiResult<Json<SettingsResponse>> {
    Ok(Json(settings::load_settings()))
}

async fn put_settings(
    State(state): State<SharedState>,
    Json(mut body): Json<SettingsResponse>,
) -> ApiResult<StatusCode> {
    // 在边界处规范化：这些值会被拿去构造 Semaphore / Duration，越界值必须在落盘前
    // 就钳住，否则一个手改的 settings.json 或一次直连 API 调用就能让后续请求 panic。
    body.clamp_numeric_ranges();

    settings::save_settings(&body)?;
    state
        .curseforge_fetch
        .set_config(body.curseforge_fetch_config());
    // 下载管理器相关的（HTTP/3 开关 / 下载线程数 / 分片数 / 代理 / 忽略 SSL）任一变化 →
    // 热替换下载管理器（旧管理器进行中的任务被取消），使新值立即生效。
    let rebuild_download_manager = {
        let old = state.settings.read().await;
        old.enable_http3.unwrap_or(false) != body.enable_http3.unwrap_or(false)
            || old.download_threads != body.download_threads
            || old.file_chunk_threads != body.file_chunk_threads
            || old.proxy_mode != body.proxy_mode
            || old.proxy_host != body.proxy_host
            || old.ignore_ssl_cert.unwrap_or(false) != body.ignore_ssl_cert.unwrap_or(false)
            || old.http1_parallel != body.http1_parallel
    };
    *state.settings.write().await = body.clone();
    if rebuild_download_manager {
        state.replace_download_manager(&body);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn get_data_dir(State(state): State<SharedState>) -> ApiResult<Json<DataDirResponse>> {
    Ok(Json(DataDirResponse {
        path: state.data_dir.to_string_lossy().into_owned(),
    }))
}

async fn put_data_dir(Json(body): Json<DataDirRequest>) -> ApiResult<Json<DataDirResponse>> {
    if body.path.trim().is_empty() {
        return Err(ApiError::bad_request(
            "INVALID_PATH",
            "Data directory path cannot be empty",
        ));
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
        path = crate::settings::resolve_base_dir()
            .join(&path)
            .to_string_lossy()
            .into_owned();
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
        return Err(ApiError::not_found(
            "BACKGROUND_NOT_FOUND",
            "Background image not found",
        ));
    }
    let bytes = std::fs::read(&path)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, background_content_type(&name))],
        bytes,
    )
        .into_response())
}

/// 按扩展名返回背景资源的 MIME 类型。支持静态图片、动图（GIF/APNG/动态 WebP）
/// 与视频（MP4/WebM）；未知扩展名回退 `application/octet-stream`。
fn background_content_type(name: &str) -> &'static str {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "apng" => "image/apng",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

async fn ping_download_sources() -> ApiResult<Json<Vec<DownloadSourcePing>>> {
    // 并行 ping 全部源（join_all 保序），总耗时 = 最慢单源 ≤ PING_TIMEOUT
    let pings =
        futures::future::join_all(DOWNLOAD_SOURCES.iter().map(|(_, _, url)| ping_head(url))).await;
    let mut results = Vec::with_capacity(DOWNLOAD_SOURCES.len());
    for ((id, name, url), (lat, ok)) in DOWNLOAD_SOURCES.iter().zip(pings) {
        results.push(DownloadSourcePing {
            id: *id,
            name: (*name).to_string(),
            url: (*url).to_string(),
            latency: lat,
            ok,
        });
    }
    Ok(Json(results))
}

async fn ping_mod_sources() -> ApiResult<Json<Vec<ModSourcePing>>> {
    let pings =
        futures::future::join_all(MOD_SOURCES.iter().map(|(_, _, url)| ping_get_fast(url))).await;
    let mut results = Vec::with_capacity(MOD_SOURCES.len());
    for ((id, name, url), (ok, lat)) in MOD_SOURCES.iter().zip(pings) {
        results.push(ModSourcePing {
            id: *id,
            name: (*name).to_string(),
            url: (*url).to_string(),
            ok,
            latency: lat,
            can_connect: ok,
        });
    }
    Ok(Json(results))
}

async fn ping_file_download_sources() -> ApiResult<Json<Vec<DownloadSourcePing>>> {
    let pings = futures::future::join_all(
        FILE_DOWNLOAD_SOURCES
            .iter()
            .map(|(_, _, url)| ping_head(url)),
    )
    .await;
    let mut results = Vec::with_capacity(FILE_DOWNLOAD_SOURCES.len());
    for ((id, name, url), (lat, ok)) in FILE_DOWNLOAD_SOURCES.iter().zip(pings) {
        results.push(DownloadSourcePing {
            id: *id,
            name: (*name).to_string(),
            url: (*url).to_string(),
            latency: lat,
            ok,
        });
    }
    Ok(Json(results))
}

async fn auto_select_download_source() -> ApiResult<Json<AutoSelectResponse>> {
    let pings =
        futures::future::join_all(DOWNLOAD_SOURCES.iter().map(|(_, _, url)| ping_head(url))).await;
    let mut best_id = 0;
    let mut best_latency = i64::MAX;
    for ((id, _, _), (lat, ok)) in DOWNLOAD_SOURCES.iter().zip(pings) {
        if ok && lat < best_latency {
            best_latency = lat;
            best_id = *id;
        }
    }
    auto_select_update(|s| s.download_source = best_id);
    Ok(Json(AutoSelectResponse {
        id: best_id,
        latency_ms: if best_latency == i64::MAX {
            -1
        } else {
            best_latency
        },
    }))
}

async fn auto_select_mod_source() -> ApiResult<Json<AutoSelectResponse>> {
    let pings =
        futures::future::join_all(MOD_SOURCES.iter().map(|(_, _, url)| ping_get_fast(url))).await;
    let mut best_id = 0;
    let mut best_latency = i64::MAX;
    for ((id, _, _), (ok, lat)) in MOD_SOURCES.iter().zip(pings) {
        if ok && lat < best_latency {
            best_latency = lat;
            best_id = *id;
        }
    }
    auto_select_update(|s| s.mod_mirror = best_id);
    Ok(Json(AutoSelectResponse {
        id: best_id,
        latency_ms: if best_latency == i64::MAX {
            -1
        } else {
            best_latency
        },
    }))
}

async fn auto_select_file_download_source() -> ApiResult<Json<AutoSelectResponse>> {
    let pings = futures::future::join_all(
        FILE_DOWNLOAD_SOURCES
            .iter()
            .map(|(_, _, url)| ping_head(url)),
    )
    .await;
    let mut best_id = 0;
    let mut best_latency = i64::MAX;
    for ((id, _, _), (lat, ok)) in FILE_DOWNLOAD_SOURCES.iter().zip(pings) {
        if ok && lat < best_latency {
            best_latency = lat;
            best_id = *id;
        }
    }
    auto_select_update(|s| s.file_download_source = best_id);
    Ok(Json(AutoSelectResponse {
        id: best_id,
        latency_ms: if best_latency == i64::MAX {
            -1
        } else {
            best_latency
        },
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

/// 系统字体列表缓存（fontdb 首次扫描系统字体目录较慢，进程内缓存一次）。
fn system_fonts() -> &'static Vec<String> {
    static FONTS: OnceLock<Vec<String>> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families: Vec<String> = db
            .faces()
            .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
            .collect();
        families.sort();
        families.dedup();
        families
    })
}

/// GET /api/settings/fonts — 系统已安装字体家族名（去重、排序），供外观设置选择。
async fn list_system_fonts() -> ApiResult<Json<Vec<String>>> {
    Ok(Json(system_fonts().clone()))
}

async fn ping_head(url: &str) -> (i64, bool) {
    let sw = Instant::now();
    match ping_client().head(url).send().await {
        Ok(resp) => (sw.elapsed().as_millis() as i64, resp.status().is_success()),
        Err(_) => (-1, false),
    }
}

async fn ping_get_fast(url: &str) -> (bool, i64) {
    let sw = Instant::now();
    match ping_client().get(url).send().await {
        Ok(resp) => (resp.status().is_success(), sw.elapsed().as_millis() as i64),
        Err(_) => (false, -1),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearCurseForgeCacheResponse {
    deleted: usize,
}

async fn clear_curseforge_cache(
    State(state): State<SharedState>,
) -> ApiResult<Json<ClearCurseForgeCacheResponse>> {
    let deleted = state.curseforge_fetch.clear_cache();
    Ok(Json(ClearCurseForgeCacheResponse { deleted }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearNeoForgeCacheResponse {
    deleted: usize,
}

/// 清理 NeoForge 版本缓存（%TEMP%/NeoForgeVersionCache/ 下所有 .json 文件）。
async fn clear_neoforge_cache() -> ApiResult<Json<ClearNeoForgeCacheResponse>> {
    let cache_dir = std::env::temp_dir().join("NeoForgeVersionCache");
    let deleted = delete_files_in_dir(&cache_dir, "json");
    Ok(Json(ClearNeoForgeCacheResponse { deleted }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearCacheResponse {
    deleted: usize,
}

/// 递归统计并删除目录下指定扩展名的文件；目录不存在返回 0。
fn delete_files_in_dir(dir: &std::path::Path, ext: &str) -> usize {
    let mut deleted = 0usize;
    if dir.is_dir() {
        if let Ok(entries) = walk_dir_files(dir) {
            for path in entries {
                if path.extension().and_then(|e| e.to_str()) == Some(ext)
                    && std::fs::remove_file(&path).is_ok()
                {
                    deleted += 1;
                }
            }
        }
    }
    deleted
}

/// 递归删除目录下全部文件（含子目录内），返回删除数量。
fn delete_all_files_in_dir(dir: &std::path::Path) -> usize {
    let mut deleted = 0usize;
    if dir.is_dir() {
        if let Ok(entries) = walk_dir_files(dir) {
            for path in entries {
                if std::fs::remove_file(&path).is_ok() {
                    deleted += 1;
                }
            }
        }
    }
    deleted
}

/// 递归收集目录下的所有文件路径（不进入无法读取的子目录）。
fn walk_dir_files(dir: &std::path::Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    Ok(out)
}

/// POST /api/settings/clear-cache — 清理 Forge 版本列表 HTML 缓存
/// （%TEMP%/ForgeVersionCache/，core `get_cache_file_path` 落盘位置）。
async fn clear_cache_files() -> ApiResult<Json<ClearCacheResponse>> {
    let cache_dir = std::env::temp_dir().join("ForgeVersionCache");
    let deleted = delete_files_in_dir(&cache_dir, "html");
    Ok(Json(ClearCacheResponse { deleted }))
}

/// POST /api/settings/clear-ftb-cache — 清理 FTB 整合包市场缓存
/// （{BaseDir}/QML/cache/ftb/ftb_cache.json，core FtbBase 落盘位置）。
async fn clear_ftb_cache(State(state): State<SharedState>) -> ApiResult<Json<ClearCacheResponse>> {
    let cache_dir = state.data_dir.join("QML").join("cache").join("ftb");
    let deleted = delete_files_in_dir(&cache_dir, "json");
    Ok(Json(ClearCacheResponse { deleted }))
}

/// POST /api/settings/clear-mods-list-cache — 清理所有实例的模组列表缓存
/// （{BaseDir}/QML/mods-cache/*.json，6h TTL）。
async fn clear_mods_list_cache(
    State(state): State<SharedState>,
) -> ApiResult<Json<ClearCacheResponse>> {
    let cache_dir = state.data_dir.join("QML").join("mods-cache");
    let deleted = delete_files_in_dir(&cache_dir, "json");
    Ok(Json(ClearCacheResponse { deleted }))
}

/// POST /api/settings/clear-mod-updates-cache — 清理所有实例的模组更新检查缓存
/// （{BaseDir}/QML/mods-update-cache/*.json，6h TTL）。
async fn clear_mod_updates_cache(
    State(state): State<SharedState>,
) -> ApiResult<Json<ClearCacheResponse>> {
    let cache_dir = state.data_dir.join("QML").join("mods-update-cache");
    let deleted = delete_files_in_dir(&cache_dir, "json");
    Ok(Json(ClearCacheResponse { deleted }))
}

/// POST /api/settings/clear-modpack-temp — 清理整合包导入临时文件
/// （{BaseDir}/temp/ 下 modpack-uploads / multimc-imports 及超期残留）。
async fn clear_modpack_temp(
    State(state): State<SharedState>,
) -> ApiResult<Json<ClearCacheResponse>> {
    let temp_dir = state.data_dir.join("temp");
    let mut deleted = delete_all_files_in_dir(&temp_dir.join("modpack-uploads"));
    deleted += delete_all_files_in_dir(&temp_dir.join("multimc-imports"));
    Ok(Json(ClearCacheResponse { deleted }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheDirStats {
    files: u64,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStatsResponse {
    forge_versions: CacheDirStats,
    neoforge: CacheDirStats,
    ftb: CacheDirStats,
    mods_list: CacheDirStats,
    mod_updates: CacheDirStats,
    modpack_temp: CacheDirStats,
}

/// 递归统计目录下指定扩展名文件的数量与总大小（字节）；目录不存在返回 0。
fn stat_files_in_dir(dir: &std::path::Path, ext: &str) -> CacheDirStats {
    let mut stats = CacheDirStats { files: 0, bytes: 0 };
    if dir.is_dir() {
        if let Ok(entries) = walk_dir_files(dir) {
            for path in entries {
                if path.extension().and_then(|e| e.to_str()) == Some(ext) {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        stats.files += 1;
                        stats.bytes += meta.len();
                    }
                }
            }
        }
    }
    stats
}

/// 递归统计目录下全部文件的数量与总大小（字节）；目录不存在返回 0。
fn stat_all_files_in_dir(dir: &std::path::Path) -> CacheDirStats {
    let mut stats = CacheDirStats { files: 0, bytes: 0 };
    if dir.is_dir() {
        if let Ok(entries) = walk_dir_files(dir) {
            for path in entries {
                if let Ok(meta) = std::fs::metadata(&path) {
                    stats.files += 1;
                    stats.bytes += meta.len();
                }
            }
        }
    }
    stats
}

/// GET /api/settings/cache-stats — 各磁盘缓存的文件数与总大小（字节），
/// 与各 clear-* 端点的清理范围一一对应。
async fn cache_stats(State(state): State<SharedState>) -> ApiResult<Json<CacheStatsResponse>> {
    let temp = std::env::temp_dir();
    let uploads = stat_all_files_in_dir(&state.data_dir.join("temp").join("modpack-uploads"));
    let imports = stat_all_files_in_dir(&state.data_dir.join("temp").join("multimc-imports"));
    Ok(Json(CacheStatsResponse {
        forge_versions: stat_files_in_dir(&temp.join("ForgeVersionCache"), "html"),
        neoforge: stat_files_in_dir(&temp.join("NeoForgeVersionCache"), "json"),
        ftb: stat_files_in_dir(
            &state.data_dir.join("QML").join("cache").join("ftb"),
            "json",
        ),
        mods_list: stat_files_in_dir(&state.data_dir.join("QML").join("mods-cache"), "json"),
        mod_updates: stat_files_in_dir(
            &state.data_dir.join("QML").join("mods-update-cache"),
            "json",
        ),
        modpack_temp: CacheDirStats {
            files: uploads.files + imports.files,
            bytes: uploads.bytes + imports.bytes,
        },
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessResourceUsageResponse {
    pid: i32,
    cpu_usage: f32,
    memory_usage: u64,
    memory_usage_mb: f64,
}

/// 获取指定进程的资源使用情况（CPU/内存）。
/// 用于运行中游戏的实时监控。
async fn get_process_resource_usage(
    AxumPath(pid): AxumPath<i32>,
) -> ApiResult<Json<ProcessResourceUsageResponse>> {
    if pid <= 0 {
        return Err(ApiError::bad_request(
            "INVALID_PID",
            "PID must be a positive integer",
        ));
    }

    let mut sys = sysinfo::System::new();
    let syspid = sysinfo::Pid::from_u32(pid as u32);

    // 进程 CPU 使用率是两次采样间的差值：先刷新建立基线，等待最小采样间隔后
    // 再次刷新，`cpu_usage()` 才有效（单次刷新恒为 0）。
    sys.refresh_process(syspid);
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    sys.refresh_process(syspid);

    let process = sys.process(syspid).ok_or_else(|| {
        ApiError::not_found(
            "PROCESS_NOT_FOUND",
            &format!("Process with PID {} not found", pid),
        )
    })?;

    // sysinfo 返回 0~100*ncpu（多核合计），归一化为整体占用百分比 0~100。
    let cpu_usage = (process.cpu_usage() / sys.cpus().len().max(1) as f32).clamp(0.0, 100.0);
    let memory_usage = process.memory(); // 字节

    Ok(Json(ProcessResourceUsageResponse {
        pid,
        cpu_usage,
        memory_usage,
        memory_usage_mb: memory_usage as f64 / (1024.0 * 1024.0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_and_delete_count_files_recursively() {
        let dir = std::env::temp_dir().join(format!("qml-cache-stats-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.json"), "12345").unwrap();
        std::fs::write(sub.join("b.json"), "1234567890").unwrap();
        std::fs::write(sub.join("c.txt"), "ignored").unwrap();

        let s = stat_files_in_dir(&dir, "json");
        assert_eq!(s.files, 2);
        assert_eq!(s.bytes, 15);

        let all = stat_all_files_in_dir(&dir);
        assert_eq!(all.files, 3);
        assert_eq!(all.bytes, 22);

        assert_eq!(delete_files_in_dir(&dir, "json"), 2);
        assert_eq!(delete_all_files_in_dir(&dir), 1);
        assert!(stat_all_files_in_dir(&dir).files == 0);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(stat_files_in_dir(&dir.join("nonexistent"), "json").files, 0);
    }
}
