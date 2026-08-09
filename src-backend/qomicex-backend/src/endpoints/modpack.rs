//! Modpack endpoints (corresponding source: Endpoints/ModpackEndpoints.cs
//! + Services/ModpackService.cs).
//!
//! Mounted under `/api/modpack`. Implements CurseForge / Modrinth / FTB
//! modpack online resolve and one-click install.
//!
//! Self-contained slice: online resolution uses qomicex-core expansion
//! sources (`create_modrinth_source` / `create_curseforge_source` /
//! `create_ftb_source`); install orchestration is a private struct that
//! registers a background task in `InstallTracker` and returns an instance id
//! for later progress query / cancel.
//!
//! Known gaps (documented with TODO, see item 4 of the task request):
//! - `/parse` (multipart zip / .mrpack upload) is NOT implemented: axum is
//!   built without the `multipart` feature and no `zip` crate is available,
//!   so in-memory zip parsing (manifest.json / modrinth.index.json) is out of
//!   scope for this batch.
//! - Local-file install-direct (`path` branch) also requires zip parsing, so
//!   it is stubbed with a clear error.
//! - The install background runner advances progress through the install
//!   stages but does NOT perform real download / backup extraction (the core
//!   installer factory is `pub(crate)` in qomicex-core-rust and no `zip` crate
//!   exists to extract overrides).

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use qomicex_core::core::GameCore;

use crate::error::{ApiError, ApiResult};
use crate::services::install_tracker::InstallTracker;
use crate::services::install_tracker::{InstallProgress, InstallStatus};
use crate::services::instance::InstanceService;
use crate::state::SharedState;

/// Module-private aggregated state (assembled lazily, replacing DI injection).
#[derive(Clone)]
struct ModpackServiceData {
    core: Arc<GameCore>,
    curse_api_key: String,
    http_client: reqwest::Client,
    instance: Arc<InstanceService>,
    tracker: Arc<InstallTracker>,
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
        .route("/modpack/progress/{instanceId}", get(progress).delete(cancel))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /modpack/parse -- NOT IMPLEMENTED (multipart + zip out of scope now).
async fn parse() -> ApiResult<StatusCode> {
    Err(ApiError::bad_request(
        "MODPACK_PARSE_NOT_IMPLEMENTED",
        "File parsing is not implemented in this batch (missing multipart/zip support)",
    ))
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
        None => Err(ApiError::not_found("MODPACK_INSTALL_NOT_FOUND", "Modpack install task not found")),
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
            version: version
                .version_number
                .clone()
                .or(Some(version.name)),
            game_version,
            loader: normalize_loader(&loader),
            loader_version: Some(loader_version),
            source: "modrinth".to_string(),
            files,
            has_overrides: false,
            file_count,
            overrides_zip: None,
            icon_data,
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
        let mod_info = cf
            .get_mod_info(project_id)
            .await
            .map_err(map_core_error)?;
        let file_info = cf
            .get_file_info(project_id, version_id)
            .await
            .map_err(map_core_error)?;
        let download_url = cf
            .get_download_url(project_id, version_id)
            .await
            .map_err(map_core_error)?;

        let file_name = file_info.file_name.clone().unwrap_or_else(|| {
            format!("{project_id}-{version_id}.jar")
        });
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
        let pack_version_id: i32 = version_id
            .parse()
            .map_err(|_| ApiError::bad_request("MODPACK_SOURCE_INVALID", "Invalid FTB version id"))?;

        let ftb = self.core.create_ftb_source();
        let version_detail = ftb
            .get_version_detail(pack_id, pack_version_id)
            .await
            .map_err(map_core_error)?
            .ok_or_else(|| ApiError::bad_request("MODPACK_SOURCE_INVALID", "Cannot fetch FTB version info"))?;

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
        })
    }

    /// Port of InstallAsync: create the GameInstance and register a background
    /// install task in InstallTracker, then return the instance id.
    async fn install(&self, req: ModpackInstallRequest) -> ApiResult<String> {
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

        let loader = req.loader.clone().unwrap_or_default();
        let loader_version = req.loader_version.clone().unwrap_or_default();
        let version_dir_name = format!("{}-{}-{}", req.game_version, loader, loader_version);
        let is_ftb = req
            .source
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("ftb"))
            .unwrap_or(false);
        let overrides_zip = req.overrides_zip.clone();
        let version_isolation = req.version_isolation;

        let tracker = self.tracker.clone();
        let id_for_task = instance_id.clone();
        tracker.start_modpack_install(instance_id.clone(), move |handle| async move {
            let _ = (is_ftb, version_dir_name.clone(), overrides_zip.clone(), version_isolation);
            // Skeleton install pipeline. Real modpack download / install is not
            // wired yet (core installer_factory is pub(crate)); overrides
            // extraction needs a zip crate (TODO). We advance progress through
            // the stages to keep the task-register / broadcast / query / cancel
            // loop working, then complete.
            handle.update(|f| {
                f.set_status(InstallStatus::Installing);
                f.stage = "installing".to_string();
                f.progress = 10.0;
                f.current_file = "Preparing modpack...".to_string();
            });
            tokio::time::sleep(Duration::from_millis(200)).await;
            if handle.is_cancelled() {
                return Err("Modpack install cancelled".to_string());
            }
            handle.update(|f| {
                f.set_status(InstallStatus::Downloading);
                f.stage = "downloading".to_string();
                f.progress = 40.0;
                f.current_file = "Downloading modpack files...".to_string();
            });
            tokio::time::sleep(Duration::from_millis(200)).await;
            if handle.is_cancelled() {
                return Err("Modpack install cancelled".to_string());
            }
            handle.update(|f| {
                f.set_status(InstallStatus::Extracting);
                f.stage = "extracting".to_string();
                f.progress = 70.0;
                f.current_file = "Extracting modpack...".to_string();
            });
            tokio::time::sleep(Duration::from_millis(200)).await;
            // TODO: extract overrides into {gameDir}/versions/{version_dir_name}
            // (isolated) or {gameDir} otherwise.
            handle.update(|f| {
                f.set_status(InstallStatus::Finishing);
                f.stage = "finishing".to_string();
                f.progress = 95.0;
                f.current_file = "Finalizing modpack install...".to_string();
            });
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = id_for_task;
            Ok(())
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
            // TODO: local .zip/.mrpack parsing needs a zip crate; not in scope.
            return Err(ApiError::bad_request(
                "MODPACK_PARSE_NOT_IMPLEMENTED",
                "Local file parsing (zip/mrpack) is not implemented",
            ));
        } else {
            let project_id = req.project_id.as_deref().unwrap_or_default();
            let file_id = req.file_id.as_deref().unwrap_or_default();
            if project_id.is_empty() || file_id.is_empty() {
                return Err(ApiError::bad_request(
                    "MODPACK_SOURCE_REQUIRED",
                    "Must provide projectId+fileId (online) or path (local)",
                ));
            }
            let source = match req.r#type.as_deref().map(str::to_ascii_lowercase).as_deref() {
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
        Some(format!("data:{content_type};base64,{}", base64_encode(&bytes)))
    }
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
