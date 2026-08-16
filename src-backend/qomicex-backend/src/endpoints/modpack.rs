//! Modpack endpoints (corresponding source: Endpoints/ModpackEndpoints.cs
//! + Services/ModpackService.cs).
//!
//! Mounted under `/api/modpack`. Implements CurseForge / Modrinth / FTB
//! modpack online resolve, one-click install, local-file import
//! (`.zip` / `.mrpack` upload + install) and instance export (CF zip / MR
//! mrpack with hash reverse lookup).
//!
//! Self-contained slice: online resolution uses qomicex-core expansion
//! sources (`create_modrinth_source` / `create_curseforge_source` /
//! `create_ftb_source`); install orchestration is a private struct that
//! registers a background task in `InstallTracker` and returns an instance id
//! for later progress query / cancel.
//!
//! Local import flow:
//! - `POST /modpack/parse` (multipart `file`) saves the upload under
//!   `{BaseDir}/temp/modpack-uploads/{uuid}`, detects the format
//!   (`modrinth.index.json` → mrpack, `manifest.json` → CF zip) and returns a
//!   `ModpackParseResult` including a `fileId` handle to the temp file.
//! - `POST /modpack/install` accepts `fileId`; the pipeline then skips the
//!   pack download and uses the temp file for manifest parsing and overrides
//!   extraction. Mods are still fetched from their sources (Modrinth URLs /
//!   CurseForge projectID:fileID lookups), and the local overrides are
//!   released afterwards (overrides carry files not resolvable via APIs).
//! - `POST /modpack/install-direct` with a `path` parses the local file and
//!   runs the same background pipeline.
//! - Temp uploads are removed after the install task settles.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::extract::{Multipart, Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use qomicex_core::api::installer::InstallerFactory;
use qomicex_core::core::GameCore;
use qomicex_core::services::installers::factory::DefaultInstallerFactory;

use crate::error::{ApiError, ApiResult};
use crate::services::export_tracker::ExportTaskSnapshot;
use crate::services::install_service::{download_batch, run_install_pipeline, InstallRequestData};
use crate::services::install_tracker::InstallTracker;
use crate::services::install_tracker::{InstallHandle, InstallProgress, InstallStatus};
use crate::services::instance::InstanceService;
use crate::services::modpack_export::{list_export_tree, ExportFormat, ExportTreeNode};
use crate::state::SharedState;

/// Module-private aggregated state (assembled lazily, replacing DI injection).
#[derive(Clone)]
struct ModpackServiceData {
    core: Arc<GameCore>,
    curse_api_key: String,
    http_client: reqwest::Client,
    instance: Arc<InstanceService>,
    tracker: Arc<InstallTracker>,
    download_manager: Arc<qomicex_downloader::DownloadManager>,
}

/// Process-wide singleton: assembled once per SharedState via OnceLock.
static MODPACK_STATE: OnceLock<Arc<ModpackServiceData>> = OnceLock::new();

fn modpack_data(shared: &SharedState) -> Arc<ModpackServiceData> {
    MODPACK_STATE
        .get_or_init(|| {
            Arc::new(ModpackServiceData {
                core: shared.core.clone(),
                curse_api_key: shared.curse_forge_api_key.clone(),
                http_client: shared.http_client.clone(),
                instance: shared.instance.clone(),
                tracker: shared.install_tracker.clone(),
                download_manager: shared.download_manager.clone(),
            })
        })
        .clone()
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/modpack/parse", post(parse))
        .route("/modpack/resolve", post(resolve))
        .route("/modpack/install", post(install))
        .route("/modpack/install-direct", post(install_direct))
        .route("/modpack/export/{instanceId}", post(export))
        .route("/modpack/export/files/{instanceId}", get(export_files))
        .route("/modpack/export/task/{taskId}", get(export_task_get))
        .route(
            "/modpack/export/task/{taskId}/cancel",
            post(export_task_cancel),
        )
        .route(
            "/modpack/export/task/{taskId}/download",
            get(export_task_download),
        )
        .route(
            "/modpack/progress/{instanceId}",
            get(progress).delete(cancel),
        )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /modpack/parse -- multipart upload of a local `.zip` / `.mrpack`.
///
/// Saves the upload to `{BaseDir}/temp/modpack-uploads/{uuid}`, detects the
/// format and returns a parse result. The returned `fileId` references the
/// temp file so the subsequent `/modpack/install` can use it without
/// re-uploading.
async fn parse(mut multipart: Multipart) -> ApiResult<Json<ModpackParseResult>> {
    let mut file_id: Option<String> = None;
    let mut saved_path: Option<PathBuf> = None;

    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        ApiError::bad_request("MODPACK_PARSE_UPLOAD_FAILED", format!("读取上传失败: {e}"))
    })? {
        if field.name() != Some("file") {
            continue;
        }
        let uploads_dir = modpack_uploads_dir()?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = uploads_dir.join(&id);
        let mut out = tokio::fs::File::create(&path)
            .await
            .map_err(|e| ApiError::internal(format!("保存上传文件失败: {e}")))?;
        let mut written: u64 = 0;
        while let Some(chunk) = field.chunk().await.map_err(|e| {
            ApiError::bad_request(
                "MODPACK_PARSE_UPLOAD_FAILED",
                format!("读取上传分块失败: {e}"),
            )
        })? {
            if chunk.is_empty() {
                continue;
            }
            written += chunk.len() as u64;
            if written > MAX_UPLOAD_BYTES {
                drop(out);
                let _ = std::fs::remove_file(&path);
                return Err(ApiError::bad_request(
                    "MODPACK_PARSE_TOO_LARGE",
                    "整合包文件过大（上限 4 GiB）",
                ));
            }
            out.write_all(&chunk)
                .await
                .map_err(|e| ApiError::internal(format!("写入上传文件失败: {e}")))?;
        }
        out.flush()
            .await
            .map_err(|e| ApiError::internal(format!("落盘失败: {e}")))?;
        file_id = Some(id);
        saved_path = Some(path);
    }

    let path = saved_path
        .ok_or_else(|| ApiError::bad_request("MODPACK_PARSE_FILE_REQUIRED", "缺少 file 字段"))?;
    let file_id = file_id.expect("saved_path 与 file_id 同设");

    let parsed = parse_local_pack_file(&path).map_err(|e| {
        let _ = std::fs::remove_file(&path);
        ApiError::bad_request("MODPACK_PARSE_FAILED", e)
    })?;

    let mut result = parsed.to_parse_result();
    result.file_id = Some(file_id);
    Ok(Json(result))
}

