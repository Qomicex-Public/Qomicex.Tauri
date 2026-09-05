//! Instance endpoints (source: Endpoints/InstanceEndpoints.cs).
//!
//! Provides game-instance CRUD, default-instance management and mod loader
//! enumeration. The launch/install flow routes depend on LaunchTracker and
//! InstallTracker which are ported separately, so they are stubbed here with
//! 501 NOT_IMPLEMENTED placeholders until those services land.

use std::path::{Path, PathBuf};
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
    /// 用户自定义备注：缺失=不修改；null=清除；Some(Some(v))=设置。
    #[serde(default)]
    remark: Option<Option<String>>,
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

/// POST /api/instance/sync-scan body：前端扫描结果。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncScanRequest {
    game_dir: String,
    versions: Vec<SyncScanVersion>,
}

/// 前端扫描的版本条目。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncScanVersion {
    name: String,
    game_version: String,
    #[serde(default)]
    loader: Option<String>,
    #[serde(default)]
    loader_version: Option<String>,
    #[serde(default)]
    icon_data: Option<String>,
    #[serde(default)]
    modpack_name: Option<String>,
    #[serde(default)]
    modpack_version: Option<String>,
    #[serde(default)]
    modpack_author: Option<String>,
    #[serde(default)]
    modpack_summary: Option<String>,
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
        .route(
            "/instance/{id}/export-diagnostics",
            post(export_diagnostics),
        )
        .route("/instance/{id}/install", post(install_instance))
        .route("/instance/{id}/install/progress", get(install_progress))
        .route("/instance/{id}/install/pause", post(install_pause))
        .route("/instance/{id}/install/resume", post(install_resume))
        .route("/instance/{id}/install/cancel", post(install_cancel))
        // 实例扫描同步
        .route("/instance/sync-scan", post(sync_scan))
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
        let game_root = if Path::new(&inst.game_dir).is_absolute() {
            PathBuf::from(&inst.game_dir)
        } else {
            crate::settings::resolve_base_dir().join(&inst.game_dir)
        };
        let version_dir = game_root.join("versions").join(&inst.name);
        if let Some(data) = resolve_pcl_icon(&version_dir) {
            inst.icon_data = Some(data);
        }
    }
}

/// GET /instance: list all instances.
async fn list_instances(State(state): State<SharedState>) -> ApiResult<Json<Vec<GameInstance>>> {
    // 以磁盘实际目录为主：过滤掉残留（下载失败/已删除文件但 JSON 未清理）的实例
    let mut instances = state.instance.list_existing();
    for inst in &mut instances {
        enrich_instance_icon(inst);
    }
    Ok(Json(instances))
}

