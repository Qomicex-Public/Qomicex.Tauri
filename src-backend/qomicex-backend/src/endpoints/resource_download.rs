//! Resource download endpoints (source: Endpoints/ResourceDownloadEndpoints.cs).
//!
//! Implements download task start, progress, cancel and batch-cancel for
//! the resource flavours (mods / resourcepacks / shaderpacks / datapacks /
//! saves / screenshots) plus a generic "download to a fixed path" variant.
//!
//! Actual downloading is delegated to the shared `state.download_manager`
//! (qomicex_downloader::DownloadManager). Task ids reported to the frontend
//! are the downloader's `TaskId` (u64) serialized as a decimal string so the
//! wire contract stays a string, as in the C# original.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use qomicex_downloader::{DownloadEvent, DownloadManager, DownloadTask, TaskId, TaskState};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::settings;
use crate::state::SharedState;

// =====================================================================
// DTO (camelCase, mirroring the C# records)
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartDownloadRequest {
    instance_id: String,
    url: String,
    file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelBatchRequest {
    task_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadStartResponse {
    task_id: String,
    file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    status: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressResponse {
    progress: f64,
    downloaded_bytes: u64,
    total_bytes: u64,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadToRequest {
    url: String,
    target_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadToResponse {
    task_id: String,
    path: String,
}

// =====================================================================
// Progress bridge
// =====================================================================

/// Cached snapshot of a downloader task, fed from the download event stream.
/// The downloader only exposes `state(id) -> TaskState`; downloaded/total
/// bytes and failure detail are delivered via `subscribe()`. A single
/// background watcher subscribes once and keeps this map up to date so the
/// progress endpoint can answer without holding per-task subscribers.
#[derive(Clone)]
pub(crate) struct TaskSnapshot {
    pub(crate) status: String,
    pub(crate) downloaded: u64,
    pub(crate) total: u64,
    pub(crate) speed: u64,
    pub(crate) error: Option<String>,
    pub(crate) file_name: Option<String>,
}

/// Snapshot of all tracked download tasks (id -> snapshot), for the progress
/// SSE stream so the download center reflects live resource-download states.
pub(crate) fn download_snapshots() -> Vec<(u64, TaskSnapshot)> {
    task_registry()
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| (*id, s.clone()))
        .collect()
}

fn task_registry() -> &'static Mutex<HashMap<TaskId, TaskSnapshot>> {
    static REGISTRY: OnceLock<Mutex<HashMap<TaskId, TaskSnapshot>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Install the one-off background subscriber that mirrors downloader events
/// into the task registry. Returns immediately if already installed.
fn ensure_watcher(manager: Arc<DownloadManager>) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let mut rx = manager.subscribe();
        loop {
            match rx.recv().await {
                Ok(DownloadEvent::Progress {
                    id,
                    downloaded,
                    total,
                    speed_bps,
                    ..
                }) => {
                    let mut reg = task_registry().lock().unwrap();
                    if let Some(s) = reg.get_mut(&id) {
                        s.downloaded = downloaded;
                        s.total = total;
                        s.speed = speed_bps;
                        if total > 0 {
                            s.status = status_of(TaskState::Downloading).to_string();
                        }
                    }
                }
                Ok(DownloadEvent::StateChanged { id, state, detail }) => {
                    let status = status_of(state).to_string();
                    let error = if state == TaskState::Failed {
                        detail
                    } else {
                        None
                    };
                    if let Some(s) = task_registry().lock().unwrap().get_mut(&id) {
                        s.status = status;
                        s.error = error;
                        // 完成时把已下载字节同步为总大小（最后一个进度 tick 可能与
                        // 完成存在节流竞态，导致快照停在未满值）。
                        if state == TaskState::Completed && s.total > 0 {
                            s.downloaded = s.total;
                        }
                        // 终态下速度必须归零，否则快照会永久残留最后一次的瞬时速度，
                        // 每个 SSE 消费者都得各自在客户端补这一下。
                        if matches!(
                            state,
                            TaskState::Completed | TaskState::Failed | TaskState::Cancelled
                        ) {
                            s.speed = 0;
                        }
                    }
                }
                Ok(DownloadEvent::GlobalProgress { .. } | DownloadEvent::Log { .. }) => {}
                Err(_) => break,
            }
        }
    });
}

/// Map a downloader TaskState to the C# session status strings.
fn status_of(state: TaskState) -> &'static str {
    match state {
        TaskState::Queued => "queued",
        TaskState::Downloading => "downloading",
        TaskState::Paused => "paused",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Cancelled => "cancelled",
    }
}

