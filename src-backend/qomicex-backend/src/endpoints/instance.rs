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

use qomicex_core::models::installer::ModLoaderType;

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
    let core = state.core.clone();
    let tracker = state.install_tracker.clone();

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
        handle.set_stage("downloading");
        match core.version().install_version(&version_name, None).await {
            Ok(()) => {
                handle.set_stage("completed");
                handle.set_status(InstallStatus::Completed);
                Ok(())
            }
            Err(e) => {
                handle.set_error(e.to_string());
                handle.set_status(InstallStatus::Failed);
                Err(e.to_string())
            }
        }
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