/// POST /instance/sync-scan: 更新扫描缓存并返回同步后的实例列表。
async fn sync_scan(
    State(state): State<SharedState>,
    Json(req): Json<SyncScanRequest>,
) -> ApiResult<Json<Vec<GameInstance>>> {
    // 将前端扫描结果转换为 ScannedVersionInfo
    let scanned: Vec<crate::services::instance::ScannedVersionInfo> = req
        .versions
        .into_iter()
        .map(|v| crate::services::instance::ScannedVersionInfo {
            name: v.name,
            game_version: v.game_version,
            game_dir: req.game_dir.clone(),
            loader: v.loader,
            loader_version: v.loader_version,
            icon_data: v.icon_data,
            modpack_name: v.modpack_name,
            modpack_version: v.modpack_version,
            modpack_author: v.modpack_author,
            modpack_summary: v.modpack_summary,
        })
        .collect();

    // 更新扫描缓存
    state.instance.update_scan_cache(&req.game_dir, scanned);

    // 返回同步后的实例列表
    let mut instances = state.instance.list_existing();
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
    if let Some(v) = req.remark {
        existing.remark = v;
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
    let account = refresh_microsoft_token(state.core.auth(), &state.account, account).await?;
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
                // 取消可能落在 core.launch() 无检查点窗口内：若已置取消位，杀掉刚
                // 拉起的进程并按取消结算，不进运行列表（否则取消后游戏仍被启动）。
                if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    crate::services::launch_tracker::kill_process(pid);
                    tracing::info!(instance = %instance_id, pid, "launch: cancelled after process start");
                    tracker.cancel_and_remove(&instance_id);
                    return;
                }
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
                // 用户取消：清掉进度即可，不写回 failed 终态（否则已取消的
                // 流程被复活成错误进度，前端 dialog 关了又弹回）。
                if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    tracker.cancel_and_remove(&instance_id);
                    return;
                }
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
        // 终态/结算由 crash_watcher 统一处理。state 缺失（已被 watcher 摘除接管中）
        // 则落到末尾继续返回 running 等终态；state 仍存在且进程已死 = 事件总线失效
        // 的兜底场景（watcher 不会再来结算），此处报 completed 并代为结算时长
        // （watcher 未接管 ⇒ 不存在双算）。
        if let Some(ps) = tracker.get_state(&instance_id) {
            if !crate::services::launch_tracker::process_alive(ps.process_id) {
                tracker.remove_state(&instance_id);
                crate::services::crash_watcher::settle_play_time(
                    &state.instance,
                    &instance_id,
                    ps.started_at,
                );
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
    state.game_log.release(&instance_id);
    Ok(Json(MessageResponse {
        message: format!("Launch cancelled for {instance_id}"),
    }))
}

/// POST /api/instance/{id}/export-diagnostics — 打包诊断信息为 zip 下载
/// （对应 C# DiagnosticExportController.Export）。
async fn export_diagnostics(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Response> {
    let instance = state
        .instance
        .get_by_id(&instance_id)
        .ok_or_else(|| instance_not_found(&instance_id))?;
    let progress = state.launch_tracker.get_progress(&instance_id);
    let trace_dump = state.trace_dump.clone();

    let safe_name: String = instance
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._- ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let file_name = format!("diagnostics-{safe_name}-{stamp}.zip");

    // 闭包内使用的实例字段提前解包，规避部分移动问题
    let game_version = instance.game_version.clone();
    let game_dir = PathBuf::from(&instance.game_dir);
    let version_name = instance.name.clone();

    let buf = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use std::io::{Cursor, Write as _};
        use zip::write::SimpleFileOptions;

        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        fn add_text(
            zw: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
            name: &str,
            text: &str,
        ) -> Result<(), String> {
            zw.start_file(name, SimpleFileOptions::default())
                .map_err(|e: zip::result::ZipError| e.to_string())?;
            zw.write_all(text.as_bytes()).map_err(|e| e.to_string())
        }

        // system-info.json（对应 C# SystemInfoHelper 段）
        let (total_mem, avail_mem) = crate::util::sysinfo::memory();
        let sys_info = serde_json::json!({
            "os": crate::util::sysinfo::os_name(),
            "osName": crate::util::sysinfo::os_description(),
            "osVersion": crate::util::sysinfo::os_version(),
            "architecture": crate::util::sysinfo::architecture(),
            "osVersionId": crate::util::sysinfo::os_version_id(),
            "osDisplayName": crate::util::sysinfo::os_display_name(),
            "gitCommit": option_env!("QOMICEX_GIT_HASH").unwrap_or("unknown"),
            "memory": total_mem,
            "availableMemory": avail_mem as f64 / (1024.0 * 1024.0),
        });
        add_text(&mut zw, "system-info.json", &sys_info.to_string())?;

        // launcher-version.json
        let version_info = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "gitCommit": option_env!("QOMICEX_GIT_HASH").unwrap_or("unknown"),
            "instanceGameVersion": game_version,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });
        add_text(&mut zw, "launcher-version.json", &version_info.to_string())?;

        // launch-error.json：仅 failed/crashed 终态时附带崩溃详情
        if let Some(p) = &progress {
            if p.stage == "failed" || p.stage == "crashed" {
                let launch_error = serde_json::json!({
                    "stage": p.stage,
                    "error": p.error,
                    "message": p.message,
                    "exitCode": p.exit_code,
                    "crashReport": p.crash_report,
                });
                add_text(&mut zw, "launch-error.json", &launch_error.to_string())?;
            }
        }

        // crash-report.txt：最新崩溃报告，截断 100K
        let crash_dir_candidates = [
            game_dir
                .join("versions")
                .join(&version_name)
                .join("crash-reports"),
            game_dir.join("crash-reports"),
        ];
        for dir in crash_dir_candidates {
            if let Some(latest) = latest_txt_file(&dir) {
                if let Ok(content) = std::fs::read_to_string(&latest) {
                    add_text(
                        &mut zw,
                        "crash-report.txt",
                        &truncate_chars(&content, 100_000),
                    )?;
                }
                break;
            }
        }

        // hs_err.log：game_dir 向上遍历找最新 JVM 崩溃日志，截断 100K
        let mut cur = Some(game_dir.clone());
        while let Some(d) = cur {
            if let Ok(entries) = std::fs::read_dir(&d) {
                let mut hs_errs: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_file()
                            && p.file_name()
                                .and_then(|n| n.to_str())
                                .map_or(false, |n| n.starts_with("hs_err_pid"))
                    })
                    .collect();
                hs_errs.sort_by_key(|p| {
                    std::cmp::Reverse(p.metadata().and_then(|m| m.modified()).ok())
                });
                if let Some(first) = hs_errs.first() {
                    if let Ok(content) = std::fs::read_to_string(first) {
                        add_text(&mut zw, "hs_err.log", &truncate_chars(&content, 100_000))?;
                    }
                    break;
                }
            }
            cur = d.parent().map(Path::to_path_buf);
        }

        // backend-trace.log：后端日志缓冲落盘后打包（失败不阻塞导出；与其他
        // 文本条目一致按 100K 截断，避免超大 trace 撑爆内存 zip）
        if let Ok(path) = trace_dump.dump("diagnostic-export") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                add_text(
                    &mut zw,
                    "backend-trace.log",
                    &truncate_chars(&content, 100_000),
                )?;
            }
        }

        let cursor = zw
            .finish()
            .map_err(|e: zip::result::ZipError| e.to_string())?;
        Ok(cursor.into_inner())
    })
    .await
    .map_err(|e| ApiError::internal(format!("诊断导出任务失败: {e}")))?
    .map_err(|e| ApiError::internal(format!("诊断打包失败: {e}")))?;

    let disposition = format!("attachment; filename=\"{file_name}\"");
    let mut resp = (StatusCode::OK, buf).into_response();
    resp.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/zip"),
    );
    resp.headers_mut().insert(
        axum::http::header::CONTENT_DISPOSITION,
        axum::http::HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("attachment")),
    );
    Ok(resp)
}