/// POST /modpack/export/{instanceId} -- start an async export task for an
/// installed instance (CF zip / MR mrpack, hash reverse lookup for files[]).
///
/// Returns `202 { taskId }`; progress is polled via
/// `GET /modpack/export/task/{taskId}`; cancellation via
/// `POST /modpack/export/task/{taskId}/cancel`; the zip bytes (when no
/// `targetPath` was given) via `GET /modpack/export/task/{taskId}/download`.
async fn export(
    State(s): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
    Json(req): Json<ModpackExportRequest>,
) -> ApiResult<Json<ExportTaskStartResponse>> {
    let instance = s
        .instance
        .get_by_id(&instance_id)
        .ok_or_else(|| ApiError::not_found("MODPACK_EXPORT_INSTANCE_NOT_FOUND", "实例不存在"))?;
    let format = match req
        .format
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("cf") | Some("curseforge") | Some("zip") => ExportFormat::CurseForge,
        Some("mr") | Some("modrinth") | Some("mrpack") => ExportFormat::Modrinth,
        _ => {
            return Err(ApiError::bad_request(
                "MODPACK_EXPORT_FORMAT_INVALID",
                "导出格式必须是 cf 或 mr",
            ))
        }
    };
    let task_id = s.export_tasks.start(
        &s.core,
        &s.curse_forge_api_key,
        &instance,
        format,
        req.include_saves.unwrap_or(false),
        req.include_screenshots.unwrap_or(false),
        req.include_files,
        req.name,
        req.version,
        req.author,
        req.target_path,
    );
    Ok(Json(ExportTaskStartResponse { task_id }))
}

/// POST /modpack/export/{instanceId} 的响应：任务 id。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTaskStartResponse {
    pub task_id: String,
}

