//! Instance endpoints (source: Endpoints/InstanceEndpoints.cs).
//!
//! Provides game-instance CRUD, default-instance management and mod loader
//! enumeration. The launch/install flow routes depend on LaunchTracker and
//! InstallTracker which are ported separately, so they are stubbed here with
//! 501 NOT_IMPLEMENTED placeholders until those services land.

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use qomicex_core::api::version::VersionLocator;
use qomicex_core::event::ProgressReporter;
use qomicex_core::models::download::DownloadProgress;
use qomicex_core::models::installer::ModLoaderType;
use qomicex_downloader::{DownloadEvent, DownloadManager, DownloadTask, TaskId, TaskState};

use crate::endpoints::loader::LoaderVersionInfo;
use crate::error::{ApiError, ApiResult};
use crate::services::instance::GameInstance;
use crate::state::SharedState;

// =====================================================================
// DTO
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInstanceRequest {
    name: String,
    game_version: String,
    #[serde(default)]
    loader: Option<String>,
    #[serde(default)]
    loader_version: Option<String>,
    #[serde(default)]
    java_path: Option<String>,
    #[serde(default)]
    max_memory: Option<i32>,
    #[serde(default)]
    game_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInstanceRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    game_version: Option<String>,
    #[serde(default)]
    loader: Option<String>,
    #[serde(default)]
    loader_version: Option<String>,
    #[serde(default)]
    java_path: Option<String>,
    #[serde(default)]
    max_memory: Option<i32>,
    #[serde(default)]
    jvm_args: Option<String>,
    #[serde(default)]
    is_hidden: Option<bool>,
    #[serde(default)]
    version_isolation: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadersQuery {
    game_version: Option<String>,
    r#type: Option<String>,
}

/// POST /api/instance/{id}/install body (source: InstallerRequest).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallerRequest {
    #[serde(default)]
    download_threads: Option<i32>,
    #[serde(default)]
    download_source_id: Option<i32>,
    #[serde(default)]
    loader: Option<String>,
    #[serde(default)]
    loader_version: Option<String>,
    #[serde(default)]
    addons: Option<Vec<String>>,
    #[serde(default)]
    version_isolation: Option<bool>,
    #[serde(default)]
    optifine_version: Option<String>,
}

/// GET /api/instance/{id}/install/progress response (source: InstallProgressResponse).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgressResponse {
    instance_id: String,
    status: String,
    progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    total_files: i32,
    completed_files: i32,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/instance", get(list_instances).post(create_instance))
        .route("/instance/default", get(get_default))
        .route("/instance/loaders", get(list_loaders))
        .route(
            "/instance/{id}/default",
            put(set_default).delete(clear_default),
        )
        .route(
            "/instance/{id}",
            get(get_instance).put(update_instance).delete(delete_instance),
        )
        .route("/instance/{id}/launch", post(launch_501))
        .route("/instance/{id}/launch/progress", get(launch_progress_501))
        .route("/instance/{id}/launch/cancel", post(launch_cancel_501))
        .route("/instance/{id}/install", post(install_instance))
        .route("/instance/{id}/install/progress", get(install_progress))
        .route("/instance/{id}/install/pause", post(install_pause))
        .route("/instance/{id}/install/resume", post(install_resume))
        .route("/instance/{id}/install/cancel", post(install_cancel))
}

// =====================================================================
// Handlers
// =====================================================================