/// 目录下最新修改的 *.txt（无则 None）。
fn latest_txt_file(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("txt"))
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())
}

/// 按字符数截断并追加省略标记（按字符边界，避免切断多字节字符）。
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}\n... (truncated)")
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
    let inst_svc = state.instance.clone();
    let inst_id_inner = instance_id.clone();

    tracker.start(instance_id.clone(), "install", move |handle| async move {
        let result = crate::services::install_service::run_install_pipeline(
            &handle,
            mgr,
            http_client,
            &cf_api_key,
            data,
            crate::services::install_service::INSTALL_STEP_BUDGET_TOP,
        )
        .await;
        if result.is_err() {
            // 回滚：安装失败/取消 → 删除实例记录 + 版本隔离目录，不残留不可用空实例。
            // 该端点仅由「下载新版本」新建实例流程调用，失败删实例安全。
            let _ = inst_svc.delete(&inst_id_inner);
        }
        result
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

/// Microsoft 账户启动前强制刷新令牌并落库。
///
/// 失败分流：
/// - 微软认证被拒（refresh_token 失效，success=false）→ `Err(TOKEN_EXPIRED)`
///   阻止启动；前端按 code 弹出微软重新登录引导。
/// - 传输层失败（断网等，core 返回 Err）→ `Err(NETWORK_ERROR)` 阻止启动；
///   前端按 code 提示检查网络或改用离线登录。
/// 非 Microsoft 账户或缺 refresh_token（历史数据）时不刷新、原样放行。
///
/// 全局锁串行化「读取→刷新→保存」窗口：微软会轮换 refresh_token，并发刷新
/// 同一账户时慢者会把已轮换的旧 refresh_token 写回覆盖新值，导致后续刷新
/// 永远失败；持锁后以最新持久化状态为准可避免该竞态。
/// 全局微软刷新锁：串行化「读取→refresh_login→保存」窗口，防止并发刷新
/// 同一账户时旧 refresh_token 覆盖微软轮换后的新值（详见 refresh_microsoft_token）。
static MS_REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) async fn refresh_microsoft_token(
    auth: &dyn qomicex_core::api::auth::AuthProvider,
    accounts: &crate::services::account::AccountService,
    account: Option<crate::services::account::StoredAccount>,
) -> Result<Option<crate::services::account::StoredAccount>, ApiError> {
    let Some(incoming) = account else {
        return Ok(None);
    };
    let _guard = MS_REFRESH_LOCK.lock().await;
    let mut acc = match accounts.get_account(&incoming.uuid).await? {
        Some(latest) => latest,
        None => incoming,
    };
    if !acc.login_method.eq_ignore_ascii_case("microsoft") || acc.refresh_token.is_empty() {
        return Ok(Some(acc));
    }
    let result = match auth.refresh_login(acc.refresh_token.as_str()).await {
        Ok(r) => r,
        Err(_) => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "NETWORK_ERROR",
                "Cannot reach the Microsoft authentication service, please check your network or switch to offline login",
            ));
        }
    };
    if !result.success {
        let msg = result.error_message.clone().unwrap_or_default();
        // 429 限流 ≠ 令牌过期：微软上游（Xbox/XSTS/MC services 链）限流时
        // 降级放行现有 token，由下游 MC API 的 401 才判真过期。否则刚登录
        // 就撞限流窗口会被误判"账户过期"引导重登，而重登后再开披风页照样
        // 强制刷新、照样撞限流，形成"永远过期"死循环。
        if msg.contains("429") || msg.contains("Too Many Requests") {
            tracing::warn!(uuid = %acc.uuid, "microsoft refresh rate-limited, falling back to existing token");
            return Ok(Some(acc));
        }
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "TOKEN_EXPIRED",
            format!(
                "Microsoft login expired, please sign in again ({})",
                result.error_message.unwrap_or_else(|| "unknown".into())
            ),
        ));
    }
    if let Some(t) = result.access_token {
        acc.access_token = t;
    }
    if let Some(t) = result.refresh_token {
        acc.refresh_token = t;
    }
    if let Some(n) = result.username {
        acc.name = n;
    }
    // 不覆盖 uuid：refresh 返回的 uuid 是微软 XUID，与启动器用作账户稳定标识的
    // Minecraft profile UUID 并不一致；覆盖后会污染账户标识，使 save_account 按
    // 新 uuid 追加重复账户，原账户令牌无人续期，导致「重新登录也修不好披风/启动」。
    accounts.save_account(&mut acc).await?;
    Ok(Some(acc))
}