/// GET /modpack/export/task/{taskId} -- poll export task progress.
async fn export_task_get(
    State(s): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<ExportTaskSnapshot>> {
    s.export_tasks
        .get(&task_id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found("MODPACK_EXPORT_TASK_NOT_FOUND", "导出任务不存在"))
}

/// POST /modpack/export/task/{taskId}/cancel -- request cancellation.
async fn export_task_cancel(
    State(s): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let cancelled = s.export_tasks.cancel(&task_id);
    if !cancelled {
        return Err(ApiError::not_found(
            "MODPACK_EXPORT_TASK_NOT_CANCELLABLE",
            "导出任务不存在或已结束",
        ));
    }
    Ok(Json(serde_json::json!({ "cancelled": true })))
}

/// GET /modpack/export/task/{taskId}/download -- fetch the finished zip bytes
/// (only for tasks started without `targetPath`; the task is cleaned up).
async fn export_task_download(
    State(s): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Response> {
    let (filename, bytes) = s
        .export_tasks
        .take_result(&task_id)
        .ok_or_else(|| ApiError::not_found("MODPACK_EXPORT_TASK_NO_RESULT", "导出结果不可用"))?;
    let body = Body::from(bytes);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(body)
        .map_err(|e| ApiError::internal(format!("构造响应失败: {e}")))
}

/// GET /modpack/export/files/{instanceId} -- list the instance's exportable
/// file tree (dir/file nodes with cumulative sizes) for the HMCL-style
/// file-selection UI. Shares the export collection rules (excluded dirs,
/// version json/jar, account caches); saves/screenshots are kept so the
/// frontend can decide via checkboxes.
async fn export_files(
    State(s): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<Vec<ExportTreeNode>>> {
    let instance = s
        .instance
        .get_by_id(&instance_id)
        .ok_or_else(|| ApiError::not_found("MODPACK_EXPORT_INSTANCE_NOT_FOUND", "实例不存在"))?;
    let tree = list_export_tree(&instance)
        .map_err(|e| ApiError::internal(format!("读取实例文件列表失败: {e}")))?;
    Ok(Json(tree))
}

/// POST /modpack/resolve -- resolve an online modpack project into parse result.
async fn resolve(
    State(s): State<SharedState>,
    Json(req): Json<ModpackResolveRequest>,
) -> ApiResult<Json<ModpackParseResult>> {
    let result = modpack_data(&s)
        .resolve_online(&req.source, &req.project_id, &req.version_id)
        .await?;
    Ok(Json(result))
}

/// POST /modpack/install -- start a modpack install from a fully-built request.
async fn install(
    State(s): State<SharedState>,
    Json(req): Json<ModpackInstallRequest>,
) -> ApiResult<Json<MessageResponse>> {
    let instance_id = modpack_data(&s).install(req).await?;
    Ok(Json(MessageResponse {
        message: "Install started".to_string(),
        version_id: Some(instance_id),
    }))
}

/// POST /modpack/install-direct -- one-click install (online or local path).
async fn install_direct(
    State(s): State<SharedState>,
    Json(req): Json<ModpackInstallDirectRequest>,
) -> ApiResult<Json<ModpackInstallDirectResponse>> {
    let instance_id = modpack_data(&s).install_direct(req).await?;
    Ok(Json(ModpackInstallDirectResponse { instance_id }))
}

/// GET /modpack/progress/{instanceId} -- query a background install task progress.
async fn progress(
    State(s): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<InstallProgress>> {
    match modpack_data(&s).tracker.get_state(&instance_id) {
        Some(p) => Ok(Json(p)),
        None => Err(ApiError::not_found(
            "MODPACK_INSTALL_NOT_FOUND",
            "Modpack install task not found",
        )),
    }
}

/// DELETE /modpack/progress/{instanceId} -- cancel a background install task.
async fn cancel(
    State(s): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<StatusCode> {
    modpack_data(&s).tracker.cancel(&instance_id);
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Modpack service (private struct; port of Services/ModpackService.cs)
// ---------------------------------------------------------------------------

impl ModpackServiceData {
    /// Resolve an online modpack into a parse result by source type.
    async fn resolve_online(
        &self,
        source: &str,
        project_id: &str,
        version_id: &str,
    ) -> ApiResult<ModpackParseResult> {
        match source.to_ascii_lowercase().as_str() {
            "modrinth" => self.resolve_modrinth(project_id, version_id).await,
            "curseforge" | "cf" => self.resolve_curseforge_online(project_id, version_id).await,
            "ftb" => self.resolve_ftb_online(project_id, version_id).await,
            other => Err(ApiError::bad_request(
                "MODPACK_SOURCE_INVALID",
                format!("Unsupported modpack source: {other}"),
            )),
        }
    }

    /// Resolve Modrinth project + version into a parse result.
    async fn resolve_modrinth(
        &self,
        project_id: &str,
        version_id: &str,
    ) -> ApiResult<ModpackParseResult> {
        let mr = self.core.create_modrinth_source();
        let project = mr
            .get_project_info(project_id)
            .await
            .map_err(map_core_error)?;
        let version = mr
            .get_version_info(version_id)
            .await
            .map_err(map_core_error)?;

        let game_version = version
            .game_version_ids
            .as_deref()
            .and_then(|g| g.first())
            .cloned()
            .unwrap_or_default();
        let loader = version
            .loaders
            .as_deref()
            .and_then(|l| l.first())
            .cloned()
            .unwrap_or_default();
        let loader_version = String::new();

        let mut files = Vec::new();
        if let Some(file_list) = version.files.as_deref() {
            for f in file_list {
                files.push(ModpackFileEntry {
                    path: f.filename.clone(),
                    download_url: Some(f.download_url.clone()),
                    size: None,
                });
            }
        }

        let icon_data = self
            .download_icon_as_data_uri(project.icon_url.as_deref())
            .await;
        let file_count = files.len() as i32;

        Ok(ModpackParseResult {
            name: project.name,
            summary: Some(project.description.clone()),
            author: project.team.clone(),
            version: version.version_number.clone().or(Some(version.name)),
            game_version,
            loader: normalize_loader(&loader),
            loader_version: Some(loader_version),
            source: "modrinth".to_string(),
            files,
            has_overrides: false,
            file_count,
            overrides_zip: None,
            icon_data,
            file_id: None,
        })
    }

    /// Resolve a CurseForge modpack file into a parse result.
    ///
    /// NOTE: the source parses the downloaded CurseForge zip to obtain game
    /// version / loader / overrides; without a `zip` crate we only surface the
    /// mod info + single download entry and leave the rest as TODO.
    async fn resolve_curseforge_online(
        &self,
        project_id: &str,
        version_id: &str,
    ) -> ApiResult<ModpackParseResult> {
        let cf = self.core.create_curseforge_source(&self.curse_api_key);
        let mod_info = cf.get_mod_info(project_id).await.map_err(map_core_error)?;
        let file_info = cf
            .get_file_info(project_id, version_id)
            .await
            .map_err(map_core_error)?;
        let download_url = cf
            .get_download_url(project_id, version_id)
            .await
            .map_err(map_core_error)?;

        let file_name = file_info
            .file_name
            .clone()
            .unwrap_or_else(|| format!("{project_id}-{version_id}.jar"));
        let files = vec![ModpackFileEntry {
            path: file_name,
            download_url: Some(download_url),
            size: None,
        }];
        let file_count = files.len() as i32;

        Ok(ModpackParseResult {
            name: mod_info.name,
            summary: mod_info.summary.clone(),
            author: mod_info
                .authors
                .as_deref()
                .and_then(|a| a.first())
                .map(|a| a.name.clone()),
            // TODO: real values come from parsing the downloaded manifest.zip;
            // unavailable without a zip crate.
            version: file_info.file_name.clone(),
            game_version: String::new(),
            loader: String::new(),
            loader_version: None,
            source: "curseforge".to_string(),
            files,
            has_overrides: false,
            file_count,
            overrides_zip: None,
            icon_data: None,
            file_id: None,
        })
    }

    /// Resolve an FTB modpack version into a parse result.
    async fn resolve_ftb_online(
        &self,
        project_id: &str,
        version_id: &str,
    ) -> ApiResult<ModpackParseResult> {
        let pack_id: i32 = project_id
            .parse()
            .map_err(|_| ApiError::bad_request("MODPACK_SOURCE_INVALID", "Invalid FTB pack id"))?;
        let pack_version_id: i32 = version_id.parse().map_err(|_| {
            ApiError::bad_request("MODPACK_SOURCE_INVALID", "Invalid FTB version id")
        })?;

        let ftb = self.core.create_ftb_source();
        let version_detail = ftb
            .get_version_detail(pack_id, pack_version_id)
            .await
            .map_err(map_core_error)?
            .ok_or_else(|| {
                ApiError::bad_request("MODPACK_SOURCE_INVALID", "Cannot fetch FTB version info")
            })?;

        let mut game_version = String::new();
        let mut loader = String::new();
        let mut loader_version = String::new();
        if let Some(targets) = version_detail.targets.as_deref() {
            for t in targets {
                if t.r#type.as_deref() == Some("game") {
                    game_version = t.version.clone().unwrap_or_default();
                } else if t.r#type.as_deref() == Some("modloader") {
                    loader = normalize_loader(t.name.as_deref().unwrap_or_default());
                    loader_version = t.version.clone().unwrap_or_default();
                }
            }
        }
        if game_version.is_empty() {
            return Err(ApiError::bad_request(
                "MODPACK_SOURCE_INVALID",
                "Cannot resolve FTB modpack game version",
            ));
        }

        let pack = ftb.get_pack_detail(pack_id).await.map_err(map_core_error)?;
        let icon_url = pack
            .as_ref()
            .and_then(|p| p.art.as_deref())
            .and_then(|arts| arts.first())
            .map(|a| a.url.clone());
        let icon_data = self.download_icon_as_data_uri(icon_url.as_deref()).await;

        Ok(ModpackParseResult {
            name: pack.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            summary: pack.as_ref().and_then(|p| p.synopsis.clone()),
            author: pack
                .as_ref()
                .and_then(|p| p.authors.as_deref())
                .and_then(|a| a.first())
                .map(|a| a.name.clone()),
            version: Some(version_detail.name),
            game_version,
            loader,
            loader_version: Some(loader_version),
            source: "ftb".to_string(),
            files: Vec::new(),
            has_overrides: false,
            file_count: 0,
            overrides_zip: None,
            icon_data,
            file_id: None,
        })
    }

    /// Port of InstallAsync: create the GameInstance and register a background
    /// install task in InstallTracker, then return the instance id.
    async fn install(&self, req: ModpackInstallRequest) -> ApiResult<String> {
        // 本地文件导入：file_id = parse 上传的临时文件句柄；local_path = 绝对路径
        // （install-direct 直传，不属于上传目录，不清理）。
        let (local_pack_path, cleanup_upload): (Option<PathBuf>, bool) =
            match (req.file_id.as_deref(), req.local_path.as_deref()) {
                (Some(fid), _) => {
                    let path = modpack_uploads_dir()?.join(fid);
                    if !path.is_file() {
                        return Err(ApiError::not_found(
                            "MODPACK_UPLOAD_NOT_FOUND",
                            "整合包临时文件不存在或已过期，请重新上传",
                        ));
                    }
                    (Some(path), true)
                }
                (None, Some(p)) => (Some(PathBuf::from(p)), false),
                _ => (None, false),
            };

        let mut instance = crate::services::instance::GameInstance::default();
        instance.name = req.name.clone();
        instance.game_version = req.game_version.clone();
        instance.loader = req.loader.clone();
        instance.loader_version = req.loader_version.clone();
        instance.game_dir = req.game_dir.clone();
        instance.max_memory = req.max_memory.unwrap_or(4096);
        instance.version_isolation = Some(req.version_isolation);
        instance.modpack_name = req.modpack_name.clone();
        instance.modpack_version = req.modpack_version.clone();
        instance.modpack_author = req.modpack_author.clone();
        instance.modpack_summary = req.modpack_summary.clone();
        instance.icon_data = req.icon_data.clone();
        let created = self.instance.create(instance);
        let instance_id = created.id.clone();
        let version_dir_name = created.name.clone();

        let tracker = self.tracker.clone();
        let mgr = self.download_manager.clone();
        let http_client = self.http_client.clone();
        let cf_api_key = self.curse_api_key.clone();
        let core = self.core.clone();
        let game_dir = req.game_dir.clone();
        let game_version = req.game_version.clone();
        let loader_in = req.loader.clone();
        let loader_version_in = req.loader_version.clone();
        let source = req.source.clone().unwrap_or_default();
        let project_id = req.project_id.clone();
        let file_id = req.version_id.clone();
        let modpack_files = req.modpack_files.clone();
        let version_isolation = req.version_isolation;
        // 管道结束后清理上传的临时文件（install-direct 的绝对路径不属于我们，不删）。
        let cleanup_path = if cleanup_upload {
            local_pack_path.clone()
        } else {
            None
        };

        tracker.start_modpack_install(instance_id.clone(), move |handle| async move {
            let result = run_modpack_pipeline(
                &handle,
                &mgr,
                &http_client,
                &cf_api_key,
                &core,
                &version_dir_name,
                &game_dir,
                &game_version,
                loader_in.as_deref(),
                loader_version_in.as_deref(),
                &source,
                project_id.as_deref(),
                file_id.as_deref(),
                modpack_files.as_deref(),
                version_isolation,
                local_pack_path.as_deref().and_then(|p| p.to_str()),
            )
            .await;
            if let Some(p) = cleanup_path {
                let _ = std::fs::remove_file(&p);
            }
            result
        });

        Ok(instance_id)
    }

    /// One-click install: resolve (local path or online), then install.
    async fn install_direct(&self, req: ModpackInstallDirectRequest) -> ApiResult<String> {
        if req.id.trim().is_empty() {
            return Err(ApiError::bad_request(
                "MODPACK_NAME_REQUIRED",
                "id (instance name) cannot be empty",
            ));
        }
        if req.game_dir.trim().is_empty() {
            return Err(ApiError::bad_request(
                "MODPACK_GAME_DIR_REQUIRED",
                "gameDir cannot be empty",
            ));
        }

        let resolved = if let Some(path) = req.path.as_deref() {
            if !Path::new(path).is_file() {
                return Err(ApiError::not_found(
                    "MODPACK_FILE_NOT_FOUND",
                    "Modpack file not found",
                ));
            }
            let parsed = parse_local_pack_file(Path::new(path))
                .map_err(|e| ApiError::bad_request("MODPACK_PARSE_FAILED", e))?;
            let p = parsed.pack;
            let result = ModpackParseResult {
                name: parsed.name,
                summary: parsed.summary,
                author: parsed.author,
                version: parsed.version,
                game_version: p.game_version,
                loader: p.loader,
                loader_version: Some(p.loader_version),
                source: parsed.source,
                files: p.files,
                has_overrides: parsed.has_overrides,
                file_count: parsed.file_count,
                overrides_zip: None,
                icon_data: None,
                file_id: None,
            };
            result
        } else {
            let project_id = req.project_id.as_deref().unwrap_or_default();
            let file_id = req.file_id.as_deref().unwrap_or_default();
            if project_id.is_empty() || file_id.is_empty() {
                return Err(ApiError::bad_request(
                    "MODPACK_SOURCE_REQUIRED",
                    "Must provide projectId+fileId (online) or path (local)",
                ));
            }
            let source = match req
                .r#type
                .as_deref()
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("mr") | Some("modrinth") => "modrinth",
                Some("cf") | Some("curseforge") => "curseforge",
                Some("ftb") => "ftb",
                _ => {
                    return Err(ApiError::bad_request(
                        "MODPACK_SOURCE_INVALID",
                        "Invalid modpack source type (mr/cf/ftb)",
                    ))
                }
            };
            self.resolve_online(source, project_id, file_id).await?
        };

        // 本地路径：直接复用该文件解析/释放 overrides（不再走 multipart 上传）。
        let local_pack_path = req.path.clone();

        let install_request = ModpackInstallRequest {
            name: req.id,
            game_version: resolved.game_version,
            loader: Some(resolved.loader),
            loader_version: resolved.loader_version,
            max_memory: req.max_memory,
            game_dir: req.game_dir,
            version_isolation: req.version_isolation.unwrap_or(false),
            modpack_files: Some(resolved.files),
            overrides_zip: resolved.overrides_zip,
            icon_data: resolved.icon_data,
            modpack_name: Some(resolved.name),
            modpack_version: resolved.version,
            modpack_author: resolved.author,
            modpack_summary: resolved.summary,
            source: Some(resolved.source),
            project_id: req.project_id,
            version_id: req.file_id,
            optifine_version: None,
            file_id: None,
            local_path: local_pack_path,
        };
        self.install(install_request).await
    }

    /// Download an icon and return it as a base64 data URI (port of
    /// DownloadIconAsDataUriAsync). Returns None on any failure.
    async fn download_icon_as_data_uri(&self, url: Option<&str>) -> Option<String> {
        let url = url?;
        if url.trim().is_empty() {
            return None;
        }
        let resp = match self.http_client.get(url).send().await {
            Ok(r) => match r.error_for_status() {
                Ok(r) => r,
                Err(e) => {
                    log_icon_err(&e);
                    return None;
                }
            },
            Err(e) => {
                log_icon_err(&e);
                return None;
            }
        };
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "image/png".to_string());
        let bytes = match resp.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                log_icon_err(&e);
                return None;
            }
        };
        Some(format!(
            "data:{content_type};base64,{}",
            base64_encode(&bytes)
        ))
    }
}