/// GET /instance: list all instances.
async fn list_instances(
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<GameInstance>>> {
    Ok(Json(state.instance.get_all()))
}

/// GET /instance/default: return the default instance or 204 if unset.
async fn get_default(State(state): State<SharedState>) -> ApiResult<Response> {
    let Some(id) = state.instance.get_default_id() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    match state.instance.get_by_id(&id) {
        Some(inst) => Ok(Json(inst).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

/// PUT /instance/{id}/default: set the default instance.
async fn set_default(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Response> {
    state.instance.set_default_id(&id);
    match state.instance.get_by_id(&id) {
        Some(inst) => Ok(Json(inst).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

/// DELETE /instance/{id}/default: clear the default instance.
async fn clear_default(
    AxumPath(_id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<StatusCode> {
    state.instance.clear_default_id();
    Ok(StatusCode::NO_CONTENT)
}

/// POST /instance: create a new instance.
async fn create_instance(
    State(state): State<SharedState>,
    Json(req): Json<CreateInstanceRequest>,
) -> ApiResult<(StatusCode, Json<GameInstance>)> {
    let mut instance = GameInstance::default();
    instance.id = short_id();
    instance.name = req.name;
    instance.game_version = req.game_version;
    instance.loader = req.loader;
    instance.loader_version = req.loader_version;
    instance.java_path = req.java_path;
    if let Some(max_memory) = req.max_memory {
        instance.max_memory = max_memory;
    }
    if let Some(game_dir) = req.game_dir {
        instance.game_dir = game_dir;
    }
    let created = state.instance.create(instance);
    Ok((StatusCode::CREATED, Json(created)))
}

/// GET /instance/{id}: return an instance by id.
async fn get_instance(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Response> {
    match state.instance.get_by_id(&id) {
        Some(inst) => Ok(Json(inst).into_response()),
        None => Err(instance_not_found(&id)),
    }
}

/// PUT /instance/{id}: update selected fields of an instance.
async fn update_instance(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<UpdateInstanceRequest>,
) -> ApiResult<Json<GameInstance>> {
    let Some(mut existing) = state.instance.get_by_id(&id) else {
        return Err(instance_not_found(&id));
    };
    if let Some(v) = req.name {
        existing.name = v;
    }
    if let Some(v) = req.game_version {
        existing.game_version = v;
    }
    if let Some(v) = req.loader {
        existing.loader = Some(v);
    }
    if let Some(v) = req.loader_version {
        existing.loader_version = Some(v);
    }
    if let Some(v) = req.java_path {
        existing.java_path = Some(v);
    }
    if let Some(v) = req.max_memory {
        existing.max_memory = v;
    }
    if let Some(v) = req.jvm_args {
        existing.jvm_args = Some(v);
    }
    if let Some(v) = req.is_hidden {
        existing.is_hidden = v;
    }
    if let Some(v) = req.version_isolation {
        existing.version_isolation = Some(v);
    }
    let updated = state
        .instance
        .update(&id, existing)
        .ok_or_else(|| instance_not_found(&id))?;
    Ok(Json(updated))
}

/// DELETE /instance/{id}: delete an instance.
async fn delete_instance(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<MessageResponse>> {
    if state.instance.delete(&id).is_none() {
        return Err(instance_not_found(&id));
    }
    Ok(Json(MessageResponse {
        message: format!("Instance {id} deleted"),
    }))
}

/// GET /instance/loaders: enumerate mod loaders for a game version.
async fn list_loaders(
    State(state): State<SharedState>,
    Query(q): Query<LoadersQuery>,
) -> ApiResult<Json<Vec<LoaderVersionInfo>>> {
    let game_version = q.game_version.unwrap_or_default();
    if game_version.trim().is_empty() {
        return Err(ApiError::bad_request(
            "INSTANCE_LOADERS_MISSING_GAME_VERSION",
            "gameVersion is required",
        ));
    }
    let loader_type = match q.r#type.as_deref() {
        Some(s) => parse_loader(s).ok_or_else(|| {
            ApiError::bad_request("INSTANCE_LOADERS_INVALID_TYPE", format!("Invalid loader type: {s}"))
        })?,
        None => ModLoaderType::All,
    };
    let loaders = state
        .core
        .installer_provider()
        .get_available_mod_loaders(&game_version, loader_type)
        .await
        .map_err(map_core_error)?;
    let infos = loaders
        .into_iter()
        .map(|l| LoaderVersionInfo {
            r#type: l.r#type as i32,
            version: l.version,
            minecraft_version: l.game_version,
            download_url: l.url,
            sha1: l.sha1,
            is_recommended: l.is_recommand,
            published_at: l.release_time,
        })
        .collect();
    Ok(Json(infos))
}

// =====================================================================
// 501 Launch / Install stubs (depend on LaunchTracker / InstallTracker)
// =====================================================================

async fn launch_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Launch"))
}

async fn launch_progress_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Launch progress"))
}

async fn launch_cancel_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Launch cancel"))
}

/// POST /api/instance/{id}/install — start an install in the background.
///
/// Minimal-but-real (vanilla) path: register an InstallTracker task, then run
/// `core.version().install_version(instance.name)` (resolves metadata and
/// downloads the game jar / libraries / assets). Loader install (forge/fabric
/// etc.) still needs core's installer_factory (pub(crate)); that is recorded
/// as TODO. Progress is exposed via GET /install/progress and the SSE stream.
async fn install_instance(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
    Json(_req): Json<InstallerRequest>,
) -> ApiResult<Json<MessageResponse>> {
    let instance = state
        .instance
        .get_by_id(&instance_id)
        .ok_or_else(|| instance_not_found(&instance_id))?;
    let version_name = instance.name.clone();
    // Loader install (forge/fabric/neoforge/...) needs qomicex-core's
    // installer_factory(), which is `pub(crate)` in the core crate and so
    // cannot be called from this backend. Vanilla only is supported here.
    // Existing instances may leave `loader` unset while the name carries a
    // loader marker (e.g. "1.12.2-Forge_14.23.5.2864"), so also sniff the name.
    let loader_marker: Option<String> = instance
        .loader
        .clone()
        .or_else(|| detect_loader(&version_name).map(String::from));
    let game_dir = instance.game_dir.clone();
    let core = state.core.clone();
    let tracker = state.install_tracker.clone();
    let mgr = state.download_manager.clone();

    tracker.start(instance_id.clone(), "install", move |handle| async move {
        use crate::services::install_tracker::InstallStatus;
        if let Some(l) = loader_marker {
            let msg = format!(
                "加载器安装({l})暂未移植到 Rust 后端：qomicex-core 的 installer_factory 为 pub(crate)，后端无法调用。仅支持纯原版下载。"
            );
            handle.set_error(msg.clone());
            handle.set_status(InstallStatus::Failed);
            return Err(msg);
        }
        handle.set_status(InstallStatus::Installing);
        handle.set_stage("resolving");

        // Resolve metadata (also writes version.json locally), then enumerate
        // the missing files and hand them to qomicex-downloader's DownloadManager
        // so pause / resume / cancel / retry actually apply.
        let meta = match core.version().get_version_metadata(&version_name).await {
            Ok(m) => m,
            Err(e) => {
                handle.set_error(e.to_string());
                handle.set_status(InstallStatus::Failed);
                return Err(e.to_string());
            }
        };
        let missing = match core.locator().get_miss_files(&meta).await {
            Ok(list) => list,
            Err(e) => {
                handle.set_error(e.to_string());
                handle.set_status(InstallStatus::Failed);
                return Err(e.to_string());
            }
        };

        handle.set_stage("downloading");
        if missing.is_empty() {
            handle.set_stage("completed");
            handle.set_status(InstallStatus::Completed);
            return Ok(());
        }

        let game_root = std::path::PathBuf::from(&game_dir);
        let ids: Vec<TaskId> = missing
            .iter()
            .map(|f| {
                let dest = game_root.join(&f.path);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                // Retry + resume are baked into the DownloadManager engine.
                mgr.add(DownloadTask::new(f.url.clone(), dest))
            })
            .collect();
        let total = ids.len() as u64;
        let id_set: std::collections::HashSet<u64> = ids.iter().copied().collect();

        // Drive progress from DownloadManager events; honor pause/cancel by
        // translating them into DownloadManager.pause/cancel on every task.
        let mut done_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut failed: Option<String> = None;
        // Per-task current (downloaded,total) bytes — summed, NOT accumulated
        // across events (each Progress event carries the task's cumulative
        // bytes, so adding them would double-count and blow past 100%).
        let mut prog: std::collections::HashMap<u64, (u64, u64)> = std::collections::HashMap::new();
        let mut paused_now = false;
        let mut rx = mgr.subscribe();

        loop {
            // Apply pause/cancel signal changes to the downloader.
            if handle.is_cancelled() {
                for id in &ids {
                    let _ = mgr.cancel(*id).await;
                }
                handle.set_status(InstallStatus::Cancelled);
                handle.set_stage("cancelled");
                return Ok(());
            }
            if handle.is_paused() && !paused_now {
                paused_now = true;
                for id in &ids {
                    let _ = mgr.pause(*id).await;
                }
            } else if !handle.is_paused() && paused_now {
                paused_now = false;
                for id in &ids {
                    let _ = mgr.resume(*id).await;
                }
            }

            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(DownloadEvent::Progress { id, downloaded, total, .. }) => {
                        if id_set.contains(&id) {
                            let e = prog.entry(id).or_insert((0, 0));
                            e.0 = downloaded as u64;
                            if total > 0 {
                                e.1 = total as u64;
                            }
                            e.1 = e.1.max(e.0);
                        }
                    }
                    Ok(DownloadEvent::StateChanged { id, state, .. }) => {
                        if id_set.contains(&id) {
                            match state {
                                TaskState::Completed => {
                                    done_ids.insert(id);
                                    // Mark fully downloaded so the byte sum counts it.
                                    if let Some(e) = prog.get_mut(&id) {
                                        if e.1 > 0 {
                                            e.0 = e.1;
                                        }
                                    }
                                }
                                TaskState::Failed => {
                                    if failed.is_none() {
                                        let done = done_ids.len();
                                        failed = Some(format!("部分文件下载失败 (已完成 {done}/{total} 项)"));
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(_) | Ok(_) => {}
                },
                _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {}
            }

            let done = done_ids.len() as u64;
            let (sum_dl, sum_tot) = {
                let mut dl = 0u64;
                let mut tot = 0u64;
                for (d, t) in prog.values() {
                    dl += *d;
                    tot += t.max(d);
                }
                (dl, tot)
            };
            let pct = if done >= total {
                100.0
            } else if sum_tot > 0 {
                (sum_dl as f64 / sum_tot as f64) * 100.0
            } else {
                0.0
            };
            handle.update(|f| {
                f.progress = pct.min(100.0).max(0.0);
                f.total_files = total as i32;
                f.completed_files = done as i32;
                f.stage = if paused_now { "paused".to_string() } else { "downloading".to_string() };
            });

            if done >= total {
                break;
            }
        }

        if let Some(err) = failed {
            handle.set_error(err.clone());
            handle.set_status(InstallStatus::Failed);
            return Err(err);
        }
        handle.set_stage("completed");
        handle.set_status(InstallStatus::Completed);
        Ok(())
    });

    Ok(Json(MessageResponse {
        message: format!("Install started for {instance_id}"),
    }))
}

/// GET /api/instance/{id}/install/progress
async fn install_progress(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<InstallProgressResponse>> {
    let p = state.install_tracker.get_state(&instance_id);
    Ok(Json(match p {
        Some(p) => InstallProgressResponse {
            instance_id: p.instance_id,
            status: p.status,
            progress: p.progress,
            error: p.error,
            total_files: p.total_files,
            completed_files: p.completed_files,
        },
        None => InstallProgressResponse {
            instance_id: instance_id.clone(),
            status: "not-started".to_string(),
            progress: 0.0,
            error: None,
            total_files: 0,
            completed_files: 0,
        },
    }))
}

async fn install_pause(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    state.install_tracker.pause(&instance_id);
    Ok(Json(MessageResponse {
        message: format!("Install paused for {instance_id}"),
    }))
}

async fn install_resume(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    state.install_tracker.resume(&instance_id);
    Ok(Json(MessageResponse {
        message: format!("Install resumed for {instance_id}"),
    }))
}

async fn install_cancel(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    state.install_tracker.cancel(&instance_id);
    Ok(Json(MessageResponse {
        message: format!("Install cancelled for {instance_id}"),
    }))
}

// =====================================================================
// Utils
// =====================================================================

fn instance_not_found(id: &str) -> ApiError {
    ApiError::not_found("INSTANCE_NOT_FOUND", format!("Instance {id} not found"))
}

/// Bridges core's `ProgressReporter` callbacks into the InstallTracker handle so
/// `install_version` reports live download progress.
///
/// Core's `DownloadProgress.percentage` is PER-CURRENT-FILE (0..100), which
/// would make the overall bar bounce per file. Instead we aggregate across all
/// seen files by byte totals so the overall percentage is monotonic, and we
/// surface speed + completed-file count.
struct InstallProgressReporter {
    handle: crate::services::install_tracker::InstallHandle,
    /// file_name -> (downloaded_bytes, total_bytes) latest snapshot per file.
    files: std::sync::Mutex<std::collections::HashMap<String, (i64, i64)>>,
}

impl InstallProgressReporter {
    fn new(handle: crate::services::install_tracker::InstallHandle) -> Self {
        Self {
            handle,
            files: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Aggregate byte progress across all reported files and write to handle.
    fn aggregate(&self, p: &DownloadProgress, stage: &str) {
        {
            let mut files = self.files.lock().unwrap();
            let cur = files
                .entry(p.file_name.clone())
                .or_insert((0, p.total_bytes));
            cur.0 = cur.0.max(p.downloaded_bytes);
            if p.total_bytes > 0 {
                cur.1 = p.total_bytes;
            }
        }
        let (sum_dl, sum_tot, completed) = {
            let files = self.files.lock().unwrap();
            let mut dl = 0i64;
            let mut tot = 0i64;
            let mut done = 0usize;
            for (_, (d, t)) in files.iter() {
                dl += *d;
                tot += t.max(d);
                if *t > 0 && *d >= *t {
                    done += 1;
                }
            }
            (dl, tot, done)
        };
        let pct = if sum_tot > 0 {
            (sum_dl as f64 / sum_tot as f64) * 100.0
        } else {
            0.0
        };
        self.handle.update(|f| {
            f.progress = pct.min(100.0).max(0.0);
            if !p.file_name.is_empty() {
                f.current_file = p.file_name.clone();
            }
            f.speed = p.speed_bytes_per_second.max(0) as f64;
            f.completed_files = completed as i32;
            f.stage = stage.to_string();
        });
    }
}

impl ProgressReporter for InstallProgressReporter {
    fn report_download(&self, p: DownloadProgress) {
        self.aggregate(&p, "downloading");
    }
    fn report_install(&self, p: DownloadProgress) {
        self.aggregate(&p, "installing");
    }
    fn report_state(&self, phase: &str) {
        if !phase.is_empty() {
            self.handle.set_stage(phase);
        }
    }
}

/// Detect a loader from a VersionDir-style name when `instance.loader` is unset.
fn detect_loader(name: &str) -> Option<&'static str> {
    // VersionDir names are `{gameVersion}-{Loader}_{LoaderVersion}` (e.g.
    // "1.12.2-Forge_14.23.5.2864"), so loaders are followed by '_' not '-'.
    let lower = name.to_ascii_lowercase();
    if lower.contains("-forge_") {
        Some("forge")
    } else if lower.contains("-neoforge_") {
        Some("neoforge")
    } else if lower.contains("-fabric_") {
        Some("fabric")
    } else if lower.contains("-quilt_") {
        Some("quilt")
    } else if lower.contains("-liteloader_") {
        Some("liteloader")
    } else if lower.contains("-optifine_") {
        Some("optifine")
    } else if lower.contains("-cleanroom") {
        Some("cleanroom")
    } else if lower.contains("-legacyfabric_") {
        Some("legacyfabric")
    } else if lower.contains("-babric_") {
        Some("babric")
    } else {
        None
    }
}

fn not_implemented(scope: &str) -> ApiError {
    ApiError {
        code: "NOT_IMPLEMENTED".to_string(),
        message: format!("{scope} is not implemented yet"),
        detail: None,
        status: StatusCode::NOT_IMPLEMENTED,
    }
}

fn short_id() -> String {
    let full = format!("{:x}", uuid::Uuid::new_v4());
    full[..12].to_string()
}

/// Parse a loader type string (case-insensitive), mirroring the source
/// loader mapping. Returns None for unknown values.
fn parse_loader(s: &str) -> Option<ModLoaderType> {
    match s.trim().to_ascii_lowercase().as_str() {
        "all" => Some(ModLoaderType::All),
        "forge" => Some(ModLoaderType::Forge),
        "neoforge" => Some(ModLoaderType::NeoForge),
        "fabric" => Some(ModLoaderType::Fabric),
        "quilt" => Some(ModLoaderType::Quilt),
        "liteloader" => Some(ModLoaderType::LiteLoader),
        "optifine" => Some(ModLoaderType::OptiFine),
        "cleanroom" => Some(ModLoaderType::Cleanroom),
        "legacyfabric" => Some(ModLoaderType::LegacyFabric),
        "babric" => Some(ModLoaderType::Babric),
        _ => None,
    }
}

/// Map core errors to backend API errors (mirrors the source middleware:
/// upstream HTTP >=500 -> 502, otherwise -> 500).
fn map_core_error(e: qomicex_core::error::Error) -> ApiError {
    let is_upstream = matches!(&e, qomicex_core::error::Error::Http { status: Some(s), .. } if *s >= 500);
    if is_upstream {
        ApiError::upstream(e.to_string())
    } else {
        ApiError::internal(e.to_string())
    }
}