/// Resolve the per-task (or not-found) progress response.
fn build_progress(task_id: TaskId) -> DownloadProgressResponse {
    let reg = task_registry().lock().unwrap();
    let snapshot = reg.get(&task_id).cloned();
    drop(reg);

    match snapshot {
        Some(s) => {
            let progress = if s.total > 0 {
                (s.downloaded as f64 / s.total as f64) * 100.0
            } else if s.status == "completed" {
                100.0
            } else {
                0.0
            };
            DownloadProgressResponse {
                progress,
                downloaded_bytes: s.downloaded,
                total_bytes: s.total,
                status: s.status,
                error: s.error,
                file_name: s.file_name,
            }
        }
        // Unknown id: report not_found. The background watcher mirrors
        // DownloadEvent progress into the registry, so an id that never hit
        // the registry is outside this backend's task set. (Avoid awaiting
        // DownloadManager::state here: its future is not Send, which would
        // make this handler ineligible as an axum handler.)
        None => DownloadProgressResponse {
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            status: "not_found".to_string(),
            error: None,
            file_name: None,
        },
    }
}

// =====================================================================
// Router — prefix string `/api/resource-download` (matches C# MapGroup).
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/resource-download/start", post(start))
        .route("/resource/classify-file", post(classify_file))
        .route("/resource-download/download-to", post(download_to))
        .route("/resource-download/{taskId}/progress", get(progress))
        .route("/resource-download/{taskId}/cancel", post(cancel))
        .route("/resource-download/cancel-batch", post(cancel_batch))
}

// =====================================================================
// Handlers
// =====================================================================

/// POST /api/resource-download/start
/// Start downloading a resource file into the resolved target directory
/// (either the explicit targetPath or the instance's version-isolated dir).
async fn start(
    State(state): State<SharedState>,
    Json(req): Json<StartDownloadRequest>,
) -> ApiResult<Json<DownloadStartResponse>> {
    ensure_watcher(state.download_manager.load_full());

    let cat = match req.category.as_deref().map(|c| c.to_lowercase()).as_deref() {
        Some("resourcepacks" | "resourcepack") => "resourcepacks",
        Some("shaderpacks" | "shader") => "shaderpacks",
        Some("datapacks" | "datapack") => "datapacks",
        Some("saves" | "save") => "saves",
        Some("screenshots") => "screenshots",
        _ => "mods",
    };

    let target_dir: PathBuf = if let Some(tp) = &req.target_path {
        PathBuf::from(tp.trim())
    } else {
        let inst = state
            .instance
            .get_by_id(&req.instance_id)
            .ok_or_else(|| ApiError::not_found("INSTANCE_NOT_FOUND", "Instance not found"))?;
        let isolation = inst
            .version_isolation
            .unwrap_or_else(settings::get_global_version_isolation);
        let game_dir = if isolation {
            PathBuf::from(&inst.game_dir)
        } else {
            PathBuf::from(inst.resolved_game_dir.as_deref().unwrap_or(&inst.game_dir))
        };
        if isolation {
            game_dir.join("versions").join(&inst.name).join(cat)
        } else {
            game_dir.join(cat)
        }
    };

    std::fs::create_dir_all(&target_dir)?;

    // The C# Save flavour extracts the downloaded zip; that extraction is not
    // performed here (see TODOs below). Nothing else is specific to `saves`.
    let full_path = target_dir.join(&req.file_name);
    // 资源下载源：重写文件 CDN 域名（官方/QML Mirror）。api-key 按重写前的原始 host 判断。
    let download_url = crate::services::file_mirror::rewrite_file_cdn(
        &req.url,
        state.settings.read().await.file_download_source,
    );
    let mut task = DownloadTask::new(download_url, full_path);
    if is_cf_url(&req.url) && !state.curse_forge_api_key.is_empty() {
        task = task.with_header("x-api-key", state.curse_forge_api_key.clone());
    }

    let id = state.download_manager.load_full().add(task);

    let file_name = req.file_name.clone();
    {
        let mut reg = task_registry().lock().unwrap();
        reg.insert(
            id,
            TaskSnapshot {
                status: "queued".to_string(),
                downloaded: 0,
                total: 0,
                speed: 0,
                error: None,
                file_name: Some(file_name.clone()),
            },
        );
    }

    Ok(Json(DownloadStartResponse {
        task_id: id.to_string(),
        file_name,
    }))
}