// ---------------------------------------------------------------------------
// 真实整合包安装管道（替代原 skeleton：下载 zip → 解析 manifest → 装游戏/加载器
// → 下载 mods → 释放 overrides；FTB 无 zip，走 core 安装器 API 直下）
// ---------------------------------------------------------------------------

/// 解析后的整合包清单（三源统一视图）。
struct ParsedModpack {
    game_version: String,
    loader: String,
    loader_version: String,
    /// (下载URL, 相对目标路径)。Modrinth：path 为完整相对路径（mods/x.jar 等）；
    /// CurseForge：仅收集 (空 URL, "projectID:fileID") 占位，随后逐个查 CF API。
    files: Vec<ModpackFileEntry>,
}

/// 版本隔离时目标路径落在 `{gameDir}/versions/{name}/` 下，否则 `{gameDir}/`。
fn modpack_target_path(
    game_dir: &str,
    version_dir_name: &str,
    version_isolation: bool,
    rel: &str,
) -> PathBuf {
    if version_isolation {
        Path::new(game_dir)
            .join("versions")
            .join(version_dir_name)
            .join(rel)
    } else {
        Path::new(game_dir).join(rel)
    }
}

/// Modrinth 下载需 UA（API 强制）；CurseForge CDN 需 x-api-key（同 install_service 判定）。
fn modpack_headers(url: &str, cf_api_key: &str) -> Vec<(String, String)> {
    if is_cf_host(url) {
        vec![
            ("x-api-key".to_string(), cf_api_key.to_string()),
            ("User-Agent".to_string(), "QomicexLauncher/1.0".to_string()),
        ]
    } else {
        vec![("User-Agent".to_string(), "QomicexLauncher/1.0".to_string())]
    }
}

