//! Instance endpoints (source: Endpoints/InstanceEndpoints.cs).
//!
//! Provides game-instance CRUD, default-instance management and mod loader
//! enumeration. The launch/install flow routes depend on LaunchTracker and
//! InstallTracker which are ported separately, so they are stubbed here with
//! 501 NOT_IMPLEMENTED placeholders until those services land.

use std::path::Path;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use qomicex_core::core::GameCore;
use qomicex_core::models::auth::{AuthMode, AuthOptions};
use qomicex_core::models::installer::ModLoaderType;
use qomicex_core::models::launch::{JavaOptions, LaunchOptions};
use qomicex_core::models::version_metadata::{CompleteVersionMetadata, JavaVersion};
use qomicex_downloader::{DownloadEvent, DownloadTask, TaskId, TaskState};

use crate::endpoints::java;
use crate::endpoints::loader::LoaderVersionInfo;
use crate::error::{ApiError, ApiResult};
use crate::services::install_service::InstallRequestData;
use crate::services::instance::GameInstance;
use crate::services::instance_group::InstanceGroup;
use crate::services::launch_tracker::LaunchProgress;
use crate::state::SharedState;
use crate::util::pcl_icon::resolve_pcl_icon;

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
    #[serde(default)]
    custom_group_ids: Option<Vec<String>>,
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
#[allow(dead_code)]
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

/// POST /api/instance/{id}/launch body (source: LaunchInstanceRequest).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchInstanceRequest {
    #[serde(default)]
    join_server: Option<String>,
    #[serde(default)]
    join_world: Option<String>,
    #[serde(default)]
    account_uuid: Option<String>,
}

/// POST /api/instance/{id}/launch response (source: LaunchResultDto).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchResultDto {
    success: bool,
    process_id: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
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
            get(get_instance)
                .put(update_instance)
                .delete(delete_instance),
        )
        .route("/instance/{id}/launch", post(launch_instance))
        .route("/instance/{id}/launch/progress", get(launch_progress))
        .route("/instance/{id}/launch/cancel", post(launch_cancel))
        .route("/instance/{id}/install", post(install_instance))
        .route("/instance/{id}/install/progress", get(install_progress))
        .route("/instance/{id}/install/pause", post(install_pause))
        .route("/instance/{id}/install/resume", post(install_resume))
        .route("/instance/{id}/install/cancel", post(install_cancel))
        // 实例自定义分组
        .route("/instance-groups", get(list_groups).post(create_group))
        .route(
            "/instance-groups/{id}",
            put(update_group).delete(delete_group),
        )
}

// =====================================================================
// Handlers
// =====================================================================

fn enrich_instance_icon(inst: &mut GameInstance) {
    if inst.icon_data.is_none() {
        let version_dir = Path::new(&inst.game_dir).join("versions").join(&inst.name);
        if let Some(data) = resolve_pcl_icon(&version_dir) {
            inst.icon_data = Some(data);
        }
    }
}

/// GET /instance: list all instances.
async fn list_instances(State(state): State<SharedState>) -> ApiResult<Json<Vec<GameInstance>>> {
    let mut instances = state.instance.get_all();
    for inst in &mut instances {
        enrich_instance_icon(inst);
    }
    Ok(Json(instances))
}

/// GET /instance/default: return the default instance or 204 if unset.
async fn get_default(State(state): State<SharedState>) -> ApiResult<Response> {
    let Some(id) = state.instance.get_default_id() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    match state.instance.get_by_id(&id) {
        Some(mut inst) => {
            enrich_instance_icon(&mut inst);
            Ok(Json(inst).into_response())
        }
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
        Some(mut inst) => {
            enrich_instance_icon(&mut inst);
            Ok(Json(inst).into_response())
        }
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
        Some(mut inst) => {
            enrich_instance_icon(&mut inst);
            Ok(Json(inst).into_response())
        }
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
    if let Some(v) = req.custom_group_ids {
        existing.custom_group_ids = v;
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

/// GET /api/instance-groups: list custom instance groups.
async fn list_groups(State(state): State<SharedState>) -> ApiResult<Json<Vec<InstanceGroup>>> {
    Ok(Json(state.instance_groups.get_all()))
}

/// POST /api/instance-groups: create a custom group.
async fn create_group(
    State(state): State<SharedState>,
    Json(req): Json<GroupUpsertRequest>,
) -> ApiResult<Json<InstanceGroup>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request(
            "GROUP_NAME_EMPTY",
            "Group name cannot be empty",
        ));
    }
    state
        .instance_groups
        .create(name, req.color.unwrap_or_else(default_group_color))
        .ok_or_else(|| {
            ApiError::bad_request("GROUP_NAME_EXISTS", "A group with this name already exists")
        })
        .map(Json)
}