/// POST /api/resource-download/download-to
/// Download a file to an explicit absolute path.
async fn download_to(
    State(state): State<SharedState>,
    Json(req): Json<DownloadToRequest>,
) -> ApiResult<Json<DownloadToResponse>> {
    ensure_watcher(state.download_manager.load_full());

    let target = PathBuf::from(req.target_path.trim());
    let target_dir = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&target_dir)?;

    let file_name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    // 资源下载源：重写文件 CDN 域名（官方/QML Mirror）。api-key 按重写前的原始 host 判断。
    let download_url = crate::services::file_mirror::rewrite_file_cdn(
        &req.url,
        state.settings.read().await.file_download_source,
    );
    let mut task = DownloadTask::new(download_url, target.clone());
    if is_cf_url(&req.url) && !state.curse_forge_api_key.is_empty() {
        task = task.with_header("x-api-key", state.curse_forge_api_key.clone());
    }

    let id = state.download_manager.load_full().add(task);

    let path = target.to_string_lossy().into_owned();
    {
        let mut reg = task_registry().lock().unwrap();
        reg.insert(
            id,
            TaskSnapshot {
                status: "queued".to_string(),
                downloaded: 0,
                total: 0,
                speed: 0,
                error: None,
                file_name: Some(file_name.clone()),
            },
        );
    }

    Ok(Json(DownloadToResponse {
        task_id: id.to_string(),
        path,
    }))
}