fn is_cf_host(url: &str) -> bool {
    const CF_DOMAINS: &[&str] = &[
        "forgecdn.net",
        "curseforge.com",
        "cursecdn.com",
        "edge.forgecdn.net",
        "media.forgecdn.net",
        "mediafilez.forgecdn.net",
    ];
    let host = url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .unwrap_or("")
        .to_ascii_lowercase();
    CF_DOMAINS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// 主安装管道（后台任务 runner）。任一步失败 → Err(msg) → tracker 置 Failed。
///
/// `local_pack_path` 非空时跳过包体下载，直接用该文件解析 manifest 并释放
/// overrides（本地导入；mods 仍按源下载——mr 按 URL、cf 按 projectID:fileID）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_modpack_pipeline(
    handle: &InstallHandle,
    mgr: &Arc<qomicex_downloader::DownloadManager>,
    http_client: &reqwest::Client,
    cf_api_key: &str,
    core: &Arc<GameCore>,
    version_dir_name: &str,
    game_dir: &str,
    game_version_in: &str,
    loader_in: Option<&str>,
    loader_version_in: Option<&str>,
    source: &str,
    project_id: Option<&str>,
    file_id: Option<&str>,
    modpack_files: Option<&[ModpackFileEntry]>,
    version_isolation: bool,
    local_pack_path: Option<&str>,
) -> Result<(), String> {
    let src = source.to_ascii_lowercase();
    let mut zip_path: Option<PathBuf> = None;
    let mut parsed: Option<ParsedModpack> = None;

    // === 1. 获取整合包包体（本地导入直接用已上传/给定文件；在线下载）===
    if let Some(local) = local_pack_path {
        zip_path = Some(PathBuf::from(local));
    } else if src == "modrinth" || src == "curseforge" {
        handle.set_stage("downloading-modpack");
        handle.set_progress(5.0);
        let files = modpack_files.ok_or("整合包下载链接缺失")?;
        let first = files.first().ok_or("整合包下载链接缺失")?;
        let url = first
            .download_url
            .as_deref()
            .filter(|u| !u.is_empty())
            .ok_or("整合包下载链接缺失")?;
        let ext = if src == "modrinth" { "mrpack" } else { "zip" };
        let temp_dir = Path::new(game_dir).join("temp");
        std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建 temp 目录失败: {e}"))?;
        let path = temp_dir.join(format!("modpack-{version_dir_name}.{ext}"));
        handle.update(|f| {
            f.set_status(InstallStatus::Downloading);
            f.current_file = format!("整合包包体: {url}");
        });
        download_batch(
            handle,
            mgr,
            vec![(
                url.to_string(),
                path.clone(),
                modpack_headers(url, cf_api_key),
            )],
            5.0,
            25.0,
        )
        .await?;

        // === 2. 解析 manifest，补全游戏版本/加载器 ==="
        handle.set_stage("parsing-modpack");
        handle.set_progress(27.0);
        parsed = Some(if src == "modrinth" {
            parse_modrinth_index(&path)
                .map_err(|e| format!("解析 modrinth.index.json 失败: {e}"))?
        } else {
            parse_curseforge_manifest(&path).map_err(|e| format!("解析 manifest.json 失败: {e}"))?
        });
        zip_path = Some(path);
    }

    // === 3. 确定 game_version / loader / loader_version（调用方传入优先，manifest 补全）===
    let mut game_version = game_version_in.to_string();
    let mut loader = loader_in.unwrap_or_default().to_string();
    let mut loader_version = loader_version_in.unwrap_or_default().to_string();
    if let Some(p) = parsed.as_ref() {
        if game_version.is_empty() {
            game_version = p.game_version.clone();
        }
        if loader.is_empty() {
            loader = p.loader.clone();
        }
        if loader_version.is_empty() {
            loader_version = p.loader_version.clone();
        }
    }
    if game_version.is_empty() {
        return Err("无法确定整合包的游戏版本".to_string());
    }
    let loader_opt = if loader.is_empty() {
        None
    } else {
        Some(loader.clone())
    };
    let loader_version_opt = if loader_version.is_empty() {
        None
    } else {
        Some(loader_version.clone())
    };

    // === 4. 装游戏本体 + 加载器（复用实例安装流水线）===
    handle.update(|f| {
        f.set_status(InstallStatus::Installing);
        f.current_file = format!("安装 Minecraft {game_version} + {loader}", loader = loader);
    });
    let data = InstallRequestData {
        game_version: game_version.clone(),
        game_dir: game_dir.to_string(),
        version_dir_name: version_dir_name.to_string(),
        loader: loader_opt,
        loader_version: loader_version_opt,
        addons: Vec::new(),
        download_threads: 8,
        version_isolation,
        download_source_id: 0,
        optifine_version: None,
    };
    run_install_pipeline(handle, mgr.clone(), http_client.clone(), cf_api_key, data).await?;

    // === 5. 下载 mods / 整合包文件 ===
    handle.set_stage("modpack-files");
    handle.set_progress(68.0);
    match src.as_str() {
        "modrinth" => {
            let p = parsed.as_ref().expect("modrinth 必有解析结果");
            let files: Vec<(String, PathBuf, Vec<(String, String)>)> = p
                .files
                .iter()
                .filter_map(|f| {
                    let url = f.download_url.clone()?;
                    if url.is_empty() {
                        return None;
                    }
                    let dest =
                        modpack_target_path(game_dir, version_dir_name, version_isolation, &f.path);
                    let headers = modpack_headers(&url, cf_api_key);
                    Some((url, dest, headers))
                })
                .collect();
            if !files.is_empty() {
                download_batch(handle, mgr, files, 68.0, 85.0).await?;
            } else {
                handle.set_progress(85.0);
            }
        }
        "curseforge" => {
            let p = parsed.as_ref().expect("curseforge 必有解析结果");
            // CF manifest 的 files 是 (projectID,fileID) 引用，逐个查下载链接（串行避免限流）
            let cf = core.create_curseforge_source(cf_api_key);
            let mut files = Vec::new();
            for f in &p.files {
                let coord = &f.path; // "projectID:fileID"
                let Some((proj, fid)) = coord.split_once(':') else {
                    continue;
                };
                let Ok(info) = cf.get_file_info(proj, fid).await else {
                    continue;
                };
                let Ok(download_url) = cf.get_download_url(proj, fid).await else {
                    continue;
                };
                if download_url.is_empty() {
                    continue;
                }
                let filename = info.file_name.unwrap_or_else(|| {
                    download_url
                        .rsplit('/')
                        .next()
                        .unwrap_or("mod.jar")
                        .to_string()
                });
                let dest = modpack_target_path(
                    game_dir,
                    version_dir_name,
                    version_isolation,
                    &format!("mods/{filename}"),
                );
                let headers = modpack_headers(&download_url, cf_api_key);
                files.push((download_url, dest, headers));
            }
            if !files.is_empty() {
                download_batch(handle, mgr, files, 68.0, 85.0).await?;
            } else {
                handle.set_progress(85.0);
            }
        }
        "ftb" => {
            // core FtbModpackInstaller：FTB API 文件清单 + CF 批量查询 mods 链接
            let factory = DefaultInstallerFactory;
            let inst = factory.create_ftb_modpack(
                game_dir,
                version_isolation,
                http_client.clone(),
                cf_api_key,
            );
            let libs = inst
                .get_miss_libraries(Some(version_dir_name), project_id, file_id)
                .await
                .map_err(|e| format!("获取 FTB 整合包文件清单失败: {e}"))?;
            let files: Vec<(String, PathBuf, Vec<(String, String)>)> = libs
                .iter()
                .map(|l| {
                    let headers = modpack_headers(&l.url, cf_api_key);
                    (l.url.clone(), PathBuf::from(&l.path), headers)
                })
                .collect();
            if !files.is_empty() {
                download_batch(handle, mgr, files, 68.0, 88.0).await?;
            } else {
                handle.set_progress(88.0);
            }
        }
        _ => {
            handle.set_progress(85.0);
        }
    }

    // === 6. 释放 overrides（core 安装器；FTB 无 zip → 跳过，与 core FTB 行为一致）===
    if src == "modrinth" || src == "curseforge" {
        handle.set_stage("modpack-overrides");
        handle.set_progress(92.0);
        let factory = DefaultInstallerFactory;
        let zip_str = zip_path
            .as_ref()
            .and_then(|p| p.to_str())
            .ok_or("整合包文件缺失")?;
        let inst = if src == "modrinth" {
            factory.create_modrinth_modpack(game_dir, version_isolation, zip_str)
        } else {
            factory.create_curseforge_modpack(game_dir, version_isolation, zip_str)
        };
        inst.install(version_dir_name, "", None, None, None, None)
            .await
            .map_err(|e| format!("释放整合包覆盖文件失败: {e}"))?;
    }

    handle.update(|f| {
        f.set_status(InstallStatus::Finishing);
        f.stage = "finishing".to_string();
        f.progress = 98.0;
        f.current_file = "整合包安装完成".to_string();
    });
    Ok(())
}