/// PUT /api/instance-groups/{id}: rename / recolor a custom group.
async fn update_group(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<GroupUpsertRequest>,
) -> ApiResult<Json<InstanceGroup>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request(
            "GROUP_NAME_EMPTY",
            "Group name cannot be empty",
        ));
    }
    let color = req.color.unwrap_or_else(default_group_color);
    state
        .instance_groups
        .update(&id, name, color)
        .ok_or_else(|| {
            ApiError::bad_request("GROUP_NAME_EXISTS", "A group with this name already exists")
        })
        .map(Json)
}

/// DELETE /api/instance-groups/{id}: delete a group and remove it from all instances.
async fn delete_group(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<MessageResponse>> {
    if state.instance_groups.delete(&id).is_none() {
        return Err(ApiError::not_found(
            "GROUP_NOT_FOUND",
            "Instance group not found",
        ));
    }
    // 清理所有实例对该分组的引用
    for inst in state.instance.get_all() {
        if inst.custom_group_ids.iter().any(|g| g == &id) {
            let mut updated = inst.clone();
            updated.custom_group_ids.retain(|g| g != &id);
            let _ = state.instance.update(&inst.id, updated);
        }
    }
    Ok(Json(MessageResponse {
        message: format!("Group {id} deleted"),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupUpsertRequest {
    name: String,
    #[serde(default)]
    color: Option<String>,
}

/// 默认分组颜色（无指定时使用），取青色。
fn default_group_color() -> String {
    "#22d3ee".to_string()
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
            ApiError::bad_request(
                "INSTANCE_LOADERS_INVALID_TYPE",
                format!("Invalid loader type: {s}"),
            )
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
// Launch (depends on LaunchTracker + core.launch())
// =====================================================================

/// POST /api/instance/{id}/launch — start a game instance in the background.
///
/// Mirrors the C# `InstanceEndpoints` launch orchestration: resolve the auth
/// options, then run integrity check (unless `skipIntegrityCheck`), pick the
/// Java runtime, assemble `LaunchOptions` and call `core.launch().launch()`.
/// Progress is written into `LaunchTracker` and consumed by
/// GET /launch/progress. The handler returns immediately (stage "starting").
async fn launch_instance(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
    request: Option<Json<LaunchInstanceRequest>>,
) -> ApiResult<Json<LaunchResultDto>> {
    let instance = state
        .instance
        .get_by_id(&instance_id)
        .ok_or_else(|| instance_not_found(&instance_id))?;

    let req = request
        .map(|Json(r)| r)
        .unwrap_or_else(|| LaunchInstanceRequest {
            join_server: None,
            join_world: None,
            account_uuid: None,
        });

    // Resolve auth options from the (default or requested) stored account.
    let account = match &req.account_uuid {
        Some(uuid) if !uuid.is_empty() => state.account.get_account(uuid).await?,
        _ => state.account.get_default().await?,
    };
    let auth_options = resolve_auth_options(account);

    let tracker = state.launch_tracker.clone();
    let game_log = state.game_log.clone();
    let core = state.core.clone();
    let download_manager = state.download_manager.load_full();
    let game_dir = instance.game_dir.clone();
    let name = instance.name.clone();
    let skip_integrity_check = instance.skip_integrity_check;
    let user_java_path = instance.java_path.clone();
    let max_memory = instance.max_memory;
    let jvm_args = instance.jvm_args.clone();
    let version_isolation = instance
        .version_isolation
        .unwrap_or_else(crate::settings::get_global_version_isolation);
    let join_server = req.join_server;
    let join_world = req.join_world;
    let cancel_flag = tracker.get_or_create_cancel(&instance_id);

    // Build a per-instance repair core rooted at this instance's game_dir (not
    // the global settings root), mirroring the C# repair stage. This fixes the
    // integrity-check path mismatch that made downloads land in the global dir.
    let repair_core = {
        let download_source = state.settings.read().await.download_source;
        crate::services::install_service::build_repair_core(
            &game_dir,
            download_source,
            state.http_client.clone(),
        )
    };

    tracker.set_progress(
        &instance_id,
        LaunchProgress {
            stage: "starting".to_string(),
            message: "准备启动...".to_string(),
            progress: 0.0,
            is_running: false,
            ..Default::default()
        },
    );

    tokio::spawn(async move {
        let mut progress = LaunchProgress {
            stage: "checking".to_string(),
            message: "正在检查文件完整性...".to_string(),
            progress: 5.0,
            is_running: false,
            ..Default::default()
        };
        tracker.set_progress(&instance_id, progress.clone());

        let result: Result<(i32, String), String> = async {
            // Integrity check: enumerate missing files from the version JSON and
            // download them (unless skipped).
            if !skip_integrity_check {
                if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("启动已取消".to_string());
                }
                let version_json = std::path::Path::new(&game_dir)
                    .join("versions")
                    .join(&name)
                    .join(format!("{name}.json"));
                let json_content = tokio::fs::read_to_string(&version_json)
                    .await
                    .map_err(|_| format!("版本 JSON 不存在: {}", version_json.display()))?;

                let miss_files = repair_core
                    .locator()
                    .get_miss_files_from_json(&json_content)
                    .await
                    .map_err(|e| e.to_string())?;
                let miss_files: Vec<_> = miss_files
                    .into_iter()
                    .filter(|f| !f.path.is_empty() && !f.url.is_empty())
                    .collect();

                if !miss_files.is_empty() {
                    let missing_names: Vec<String> =
                        miss_files.iter().map(|f| f.name.clone()).collect();
                    progress.stage = "repairing".to_string();
                    progress.message = format!("正在补全 {} 个缺失文件...", miss_files.len());
                    progress.progress = 10.0;
                    progress.missing_files = Some(missing_names);
                    progress.total_files = miss_files.len() as i32;
                    tracker.set_progress(&instance_id, progress.clone());

                    let game_root = std::path::PathBuf::from(&game_dir);
                    let ids: Vec<TaskId> = miss_files
                        .iter()
                        .map(|f| {
                            let dest = game_root.join(&f.path);
                            if let Some(parent) = dest.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            download_manager.add(DownloadTask::new(f.url.clone(), dest))
                        })
                        .collect();
                    let total = ids.len() as u64;
                    let id_set: std::collections::HashSet<u64> = ids.iter().copied().collect();
                    let mut done_ids: std::collections::HashSet<u64> =
                        std::collections::HashSet::new();
                    let mut failed: Option<String> = None;
                    let mut rx = download_manager.subscribe();

                    while done_ids.len() < ids.len() {
                        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                            for id in &ids {
                                let _ = download_manager.cancel(*id).await;
                            }
                            return Err("启动已取消".to_string());
                        }
                        tokio::select! {
                            ev = rx.recv() => match ev {
                                Ok(DownloadEvent::StateChanged { id, state, .. }) => {
                                    if id_set.contains(&id) {
                                        match state {
                                            TaskState::Completed => { done_ids.insert(id); }
                                            TaskState::Failed => {
                                                if failed.is_none() {
                                                    failed = Some("文件补全失败".to_string());
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                _ => {}
                            },
                            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
                        }
                        let done = done_ids.len() as i32;
                        progress.completed_files = done;
                        progress.progress = 10.0 + (done as f64 / total.max(1) as f64) * 20.0;
                        tracker.set_progress(&instance_id, progress.clone());
                    }
                    if let Some(err) = failed {
                        return Err(err);
                    }
                }
            }

            if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("启动已取消".to_string());
            }
            progress.stage = "preparing".to_string();
            progress.message = "正在准备环境...".to_string();
            progress.progress = 30.0;
            tracker.set_progress(&instance_id, progress.clone());

            // Auto-set the game language on first launch (only when options.txt
            // has no `lang` yet, so in-game language choices are respected).
            crate::services::options::ensure_lang(
                &game_dir,
                &name,
                version_isolation,
                &crate::settings::load_settings().language,
            );

            // Determine required Java major version from the version JSON chain.
            // Pick the Java runtime: user-specified path wins, else auto-recommend.
            let selected_java_path = resolve_java_path(&core, &game_dir, &name, &user_java_path)
                .await
                .map_err(|e| e)?;

            if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("启动已取消".to_string());
            }
            progress.stage = "launching".to_string();
            progress.message = "正在启动游戏...".to_string();
            progress.progress = 50.0;
            tracker.set_progress(&instance_id, progress.clone());

            let options = LaunchOptions {
                version: name.clone(),
                version_isolation,
                join_server,
                join_world,
                java_options: Some(JavaOptions {
                    java_path: selected_java_path,
                    max_memory_mb: max_memory,
                    extra_jvm_args: jvm_args
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| {
                            s.split(' ')
                                .filter(|t| !t.is_empty())
                                .map(String::from)
                                .collect()
                        }),
                }),
                auth_options: Some(auth_options),
                game_root: Some(game_dir.clone()),
            };
            let result = core
                .launch()
                .launch(options)
                .await
                .map_err(|e| e.to_string())?;
            if !result.success {
                return Err(result.message.unwrap_or_else(|| "启动失败".to_string()));
            }
            Ok((result.process_id, result.message.unwrap_or_default()))
        }
        .await;

        match result {
            Ok((pid, _msg)) => {
                tracing::info!(instance = %instance_id, pid, "launch: game started");
                tracker.track(&instance_id, pid);
                game_log.register(&instance_id, pid);
                tracker.set_progress(
                    &instance_id,
                    LaunchProgress {
                        stage: "running".to_string(),
                        message: "游戏运行中".to_string(),
                        progress: 100.0,
                        is_running: true,
                        process_id: Some(pid),
                        ..Default::default()
                    },
                );
            }
            Err(err) => {
                tracing::error!(instance = %instance_id, error = %err, "launch: failed");
                let _ = std::fs::create_dir_all(std::path::Path::new(&game_dir).join("logs"));
                let _ = std::fs::write(
                    std::path::Path::new(&game_dir).join("logs/launch-errors.log"),
                    format!("[{:?}] [{}] {}\n\n", chrono::Utc::now(), instance_id, err),
                );
                tracker.set_progress(
                    &instance_id,
                    LaunchProgress {
                        stage: "failed".to_string(),
                        message: "启动失败".to_string(),
                        progress: 0.0,
                        is_running: false,
                        error: Some(err),
                        ..Default::default()
                    },
                );
            }
        }
    });

    Ok(Json(LaunchResultDto {
        success: true,
        process_id: 0,
        error: None,
        detail: None,
        stage: Some("starting".to_string()),
    }))
}

/// GET /api/instance/{id}/launch/progress — mirror the C# handler.
async fn launch_progress(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<LaunchProgress>> {
    let tracker = &state.launch_tracker;
    let Some(progress) = tracker.get_progress(&instance_id) else {
        // No progress recorded: fall back to process state.
        return match tracker.get_state(&instance_id) {
            Some(state) => Ok(Json(LaunchProgress {
                stage: "running".to_string(),
                message: "游戏运行中".to_string(),
                progress: 100.0,
                is_running: true,
                process_id: Some(state.process_id),
                ..Default::default()
            })),
            None => Ok(Json(LaunchProgress {
                stage: "completed".to_string(),
                message: "进程已结束".to_string(),
                progress: 100.0,
                is_running: false,
                ..Default::default()
            })),
        };
    };

    if progress.stage == "running" {
        let ps = tracker.get_state(&instance_id);
        if let Some(ps) = ps {
            if !crate::services::launch_tracker::process_alive(ps.process_id) {
                // Process exited: settle play time then report completed.
                if let Some(mut inst) = state.instance.get_by_id(&instance_id) {
                    let elapsed = (chrono::Utc::now() - ps.started_at).num_minutes().max(1);
                    inst.play_time += elapsed as i64;
                    inst.last_played = Some(chrono::Utc::now().to_rfc3339());
                    state.instance.update(&instance_id, inst);
                }
                tracker.cancel_and_remove(&instance_id);
                return Ok(Json(LaunchProgress {
                    stage: "completed".to_string(),
                    message: "游戏已退出".to_string(),
                    progress: 100.0,
                    is_running: false,
                    ..Default::default()
                }));
            }
        }
    }

    Ok(Json(progress))
}

/// POST /api/instance/{id}/launch/cancel — cancel + kill (source LaunchTracker.Stop).
async fn launch_cancel(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    state.launch_tracker.stop(&instance_id);
    state.game_log.remove(&instance_id);
    Ok(Json(MessageResponse {
        message: format!("Launch cancelled for {instance_id}"),
    }))
}

// =====================================================================
// Install
// =====================================================================

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
    Json(req): Json<InstallerRequest>,
) -> ApiResult<Json<MessageResponse>> {
    let instance = state
        .instance
        .get_by_id(&instance_id)
        .ok_or_else(|| instance_not_found(&instance_id))?;

    let data = InstallRequestData {
        game_version: instance.game_version.clone(),
        game_dir: instance.game_dir.clone(),
        version_dir_name: instance.name.clone(),
        loader: req.loader.clone(),
        loader_version: req.loader_version.clone(),
        addons: req.addons.clone().unwrap_or_default(),
        download_threads: req.download_threads.unwrap_or(8).max(1),
        version_isolation: req
            .version_isolation
            .unwrap_or_else(crate::settings::get_global_version_isolation),
        download_source_id: req.download_source_id.unwrap_or(0),
        optifine_version: req.optifine_version.clone(),
    };

    let tracker = state.install_tracker.clone();
    let mgr = state.download_manager.load_full();
    let http_client = state.http_client.clone();
    let cf_api_key = state.curse_forge_api_key.clone();

    tracker.start(instance_id.clone(), "install", move |handle| async move {
        crate::services::install_service::run_install_pipeline(
            &handle,
            mgr,
            http_client,
            &cf_api_key,
            data,
        )
        .await
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

/// Build core `AuthOptions` from a stored account (source: ResolveAuthOptions).
/// Microsoft accounts refresh their token via the core auth provider; failures
/// are swallowed (the stale token is still passed through, matching C# catch{}).
pub(crate) fn resolve_auth_options(
    account: Option<crate::services::account::StoredAccount>,
) -> AuthOptions {
    let Some(account) = account else {
        return AuthOptions::default();
    };
    let mode = match account.login_method.to_ascii_lowercase().as_str() {
        "microsoft" => AuthMode::Microsoft,
        "yggdrasil" | "统一通行证" => AuthMode::Yggdrasil,
        _ => AuthMode::Offline,
    };
    let server_url = if mode == AuthMode::Yggdrasil {
        account.server_url.clone()
    } else {
        None
    };
    AuthOptions {
        mode,
        uuid: Some(account.uuid),
        name: Some(account.name),
        token: if account.token.is_empty() {
            None
        } else {
            Some(account.token)
        },
        access_token: Some(if account.access_token.is_empty() {
            "0".to_string()
        } else {
            account.access_token
        }),
        refresh_token: if account.refresh_token.is_empty() {
            None
        } else {
            Some(account.refresh_token)
        },
        server_url: server_url.clone(),
        authlib_injector_param: if mode == AuthMode::Yggdrasil {
            server_url.map(|u| format!("--authlibInjector={u}"))
        } else {
            None
        },
    }
}

/// Read the required Java major version from the version JSON (following the
/// `inheritsFrom` chain, defaulting to 8), mirroring `GetRequiredJavaFromNode`.
fn required_java_version(game_dir: &str, version: &str) -> i32 {
    let path = std::path::Path::new(game_dir)
        .join("versions")
        .join(version)
        .join(format!("{version}.json"));
    required_java_from_path(&path, game_dir)
}

/// 选择启动用 Java 路径：用户指定优先，否则按版本 JSON 的 Java 要求自动推荐
/// （scan_quick + recommand，与 C# launch 流程一致）。供普通启动与联机建房复用。
pub(crate) async fn resolve_java_path(
    core: &Arc<GameCore>,
    game_dir: &str,
    name: &str,
    user_java_path: &Option<String>,
) -> Result<String, String> {
    if let Some(path) = user_java_path.as_ref().filter(|p| !p.is_empty()) {
        return Ok(path.clone());
    }
    let required_java = required_java_version(game_dir, name);
    let loader_lower = instance_loader(game_dir, name).unwrap_or_default();
    let effective_required = apply_loader_java_requirement(&loader_lower, name, required_java);
    let metadata = CompleteVersionMetadata {
        id: name.to_string(),
        r#type: "release".to_string(),
        main_class: String::new(),
        inherits_from: None,
        jar: None,
        arguments: None,
        libraries: Vec::new(),
        asset_index: None,
        downloads: None,
        java_version: Some(JavaVersion {
            component: "jre-legacy".to_string(),
            major_version: effective_required,
        }),
        minimum_launcher_version: None,
        release_time: String::new(),
        time: String::new(),
    };
    let java_results = java::scan_quick(core.clone()).await;
    if java_results.is_empty() {
        return Err("未找到可用的 Java 运行时，请在实例设置中指定 Java 路径".to_string());
    }
    let recommended = core
        .java_provider()
        .recommand(&java_results, &metadata)
        .await
        .map_err(|e| e.to_string())?;
    Ok(recommended.path)
}

fn required_java_from_path(path: &std::path::Path, game_dir: &str) -> i32 {
    let Ok(content) = std::fs::read_to_string(path) else {
        return 8;
    };
    let Ok(node) = serde_json::from_str::<serde_json::Value>(&content) else {
        return 8;
    };
    if let Some(major) = node
        .get("javaVersion")
        .and_then(|j| j.get("majorVersion"))
        .and_then(|m| m.as_i64())
    {
        return major as i32;
    }
    if let Some(inherits) = node.get("inheritsFrom").and_then(|i| i.as_str()) {
        let parent = std::path::Path::new(game_dir)
            .join("versions")
            .join(inherits)
            .join(format!("{inherits}.json"));
        return required_java_from_path(&parent, game_dir);
    }
    8
}

/// Sniff the loader from the version JSON's `inheritsFrom` / folder name,
/// mirroring the C# cleanroom/babric special-casing in the launch flow.
fn instance_loader(game_dir: &str, version: &str) -> Option<String> {
    let path = std::path::Path::new(game_dir)
        .join("versions")
        .join(version)
        .join(format!("{version}.json"));
    let lower = if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(node) = serde_json::from_str::<serde_json::Value>(&content) {
            node.get("inheritsFrom")
                .and_then(|i| i.as_str())
                .map(|s| s.to_ascii_lowercase())
        } else {
            None
        }
    } else {
        None
    };
    lower.or_else(|| detect_loader(version).map(String::from))
}

/// Apply the C# cleanroom/babric Java-version bumps.
fn apply_loader_java_requirement(loader: &str, version_name: &str, required: i32) -> i32 {
    let mut required = required;
    if loader == "cleanroom" {
        // LoaderVersion may be embedded in the name (e.g. "...-cleanroom0.5.0").
        let cleanroom_ver = extract_cleanroom_version(version_name);
        if let Some(v) = cleanroom_ver {
            required = required.max(if v < 500 { 21 } else { 25 });
        }
    }
    if loader == "babric" {
        required = required.max(17);
    }
    required
}

/// Parse a cleanroom loader version like "0.5.0" from the version name;
/// returns `Some(major*100 + minor*10 + patch)`-style scaled int, or None.
fn extract_cleanroom_version(name: &str) -> Option<i32> {
    let idx = name.find("cleanroom")?;
    let rest = &name[idx + "cleanroom".len()..];
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let parts: Vec<u32> = digits
        .split('.')
        .filter_map(|p| p.parse().ok())
        .take(3)
        .collect();
    if parts.is_empty() {
        return None;
    }
    let major = parts[0];
    let minor = parts.get(1).copied().unwrap_or(0);
    let patch = parts.get(2).copied().unwrap_or(0);
    Some((major * 100 + minor * 10 + patch) as i32)
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
    let is_upstream =
        matches!(&e, qomicex_core::error::Error::Http { status: Some(s), .. } if *s >= 500);
    if is_upstream {
        ApiError::upstream(e.to_string())
    } else {
        ApiError::internal(e.to_string())
    }
}