/// GET /api/resource-download/{taskId}/progress
async fn progress(
    State(_state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<DownloadProgressResponse>> {
    if let Ok(id) = task_id.parse::<TaskId>() {
        let resp = build_progress(id);
        if resp.status != "not_found" {
            return Ok(Json(resp));
        }
    }
    // Fallback: plugin-started downloads use a Guid string task id; the
    // download center also polls them through this endpoint when the SSE
    // channel has not yet delivered an entry.
    if let Some(json) = crate::endpoints::plugin::session_progress_json(&task_id) {
        let resp = serde_json::from_value::<DownloadProgressResponse>(json)
            .map_err(|_| ApiError::internal("invalid plugin session snapshot"))?;
        return Ok(Json(resp));
    }
    Ok(Json(DownloadProgressResponse {
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        status: "not_found".to_string(),
        error: None,
        file_name: None,
    }))
}

/// POST /api/resource-download/{taskId}/cancel
async fn cancel(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<StatusResponse>> {
    let id: TaskId = task_id.parse().map_err(|_| {
        ApiError::bad_request("INVALID_TASK_ID", "Task id must be a numeric string")
    })?;
    // Cancel is best-effort in the original: a missing task still replies
    // `{ status: "cancelled" }`. Ignore TaskNotFound here to match that.
    let _ = state.download_manager.load_full().cancel(id).await;
    Ok(Json(StatusResponse {
        status: "cancelled".to_string(),
    }))
}

/// POST /api/resource-download/cancel-batch
async fn cancel_batch(
    State(state): State<SharedState>,
    Json(req): Json<CancelBatchRequest>,
) -> ApiResult<Json<StatusResponse>> {
    let mut ids: Vec<TaskId> = Vec::with_capacity(req.task_ids.len());
    for raw in &req.task_ids {
        if let Ok(id) = raw.parse::<TaskId>() {
            ids.push(id);
        }
    }
    for id in ids {
        let _ = state.download_manager.load_full().cancel(id).await;
    }
    Ok(Json(StatusResponse {
        status: "cancelled".to_string(),
    }))
}

// =====================================================================
// Helpers
// =====================================================================

/// Detect CurseForge download hosts so the x-api-key header is attached.
///
/// The C# original stamps lowest-case host matches against forgecdn.net /
/// curseforge.com. A plain case-insensitive substring check reproduces that
/// behaviour without pulling in the `url` crate (keeps zero-new-deps).
fn is_cf_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("forgecdn.net") || lower.contains("curseforge.com")
}

// =====================================================================
// Local file classification (drag-and-drop install entry)
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyFileRequest {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyFileResponse {
    /// `modpack` | `mod` | `resourcepack` | `shaderpack` | `unknown`
    file_type: String,
    file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pack_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    game_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

/// POST /api/resource/classify-file — sniff a local file dropped onto the
/// launcher window and report its installable type plus modpack preview
/// metadata (name / game version / loader) for the confirm dialog.
///
/// Zip contents decide between the flavours: modpack markers first
/// (`qmodpack.index.json`, `modrinth.index.json`, CF `manifest.json` with
/// `manifestType == minecraftModpack`), then the `shaders/` layout, then a
/// root `pack.mcmeta`.
async fn classify_file(
    Json(req): Json<ClassifyFileRequest>,
) -> ApiResult<Json<ClassifyFileResponse>> {
    let path = PathBuf::from(req.path.trim());
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("CLASSIFY_PATH_INVALID", "Invalid file path"))?;
    if !path.is_file() {
        return Err(ApiError::not_found("FILE_NOT_FOUND", "File does not exist"));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let (file_type, meta) = match ext.as_str() {
        "jar" | "litemod" => ("mod", None),
        "zip" | "mrpack" => classify_zip(&path, ext == "mrpack"),
        _ => ("unknown", None),
    };
    let meta = meta.unwrap_or_default();
    Ok(Json(ClassifyFileResponse {
        file_type: file_type.to_string(),
        file_name,
        pack_name: meta.name,
        game_version: meta.game_version,
        loader: meta.loader,
        summary: meta.summary,
    }))
}

#[derive(Default)]
struct PackMeta {
    name: Option<String>,
    game_version: Option<String>,
    loader: Option<String>,
    summary: Option<String>,
}

fn classify_zip(path: &Path, is_mrpack_ext: bool) -> (&'static str, Option<PackMeta>) {
    let Ok(file) = std::fs::File::open(path) else {
        return ("unknown", None);
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return ("unknown", None);
    };

    let mut has_mr = false;
    let mut has_qml = false;
    let mut has_cf_manifest = false;
    let mut has_mmc = false;
    let mut has_shaders = false;
    let mut has_mcmeta = false;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            continue;
        };
        match entry.name() {
            "modrinth.index.json" => has_mr = true,
            "qmodpack.index.json" => has_qml = true,
            "manifest.json" => has_cf_manifest = true,
            "pack.mcmeta" => has_mcmeta = true,
            n if n == "mmc-pack.json" || n.ends_with("/mmc-pack.json") => has_mmc = true,
            _ => {}
        }
        if entry.name().starts_with("shaders/") {
            has_shaders = true;
        }
    }

    // Modpack markers win. A stray `manifest.json` without the CF
    // manifestType is not a modpack and falls through to the other flavours.
    if has_mr || (is_mrpack_ext && !has_qml) {
        return (
            "modpack",
            Some(pack_meta_from(
                &mut archive,
                "modrinth.index.json",
                "modrinth",
            )),
        );
    }
    if has_qml {
        return (
            "modpack",
            Some(pack_meta_from(
                &mut archive,
                "qmodpack.index.json",
                "modrinth",
            )),
        );
    }
    if has_cf_manifest && is_cf_modpack_manifest(&mut archive) {
        return (
            "modpack",
            Some(pack_meta_from(&mut archive, "manifest.json", "curseforge")),
        );
    }
    if has_mmc {
        return ("modpack", multimc_pack_meta(&mut archive));
    }

    if has_shaders {
        return ("shaderpack", None);
    }
    if has_mcmeta {
        return ("resourcepack", None);
    }
    ("unknown", None)
}

fn is_cf_modpack_manifest(archive: &mut zip::ZipArchive<std::fs::File>) -> bool {
    read_entry_json(archive, "manifest.json")
        .and_then(|v| {
            v.get("manifestType")
                .and_then(|t| t.as_str())
                .map(String::from)
        })
        .as_deref()
        == Some("minecraftModpack")
}

/// MultiMC 整合包预览元数据：name 取自 instance.cfg 的 `name=`，
/// game_version/loader 取自 mmc-pack.json 的 components。
fn multimc_pack_meta(archive: &mut zip::ZipArchive<std::fs::File>) -> Option<PackMeta> {
    let mut name = None;
    if let Ok(mut f) = archive.by_name("instance.cfg") {
        let mut text = String::new();
        if std::io::Read::read_to_string(&mut f, &mut text).is_ok() {
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("name=") {
                    let v = v.trim();
                    if !v.is_empty() {
                        name = Some(v.to_string());
                    }
                    break;
                }
            }
        }
    }
    let root = read_entry_json(archive, "mmc-pack.json")?;
    let components = root.get("components").and_then(|c| c.as_array());
    let game_version = components
        .and_then(|cs| {
            cs.iter()
                .find(|c| c.get("uid").and_then(|u| u.as_str()) == Some("net.minecraft"))
        })
        .and_then(|c| str_field(c, "version"));
    let loader = components.and_then(|cs| {
        for c in cs {
            let uid = c.get("uid").and_then(|u| u.as_str()).unwrap_or("");
            let n = match uid {
                "net.fabricmc.fabric-loader" => Some("fabric".to_string()),
                "org.quiltmc.quilt-loader" => Some("quilt".to_string()),
                "net.minecraftforge" | "net.minecraftforge.forge" => Some("forge".to_string()),
                "net.neoforged" => Some("neoforge".to_string()),
                _ => None,
            };
            if n.is_some() {
                return n;
            }
        }
        None
    });
    Some(PackMeta {
        name,
        game_version,
        loader,
        summary: None,
    })
}

fn pack_meta_from(
    archive: &mut zip::ZipArchive<std::fs::File>,
    marker: &str,
    kind: &str,
) -> PackMeta {
    let Some(root) = read_entry_json(archive, marker) else {
        return PackMeta::default();
    };
    if kind == "curseforge" {
        let mc = root.get("minecraft");
        PackMeta {
            name: str_field(&root, "name"),
            game_version: mc.and_then(|m| str_field(m, "version")),
            loader: mc
                .and_then(|m| m.get("modLoaders"))
                .and_then(|l| l.as_array())
                .and_then(|a| a.first())
                .and_then(|l| l.get("id"))
                .and_then(|v| v.as_str())
                .map(|v| short_loader_id(v.to_string())),
            summary: None,
        }
    } else {
        // Modrinth index: `dependencies` maps {minecraft, fabric-loader, ...};
        // qmodpack.index.json keeps a compatible shape when present.
        let deps = root.get("dependencies").and_then(|d| d.as_object());
        PackMeta {
            name: str_field(&root, "name"),
            game_version: deps
                .and_then(|d| d.get("minecraft"))
                .and_then(|v| v.as_str())
                .map(String::from),
            loader: deps
                .and_then(|d| d.keys().find(|k| k.as_str() != "minecraft").cloned())
                .map(short_loader_id),
            summary: str_field(&root, "summary"),
        }
    }
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

fn short_loader_id(id: String) -> String {
    match id.as_str() {
        "fabric-loader" => "fabric".to_string(),
        "quilt-loader" => "quilt".to_string(),
        _ => id.split('-').next().unwrap_or(&id).to_string(),
    }
}

fn read_entry_json(
    archive: &mut zip::ZipArchive<std::fs::File>,
    entry_name: &str,
) -> Option<serde_json::Value> {
    let mut f = archive.by_name(entry_name).ok()?;
    serde_json::from_reader(&mut f).ok()
}