/// 解析 Modrinth `.mrpack` 的 `modrinth.index.json`。
fn parse_modrinth_index(zip_path: &Path) -> Result<ParsedModpack, String> {
    let root = read_zip_json(zip_path, "modrinth.index.json")?;
    let deps = root
        .get("dependencies")
        .and_then(|d| d.as_object())
        .cloned()
        .unwrap_or_default();
    let game_version = deps
        .get("minecraft")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    // 优先级：neoforge > forge > quilt > fabric；Modrinth dependencies 键为
    // "fabric-loader"/"quilt-loader"（forge/neoforge 无后缀）
    let loader_key = ["neoforge", "forge", "quilt-loader", "fabric-loader"]
        .iter()
        .find(|k| deps.contains_key(**k))
        .map(|k| k.to_string())
        .unwrap_or_default();
    let loader_version = deps
        .get(&loader_key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    // 归一化为管道/安装器使用的 loader 名（同 core resolve 的 normalize_loader）
    let loader = match loader_key.as_str() {
        "fabric-loader" => "fabric".to_string(),
        "quilt-loader" => "quilt".to_string(),
        other => other.to_string(),
    };

    let mut files = Vec::new();
    if let Some(arr) = root.get("files").and_then(|f| f.as_array()) {
        for f in arr {
            // 源语义：env.client == "required" 才收集；缺失按 required 处理
            let env_client = f
                .get("env")
                .and_then(|e| e.get("client"))
                .and_then(|c| c.as_str())
                .unwrap_or("required");
            if env_client != "required" {
                continue;
            }
            let path = f
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or_default()
                .to_string();
            // ⚠️ modrinth.index.json 的 downloads 是字符串数组（直链），非对象数组
            let url = f
                .get("downloads")
                .and_then(|d| d.as_array())
                .and_then(|a| a.first())
                .and_then(|u| u.as_str())
                .unwrap_or_default()
                .to_string();
            if path.is_empty() || url.is_empty() {
                continue;
            }
            files.push(ModpackFileEntry {
                path,
                download_url: Some(url),
                size: None,
            });
        }
    }

    Ok(ParsedModpack {
        game_version,
        loader,
        loader_version,
        files,
    })
}

/// 解析 CurseForge 整合包 zip 的 `manifest.json`。
fn parse_curseforge_manifest(zip_path: &Path) -> Result<ParsedModpack, String> {
    let root = read_zip_json(zip_path, "manifest.json")?;
    if root.get("manifestType").and_then(|v| v.as_str()) != Some("minecraftModpack") {
        return Err("不是有效的 CurseForge 整合包".to_string());
    }
    let mc = root
        .get("minecraft")
        .and_then(|m| m.as_object())
        .cloned()
        .unwrap_or_default();
    let game_version = mc
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    // modLoaders[].id = "forge-47.1.0" → ("forge", "47.1.0")
    let mut loader = String::new();
    let mut loader_version = String::new();
    if let Some(ml) = mc
        .get("modLoaders")
        .and_then(|m| m.as_array())
        .and_then(|a| a.first())
    {
        if let Some(id) = ml.get("id").and_then(|v| v.as_str()) {
            if let Some((l, v)) = id.split_once('-') {
                loader = l.to_string();
                loader_version = v.to_string();
            } else {
                loader = id.to_string();
            }
        }
    }

    let mut files = Vec::new();
    if let Some(arr) = root.get("files").and_then(|f| f.as_array()) {
        for f in arr {
            let required = f.get("required").and_then(|r| r.as_bool()).unwrap_or(true);
            if !required {
                continue;
            }
            let proj = f.get("projectID").and_then(|v| v.as_i64()).unwrap_or(0);
            let fid = f.get("fileID").and_then(|v| v.as_i64()).unwrap_or(0);
            if proj <= 0 || fid <= 0 {
                continue;
            }
            files.push(ModpackFileEntry {
                path: format!("{proj}:{fid}"),
                download_url: None,
                size: None,
            });
        }
    }

    Ok(ParsedModpack {
        game_version,
        loader,
        loader_version,
        files,
    })
}

/// 读取 zip 内 JSON 文件并解析为 Value。
fn read_zip_json(zip_path: &Path, entry_name: &str) -> Result<serde_json::Value, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开整合包文件失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|_| format!("整合包内缺少 {entry_name}"))?;
    let mut content = String::new();
    entry
        .read_to_string(&mut content)
        .map_err(|e| format!("读取 {entry_name} 失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析 {entry_name} 失败: {e}"))
}