/// Build core `AuthOptions` from a stored account (source: ResolveAuthOptions).
/// Microsoft token refresh is handled by `refresh_microsoft_token` before this
/// mapping (core launch itself never refreshes).
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

#[cfg(test)]
mod refresh_tests {
    use super::*;

    use qomicex_core::api::auth::AuthProvider;
    use qomicex_core::error::Error;
    use qomicex_core::models::auth::{AuthRequest, AuthResult};

    use crate::services::account::{AccountService, StoredAccount};
    // 复用全局唯一的 env 测试锁：QOMICEX_HOME 是进程全局的，cargo test 并行会互相串扰。
    use crate::services::error_report::tests::ENV_LOCK;

    fn set_env(key: &str, value: impl AsRef<std::ffi::OsStr>) -> Option<std::ffi::OsString> {
        let old = std::env::var_os(key);
        std::env::set_var(key, value);
        old
    }

    fn restore_env(key: &str, old: Option<std::ffi::OsString>) {
        match old {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    fn auth_result(success: bool) -> AuthResult {
        AuthResult {
            success,
            username: None,
            access_token: None,
            client_token: None,
            refresh_token: None,
            uuid: None,
            user_type: None,
            expires_at: None,
            error_message: None,
        }
    }

    enum Scenario {
        NoCall,
        Rejected,
        TransportErr,
        Success(AuthResult),
    }

    /// 记录每次收到的 refresh_token 并返回轮换后的新值，用于验证并发刷新
    /// 时第二次调用基于第一次落库的最新令牌而非过期快照。
    struct RotatingAuth {
        seen: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl AuthProvider for RotatingAuth {
        async fn authenticate(&self, _request: AuthRequest) -> Result<AuthResult, Error> {
            panic!("refresh path must not call authenticate")
        }
        async fn validate(&self, _access_token: &str) -> Result<bool, Error> {
            Ok(true)
        }
        async fn invalidate(&self, _access_token: &str) -> Result<(), Error> {
            Ok(())
        }
        async fn refresh_login(&self, refresh_token: &str) -> Result<AuthResult, Error> {
            let n = {
                let mut seen = self.seen.lock().unwrap();
                seen.push(refresh_token.to_string());
                seen.len()
            };
            let mut r = auth_result(true);
            r.access_token = Some(format!("access-{n}"));
            r.refresh_token = Some(format!("rotated-{n}"));
            Ok(r)
        }
    }

    struct MockAuth {
        scenario: Scenario,
    }

    #[async_trait::async_trait]
    impl AuthProvider for MockAuth {
        async fn authenticate(&self, _request: AuthRequest) -> Result<AuthResult, Error> {
            panic!("refresh path must not call authenticate")
        }
        async fn validate(&self, _access_token: &str) -> Result<bool, Error> {
            Ok(true)
        }
        async fn invalidate(&self, _access_token: &str) -> Result<(), Error> {
            Ok(())
        }
        async fn refresh_login(&self, _refresh_token: &str) -> Result<AuthResult, Error> {
            match &self.scenario {
                Scenario::NoCall => panic!("unexpected refresh_login call"),
                Scenario::Rejected => Ok(auth_result(false)),
                Scenario::TransportErr => Err(Error::Http {
                    message: "connection refused".into(),
                    status: None,
                    source: None,
                }),
                Scenario::Success(r) => Ok(r.clone()),
            }
        }
    }

    fn ms_account() -> StoredAccount {
        StoredAccount {
            name: "Steve".into(),
            uuid: "test-uuid".into(),
            token: String::new(),
            access_token: "stale-token".into(),
            refresh_token: "refresh-token".into(),
            login_method: "Microsoft".into(),
            last_used: 0,
            is_default: true,
            server_url: None,
        }
    }

    /// Drop 时恢复 QOMICEX_HOME，保证 panic unwind 也不残留进程级环境变量。
    struct EnvGuard(Option<std::ffi::OsString>);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            restore_env("QOMICEX_HOME", self.0.take());
        }
    }

    fn test_account_service(tag: &str) -> (AccountService, EnvGuard) {
        let tmp = std::env::temp_dir().join(format!(
            "qomicex-refresh-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let old = set_env("QOMICEX_HOME", &tmp);
        (
            AccountService::new().expect("account service"),
            EnvGuard(old),
        )
    }

    #[tokio::test]
    async fn none_account_passthrough() {
        // into_inner：锁被 panic 毒化时仍继续执行，避免连锁失败掩盖根因
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("none");
        let out = refresh_microsoft_token(
            &MockAuth {
                scenario: Scenario::NoCall,
            },
            &accounts,
            None,
        )
        .await
        .unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn non_microsoft_passthrough_without_refresh_call() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("offline");
        let mut acc = ms_account();
        acc.login_method = "Offline".into();
        let original = acc.clone();
        let out = refresh_microsoft_token(
            &MockAuth {
                scenario: Scenario::NoCall,
            },
            &accounts,
            Some(acc),
        )
        .await
        .unwrap();
        assert_eq!(out, Some(original));
    }

    #[tokio::test]
    async fn microsoft_without_refresh_token_passthrough() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("no-rt");
        let mut acc = ms_account();
        acc.refresh_token.clear();
        let original = acc.clone();
        let out = refresh_microsoft_token(
            &MockAuth {
                scenario: Scenario::NoCall,
            },
            &accounts,
            Some(acc),
        )
        .await
        .unwrap();
        assert_eq!(out, Some(original));
    }

    #[tokio::test]
    async fn rejected_refresh_blocks_with_token_expired() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("rejected");
        let result = refresh_microsoft_token(
            &MockAuth {
                scenario: Scenario::Rejected,
            },
            &accounts,
            Some(ms_account()),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "TOKEN_EXPIRED");
    }

    #[tokio::test]
    async fn rate_limited_refresh_falls_back_to_existing_token() {
        // 回归：MC services 链 429 时不得误判 TOKEN_EXPIRED（重登死循环），
        // 应降级放行现有 token，交由下游 MC API 401 判真过期。
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("rate-limited");
        let mut r = auth_result(false);
        r.error_message =
            Some("Response status code does not indicate success: 429 (Too Many Requests).".into());
        let out = refresh_microsoft_token(
            &MockAuth {
                scenario: Scenario::Success(r),
            },
            &accounts,
            Some(ms_account()),
        )
        .await
        .unwrap();
        assert_eq!(out.unwrap().access_token, "stale-token");
    }

    #[tokio::test]
    async fn transport_error_blocks_with_network_error() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("transport");
        let result = refresh_microsoft_token(
            &MockAuth {
                scenario: Scenario::TransportErr,
            },
            &accounts,
            Some(ms_account()),
        )
        .await;
        let err = result.unwrap_err();
        assert_eq!(err.code, "NETWORK_ERROR");
        assert_eq!(err.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn success_updates_fields_and_persists() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("success");
        accounts.save_account(&mut ms_account()).await.unwrap();

        let mut fresh = auth_result(true);
        fresh.access_token = Some("new-access".into());
        fresh.refresh_token = Some("new-refresh".into());
        // 同一微软账户续期后 uuid 不变（仅 name 可因改名变化），保持原 uuid 走替换路径
        fresh.username = Some("Alex".into());

        let result = refresh_microsoft_token(
            &MockAuth {
                scenario: Scenario::Success(fresh),
            },
            &accounts,
            Some(ms_account()),
        )
        .await;
        let out = result.unwrap().expect("account");
        assert_eq!(out.access_token, "new-access");
        assert_eq!(out.refresh_token, "new-refresh");
        assert_eq!(out.name, "Alex");

        let persisted = accounts.get_account("test-uuid").await.unwrap().unwrap();
        assert_eq!(persisted.access_token, "new-access");
        assert_eq!(persisted.refresh_token, "new-refresh");
    }

    #[tokio::test]
    async fn concurrent_refreshes_serialize_and_read_latest() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (accounts, _env) = test_account_service("race");
        accounts.save_account(&mut ms_account()).await.unwrap();

        let auth = std::sync::Arc::new(RotatingAuth {
            seen: std::sync::Mutex::new(Vec::new()),
        });
        let accounts = std::sync::Arc::new(accounts);
        let a = auth.clone();
        let b = auth.clone();
        let ac = accounts.clone();
        let (r1, r2) = tokio::join!(
            async move { refresh_microsoft_token(a.as_ref(), ac.as_ref(), Some(ms_account())).await },
            async move {
                refresh_microsoft_token(b.as_ref(), accounts.as_ref(), Some(ms_account())).await
            },
        );
        r1.unwrap();
        r2.unwrap();

        let seen = auth.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        // 第一次基于初始令牌；第二次必须基于第一次轮换并落库后的最新值，
        // 否则旧 refresh_token 覆盖新值会导致后续刷新永久失败
        assert_eq!(seen[0], "refresh-token");
        assert_eq!(seen[1], "rotated-1");
    }
}