/// 上传整合包最大体积（4 GiB，对应 CF zip / mrpack 上限）。
const MAX_UPLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// 上传临时目录 `{BaseDir}/temp/modpack-uploads/`；顺带清理超过 1 天的残留。
fn modpack_uploads_dir() -> ApiResult<PathBuf> {
    let dir = crate::settings::resolve_base_dir()
        .join("temp")
        .join("modpack-uploads");
    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::internal(format!("创建上传目录失败: {e}")))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(age) = modified.elapsed() {
                        if age.as_secs() > 24 * 3600 {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }
    Ok(dir)
}

/// 本地文件解析结果（meta + 管道用的 ParsedModpack）。
struct LocalPackParse {
    source: String,
    name: String,
    summary: Option<String>,
    author: Option<String>,
    version: Option<String>,
    has_overrides: bool,
    file_count: i32,
    pack: ParsedModpack,
}

impl LocalPackParse {
    fn to_parse_result(self) -> ModpackParseResult {
        ModpackParseResult {
            name: self.name,
            summary: self.summary,
            author: self.author,
            version: self.version,
            game_version: self.pack.game_version,
            loader: self.pack.loader,
            loader_version: Some(self.pack.loader_version),
            source: self.source,
            files: self.pack.files,
            has_overrides: self.has_overrides,
            file_count: self.file_count,
            overrides_zip: None,
            icon_data: None,
            file_id: None,
        }
    }
}

/// 解析本地 `.zip`（CurseForge）/`.mrpack`（Modrinth）文件：探测格式 + 提取
/// meta（名称/版本/作者/简介）与管道用 ParsedModpack。
fn parse_local_pack_file(path: &Path) -> Result<LocalPackParse, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开整合包文件失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;
    let mut has_mr = false;
    let mut has_cf = false;
    let mut has_mr_overrides = false;
    let mut has_cf_overrides = false;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            continue;
        };
        let name = entry.name();
        match name {
            "modrinth.index.json" => has_mr = true,
            "manifest.json" => has_cf = true,
            _ => {}
        }
        if name.eq_ignore_ascii_case("override/") || name.starts_with("override/") {
            has_mr_overrides = true;
        }
        if name.eq_ignore_ascii_case("overrides/") || name.starts_with("overrides/") {
            has_cf_overrides = true;
        }
    }
    drop(archive);

    if has_mr {
        let root = read_zip_json(path, "modrinth.index.json")?;
        if root.get("game").and_then(|v| v.as_str()) != Some("minecraft") {
            return Err("不是有效的 Modrinth 整合包（game 字段非 minecraft）".to_string());
        }
        let name = root
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("整合包")
            .to_string();
        let version = root
            .get("versionId")
            .and_then(|v| v.as_str())
            .map(String::from);
        let summary = root
            .get("summary")
            .and_then(|v| v.as_str())
            .map(String::from);
        let pack = parse_modrinth_index(path)?;
        let file_count = pack.files.len() as i32;
        return Ok(LocalPackParse {
            source: "modrinth".to_string(),
            name,
            summary,
            author: None,
            version,
            has_overrides: has_mr_overrides,
            file_count,
            pack,
        });
    }

    if has_cf {
        let root = read_zip_json(path, "manifest.json")?;
        if root.get("manifestType").and_then(|v| v.as_str()) != Some("minecraftModpack") {
            return Err(
                "不是有效的 CurseForge 整合包（manifestType 非 minecraftModpack）".to_string(),
            );
        }
        let name = root
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("整合包")
            .to_string();
        let version = root
            .get("version")
            .and_then(|v| v.as_str())
            .map(String::from);
        let author = root
            .get("author")
            .and_then(|v| v.as_str())
            .map(String::from);
        let pack = parse_curseforge_manifest(path)?;
        let file_count = pack.files.len() as i32;
        return Ok(LocalPackParse {
            source: "curseforge".to_string(),
            name,
            summary: None,
            author,
            version,
            has_overrides: has_cf_overrides,
            file_count,
            pack,
        });
    }

    Err("无法识别的整合包格式：需包含 modrinth.index.json（Modrinth）或 manifest.json（CurseForge）".to_string())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn normalize_loader(loader: &str) -> String {
    match loader.to_ascii_lowercase().as_str() {
        "fabric-loader" => "fabric".to_string(),
        "quilt-loader" => "quilt".to_string(),
        other => other.to_string(),
    }
}

fn map_core_error(e: qomicex_core::error::Error) -> ApiError {
    ApiError::upstream(e.to_string())
}

fn log_icon_err(e: &dyn std::fmt::Display) -> ApiError {
    eprintln!("[ModpackEndpoints] download icon failed: {e}");
    ApiError::internal(e.to_string())
}

/// Minimal standard base64 encoder (no external base64 crate).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push(TABLE[n as usize & 63] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push('=');
    }
    out
}

// ---------------------------------------------------------------------------
// DTOs (camelCase, mirror source records)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackParseResult {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub game_version: String,
    pub loader: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    pub source: String,
    pub files: Vec<ModpackFileEntry>,
    pub has_overrides: bool,
    pub file_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides_zip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    /// 本地导入时上传临时文件的句柄（随 /modpack/install 传回）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackFileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackResolveRequest {
    pub source: String,
    pub project_id: String,
    pub version_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackInstallRequest {
    pub name: String,
    pub game_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory: Option<i32>,
    pub game_dir: String,
    pub version_isolation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub modpack_files: Option<Vec<ModpackFileEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub overrides_zip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub optifine_version: Option<String>,
    /// 本地导入：parse 返回的临时文件句柄。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    /// 本地导入：绝对路径（仅 install-direct 内部使用，不走 HTTP）。
    #[serde(skip)]
    pub local_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackInstallDirectRequest {
    pub id: String,
    #[serde(rename = "type")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub game_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_isolation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackInstallDirectResponse {
    pub instance_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
}

/// POST /modpack/export/{instanceId} 请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackExportRequest {
    /// 导出格式：cf（CurseForge zip）或 mr（Modrinth mrpack）。
    pub format: Option<String>,
    /// 是否包含存档 saves。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_saves: Option<bool>,
    /// 是否包含截图 screenshots。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_screenshots: Option<bool>,
    /// 包含文件白名单（相对路径，如 `mods/a.jar`）。不传 = 全量（向后兼容，
    /// saves/screenshots 由上述开关控制）；传入时由白名单唯一决定包含内容。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_files: Option<Vec<String>>,
    /// 覆盖包名（trim 非空时生效，覆盖实例 modpackName，并用于下载文件名）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 覆盖包版本（trim 非空时生效，覆盖实例 modpackVersion）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 覆盖作者（trim 非空时生效，覆盖实例 modpackAuthor；仅 CF manifest.json
    /// 写入，mrpack 标准格式无 author 字段）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// 保存目标路径（用户经系统保存对话框选择的完整文件路径）。传了由后端
    /// 在任务完成后把 zip 复制到该路径；不传则产物保留在临时目录，前端经
    /// `GET /modpack/export/task/{taskId}/download` 取字节（浏览器 fallback）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
}
