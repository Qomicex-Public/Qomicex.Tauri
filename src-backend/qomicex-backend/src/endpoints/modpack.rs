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
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, State};
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
use crate::services::install_service::{
    download_batch, ensure_not_cancelled, run_install_pipeline, InstallRequestData,
};
use crate::services::install_tracker::InstallStepSpec;
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
                download_manager: shared.download_manager.load_full(),
            })
        })
        .clone()
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/modpack/parse",
            post(parse).route_layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES as usize)),
        )
        .route(
            "/modpack/multimc/parse",
            post(multimc_parse).route_layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES as usize)),
        )
        .route("/modpack/multimc/parse-folder", post(multimc_parse_folder))
        .route("/modpack/multimc/import", post(multimc_import))
        .route("/modpack/technic/import", post(technic_import))
        .route("/modpack/parse-path", post(parse_path))
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
/// re-uploading. MultiMC 整合包（zip 内含 `mmc-pack.json`/`instance.cfg`）也在此
/// 识别：解压到 `{BaseDir}/temp/multimc-imports/{uuid}` 并返回 `packType: "multimc"`
/// + `sourceId`，供 `/modpack/multimc/import` 使用（单次上传，避免大包二次上传）。
async fn parse(
    State(s): State<SharedState>,
    mut multipart: Multipart,
) -> ApiResult<Json<ModpackParseResult>> {
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

    // === MultiMC 整合包（zip 内含 mmc-pack.json / instance.cfg）===
    // 解析阶段不落盘：像 C# ZipArchive 只读 zip 条目解析元数据，返回 source_path
    // （上传文件路径），安装阶段（multimc_import）再解压到临时目录并清理。
    if is_multimc_zip(&path) {
        let meta = crate::services::multimc::parse_metadata_from_zip(&path)
            .map_err(|e| ApiError::bad_request("MULTIMC_PARSE_FAILED", e))?;
        let loader = meta
            .loader_candidates
            .first()
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| meta.loader_uid.clone());
        return Ok(Json(ModpackParseResult {
            name: meta.name,
            summary: None,
            author: None,
            version: None,
            game_version: meta.game_version,
            loader,
            loader_version: if meta.loader_version.is_empty() {
                None
            } else {
                Some(meta.loader_version)
            },
            source: "multimc".to_string(),
            files: Vec::new(),
            optional_files: Vec::new(),
            has_overrides: false,
            file_count: 0,
            overrides_zip: None,
            icon_data: meta.icon_data,
            file_id: None,
            pack_type: Some("multimc".to_string()),
            source_id: None,
            source_path: Some(path.to_string_lossy().into_owned()),
        }));
    }

    // === Technic SingleZip 整合包（zip 含 bin/modpack.jar / bin/version.json）===
    // 探测阶段不落盘（只读中央目录 + 少量条目）；安装阶段（technic_import）再
    // 解压到临时目录并清理（大包解压耗时，必须后台可见进度，同 MultiMC / #89）。
    if crate::services::technic::is_technic_zip(&path) {
        let meta = parse_technic_or_api_error(&path).map_err(|e| {
            // 解析失败（含古董包缺 MC 版本）→ 删除上传临时文件，对齐
            // parse_local_pack_file 分支行为（4 GiB 上限的残留不能等 24h 自动清理）。
            let _ = std::fs::remove_file(&path);
            e
        })?;
        let name = meta.name.clone().unwrap_or_else(|| {
            // 无 name：退化为 zip 文件名（去扩展名）
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Technic 整合包".to_string())
        });
        return Ok(Json(ModpackParseResult {
            name,
            summary: None,
            author: None,
            version: None,
            game_version: meta.game_version.clone(),
            loader: meta.loader.clone().unwrap_or_default(),
            loader_version: meta.loader_version.clone(),
            source: "technic".to_string(),
            files: Vec::new(),
            optional_files: Vec::new(),
            has_overrides: false,
            file_count: 0,
            overrides_zip: None,
            icon_data: None,
            file_id: Some(file_id),
            pack_type: Some("technic".to_string()),
            source_id: None,
            source_path: Some(path.to_string_lossy().into_owned()),
        }));
    }

    let parsed = parse_local_pack_file(&path).map_err(|e| {
        let _ = std::fs::remove_file(&path);
        ApiError::bad_request("MODPACK_PARSE_FAILED", e)
    })?;

    let source = parsed.source.clone();
    let mut result = parsed.to_parse_result();
    result.file_id = Some(file_id);
    let data = modpack_data(&s);
    enrich_optional_files(&data.core, &data.curse_api_key, &mut result.optional_files).await;
    result.pack_type = Some(match source.as_str() {
        "modrinth" => "modrinth".to_string(),
        "curseforge" => "curseforge".to_string(),
        _ => "qomicex".to_string(),
    });
    Ok(Json(result))
}

/// POST /modpack/parse-path -- parse a local modpack file by absolute path.
///
/// IPC 模式下大文件（>200MB）无法通过 Tauri invoke 传输（JSON 序列化 Uint8Array
/// 触发 RangeError: Invalid array length），改为前端用 dialog 取路径后调此端点，
/// 后端直接从磁盘读取，绕过 IPC 二进制瓶颈。
async fn parse_path(
    State(s): State<SharedState>,
    Json(req): Json<ParsePathRequest>,
) -> ApiResult<Json<ModpackParseResult>> {
    let path = validate_source_path(&req.path)?;
    if !path.is_file() {
        return Err(ApiError::not_found(
            "MODPACK_FILE_NOT_FOUND",
            "整合包文件不存在",
        ));
    }

    // MultiMC 整合包（zip 内含 mmc-pack.json/instance.cfg）
    if is_multimc_zip(path) {
        let meta = crate::services::multimc::parse_metadata_from_zip(path)
            .map_err(|e| ApiError::bad_request("MULTIMC_PARSE_FAILED", e))?;
        let loader = meta
            .loader_candidates
            .first()
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| meta.loader_uid.clone());
        return Ok(Json(ModpackParseResult {
            name: meta.name,
            summary: None,
            author: None,
            version: None,
            game_version: meta.game_version,
            loader,
            loader_version: if meta.loader_version.is_empty() {
                None
            } else {
                Some(meta.loader_version)
            },
            source: "multimc".to_string(),
            files: Vec::new(),
            optional_files: Vec::new(),
            has_overrides: false,
            file_count: 0,
            overrides_zip: None,
            icon_data: meta.icon_data,
            file_id: None,
            pack_type: Some("multimc".to_string()),
            source_id: None,
            source_path: Some(path.to_string_lossy().into_owned()),
        }));
    }

    // Technic SingleZip 整合包：同 parse 的探测（不落盘）。
    if crate::services::technic::is_technic_zip(path) {
        let meta = parse_technic_or_api_error(path)?;
        let name = meta.name.clone().unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Technic 整合包".to_string())
        });
        return Ok(Json(ModpackParseResult {
            name,
            summary: None,
            author: None,
            version: None,
            game_version: meta.game_version.clone(),
            loader: meta.loader.clone().unwrap_or_default(),
            loader_version: meta.loader_version.clone(),
            source: "technic".to_string(),
            files: Vec::new(),
            optional_files: Vec::new(),
            has_overrides: false,
            file_count: 0,
            overrides_zip: None,
            icon_data: None,
            file_id: None,
            pack_type: Some("technic".to_string()),
            source_id: None,
            source_path: Some(path.to_string_lossy().into_owned()),
        }));
    }

    let parsed = parse_local_pack_file(path)
        .map_err(|e| ApiError::bad_request("MODPACK_PARSE_FAILED", e))?;

    let source = parsed.source.clone();
    let mut result = parsed.to_parse_result();
    result.file_id = None;
    let data = modpack_data(&s);
    enrich_optional_files(&data.core, &data.curse_api_key, &mut result.optional_files).await;
    result.pack_type = Some(match source.as_str() {
        "modrinth" => "modrinth".to_string(),
        "curseforge" => "curseforge".to_string(),
        _ => "qomicex".to_string(),
    });
    Ok(Json(result))
}

#[derive(Deserialize)]
struct ParsePathRequest {
    path: String,
}

// ---------------------------------------------------------------------------
// MultiMC 实例/整合包导入
// ---------------------------------------------------------------------------

/// POST /modpack/multimc/parse -- multipart 上传 MultiMC 整合包 zip，
/// 解压到 `{BaseDir}/temp/multimc-imports/{uuid}/`，解析元数据并返回句柄。
async fn multimc_parse(mut multipart: Multipart) -> ApiResult<Json<MultiMcParseResult>> {
    let mut zip_data: Option<Vec<u8>> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        ApiError::bad_request("MULTIMC_PARSE_UPLOAD_FAILED", format!("读取上传失败: {e}"))
    })? {
        if field.name() != Some("file") {
            continue;
        }
        let mut data = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(|e| {
            ApiError::bad_request(
                "MULTIMC_PARSE_UPLOAD_FAILED",
                format!("读取上传分块失败: {e}"),
            )
        })? {
            if chunk.is_empty() {
                continue;
            }
            data.extend_from_slice(&chunk);
            if data.len() as u64 > MAX_UPLOAD_BYTES {
                return Err(ApiError::bad_request(
                    "MULTIMC_PARSE_TOO_LARGE",
                    "整合包文件过大（上限 4 GiB）",
                ));
            }
        }
        zip_data = Some(data);
    }
    let data = zip_data
        .ok_or_else(|| ApiError::bad_request("MULTIMC_PARSE_FILE_REQUIRED", "缺少 file 字段"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let dir = multimc_imports_dir()?.join(&id);
    extract_zip(&data, &dir)
        .map_err(|e| ApiError::bad_request("MULTIMC_PARSE_EXTRACT_FAILED", e))?;
    multimc_parse_from_dir(&dir, Some(id)).map(Json)
}

/// POST /modpack/multimc/parse-folder -- 解析已解压的 MultiMC 实例目录。
async fn multimc_parse_folder(
    Json(req): Json<MultiMcParseFolderRequest>,
) -> ApiResult<Json<MultiMcParseResult>> {
    let dir = validate_source_path(&req.path)?;
    if !dir.is_dir() {
        return Err(ApiError::not_found(
            "MULTIMC_SOURCE_NOT_FOUND",
            "MultiMC 实例目录不存在",
        ));
    }
    multimc_parse_from_dir(dir, None).map(Json)
}

/// 校验调用方提供的源路径：必须为绝对路径且不含 `..` 遍历（防读取任意路径）。
/// 后端为本地无认证服务，路径由受信任 Tauri 前端经文件/文件夹选择器提供；
/// 此处仅做基础防御。返回规范化后的 `&Path`。
fn validate_source_path<'a>(raw: &'a str) -> ApiResult<&'a std::path::Path> {
    let path = std::path::Path::new(raw);
    if !path.is_absolute() {
        return Err(ApiError::bad_request(
            "MULTIMC_SOURCE_PATH_RELATIVE",
            "MultiMC 源路径必须为绝对路径",
        ));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(ApiError::bad_request(
            "MULTIMC_SOURCE_PATH_TRAVERSAL",
            "MultiMC 源路径不允许包含 ..",
        ));
    }
    Ok(path)
}

/// 从实例目录解析元数据（zip 解压根或用户选择的文件夹），返回解析结果 + 源句柄。
fn multimc_parse_from_dir(
    dir: &std::path::Path,
    source_id: Option<String>,
) -> ApiResult<MultiMcParseResult> {
    let root = crate::services::multimc::locate_instance_root(dir).ok_or_else(|| {
        ApiError::bad_request(
            "MULTIMC_NOT_FOUND",
            "未找到 MultiMC 实例（缺少 instance.cfg / mmc-pack.json）",
        )
    })?;
    let meta = crate::services::multimc::parse_metadata(&root)
        .map_err(|e| ApiError::bad_request("MULTIMC_PARSE_FAILED", e))?;
    let loader = meta
        .loader_candidates
        .first()
        .map(|(_, n)| n.clone())
        .unwrap_or_else(|| meta.loader_uid.clone());
    let source_path = if source_id.is_none() {
        Some(root.to_string_lossy().into_owned())
    } else {
        None
    };
    Ok(MultiMcParseResult {
        source_id,
        source_path,
        name: meta.name,
        game_version: meta.game_version,
        loader,
        loader_version: if meta.loader_version.is_empty() {
            None
        } else {
            Some(meta.loader_version)
        },
        icon_data: meta.icon_data,
    })
}

/// POST /modpack/multimc/import -- 创建实例并后台执行 MultiMC 导入。
async fn multimc_import(
    State(s): State<SharedState>,
    Json(req): Json<MultiMcImportRequest>,
) -> ApiResult<Json<ModpackInstallDirectResponse>> {
    multimc_import_impl(s, req).await
}

/// MultiMC 导入主体（multimc_import 与 /modpack/install-direct 的 MultiMC zip
/// 分支共用；source_path 指向 zip 时解压到临时目录，导入后清理）。
async fn multimc_import_impl(
    s: SharedState,
    req: MultiMcImportRequest,
) -> ApiResult<Json<ModpackInstallDirectResponse>> {
    // 导入临时资源 RAII 守卫：Drop 时删除登记路径，覆盖所有提前返回路径
    // （解压后 locate_instance_root / parse_metadata / 实例创建失败也会清理）。
    struct ImportCleanup(Vec<PathBuf>);
    impl ImportCleanup {
        fn new() -> Self {
            Self(Vec::new())
        }
        fn push_dir(&mut self, p: PathBuf) {
            self.0.push(p);
        }
        fn push_file(&mut self, p: PathBuf) {
            self.0.push(p);
        }
    }
    impl Drop for ImportCleanup {
        fn drop(&mut self) {
            for p in &self.0 {
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(p);
                } else {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
    }
    let mut cleanup = ImportCleanup::new();

    let pending_zip: Option<std::path::PathBuf> =
        match (req.source_id.as_deref(), req.source_path.as_deref()) {
            (Some(id), _) => {
                // source_id 由解析阶段生成（multimc_imports_dir/{uuid}），此处要求 UUID
                // 格式，防止恶意 source_id（含 .. / 绝对路径）让 RAII 清理删除任意目录。
                let is_uuid = uuid::Uuid::parse_str(id).is_ok();
                if !is_uuid || id.is_empty() {
                    return Err(ApiError::bad_request(
                        "MULTIMC_SOURCE_ID_INVALID",
                        "sourceId 无效（应为 UUID）",
                    ));
                }
                let dir = multimc_imports_dir()?.join(id);
                // 纵深防御：确认拼接后仍在 imports 根下（UUID 已保证无分隔符，此处兜底）。
                if !dir.starts_with(&multimc_imports_dir()?) {
                    return Err(ApiError::bad_request(
                        "MULTIMC_SOURCE_ID_INVALID",
                        "sourceId 无效（越界路径）",
                    ));
                }
                cleanup.push_dir(dir.clone());
                None
            }
            (None, Some(p)) => {
                let p = validate_source_path(p)?.to_path_buf();
                if p.is_file() {
                    // source_path 指向 zip：解析阶段不落盘，解压挪进后台任务
                    // （大包解压耗时远超前端 15s 请求超时，请求内同步解压会导致
                    // 「前端超时报错、后端仍在导入」的空实例假象，见 issue #89）。
                    // 上传的 zip（位于 modpack-uploads/）导入完成后删除，避免累积。
                    if p.starts_with(&modpack_uploads_dir()?) {
                        cleanup.push_file(p.clone());
                    }
                    Some(p)
                } else {
                    cleanup.push_dir(p.clone());
                    None
                }
            }
            _ => {
                return Err(ApiError::bad_request(
                    "MULTIMC_SOURCE_REQUIRED",
                    "缺少 sourceId（zip 上传）或 sourcePath（实例目录）",
                ))
            }
        };
    // 元数据来源：zip → 只读中央目录（不解压，秒级）；目录 → locate_instance_root。
    let mut folder_root: Option<std::path::PathBuf> = None;
    let meta = if let Some(zip) = &pending_zip {
        crate::services::multimc::parse_metadata_from_zip(zip)
            .map_err(|e| ApiError::bad_request("MULTIMC_PARSE_FAILED", e))?
    } else {
        let source_dir = match (req.source_id.as_deref(), req.source_path.as_deref()) {
            (Some(id), _) => multimc_imports_dir()?.join(id),
            (None, Some(p)) => validate_source_path(p)?.to_path_buf(),
            _ => unreachable!("上面 match 已拒绝双空"),
        };
        let root =
            crate::services::multimc::locate_instance_root(&source_dir).ok_or_else(|| {
                ApiError::bad_request(
                    "MULTIMC_NOT_FOUND",
                    "未找到 MultiMC 实例（缺少 instance.cfg / mmc-pack.json）",
                )
            })?;
        folder_root = Some(root.clone());
        crate::services::multimc::parse_metadata(&root)
            .map_err(|e| ApiError::bad_request("MULTIMC_PARSE_FAILED", e))?
    };

    let game_dir = validate_source_path(&req.game_dir)?.to_path_buf();
    let game_dir = crate::services::install_service::absolute_path(&game_dir.to_string_lossy());
    // MultiMC 实例天生自带完整 `.minecraft`（含自身 mods/config/版本隔离内容），
    // 必须写入 `versions/{name}` 隔离目录；共享根目录（version_isolation=false）会让
    // 内容与启动路径不一致，故强制隔离。
    let version_isolation = true;
    let base_name = sanitize_instance_name(if req.name.trim().is_empty() {
        meta.name.as_str()
    } else {
        req.name.trim()
    });
    // 并发导入同名实例的选名是"检查后创建"竞态：两个请求可能同时选中同一名字，
    // 后台任务会互相覆盖版本 JSON 与内容。用全局锁串行化「选名 → 创建实例记录」；
    // 导入低频，全局锁可接受（若需高并发再按 game_dir 分锁）。
    static MULTIMC_IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = MULTIMC_IMPORT_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let name = unique_instance_name(&game_dir, &base_name);
    let loader = if meta.loader_uid.is_empty() {
        None
    } else {
        Some(
            meta.loader_candidates
                .first()
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| meta.loader_uid.clone()),
        )
    };
    let mut inst = crate::services::instance::GameInstance::default();
    inst.name = name.clone();
    inst.game_version = meta.game_version.clone();
    inst.loader = loader;
    inst.loader_version = if meta.loader_version.is_empty() {
        None
    } else {
        Some(meta.loader_version.clone())
    };
    inst.java_path = meta.java_path.clone();
    inst.max_memory = meta.max_memory.unwrap_or(4096);
    inst.game_dir = game_dir.to_string_lossy().into_owned();
    inst.version_isolation = Some(version_isolation);
    // 归一化到缩略图尺寸：否则 instances.json 与 /api/instance 响应里存/发的还是
    // 512x512 的全尺寸 base64（73 个实例就是 10MB+，每次 GET /api/instance 全量重传）。
    // 注意这**只**影响实例记录：落盘的 `versions/{name}/icon.png` 仍写原图
    // （见本函数末尾的 write_pack_icon），原图是用户资产，扫描时会自行缩小。
    inst.icon_data = meta
        .icon_data
        .as_deref()
        .map(crate::util::pcl_icon::normalize_icon_data_uri);
    inst.modpack_name = Some(name.clone());
    let created = s.instance.create(inst);
    drop(_guard);
    let instance_id = created.id.clone();

    let tracker = s.install_tracker.clone();
    let mgr = s.download_manager.load_full();
    let http_client = s.http_client.clone();
    let inst_svc = s.instance.clone();
    let meta_owned = meta;
    let gd = game_dir.to_string_lossy().into_owned();
    let inst_id_inner = instance_id.clone();
    let imports_root = multimc_imports_dir()?;

    tracker.start_modpack_install(instance_id.clone(), move |handle| async move {
        // zip 解压目录在后台任务内创建并登记到 cleanup（extract 步骤产物）。
        let extract_dir = match pending_zip {
            Some(_) => {
                let dir = imports_root.join(uuid::Uuid::new_v4().to_string());
                cleanup.push_dir(dir.clone());
                Some(dir)
            }
            None => None,
        };
        let result = run_multimc_import(
            &handle,
            &mgr,
            &http_client,
            pending_zip.as_deref(),
            extract_dir.as_deref(),
            folder_root.as_deref(),
            &meta_owned,
            &gd,
            &name,
            &inst_svc,
            &inst_id_inner,
        )
        .await;
        drop(cleanup); // 导入完成（含失败）后清理临时解压目录与上传 zip
        if result.is_err() {
            // 回滚：删除实例记录 + 版本隔离目录。
            // 目录删除失败 → 保留记录防幽灵实例复活，错误并入任务失败信息。
            if let Err(e) = inst_svc.try_delete(&inst_id_inner) {
                let msg = format!(
                    "{}；另：{e}，实例记录已保留，请手动删除或重试",
                    result.as_ref().err().map(String::as_str).unwrap_or("")
                );
                return Err(msg);
            }
        }
        result
    });

    Ok(Json(ModpackInstallDirectResponse { instance_id }))
}

/// MultiMC 导入后台任务：组件补丁链合并（策略 B，对齐 HMCL）+ 内容/内嵌库拷贝。
/// `pending_zip` 非空时先在 extract 步骤解压到 `extract_dir`（大包耗时分钟级，
/// 必须在后台可见进度）；否则 `folder_root` 即实例根目录。
#[allow(clippy::too_many_arguments)]
async fn run_multimc_import(
    handle: &InstallHandle,
    mgr: &Arc<qomicex_downloader::DownloadManager>,
    http_client: &reqwest::Client,
    pending_zip: Option<&std::path::Path>,
    extract_dir: Option<&std::path::Path>,
    folder_root: Option<&std::path::Path>,
    meta: &crate::services::multimc::MultiMcMetadata,
    game_dir: &str,
    version_dir_name: &str,
    inst_svc: &crate::services::instance::InstanceService,
    instance_id: &str,
) -> Result<(), String> {
    use InstallStepSpec as S;

    // === 解压整合包 zip（仅 zip 导入）===
    if let (Some(zip), Some(dir)) = (pending_zip, extract_dir) {
        let specs: Vec<S> = vec![
            S {
                id: "extract",
                weight: 10.0,
            },
            S {
                id: "install-game",
                weight: 35.0,
            },
            S {
                id: "copy-files",
                weight: 35.0,
            },
            S {
                id: "finalize",
                weight: 20.0,
            },
        ];
        handle.define_steps(
            &specs,
            crate::services::install_service::INSTALL_STEP_BUDGET_TOP,
        );
        handle.mark_step("extract", "active");
        handle.set_stage("extracting-modpack");
        extract_zip_file_progressed(zip, dir, &mut |done, total| {
            let pct = if total > 0 {
                done as f64 * 100.0 / total as f64
            } else {
                100.0
            };
            handle.set_step_percent("extract", pct);
            handle.set_current_file(&format!("解压整合包文件 {done}/{total}..."));
        })?;
        handle.mark_step("extract", "done");
    } else {
        handle.define_steps(
            &[
                S {
                    id: "install-game",
                    weight: 40.0,
                },
                S {
                    id: "copy-files",
                    weight: 35.0,
                },
                S {
                    id: "finalize",
                    weight: 15.0,
                },
            ],
            crate::services::install_service::INSTALL_STEP_BUDGET_TOP,
        );
    }
    let root: std::path::PathBuf = match (pending_zip, extract_dir) {
        (Some(_), Some(dir)) => {
            crate::services::multimc::locate_instance_root(dir).ok_or_else(|| {
                "解压后未找到 MultiMC 实例（缺少 instance.cfg / mmc-pack.json）".to_string()
            })?
        }
        _ => folder_root
            .map(std::path::Path::to_path_buf)
            .ok_or("导入源缺失（既非 zip 也非实例目录）".to_string())?,
    };

    // 统一路径（对齐 HMCL）：所有 MultiMC 包都走「组件补丁链合并」生成官方版本 JSON。
    // 标准安装管线捷径会对带辅助组件 / 新版 Java 参数（+jvmArgs）的包漏掉补丁
    // （LWJGL3 库、RFB 主类、--add-opens 启动参数），且 fabric/quilt 会误加默认 addon，
    // 故不再使用。
    handle.mark_step("install-game", "active");
    handle.set_stage("building-version");
    handle.set_current_file("合并 MultiMC 组件补丁...");
    let (merged, jvm_args) = crate::services::multimc::build_merged_version_json(
        http_client,
        &root,
        meta,
        version_dir_name,
    )
    .await?;
    let version_dir = std::path::Path::new(game_dir)
        .join("versions")
        .join(version_dir_name);
    std::fs::create_dir_all(&version_dir).map_err(|e| format!("创建版本目录失败: {e}"))?;
    std::fs::write(
        version_dir.join(format!("{version_dir_name}.json")),
        &merged,
    )
    .map_err(|e| format!("写入版本 JSON 失败: {e}"))?;

    // 先把包内 MMC-hint:local 内嵌库复制到 maven 路径（如 GTNH 的
    // lwjgl3ify-2.1.16-forgePatches.jar），使下方下载扫描判定已存在而跳过；
    // 否则空 url 会被 locator 回退成 libraries.minecraft.net 触发 404 下载。
    let game_root = std::path::Path::new(game_dir);
    let _ = crate::services::multimc::copy_embedded_libraries(&root, game_root, &merged)?;

    // 下载缺失文件（库 + 主 jar + 资源；镜像/进度/取消复用 locator + download_manager）。
    handle.set_stage("downloading-game");
    let source_id = crate::settings::get_global_file_download_source();
    let repair = crate::services::install_service::build_repair_core(
        game_dir,
        source_id,
        http_client.clone(),
    );
    let miss = repair
        .locator()
        .get_miss_files_from_json(&merged)
        .await
        .map_err(|e| format!("扫描缺失文件失败: {e}"))?;
    let miss: Vec<_> = miss
        .into_iter()
        .filter(|f| !f.path.is_empty() && !f.url.is_empty())
        .collect();
    if !miss.is_empty() {
        handle.set_current_file(&format!("下载游戏文件（{} 个）...", miss.len()));
        let files: Vec<(String, std::path::PathBuf, Vec<(String, String)>)> = miss
            .iter()
            .map(|f| (f.url.clone(), std::path::PathBuf::from(&f.path), Vec::new()))
            .collect();
        download_batch(handle, mgr, files, Some("install-game")).await?;
    }
    // 组件收集的 +jvmArgs（等价 HMCL addnJvmArguments）写入实例 jvm_args，启动时统一生效
    // （任何包声明 Java 9+ 参数都会应用，覆盖所有新版 Java 整合包）。
    if !jvm_args.is_empty() {
        if let Some(mut inst) = inst_svc.get_by_id(instance_id) {
            inst.jvm_args = Some(jvm_args.join(" "));
            let _ = inst_svc.update(instance_id, inst);
        }
    }
    handle.mark_step("install-game", "done");

    // === 拷贝用户内容 + 内嵌库 ===
    handle.mark_step("copy-files", "active");
    handle.set_stage("copying-files");
    handle.set_current_file("拷贝实例内容...");
    crate::services::multimc::copy_instance_content(&root, game_root, version_dir_name)?;
    handle.mark_step("copy-files", "done");

    // === 收尾 ===
    handle.mark_step("finalize", "active");
    handle.set_stage("finishing");
    handle.set_current_file("导入完成");
    write_pack_icon(game_dir, version_dir_name, meta.icon_data.as_deref())?;
    handle.mark_step("finalize", "done");
    Ok(())
}

/// Technic 解析错误 → `ApiError`（issue #180）。
///
/// 解析器用错误文本前缀携带**具体**错误码（如
/// `TECHNIC_ANCIENT_PACK_NO_VERSION`）。若一律包成 `TECHNIC_PARSE_FAILED`，
/// API 文档承诺的专门错误码就永远不会出现——调用方（含前端按码分支）拿不到可判别的
/// 原因（CodeRabbit PR #190 finding）。故这里识别已知前缀并提升为对应的 `code`，
/// 其余仍归 `TECHNIC_PARSE_FAILED`。
fn technic_parse_error(e: String) -> ApiError {
    // 已知的「解析失败但原因明确」前缀 → 专门错误码
    const KNOWN: [&str; 2] = [
        "TECHNIC_ANCIENT_PACK_NO_VERSION",
        crate::services::technic::JARMOD_UNSUPPORTED,
    ];
    match KNOWN.iter().find(|code| e.starts_with(**code)) {
        Some(code) => ApiError::bad_request(*code, e),
        None => ApiError::bad_request("TECHNIC_PARSE_FAILED", e),
    }
}

/// Technic SingleZip 整合包探测（只读，不落盘）：`/modpack/parse`、
/// `/modpack/parse-path`、`classify` 与安装前的预览共用。
fn parse_technic_or_api_error(path: &Path) -> ApiResult<crate::services::technic::TechnicMeta> {
    crate::services::technic::parse_technic_zip(path).map_err(technic_parse_error)
}

/// POST /modpack/technic/import 请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechnicImportRequest {
    /// Technic SingleZip 包体绝对路径（parse / parse-path 已验证存在）。
    ///
    /// 与 `download_url` 二选一：本地导入给 `source_path`；资源中心在线安装
    /// （`install-direct` 的 technic 分支）给 `download_url`，由后台任务先下载。
    #[serde(default)]
    pub source_path: Option<String>,
    /// SingleZip 直链（issue #151 在线安装用）。
    ///
    /// **只能由后端填入**（`install_direct` 调 Technic API 解析得到），不从
    /// 前端请求体读取——否则等于开放「下载任意 URL」的面。
    /// `skip_deserializing` 是这条约束的**强制手段**（注释挡不住伪造请求体）：
    /// 该端点本地可达，任何调用方都能提交任意 `downloadUrl` 并被后端下载落盘。
    #[serde(default, skip_deserializing)]
    pub download_url: Option<String>,
    /// MC 版本提示（在线安装时来自 API 详情的 `minecraft` 字段）。
    ///
    /// 仅用于**创建实例记录时的初始值**：真实版本以下载后解析 zip 内
    /// `version.json` / `fmlversion.properties` 的结果为准，解析完会回写覆盖
    /// （Technic 该字段与包内元数据实测可能不一致）。
    ///
    /// 同样 `skip_deserializing`：它是给实例记录**预填元数据**的字段，外部可伪造
    /// 一个与包体不符的版本号（例如把 1.6.4 的包标成 1.20.1），不影响下载但会误导
    /// 用户在实例列表里看到错误的版本。
    #[serde(default, skip_deserializing)]
    pub game_version_hint: Option<String>,
    /// 资源中心的 Technic slug（在线安装时由 `install_direct` 填入，
    /// 用于写实例的来源字段）。本地导入为 None。
    ///
    /// `skip_deserializing`：来源字段是**安装方声明**，不该由调用方自报——否则可
    /// 伪造出「来自 technic 某包」的实例记录。
    #[serde(default, skip_deserializing)]
    pub slug: Option<String>,
    pub name: String,
    pub game_dir: String,
    /// 接受但忽略：Technic zip 根 = minecraft 目录，隔离强制（同 MultiMC，
    /// 见 technic_import_impl 注释）；保留字段以兼容前端统一请求形状。
    #[serde(default)]
    #[allow(dead_code)]
    pub version_isolation: Option<bool>,
}

/// POST /modpack/technic/import -- 创建实例并后台执行 Technic SingleZip 导入
/// （issue #123 期1）。骨架对齐 `multimc_import_impl`：RAII 临时清理 / 大包
/// 后台解压 / 全局锁选名 / 失败回滚实例。版本隔离强制（zip 根内容 = minecraft
/// 目录，必须落 `versions/{name}/`，同 MultiMC 语义）。
async fn technic_import(
    State(s): State<SharedState>,
    Json(req): Json<TechnicImportRequest>,
) -> ApiResult<Json<ModpackInstallDirectResponse>> {
    technic_import_impl(s, req).await
}

async fn technic_import_impl(
    s: SharedState,
    req: TechnicImportRequest,
) -> ApiResult<Json<ModpackInstallDirectResponse>> {
    // 两种入口（issue #151 期2 扩展）：
    // - 本地导入：`source_path` 给已有 zip → 请求期即可解析元数据；
    // - 在线安装：`download_url` 为后端解析出的 SingleZip 直链 → zip 尚不存在，
    //   元数据必须**下载后**在后台任务里解析（见 run_technic_import）。
    let local_zip = match req.source_path.as_deref() {
        Some(p) => {
            let p = validate_source_path(p)?;
            if !p.is_file() {
                return Err(ApiError::not_found(
                    "TECHNIC_SOURCE_NOT_FOUND",
                    "Technic 整合包文件不存在或已被移动/删除，请重新选择",
                ));
            }
            Some(p.to_path_buf())
        }
        None => None,
    };
    let download_url = req
        .download_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    if local_zip.is_none() && download_url.is_none() {
        return Err(ApiError::bad_request(
            "TECHNIC_SOURCE_REQUIRED",
            "缺少 sourcePath（本地包体）或 downloadUrl（在线直链）",
        ));
    }
    // 上传的 zip（位于 modpack-uploads/）导入完成后删除，避免累积（同 MultiMC）。
    //
    // ⚠️ 目录解析失败时必须按「**不清理**」处理（CodeRabbit 在 PR #187 指出的数据丢失
    // 风险，已实测确认）：`PathBuf::default()` 是空路径，而 `Path::starts_with("")`
    // 对**任何**路径都返回 true（它按路径组件比较，空前缀是任意路径的前缀）。
    // 若用 `unwrap_or_default()`，则目录创建失败时 `cleanup_upload` 会变成 true，
    // 任务是结束后把用户自己选的本地 zip 一并删掉——不可恢复。
    let cleanup_upload = match (local_zip.as_ref(), modpack_uploads_dir()) {
        (Some(p), Ok(dir)) => p.starts_with(&dir),
        // 没有本地包体 / 目录不可解析 → 一律不清理调用方的文件
        _ => false,
    };

    // 本地路径：请求期解析元数据（快速失败，用户立刻看到「不是有效 Technic 包」）。
    // 在线路径：先用 API 给的 MC 版本提示建实例，真实值由任务内解析后回写。
    let meta = match local_zip.as_deref() {
        Some(p) => Some(parse_technic_or_api_error(p)?),
        None => None,
    };
    let game_version = meta
        .as_ref()
        .map(|m| m.game_version.clone())
        .or_else(|| {
            req.game_version_hint
                .clone()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_default();
    let fallback_name = meta
        .as_ref()
        .and_then(|m| m.name.clone())
        .or_else(|| {
            local_zip
                .as_ref()
                .and_then(|p| p.file_stem().map(|st| st.to_string_lossy().into_owned()))
        })
        .unwrap_or_default();
    let base_name = sanitize_instance_name(if req.name.trim().is_empty() {
        fallback_name.as_str()
    } else {
        req.name.trim()
    });
    let game_dir = validate_source_path(&req.game_dir)?.to_path_buf();
    let game_dir = crate::services::install_service::absolute_path(&game_dir.to_string_lossy());
    // Technic zip 根内容就是 minecraft 目录（含 mods/config 等版本隔离内容），
    // 必须写入 `versions/{name}` 隔离目录（同 MultiMC：共享根会让内容与启动
    // 路径不一致），强制隔离。
    let version_isolation = true;
    // 并发导入同名实例的选名竞态用全局锁串行化（同 multimc_import_impl）。
    static TECHNIC_IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = TECHNIC_IMPORT_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let name = unique_instance_name(&game_dir, &base_name);
    let mut inst = crate::services::instance::GameInstance::default();
    inst.name = name.clone();
    inst.game_version = game_version.clone();
    inst.loader = meta.as_ref().and_then(|m| m.loader.clone());
    inst.loader_version = meta.as_ref().and_then(|m| m.loader_version.clone());
    inst.game_dir = game_dir.to_string_lossy().into_owned();
    inst.version_isolation = Some(version_isolation);
    inst.modpack_name = Some(base_name.clone());
    let created = s.instance.create(inst);
    drop(_guard);
    let instance_id = created.id.clone();

    let tracker = s.install_tracker.clone();
    let mgr = s.download_manager.load_full();
    let http_client = s.http_client.clone();
    let inst_svc = s.instance.clone();
    let gd = game_dir.to_string_lossy().into_owned();
    let inst_id_inner = instance_id.clone();
    let technic_root = technic_imports_dir()?;
    // 在线安装的 slug（写入实例来源字段用；本地导入为 None）。
    let source_slug = req.slug.clone();

    tracker.start_modpack_install(instance_id.clone(), move |handle| async move {
        // RAII：失败/成功都清理解压目录与上传 zip（成功路径在导入体内已无临时
        // 数据时由 Drop 兜底，幂等）。
        struct Cleanup {
            dirs: Vec<PathBuf>,
            files: Vec<PathBuf>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for d in &self.dirs {
                    let _ = std::fs::remove_dir_all(d);
                }
                for f in &self.files {
                    let _ = std::fs::remove_file(f);
                }
            }
        }
        let mut cleanup = Cleanup {
            dirs: Vec::new(),
            files: Vec::new(),
        };
        // 任务专属目录：**解压目录与包体必须分开放**。
        //
        // 实测缺陷：把在线包体下到 `extract_dir/pack.zip` 时，`copy_technic_content`
        // 会把这个 60 MB 的 zip 当成整合包内容一起拷进 `versions/{name}/`，
        // 在实例根留下一个无用的大文件（本次 E2E 抓到）。
        let task_dir = technic_root.join(uuid::Uuid::new_v4().to_string());
        let extract_dir = task_dir.join("extract");
        cleanup.dirs.push(task_dir.clone());
        if cleanup_upload {
            if let Some(p) = local_zip.as_ref() {
                cleanup.files.push(p.clone());
            }
        }
        // 在线包体下到任务目录下（**与解压目录平级，不在 extract/ 内**），
        // 随任务结束一并清理（RAII 已覆盖 task_dir）。
        let download_zip = download_url.as_ref().map(|_| task_dir.join("pack.zip"));
        if let Some(z) = download_zip.as_ref() {
            if let Some(parent) = z.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
        }

        let result = run_technic_import(
            &handle,
            &mgr,
            &http_client,
            local_zip.as_deref(),
            download_url.as_deref(),
            download_zip.as_deref(),
            &extract_dir,
            meta.as_ref(),
            &gd,
            &name,
            &inst_svc,
            &inst_id_inner,
            source_slug.as_deref(),
        )
        .await;
        drop(cleanup);
        if result.is_err() {
            // 回滚：删除实例记录 + 版本隔离目录（同 MultiMC：删除失败保留记录
            // 防幽灵实例，错误并入任务失败信息）。
            if let Err(e) = inst_svc.try_delete(&inst_id_inner) {
                let msg = format!(
                    "{}；另：{e}，实例记录已保留，请手动删除或重试",
                    result.as_ref().err().map(String::as_str).unwrap_or("")
                );
                return Err(msg);
            }
        }
        result
    });

    Ok(Json(ModpackInstallDirectResponse { instance_id }))
}

/// Technic SingleZip 导入后台任务（issue #123 期1；#151 期2 增加在线下载入口）：
/// 0. download（仅在线）：把 SingleZip 直链下到临时目录，**再**解析元数据；
/// 1. extract：zip 解压到临时目录（zip 根 = minecraft 目录）；
/// 2. install-game：标准安装管线装 MC + loader（loader 由 version.json 识别）；
/// 3. copy-files：包内容（zip 根）拷入 `versions/{name}/`；
/// 4. finalize：收尾（图标落盘，由 `run_install_pipeline` 的调用方语义决定）。
///
/// 对齐 Prism：version.json 仅用于**识别** MC/loader，游戏文件由安装管线按
/// 官方 manifest 下载（不信任包内 bin/ 的第三方库副本）；bin/modpack.jar
/// 内含 version.json 的标准包**不注入** jar 本体（其 mod 内容在包根 mods/ 等
/// 目录已就位）。
///
/// # 在线路径为什么要在任务内解析元数据
///
/// 本地导入时 `meta` 已在请求期解析好（可以快速失败）。在线安装时 zip 还不存在，
/// 只能先建实例（用 API 的 `minecraft` 字段做初始值）再下载解析——因此解析出
/// 真实 MC/loader 后必须**回写实例记录**，否则实例元数据会与磁盘上的版本 JSON
/// 不一致（启动/校验都依赖 `inst.game_version`）。
#[allow(clippy::too_many_arguments)]
async fn run_technic_import(
    handle: &InstallHandle,
    mgr: &Arc<qomicex_downloader::DownloadManager>,
    http_client: &reqwest::Client,
    local_zip: Option<&std::path::Path>,
    download_url: Option<&str>,
    download_zip: Option<&std::path::Path>,
    extract_dir: &std::path::Path,
    meta: Option<&crate::services::technic::TechnicMeta>,
    game_dir: &str,
    version_dir_name: &str,
    inst_svc: &crate::services::instance::InstanceService,
    instance_id: &str,
    source_slug: Option<&str>,
) -> Result<(), String> {
    use InstallStepSpec as S;
    let online = local_zip.is_none();
    // 在线安装多一个 download 段；权重之和仍为 100（进度百分比语义不变）。
    let specs: Vec<InstallStepSpec> = if online {
        vec![
            S {
                id: "download",
                weight: 20.0,
            },
            S {
                id: "extract",
                weight: 12.0,
            },
            S {
                id: "install-game",
                weight: 48.0,
            },
            S {
                id: "copy-files",
                weight: 15.0,
            },
            S {
                id: "finalize",
                weight: 5.0,
            },
        ]
    } else {
        vec![
            S {
                id: "extract",
                weight: 15.0,
            },
            S {
                id: "install-game",
                weight: 55.0,
            },
            S {
                id: "copy-files",
                weight: 25.0,
            },
            S {
                id: "finalize",
                weight: 5.0,
            },
        ]
    };
    handle.define_steps(
        &specs,
        crate::services::install_service::INSTALL_STEP_BUDGET_TOP,
    );

    // === 0. 在线：下载包体 ===
    // `meta` 在本地路径由调用方给出；在线路径下载后才解析。用 `Cow` 避免为
    // 「本地已有 meta」的情形多拷贝一份数据。
    let owned_meta: Option<crate::services::technic::TechnicMeta>;
    let meta: &crate::services::technic::TechnicMeta = match meta {
        Some(m) => m,
        None => {
            let url = download_url.ok_or("在线导入缺少 downloadUrl")?;
            let zip_path = download_zip.ok_or("在线导入缺少临时包体路径")?;
            handle.mark_step("download", "active");
            handle.set_stage("downloading-modpack");
            // 必须显式切到 Downloading：任务初始状态是 Queued，只有 `download_batch`
            // 内部才会写字节进度，但**状态**得由调用方设置。漏掉这一步的实测后果是
            // 整个下载期间 UI 一直显示「排队中（0%）」，看起来像卡死（本次 E2E 抓到的
            // 真实缺陷，对照 `run_modpack_pipeline` 的 download-modpack 段同为显式设置）。
            handle.update(|f| {
                f.set_status(InstallStatus::Downloading);
                f.current_file = "下载整合包包体...".to_string();
            });
            // 复用下载管理器：进度/重试/镜像逻辑与其它安装一致。
            let targets: Vec<crate::services::install_service::DownloadTarget> = vec![(
                url.to_string(),
                zip_path.to_path_buf(),
                technic_download_headers(),
            )];
            crate::services::install_service::download_batch(
                handle,
                mgr,
                targets,
                Some("download"),
            )
            .await?;
            handle.mark_step("download", "done");

            handle.set_stage("parsing-modpack");
            handle.update(|f| {
                f.set_status(InstallStatus::Installing);
                f.current_file = "解析整合包元数据...".to_string();
            });
            let parsed = crate::services::technic::parse_technic_zip(zip_path)
                .map_err(|e| format!("在线整合包解析失败（{url}）: {e}"))?;
            // 回写实例元数据：请求期只能用 API 的 minecraft 提示，真实值以包内
            // version.json / fmlversion.properties 为准（Technic 该字段实测会不一致）。
            if let Some(mut inst) = inst_svc.get_by_id(instance_id) {
                inst.game_version = parsed.game_version.clone();
                inst.loader = parsed.loader.clone();
                inst.loader_version = parsed.loader_version.clone();
                // 记录来源（不改 modpack_origin：technic 不支持原地更新，见决策）
                inst.modpack_source = Some("technic".to_string());
                inst.modpack_project_id = source_slug.map(str::to_string);
                let _ = inst_svc.update(instance_id, inst);
            }
            owned_meta = Some(parsed);
            owned_meta.as_ref().expect("刚赋值")
        }
    };
    let zip_path: &std::path::Path = match local_zip {
        Some(p) => p,
        None => download_zip.ok_or("在线导入缺少临时包体路径")?,
    };

    // === 1. 解压（zip 根 = minecraft 目录）===
    handle.mark_step("extract", "active");
    handle.set_stage("extracting-modpack");
    extract_zip_file_progressed(zip_path, extract_dir, &mut |done, total| {
        let pct = if total > 0 {
            done as f64 * 100.0 / total as f64
        } else {
            100.0
        };
        handle.set_step_percent("extract", pct);
        handle.set_current_file(&format!("解压整合包文件 {done}/{total}..."));
    })?;
    handle.mark_step("extract", "done");

    // === 2. 安装 MC + loader（标准管线，嵌套步骤以 step_budget 平铺进本表）===
    handle.mark_step("install-game", "active");
    handle.set_stage("downloading-game");
    let loader_msg = match (&meta.loader, &meta.loader_version) {
        (Some(l), Some(v)) => format!("Minecraft {} + {l} {v}", meta.game_version),
        (Some(l), None) => format!("Minecraft {} + {l}", meta.game_version),
        _ => format!("Minecraft {}", meta.game_version),
    };
    handle.update(|f| {
        f.set_status(InstallStatus::Installing);
        f.current_file = loader_msg;
    });
    let data = InstallRequestData {
        game_version: meta.game_version.clone(),
        game_dir: game_dir.to_string(),
        version_dir_name: version_dir_name.to_string(),
        loader: meta.loader.clone(),
        loader_version: meta.loader_version.clone(),
        addons: Vec::new(),
        download_threads: 8,
        version_isolation: true,
        download_source_id: crate::settings::get_global_file_download_source(),
        optifine_version: None,
    };
    run_install_pipeline(handle, mgr.clone(), http_client.clone(), "", data, 55.0).await?;
    handle.mark_step("install-game", "done");

    // === 3. 拷贝包内容（zip 根 = minecraft 目录 → versions/{name}/）===
    handle.mark_step("copy-files", "active");
    handle.set_stage("copying-files");
    handle.set_current_file("拷贝实例内容...");
    // Technic zip 根直接就是 minecraft 目录（无 .minecraft 包装），按 MultiMC 的
    // 顶层拷贝语义拷入版本隔离目录；libraries 仍落共享库目录。
    copy_technic_content(extract_dir, Path::new(game_dir), version_dir_name)?;

    // === 3.5 JarMod 注入（issue #180，仅古董包）===
    // 必须在 copy-files 之后：版本 JSON 由 run_install_pipeline（install-game 段）
    // 生成，jarmod 声明要追加到那个文件上。
    if meta.jarmod {
        handle.set_current_file("注入 JarMod（modpack.jar）...");
        install_technic_jarmod(extract_dir, Path::new(game_dir), version_dir_name)?;
    }
    handle.mark_step("copy-files", "done");

    // === 4. 收尾 ===
    handle.mark_step("finalize", "active");
    handle.set_stage("finishing");
    handle.set_current_file("导入完成");
    handle.mark_step("finalize", "done");
    Ok(())
}

/// 拷贝 Technic 包内容（zip 根 = minecraft 目录）到 `versions/{name}/`。
///
/// 规则：顶层 `bin/` 是 Technic 安装残壳（modpack.jar / version.json），元数据
/// 已消费，内容不参与启动，不拷（对齐 Prism 只消费元数据的行为）；顶层
/// `libraries/` 落共享库目录；其余递归拷入版本隔离目录。
fn copy_technic_content(
    extract_root: &Path,
    game_root: &Path,
    version_dir_name: &str,
) -> Result<u64, String> {
    let dest = game_root.join("versions").join(version_dir_name);
    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("创建实例目录失败 {}: {e}", dest.display()))?;
    let mut files = 0u64;
    let entries = std::fs::read_dir(extract_root)
        .map_err(|e| format!("读取 {} 失败: {e}", extract_root.display()))?;
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if name == "bin" {
                continue;
            }
            let target = if name == "libraries" {
                game_root.join("libraries")
            } else {
                dest.join(&name)
            };
            // 共享目录（libraries）不覆盖已有文件：install-game 刚从官方源下载的库
            // 可能已被其他实例共享，包内同路径副本（可能更旧/被改）不得回写覆盖
            // （CodeRabbit review：数据完整性）。版本目录内是本实例私有内容，正常覆盖。
            let skip_existing = name == "libraries";
            files += copy_tree_simple(&p, &target, skip_existing)?;
        } else {
            let target = dest.join(&name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
            }
            std::fs::copy(&p, &target)
                .map_err(|e| format!("拷贝失败 {} → {}: {e}", p.display(), target.display()))?;
            files += 1;
        }
    }
    Ok(files)
}

/// 把古董包的 `bin/modpack.jar` 落盘为 jarmod 并在版本 JSON 声明 `jarmods`（issue #180）。
///
/// 只在 `meta.jarmod` 为 true（标准包之外的古董包）时调用。
///
/// 落盘形态（对齐 Prism/MultiMC 的组件 patch 思路，与本仓库既有的「实例级 patch」约定同构）：
/// - jar 复制到 `versions/{VDN}/jarmods/modpack.jar`（实例内、版本作用域）；
/// - 版本 JSON 增 `jarmods: ["jarmods/modpack.jar"]`（**相对版本目录**）。
///
/// 随后 core 启动链（`services/jarmod.rs` + `jvm_args.rs`）会合并出**非破坏性派生 jar**
/// `{VDN}-jarmod.jar` 并顶替主 jar 进入 classpath；主 jar 保持原样，SHA1 校验不受影响。
///
/// 失败即导入失败（不静默降级）：jarmod 是这类包唯一的 mod 载体，落盘不成功的话实例
/// 即使「装上了」也跑不出整合包内容，属于必须让用户知道的失败。
fn install_technic_jarmod(
    extract_root: &Path,
    game_root: &Path,
    version_dir_name: &str,
) -> Result<(), String> {
    let src = extract_root.join("bin").join("modpack.jar");
    if !src.is_file() {
        return Err(format!(
            "古董包缺少 bin/modpack.jar（{}），无法注入 JarMod",
            src.display()
        ));
    }
    let version_dir = game_root.join("versions").join(version_dir_name);
    let jarmod_dir = version_dir.join("jarmods");
    std::fs::create_dir_all(&jarmod_dir)
        .map_err(|e| format!("创建 jarmods 目录失败 {}: {e}", jarmod_dir.display()))?;
    let dest_jar = jarmod_dir.join("modpack.jar");
    std::fs::copy(&src, &dest_jar).map_err(|e| {
        format!(
            "复制 modpack.jar 到 jarmods 失败 {}: {e}",
            dest_jar.display()
        )
    })?;

    // 在版本 JSON 里声明 jarmods（读-改-写；JSON 由 run_install_pipeline 生成，
    // 此处只追加一个数组字段，不触碰其它键）。
    let json_path = version_dir.join(format!("{version_dir_name}.json"));
    let text = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("读取版本 JSON 失败 {}: {e}", json_path.display()))?;
    let mut root: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析版本 JSON 失败 {}: {e}", json_path.display()))?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("版本 JSON 不是对象: {}", json_path.display()))?;
    obj.insert(
        "jarmods".to_string(),
        serde_json::json!(["jarmods/modpack.jar"]),
    );
    let out = serde_json::to_string(&root).map_err(|e| format!("序列化版本 JSON 失败: {e}"))?;
    std::fs::write(&json_path, out)
        .map_err(|e| format!("写入版本 JSON 失败 {}: {e}", json_path.display()))?;
    Ok(())
}

// =====================================================================
// Solder 在线分发（issue #181，#123 期3）
// =====================================================================

/// Solder 导入请求（仅由 `install_direct` 的 technic 分支构造，不经前端）。
///
/// Solder 基地址/mod 清单/MD5/URL 全部由后端从 Technic 详情 + Solder 接口解析，
/// 不接受前端提交的下载面（与 SingleZip 的 `download_url` 同一安全约束）。
pub(crate) struct SolderImportRequest {
    pub slug: String,
    /// 实例名（安装对话框传入，可空 → 用 slug 兜底）。
    pub name: String,
    pub game_dir: String,
}

/// POST /modpack/install-direct 的 Solder 分支入口：同步解析 Solder 元数据并
/// 创建实例 + 后台任务（骨架与 [`technic_import_impl`] 一致，差异在后台管线）。
///
/// 与 SingleZip 路径的模型差异（决策见 ADR-108）：
/// - **无包体直链**：Solder 是逐文件分发，先拉 build 清单再逐文件下载；
/// - **元数据请求期即可解析**（Solder build 接口就是完整元数据源），不像
///   SingleZip 在线路径要下载 zip 后二次解析——因此实例元数据一次写对，无需回写；
/// - **loader 是元数据标注**：1.2.5 时代 Forge 经 basemods zip 的
///   `bin/modpack.jar` 分发（实测夹具验证），安装管线装 vanilla MC，Forge/FML
///   由 jarmod 机制注入（期2-B 已就绪），故 `loader=forge/{build}` 只写实例记录。
pub(crate) async fn solder_import_impl(
    s: SharedState,
    req: SolderImportRequest,
) -> ApiResult<Json<ModpackInstallDirectResponse>> {
    let technic = s.core.create_technic_source();
    let detail = technic
        .get_pack_detail(&req.slug)
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?
        .ok_or_else(|| {
            ApiError::not_found(
                "MODPACK_NOT_FOUND",
                format!("Technic 整合包不存在: {}", req.slug),
            )
        })?;
    // 双重确认分发形态：调用方按 detail 判定进入本分支，这里再核一次（防御
    // 上游模型漂移：url 与 solder 同时有值时 SingleZip 优先，属期2 语义）。
    if detail.distribution()
        != qomicex_core::models::expansion::technic::TechnicDistribution::Solder
    {
        return Err(ApiError::bad_request(
            "TECHNIC_SOLDER_NOT_DISTRIBUTED",
            format!("整合包 {} 不是 Solder 分发形态", req.slug),
        ));
    }
    let solder_base = detail
        .solder
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad_request(
                "TECHNIC_SOLDER_NOT_DISTRIBUTED",
                format!("整合包 {} 缺少 Solder 基地址", req.slug),
            )
        })?;

    // 1) build 列表 → 选 build（recommended 优先 → latest → 列表末位）。
    let pack = technic
        .get_solder_pack(&solder_base, &req.slug)
        .await
        .map_err(|e| ApiError::upstream(format!("Solder build 列表查询失败: {e}")))?
        .ok_or_else(|| {
            ApiError::bad_request(
                "TECHNIC_SOLDER_NO_BUILDS",
                format!("整合包 {} 在 Solder 上没有可安装的构建", req.slug),
            )
        })?;
    let Some(build_id) = pack.selected_build().map(str::to_string) else {
        return Err(ApiError::bad_request(
            "TECHNIC_SOLDER_NO_BUILDS",
            format!("整合包 {} 的 Solder build 列表为空", req.slug),
        ));
    };

    // 2) build 详情 = 完整元数据源（MC 版本 / Forge build / mod 清单）。
    let build = technic
        .get_solder_build(&solder_base, &req.slug, &build_id)
        .await
        .map_err(|e| ApiError::upstream(format!("Solder build 详情查询失败: {e}")))?
        .ok_or_else(|| {
            ApiError::bad_request(
                "TECHNIC_SOLDER_BUILD_NOT_FOUND",
                format!("整合包 {} 的构建 {build_id} 在 Solder 上不存在", req.slug),
            )
        })?;
    let game_version = build
        .minecraft
        .clone()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad_request(
                "TECHNIC_SOLDER_BUILD_INVALID",
                format!("构建 {build_id} 缺少 minecraft 字段，无法安装"),
            )
        })?;

    // 3) 建实例（元数据一次写对：Solder 无「下载后二次解析」环节）。
    let base_name = sanitize_instance_name(if req.name.trim().is_empty() {
        detail.instance_name()
    } else {
        req.name.trim()
    });
    let game_dir = validate_source_path(&req.game_dir)?.to_path_buf();
    let game_dir = crate::services::install_service::absolute_path(&game_dir.to_string_lossy());
    // 版本隔离强制（同 Technic SingleZip：包内容 = minecraft 目录）；安装管线
    // 的 InstallRequestData.version_isolation 也传 true，此处字段仅写入实例记录。
    let version_isolation = true;
    static SOLDER_IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SOLDER_IMPORT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let name = unique_instance_name(&game_dir, &base_name);
    let mut inst = crate::services::instance::GameInstance::default();
    inst.name = name.clone();
    inst.game_version = game_version.clone();
    // Forge build 仅元数据标注（1.2.5 时代无 installer；本体经 jarmod 注入）。
    inst.loader = build.forge.as_ref().map(|_| "forge".to_string());
    inst.loader_version = build.forge.clone();
    inst.game_dir = game_dir.to_string_lossy().into_owned();
    inst.version_isolation = Some(version_isolation);
    inst.modpack_name = Some(base_name.clone());
    inst.modpack_version = Some(build_id.clone());
    let created = s.instance.create(inst);
    drop(_guard);
    let instance_id = created.id.clone();

    // 4) 派发后台任务。
    let tracker = s.install_tracker.clone();
    let mgr = s.download_manager.load_full();
    let http_client = s.http_client.clone();
    let inst_svc = s.instance.clone();
    let gd = game_dir.to_string_lossy().into_owned();
    let inst_id_inner = instance_id.clone();
    let technic_root = technic_imports_dir()?;

    tracker.start_modpack_install(instance_id.clone(), move |handle| async move {
        // RAII 清理（同 technic_import_impl 的 Cleanup：任务目录随任务终局删除）。
        struct Cleanup {
            dirs: Vec<PathBuf>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for d in &self.dirs {
                    let _ = std::fs::remove_dir_all(d);
                }
            }
        }
        let task_dir = technic_root.join(uuid::Uuid::new_v4().to_string());
        let extract_dir = task_dir.join("extract");
        let zips_dir = task_dir.join("mod-zips");
        let cleanup = Cleanup {
            dirs: vec![task_dir.clone()],
        };

        let result = run_solder_import(
            &handle,
            &mgr,
            &http_client,
            &build,
            &game_version,
            &zips_dir,
            &extract_dir,
            &gd,
            &name,
            &inst_svc,
            &inst_id_inner,
            &req.slug,
            &build_id,
        )
        .await;
        drop(cleanup);
        if result.is_err() {
            // 回滚实例记录 + 版本隔离目录（同 technic_import_impl；删除失败保留
            // 记录防幽灵实例，错误并入任务失败信息）。
            if let Err(e) = inst_svc.try_delete(&inst_id_inner) {
                let msg = format!(
                    "{}；另：{e}，实例记录已保留，请手动删除或重试",
                    result.as_ref().err().map(String::as_str).unwrap_or("")
                );
                return Err(msg);
            }
        }
        result
    });

    Ok(Json(ModpackInstallDirectResponse { instance_id }))
}

/// Solder 导入后台管线（issue #181）。步骤表权重合计 100：
/// download-mods(25) → verify(5) → extract-merge(10) → install-game(40) →
/// copy-files(15) → jarmod(5)。
///
/// 数据流：Solder mods[] 按**数组顺序**逐 zip 解压叠加到 extract_dir（后者覆盖
/// 前者——`z-` 前缀配置包排在清单末尾最后覆盖是 Technic 约定，见 ADR-108），
/// 然后 vanilla 安装管线装 MC，最后把包内容拷进版本隔离目录并注入 jarmod。
#[allow(clippy::too_many_arguments)]
async fn run_solder_import(
    handle: &InstallHandle,
    mgr: &Arc<qomicex_downloader::DownloadManager>,
    http_client: &reqwest::Client,
    build: &qomicex_core::models::expansion::technic::TechnicSolderBuild,
    game_version: &str,
    zips_dir: &std::path::Path,
    extract_dir: &std::path::Path,
    game_dir: &str,
    version_dir_name: &str,
    inst_svc: &crate::services::instance::InstanceService,
    instance_id: &str,
    slug: &str,
    build_id: &str,
) -> Result<(), String> {
    use InstallStepSpec as S;
    let specs: Vec<InstallStepSpec> = vec![
        S {
            id: "download-mods",
            weight: 25.0,
        },
        S {
            id: "verify",
            weight: 5.0,
        },
        S {
            id: "extract-merge",
            weight: 10.0,
        },
        S {
            id: "install-game",
            weight: 40.0,
        },
        S {
            id: "copy-files",
            weight: 15.0,
        },
        S {
            id: "jarmod",
            weight: 5.0,
        },
    ];
    handle.define_steps(
        &specs,
        crate::services::install_service::INSTALL_STEP_BUDGET_TOP,
    );

    // === 1. 下载全部 mod zip（download_batch 并行，进度写字节比例）===
    handle.mark_step("download-mods", "active");
    handle.set_stage("downloading-modpack");
    handle.update(|f| {
        f.set_status(InstallStatus::Downloading);
        f.current_file = "下载整合包文件（Solder 逐文件分发）...".to_string();
    });
    std::fs::create_dir_all(zips_dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    let headers = technic_download_headers();
    let targets: Vec<crate::services::install_service::DownloadTarget> = build
        .mods
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let url = m.url.as_deref()?.trim();
            if url.is_empty() {
                return None;
            }
            Some((
                url.to_string(),
                solder_mod_zip_path(zips_dir, i, &m.name),
                headers.clone(),
            ))
        })
        .collect();
    let total_mods = targets.len();
    if total_mods == 0 {
        return Err(format!(
            "Solder 构建 {build_id} 的 mod 清单为空或全部缺少下载地址"
        ));
    }
    let skipped = build.mods.len() - total_mods;
    if skipped > 0 {
        eprintln!(
            "[Solder] 构建 {build_id} 有 {skipped} 个 mod 缺少下载地址，跳过（清单共 {} 项）",
            build.mods.len()
        );
    }
    crate::services::install_service::download_batch(handle, mgr, targets, Some("download-mods"))
        .await?;
    handle.mark_step("download-mods", "done");

    // === 2. MD5 校验（硬失败：Solder 给 md5 就是为了分发校验）===
    handle.mark_step("verify", "active");
    handle.set_stage("verifying");
    handle.update(|f| {
        f.current_file = "校验文件完整性（MD5）...".to_string();
    });
    let mut checked = 0usize;
    for (i, m) in build.mods.iter().enumerate() {
        // 与下载/解压步骤同一过滤条件：无 URL 的条目三阶段一致跳过（否则
        // verify 会去读一个从未下载的 zip，导入必然失败——CodeRabbit #196）。
        if m.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
            continue;
        }
        let Some(expected) = m.md5.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let path = solder_mod_zip_path(zips_dir, i, &m.name);
        let bytes = std::fs::read(&path).map_err(|e| {
            format!(
                "读取已下载文件失败 {}: {e}（校验无法进行，安装中止）",
                path.display()
            )
        })?;
        if !solder_md5_matches(&bytes, expected) {
            use md5::Digest;
            let mut hasher = md5::Md5::new();
            md5::Digest::update(&mut hasher, &bytes);
            let got = format!("{:x}", md5::Digest::finalize(hasher));
            return Err(format!(
                "TECHNIC_SOLDER_MD5_MISMATCH: mod {}({}) MD5 不符（期望 {expected}，实际 {got}），分发文件可能损坏",
                m.name, m.version
            ));
        }
        checked += 1;
        handle.set_step_percent("verify", checked as f64 * 100.0 / build.mods.len() as f64);
    }
    handle.mark_step("verify", "done");

    // === 3. 按清单顺序解压合并（后者覆盖前者）===
    handle.mark_step("extract-merge", "active");
    handle.set_stage("extracting-modpack");
    std::fs::create_dir_all(extract_dir).map_err(|e| format!("创建解压目录失败: {e}"))?;
    // 进度序号用独立计数器（done）：清单索引 i 含跳过项，若有条目缺 URL，
    // i+1 会超过 total_mods 显示出 (31/30) 的假进度（CodeRabbit #196 finding）。
    let mut done = 0usize;
    for (i, m) in build.mods.iter().enumerate() {
        if m.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
            continue;
        }
        done += 1;
        let path = solder_mod_zip_path(zips_dir, i, &m.name);
        handle.set_current_file(&format!("解压 {} ({done}/{total_mods})...", m.name));
        handle.set_step_percent(
            "extract-merge",
            ((done - 1) as f64) * 100.0 / total_mods as f64,
        );
        // archive::extract_zip_file 允许目标已有文件（File::create 直接覆盖），
        // 正是「后者覆盖前者」的叠加语义；zip-slip / 炸弹防护由共享实现兜底。
        crate::services::archive::extract_zip_file(&path, extract_dir).map_err(|e| {
            format!(
                "解压 mod {}({}) 失败: {e}（文件 {}）",
                m.name,
                m.version,
                path.display()
            )
        })?;
    }
    handle.mark_step("extract-merge", "done");

    // === 4. 安装 vanilla MC（loader 安装不走：1.2.5 无 installer.jar）===
    handle.mark_step("install-game", "active");
    handle.set_stage("downloading-game");
    let loader_note = build
        .forge
        .as_deref()
        .map(|f| format!("（Forge {f} 经整合包内置，稍后注入）"))
        .unwrap_or_default();
    handle.update(|f| {
        f.set_status(InstallStatus::Installing);
        f.current_file = format!("Minecraft {game_version} {loader_note}");
    });
    let data = InstallRequestData {
        game_version: game_version.to_string(),
        game_dir: game_dir.to_string(),
        version_dir_name: version_dir_name.to_string(),
        // 关键：loader 置 None → run_install_pipeline 走 vanilla 分支。
        // Forge 本体在 basemods zip 的 bin/modpack.jar 里，步骤 6 注入。
        loader: None,
        loader_version: None,
        addons: Vec::new(),
        download_threads: 8,
        version_isolation: true,
        download_source_id: crate::settings::get_global_file_download_source(),
        optifine_version: None,
    };
    run_install_pipeline(handle, mgr.clone(), http_client.clone(), "", data, 40.0).await?;
    handle.mark_step("install-game", "done");

    // === 5. 拷贝包内容（复用 Technic SingleZip 的拷贝语义）===
    handle.mark_step("copy-files", "active");
    handle.set_stage("copying-files");
    handle.set_current_file("拷贝实例内容...");
    // 顶层 bin/ 不拷（jarmod 源在下一步单独落盘；其余内容 = minecraft 目录）。
    copy_technic_content(extract_dir, Path::new(game_dir), version_dir_name)?;
    handle.mark_step("copy-files", "done");

    // === 6. JarMod 注入（Forge/FML 本体从 bin/modpack.jar 进 classpath）===
    handle.mark_step("jarmod", "active");
    if extract_dir.join("bin").join("modpack.jar").is_file() {
        handle.set_current_file("注入 Forge（整合包内置 modpack.jar）...");
        install_technic_jarmod(extract_dir, Path::new(game_dir), version_dir_name)?;
    } else {
        // 无 modpack.jar 的 Solder 包：若声明了 forge 则说明清单形态与已知实测
        // 不同——不静默吞掉，打日志供排障；vanilla 实例仍可用。
        if build.forge.is_some() {
            eprintln!(
                "[Solder] {slug} {build_id} 声明 forge 但解压结果无 bin/modpack.jar，Forge 未注入（清单形态可能与已知 Solder 约定不同）"
            );
        }
    }
    handle.mark_step("jarmod", "done");

    // === 收尾：来源标注 ===
    if let Some(mut inst) = inst_svc.get_by_id(instance_id) {
        inst.modpack_source = Some("technic".to_string());
        inst.modpack_project_id = Some(slug.to_string());
        let _ = inst_svc.update(instance_id, inst);
    }
    handle.set_stage("finishing");
    handle.set_current_file("导入完成");
    Ok(())
}

/// Solder mod zip 的任务内落盘路径：`{zips_dir}/{序号:04}-{清理后的 mod 名}.zip`。
///
/// 序号前缀承载 mods[] 的**解压覆盖顺序**（后者覆盖前者）且天然防重名；mod 名经
/// [`sanitize_instance_name`] 清洗防路径注入（清单来自远端，文件名不可信）。
fn solder_mod_zip_path(zips_dir: &Path, index: usize, mod_name: &str) -> PathBuf {
    zips_dir.join(format!(
        "{index:04}-{}.zip",
        sanitize_instance_name(mod_name)
    ))
}

/// Solder 分发文件 MD5 判定（`run_solder_import` 的 verify 步骤与单测共用）。
///
/// 大小写不敏感比对：Solder 契约给小写 hex，容忍镜像端大写形态；`expected`
/// 先 trim，容忍响应里的首尾空白。
fn solder_md5_matches(bytes: &[u8], expected: &str) -> bool {
    use md5::Digest;
    let mut hasher = md5::Md5::new();
    Digest::update(&mut hasher, bytes);
    let got = format!("{:x}", Digest::finalize(hasher));
    got.eq_ignore_ascii_case(expected.trim())
}

/// Solder 管线单元测试（issue #181）。
///
/// 端到端在线安装依赖外网与真实 Solder 服务，这里覆盖**纯逻辑**部分：落盘命名
/// 的保序/防注入语义、MD5 校验的判定逻辑（对 / 不对 / 空跳过）。MD5 判定通过
/// 独立的纯函数 `solder_md5_matches` 交付以便测试。
#[cfg(test)]
mod solder_tests {
    use super::*;

    #[test]
    fn mod_zip_path_is_ordered_and_sanitized() {
        let dir = std::env::temp_dir().join("qmx-solder-path-test");
        let p = solder_mod_zip_path(&dir, 12, "buildcraft");
        assert!(
            p.ends_with("0012-buildcraft.zip"),
            "应含 4 位序号前缀: {p:?}"
        );
        // 远端恶意名：路径分隔符/非法字符必须被清洗（`.` 会保留为下划线相邻形态，
        // 但文件名中的 `..` 无穿越能力——它不再含路径分隔符），必须仍落在 zips_dir 内
        let evil = solder_mod_zip_path(&dir, 0, r#"..\..\evil"#);
        let name = evil.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            !name.contains('\\') && !name.contains('/'),
            "不得含分隔符: {name}"
        );
        assert_eq!(evil.parent(), Some(dir.as_path()), "必须仍落在 zips_dir 内");
        assert!(
            evil.components()
                .all(|c| c != std::path::Component::ParentDir),
            "不得含父目录组件"
        );
    }

    #[test]
    fn md5_compare_is_case_insensitive() {
        let data = b"tekkit";
        let got = {
            use md5::Digest;
            let mut h = md5::Md5::new();
            Digest::update(&mut h, data);
            format!("{:x}", Digest::finalize(h))
        };
        // 与 run_solder_import 的 verify 步骤**同一个**生产函数：生产逻辑回归时
        // 本测试必然失败（CodeRabbit #196 finding：测试不得持有比对逻辑的副本）。
        assert!(solder_md5_matches(data, &got.to_uppercase()));
        assert!(solder_md5_matches(data, &format!("  {}  ", got)));
        assert!(!solder_md5_matches(
            data,
            "00000000000000000000000000000000"
        ));
    }

    #[test]
    fn md5_known_vector() {
        // RFC 1321 空串与 "abc" 向量：证明用的是标准 MD5 而非自造哈希
        assert!(solder_md5_matches(b"", "d41d8cd98f00b204e9800998ecf8427e"));
        assert!(solder_md5_matches(
            b"abc",
            "900150983cd24fb0d6963f7d28e17f72"
        ));
        // 大写期望值也应通过（大小写不敏感语义）
        assert!(solder_md5_matches(
            b"abc",
            "900150983CD24FB0D6963F7D28E17F72"
        ));
        assert!(!solder_md5_matches(
            b"abc",
            "00000000000000000000000000000000"
        ));
    }
}

/// 递归拷贝目录树（Technic 包内容用；multimc::copy_tree 为私有，此处不引入
/// 可见性扩散，独立实现——语义就是普通递归拷贝）。
/// `skip_existing` = 目标已存在的文件直接跳过（共享库目录防覆盖语义）。
fn copy_tree_simple(src: &Path, dest: &Path, skip_existing: bool) -> Result<u64, String> {
    // 先建目标目录本身：递归子目录时目标父目录链由本行保证存在
    // （复测发现：仅拷文件时建父目录，嵌套目录 a/b/c 的拷贝会在 b 层失败）。
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目录失败 {}: {e}", dest.display()))?;
    let mut files = 0u64;
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
    for entry in entries.flatten() {
        let p = entry.path();
        let file_name = entry.file_name();
        if p.is_dir() {
            files += copy_tree_simple(&p, &dest.join(&file_name), skip_existing)?;
        } else {
            let target = dest.join(&file_name);
            if skip_existing && target.is_file() {
                continue;
            }
            std::fs::copy(&p, &target)
                .map_err(|e| format!("拷贝失败 {} → {}: {e}", p.display(), target.display()))?;
            files += 1;
        }
    }
    Ok(files)
}

/// `{BaseDir}/temp/technic-imports/`（zip 解压根）；顺带清理超过 1 天的残留
/// （同 multimc_imports_dir）。
fn technic_imports_dir() -> ApiResult<PathBuf> {
    let dir = crate::settings::resolve_base_dir()
        .join("temp")
        .join("technic-imports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::internal(format!("创建导入目录失败: {e}")))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(age) = modified.elapsed() {
                        if age.as_secs() > 24 * 3600 {
                            let _ = std::fs::remove_dir_all(entry.path());
                        }
                    }
                }
            }
        }
    }
    Ok(dir)
}

/// 把整合包图标（data URI）落盘为 `{gameDir}/versions/{name}/icon.png`
/// （HMCL 同款约定；实例扫描 resolve_pcl_icon 从该文件兜底读取，
/// 不再依赖 instances.json 内嵌数据，修复导入后 logo 丢失）。
/// 无图标 → Ok（跳过）；有图标但写盘失败（权限/磁盘满）→ Err，导入随管线失败回滚
/// ——否则实例元数据声称有图标、扫描却读不到，比导入失败更难排查。
fn write_pack_icon(
    game_dir: &str,
    version_dir_name: &str,
    icon_data: Option<&str>,
) -> Result<(), String> {
    let Some(data) = icon_data.and_then(|d| d.strip_prefix("data:image/")) else {
        return Ok(());
    };
    let Some((_, b64)) = data.split_once("base64,") else {
        return Ok(());
    };
    let Some(bytes) = crate::util::pcl_icon::base64_decode(b64) else {
        return Ok(());
    };
    if bytes.is_empty() {
        return Ok(());
    }
    let version_dir = std::path::Path::new(game_dir)
        .join("versions")
        .join(version_dir_name);
    if !version_dir.is_dir() {
        return Ok(());
    }
    std::fs::write(version_dir.join("icon.png"), &bytes).map_err(|e| {
        format!(
            "写入整合包图标失败 {}: {e}",
            version_dir.join("icon.png").display()
        )
    })
}

/// 探测 zip 是否为 MultiMC 整合包。
/// 只认 `mmc-pack.json`（MultiMC 实例的强标识，且 parse_metadata_from_zip 也以此为准）。
/// 单独的 `instance.cfg` 不作为信号：普通 Modrinth/CurseForge 包可能恰好含同名文件，
/// 误判后会被交给 parse_metadata_from_zip 并因缺 mmc-pack.json 而拒绝本应有效的整合包。
///
/// 只读中央目录（`file_names()`）而不 `by_index()`：`by_index()` 会为每个条目 seek 并读
/// 本地文件头，GTNH 这类 1.6 万条目 / 700MB 的包会退化成上万次随机读，探测本身就要数秒
/// 到十几秒（issue #119 的「解析请求超时」根因之一）。名字信息在中央目录里已有，
/// 逐条目读本地头纯属浪费。
fn is_multimc_zip(zip_path: &std::path::Path) -> bool {
    let Ok(file) = std::fs::File::open(zip_path) else {
        return false;
    };
    let Ok(archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    for name in archive.file_names() {
        if name == "mmc-pack.json" || name.ends_with("/mmc-pack.json") {
            return true;
        }
    }
    false
}

/// zip 解压统一走 `services::archive`（#162 抽出共享，避免整合包与地图存档
/// 各维护一份 zip-slip / 炸弹防护而漂移）。此处仅保留调用点需要的窄包装。
fn extract_zip_file(zip_path: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    crate::services::archive::extract_zip_file(zip_path, dest)
}

/// 从磁盘 zip 文件解压到目标目录并逐条目上报进度 (已完成条目, 总条目)。
fn extract_zip_file_progressed(
    zip_path: &std::path::Path,
    dest: &std::path::Path,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<(), String> {
    crate::services::archive::extract_zip_file_progressed(zip_path, dest, progress)
}

/// 从内存字节解压到目标目录（防 zip-slip：仅使用 `enclosed_name` 安全路径）。
fn extract_zip(data: &[u8], dest: &std::path::Path) -> Result<(), String> {
    crate::services::archive::extract_zip(data, dest)
}

/// `{BaseDir}/temp/multimc-imports/`（zip 解压根）；顺带清理超过 1 天的残留。
fn multimc_imports_dir() -> ApiResult<std::path::PathBuf> {
    let dir = crate::settings::resolve_base_dir()
        .join("temp")
        .join("multimc-imports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::internal(format!("创建导入目录失败: {e}")))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(age) = modified.elapsed() {
                        if age.as_secs() > 24 * 3600 {
                            let _ = std::fs::remove_dir_all(entry.path());
                        }
                    }
                }
            }
        }
    }
    Ok(dir)
}

/// 清理实例名中的非法文件名字符。
fn sanitize_instance_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " ._-+()[]".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "MultiMC 实例".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 生成不冲突的实例名（`{game_root}/versions/{name}` 已存在则追加 ` (2)` 等）。
fn unique_instance_name(game_root: &std::path::Path, base: &str) -> String {
    let mut name = base.to_string();
    let mut i = 2;
    while game_root.join("versions").join(&name).exists() {
        name = format!("{base} ({i})");
        i += 1;
    }
    name
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
        Some("qml") | Some("qomicex") | Some("qmodpack") => ExportFormat::Qomicex,
        _ => {
            return Err(ApiError::bad_request(
                "MODPACK_EXPORT_FORMAT_INVALID",
                "导出格式必须是 cf、mr 或 qml",
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
    let instance_id = modpack_data(&s).install_direct(s, req).await?;
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

/// 安装请求是否应标记为「可原地更新」（issue #118）。
///
/// 白名单式**全条件**判定，任一不满足即不可更新：
/// 1. 前端显式标记 `origin == "resource-center"`（本地导入/拖入/MultiMC 不发）；
/// 2. `source` 为 modrinth / curseforge（平台版本列表可查）；
/// 3. 同时带 `projectId` 与 `versionId`（身份标识完整）；
/// 4. 不带 `fileId` / `localPath`（排除本地包体导入路径）；
/// 5. 启用版本隔离（非隔离实例会改到共享目录、波及其他实例，回滚范围无法界定）。
///
/// 刻意不用「有 id 就写」：宁可少判可更新，也不要为一个来源不明的实例提供
/// 原地更新 —— 那会覆盖用户手工搭建的内容。
fn is_updatable_origin(req: &ModpackInstallRequest) -> bool {
    let origin_marked = req
        .origin
        .as_deref()
        .is_some_and(|o| o.eq_ignore_ascii_case("resource-center"));
    let src_norm = req
        .source
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let source_ok = matches!(src_norm.as_str(), "modrinth" | "curseforge");
    let ids_ok = req
        .project_id
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
        && req
            .version_id
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
    let no_local = req.file_id.is_none() && req.local_path.is_none();
    origin_marked && source_ok && ids_ok && no_local && req.version_isolation
}

/// 安装成功后落清单所需的元数据（issue #118）。
#[derive(Clone)]
struct ModpackManifestMeta {
    game_dir: String,
    version_dir_name: String,
    game_version: String,
    loader: Option<String>,
    loader_version: Option<String>,
    source: String,
    project_id: Option<String>,
    version_id: Option<String>,
    version_published_at: Option<String>,
}

/// 安装成功后生成并写入托管文件清单。
///
/// 只告警不失败：安装已完成，清单是**后续更新**的辅助基线，写不出来不该让成功的
/// 安装报失败（那会引导用户重装一遍）。用户在下一次安装/更新时自然会重建。
fn write_manifest_after_install(
    meta: &ModpackManifestMeta,
    version_isolation: bool,
    content_rels: &[String],
) {
    let instance_dir = modpack_target_path(
        &meta.game_dir,
        &meta.version_dir_name,
        version_isolation,
        "",
    );
    let content: std::collections::HashSet<String> = content_rels
        .iter()
        .map(|r| crate::services::modpack_manifest::normalize_rel_path(r))
        .collect();

    let files = crate::services::modpack_manifest::sweep_hosted_files(
        &instance_dir,
        &meta.version_dir_name,
        &content,
    );

    let manifest = crate::services::modpack_manifest::ModpackManifest {
        schema_version: crate::services::modpack_manifest::MANIFEST_SCHEMA_VERSION,
        game_version: meta.game_version.clone(),
        loader: meta.loader.clone().filter(|s| !s.is_empty()),
        loader_version: meta.loader_version.clone().filter(|s| !s.is_empty()),
        origin: crate::services::modpack_manifest::ManifestOrigin {
            source: Some(meta.source.clone()),
            project_id: meta.project_id.clone(),
            version_id: meta.version_id.clone(),
            origin: Some("resource-center".to_string()),
            version_published_at: meta.version_published_at.clone(),
        },
        files,
    };

    match crate::services::modpack_manifest::save_manifest(
        &meta.game_dir,
        &meta.version_dir_name,
        &manifest,
    ) {
        Ok(()) => tracing::info!(
            instance = %meta.version_dir_name,
            files = manifest.files.len(),
            "整合包托管文件清单已写入（原地更新基线就绪）"
        ),
        Err(e) => tracing::warn!(
            instance = %meta.version_dir_name,
            error = %e,
            "写入整合包托管文件清单失败（安装已完成，该实例将不可原地更新）"
        ),
    }
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
            optional_files: Vec::new(),
            has_overrides: false,
            file_count,
            overrides_zip: None,
            icon_data,
            file_id: None,
            pack_type: None,
            source_id: None,
            source_path: None,
        })
    }

    /// Resolve a CurseForge modpack file into a parse result.
    ///
    /// The install pipeline re-parses the downloaded zip (parse_curseforge_manifest)
    /// to fill game version / loader / overrides, so these fields stay empty here
    /// (install-time preview only shows mod info + single download entry).
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

        // 下载 CurseForge 模组图标（与 Modrinth/FTB 保持一致）
        let icon_url = mod_info.logo.as_ref().and_then(|l| l.url.clone());
        let icon_data = self.download_icon_as_data_uri(icon_url.as_deref()).await;

        Ok(ModpackParseResult {
            name: mod_info.name,
            summary: mod_info.summary.clone(),
            author: mod_info
                .authors
                .as_deref()
                .and_then(|a| a.first())
                .map(|a| a.name.clone()),
            // 预览值留空：安装管线下载 zip 后经 parse_curseforge_manifest 补全
            version: file_info.file_name.clone(),
            game_version: String::new(),
            loader: String::new(),
            loader_version: None,
            source: "curseforge".to_string(),
            files,
            optional_files: Vec::new(),
            has_overrides: false,
            file_count,
            overrides_zip: None,
            icon_data,
            file_id: None,
            pack_type: None,
            source_id: None,
            source_path: None,
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
            optional_files: Vec::new(),
            has_overrides: false,
            file_count: 0,
            overrides_zip: None,
            icon_data,
            file_id: None,
            pack_type: None,
            source_id: None,
            source_path: None,
        })
    }

    /// Port of InstallAsync: create the GameInstance and register a background
    /// install task in InstallTracker, then return the instance id.
    async fn install(&self, req: ModpackInstallRequest) -> ApiResult<String> {
        // 本地文件导入：file_id = parse 上传的临时文件句柄；local_path = 整合包
        // 绝对路径（parse-path 流程由前端回传；install-direct 内部直传，均不属于
        // 上传目录，不清理）。
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
                (None, Some(p)) => {
                    // parse-path 解析的本地包：装进管道前先确认文件还在（用户可能在
                    // 预览后移动/删除/重命名了它），否则要到管道深处才报
                    // “打开整合包文件失败”。
                    let path = PathBuf::from(p);
                    if !path.is_file() {
                        return Err(ApiError::not_found(
                            "MODPACK_FILE_NOT_FOUND",
                            "整合包文件不存在或已被移动/删除，请重新选择",
                        ));
                    }
                    (Some(path), false)
                }
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
        // === 来源字段（issue #118 原地更新的资格依据）===
        // 判定逻辑集中在 `is_updatable_origin`（纯函数，有单测覆盖）。
        let origin_marked = req
            .origin
            .as_deref()
            .is_some_and(|o| o.eq_ignore_ascii_case("resource-center"));
        let src_norm = req
            .source
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let no_local = req.file_id.is_none() && req.local_path.is_none();
        let isolation_ok = req.version_isolation;

        let writable_origin = is_updatable_origin(&req);
        if writable_origin {
            instance.modpack_source = Some(src_norm.clone());
            instance.modpack_project_id = req.project_id.clone();
            instance.modpack_version_id = req.version_id.clone();
            instance.modpack_origin = Some("resource-center".to_string());
            instance.modpack_version_published_at = req
                .version_published_at
                .clone()
                .filter(|s| !s.trim().is_empty());
        } else if origin_marked {
            // 标记了却落不进来源字段：静默降级会让「为什么不能更新」无从排查。
            tracing::info!(
                source = %src_norm,
                has_project_id = req.project_id.is_some(),
                has_version_id = req.version_id.is_some(),
                has_local_input = !no_local,
                version_isolation = isolation_ok,
                "整合包安装：标记为资源中心来源但未写入更新元数据（该实例将不可原地更新）"
            );
        }
        // 同 MultiMC 导入：只缩小实例记录里的 icon_data，落盘的原图 icon.png 不受影响。
        instance.icon_data = req
            .icon_data
            .as_deref()
            .map(crate::util::pcl_icon::normalize_icon_data_uri);
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
        let optional_file_ids = req.optional_file_ids.clone();
        let version_isolation = req.version_isolation;
        // 管道结束后清理上传的临时文件（install-direct 的绝对路径不属于我们，不删）。
        let cleanup_path = if cleanup_upload {
            local_pack_path.clone()
        } else {
            None
        };

        let file_download_source = crate::settings::get_global_file_download_source();
        let inst_svc = self.instance.clone();
        let inst_id_inner = instance_id.clone();
        let icon_data_inner = req.icon_data.clone();
        // 清单写入所需的元数据（仅可更新实例才写；见下方判定）。
        let manifest_meta = if writable_origin {
            Some(ModpackManifestMeta {
                game_dir: game_dir.clone(),
                version_dir_name: version_dir_name.clone(),
                game_version: game_version.clone(),
                loader: loader_in.clone(),
                loader_version: loader_version_in.clone(),
                source: src_norm.clone(),
                project_id: req.project_id.clone(),
                version_id: req.version_id.clone(),
                version_published_at: req
                    .version_published_at
                    .clone()
                    .filter(|s| !s.trim().is_empty()),
            })
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
                file_download_source,
                icon_data_inner,
                optional_file_ids.as_deref(),
            )
            .await;
            // 安装成功 → 用管线内确定的**生效版本**回写实例记录与托管清单。
            // （CodeRabbit 评审 #183：实例在管线前以请求原始值（如 1.12）创建、
            // 清单元数据同源，而实际安装的是 manifest 权威值（如 1.12.2）——
            // 不回写会让两处持久化与实际安装版本不一致。）
            // ⚠️ 实例回写**不看出处**（CodeRabbit 二轮评审）：install_direct 等入口
            // origin=None → manifest_meta=None，若回写套在 Some(meta) 分支内，直接
            // 安装（拖入/一键装/插件）的实例永远不会被修正。清单落盘仍仅在
            // manifest_meta 存在（可更新实例）时执行——那是它独有的用途。
            // 清单失败**只告警**：安装本身已经完成，不能因为一份辅助记录把成功的安装
            // 报成失败（那会误导用户重装）。
            let result = match (result, &manifest_meta) {
                (Ok((content_rels, effective_gv)), meta) => {
                    if let Some(meta) = meta {
                        // 清单元数据改为生效版本后落清单（仅可更新实例有清单）
                        let meta = ModpackManifestMeta {
                            game_version: effective_gv.clone(),
                            ..meta.clone()
                        };
                        write_manifest_after_install(&meta, version_isolation, &content_rels);
                    }
                    // 实例记录回写生效版本（失败只告警——安装已完成）
                    if let Some(mut inst) = inst_svc.get_by_id(&inst_id_inner) {
                        if inst.game_version != effective_gv {
                            tracing::info!(
                                instance = %inst_id_inner,
                                requested = %inst.game_version,
                                effective = %effective_gv,
                                "整合包生效游戏版本与请求值不一致，已按 manifest 回写实例"
                            );
                            inst.game_version = effective_gv.clone();
                            if let Some(meta) = meta {
                                inst.loader_version = meta.loader_version.clone();
                            }
                            if inst_svc.update(&inst_id_inner, inst).is_none() {
                                tracing::warn!(
                                    instance = %inst_id_inner,
                                    "生效版本回写实例失败（实例可能已被删除）"
                                );
                            }
                        }
                    }
                    Ok(())
                }
                (other, _) => other.map(|_| ()),
            };
            // 清理在线下载的包体临时文件（本地导入的文件不属于我们，不删）。
            if local_pack_path.is_none() {
                let ext = if source == "modrinth" {
                    "mrpack"
                } else {
                    "zip"
                };
                let temp_pack = Path::new(&game_dir)
                    .join("temp")
                    .join(format!("modpack-{version_dir_name}.{ext}"));
                let _ = std::fs::remove_file(&temp_pack);
            }
            if let Some(p) = cleanup_path {
                let _ = std::fs::remove_file(&p);
            }
            if result.is_err() {
                // 回滚：安装失败/取消 → 删除实例记录 + 版本隔离目录，不残留不可用实例。
                // 共享目录（libraries/assets/非隔离 mods）不清理，避免误删。
                // 目录删除失败 → 保留记录防幽灵实例复活，错误并入任务失败信息。
                if let Err(e) = inst_svc.try_delete(&inst_id_inner) {
                    let msg = format!(
                        "{}；另：{e}，实例记录已保留，请手动删除或重试",
                        result.as_ref().err().map(String::as_str).unwrap_or("")
                    );
                    return Err(msg);
                }
            }
            result
        });

        Ok(instance_id)
    }

    /// One-click install: resolve (local path or online), then install.
    async fn install_direct(
        &self,
        s: SharedState,
        req: ModpackInstallDirectRequest,
    ) -> ApiResult<String> {
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
            // MultiMC zip（含 mmc-pack.json）：走 MultiMC 导入管线，其余格式走
            // 本地 parse_local_pack_file。id 即实例名，语义与 ImportDialog 一致。
            if is_multimc_zip(Path::new(path)) {
                let resp = multimc_import_impl(
                    s,
                    MultiMcImportRequest {
                        source_id: None,
                        source_path: Some(path.to_string()),
                        name: req.id,
                        game_dir: req.game_dir,
                        version_isolation: req.version_isolation,
                    },
                )
                .await?;
                return Ok(resp.0.instance_id);
            }
            // Technic SingleZip（含 bin/modpack.jar / bin/version.json）：走
            // Technic 导入管线（同 MultiMC 语义，版本隔离强制）。
            if crate::services::technic::is_technic_zip(Path::new(path)) {
                let resp = technic_import_impl(
                    s,
                    TechnicImportRequest {
                        source_path: Some(path.to_string()),
                        download_url: None,
                        game_version_hint: None,
                        slug: None,
                        name: req.id,
                        game_dir: req.game_dir,
                        version_isolation: req.version_isolation,
                    },
                )
                .await?;
                return Ok(resp.0.instance_id);
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
                // install-direct 走本地路径：选择由请求直接携带，此处无需回填可选清单
                optional_files: Vec::new(),
                has_overrides: parsed.has_overrides,
                file_count: parsed.file_count,
                overrides_zip: None,
                icon_data: None,
                file_id: None,
                pack_type: None,
                source_id: None,
                source_path: None,
            };
            result
        } else {
            let project_id = req.project_id.as_deref().unwrap_or_default();
            let file_id = req.file_id.as_deref().unwrap_or_default();
            // Technic 例外：它没有 fileId 概念（一个包 = 一个直链，ADR-103 实测），
            // 只要 projectId（slug）。其余源仍要求两者齐备（fileId 是版本身份）。
            let is_technic = req
                .r#type
                .as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case("technic"));
            let ids_ok = if is_technic {
                !project_id.is_empty()
            } else {
                !project_id.is_empty() && !file_id.is_empty()
            };
            if !ids_ok {
                return Err(ApiError::bad_request(
                    "MODPACK_SOURCE_REQUIRED",
                    if is_technic {
                        "Technic 安装需要 projectId（整合包 slug）"
                    } else {
                        "Must provide projectId+fileId (online) or path (local)"
                    },
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
                Some("technic") => {
                    // === Technic 在线安装（issue #151）===
                    //
                    // 与其它源的模型差异（ADR-103 实测）：
                    // - projectId 语义是 **slug**（数字 id 在详情接口上 404）；
                    // - **无 fileId**（一个包只有一个直链），故这里不要求 fileId；
                    // - 直链由**后端**从 Technic API 解析后交给导入管线下载，
                    //   绝不接受前端提交的 URL（否则等于开放任意 URL 下载面）。
                    let slug = project_id.trim();
                    if slug.is_empty() {
                        return Err(ApiError::bad_request(
                            "MODPACK_SOURCE_REQUIRED",
                            "Technic 安装需要 projectId（整合包 slug）",
                        ));
                    }
                    let detail = s
                        .core
                        .create_technic_source()
                        .get_pack_detail(slug)
                        .await
                        .map_err(|e| ApiError::upstream(e.to_string()))?
                        .ok_or_else(|| {
                            ApiError::not_found(
                                "MODPACK_NOT_FOUND",
                                format!("Technic 整合包不存在: {slug}"),
                            )
                        })?;
                    // Solder（url=null 且有 solder）：Solder 是逐文件分发协议
                    // （issue #181 期3），后端解析 build 清单与 mod 列表后走专用
                    // 管线，Forge 经包内 modpack.jar 注入（ADR-108）。
                    if detail.distribution()
                        == qomicex_core::models::expansion::technic::TechnicDistribution::Solder
                    {
                        let resp = solder_import_impl(
                            s,
                            SolderImportRequest {
                                slug: slug.to_string(),
                                name: req.id,
                                game_dir: req.game_dir,
                            },
                        )
                        .await?;
                        return Ok(resp.0.instance_id);
                    }
                    let Some(zip_url) = detail.single_zip_url().map(str::to_string) else {
                        return Err(ApiError::bad_request(
                            "TECHNIC_SOLDER_UNSUPPORTED",
                            "该整合包无可用分发（既无 SingleZip 直链也无 Solder）",
                        ));
                    };
                    let resp = technic_import_impl(
                        s,
                        TechnicImportRequest {
                            source_path: None,
                            download_url: Some(zip_url),
                            game_version_hint: Some(detail.minecraft.clone()),
                            slug: Some(slug.to_string()),
                            name: req.id,
                            game_dir: req.game_dir,
                            version_isolation: req.version_isolation,
                        },
                    )
                    .await?;
                    return Ok(resp.0.instance_id);
                }
                _ => {
                    return Err(ApiError::bad_request(
                        "MODPACK_SOURCE_INVALID",
                        "Invalid modpack source type (mr/cf/ftb/technic)",
                    ))
                }
            };
            // Technic 走上面的早返回分支；此处只剩 modrinth/cf/ftb 三家，
            // 它们都要求 projectId+fileId 同时存在。
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
            optional_file_ids: None,
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
            // install-direct（拖入 / 一键安装 / 插件）不声明资源中心来源：
            // 即便带 projectId+fileId，其入口未经资源中心的两个安装对话框确认，
            // 按 issue #118「不为手动导入提供更新」的口径一律不标记可更新。
            origin: None,
            version_published_at: None,
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
#[derive(Debug, Clone)]
pub(crate) struct ParsedModpack {
    pub(crate) game_version: String,
    pub(crate) loader: String,
    pub(crate) loader_version: String,
    /// (下载URL, 相对目标路径)。Modrinth：path 为完整相对路径（mods/x.jar 等）；
    /// CurseForge：仅收集 (空 URL, "projectID:fileID") 占位，随后逐个查 CF API。
    pub(crate) files: Vec<ModpackFileEntry>,
    /// CurseForge `manifest.json` 中 `required: false` 的可选条目（issue #129）。
    /// 默认不安装：仅当用户在导入预览里勾选（`optionalFileIds`）才并入 `files`。
    /// 其余来源（Modrinth / Qomicex）无此语义，恒为空。
    pub(crate) optional_files: Vec<ModpackOptionalFile>,
}

/// 组装选中项回 `files` 用的占位 path（与 CF manifest 必需项同格式）。
fn cf_placeholder_path(project_id: i64, file_id: i64) -> String {
    format!("{project_id}:{file_id}")
}

/// 版本隔离时目标路径落在 `{gameDir}/versions/{name}/` 下，否则 `{gameDir}/`。
pub(crate) fn modpack_target_path(
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

/// zip 条目名的大小写不敏感前缀匹配（打包工具决定目录名大小写）。
fn name_has_prefix_ci(name: &str, prefix: &str) -> bool {
    name.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// Modrinth 下载需 UA（API 强制）；CurseForge CDN 需 x-api-key（同 install_service 判定）。
fn modpack_headers(url: &str, cf_api_key: &str) -> Vec<(String, String)> {
    if is_cf_host(url) {
        vec![
            ("x-api-key".to_string(), cf_api_key.to_string()),
            (
                "User-Agent".to_string(),
                crate::state::USER_AGENT.to_string(),
            ),
        ]
    } else {
        vec![(
            "User-Agent".to_string(),
            crate::state::USER_AGENT.to_string(),
        )]
    }
}

/// Technic SingleZip 直链下载头（issue #151）。
///
/// 实测该直链是普通静态托管（无需 `build` 参数、无需特定 UA），带上自标识 UA
/// 仅为对齐 ADR-025 的约定。**不放任何鉴权头**：直链由后端从 Technic API 解析，
/// 不接收前端提交的 URL（避免开放任意下载面）。
fn technic_download_headers() -> Vec<(String, String)> {
    vec![(
        "User-Agent".to_string(),
        crate::state::USER_AGENT.to_string(),
    )]
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

/// 按「资源下载源」重写一个 mod 文件 URL 并配好请求头。
///
/// headers 按**重写前的原始 host** 决定（CF 文件透传 x-api-key 到镜像）；URL 再按
/// `file_download_source` 重写 CDN 域名（官方=不变，QML Mirror=换成镜像域名）。
fn mirror_mod_url(
    url: String,
    cf_api_key: &str,
    file_download_source: i32,
) -> (String, Vec<(String, String)>) {
    let headers = modpack_headers(&url, cf_api_key);
    let rewritten = crate::services::file_mirror::rewrite_file_cdn(&url, file_download_source);
    (rewritten, headers)
}

/// 确定整合包安装的生效游戏版本（issue #176 复盘，评审确认的方向 A）。
///
/// **manifest 解析结果优先，调用方传入值仅兜底**。此前是「调用方优先，manifest 补全」，
/// 实测踩坑：CF 的 `sortableGameVersions` 顺序为 `["1.12", "Forge", "1.12.2"]`
/// （MeatballCraft 全部文件实测如此），前端把 `gameVersions[0]`（"1.12"）作为
/// gameVersion 传入，而包内 `manifest.json` 的 `minecraft.version` 才是权威值
/// （"1.12.2"）——沿用调用方值会用 1.12 去查 Forge 版本列表（112 个候选无
/// 14.23.5.2860）→「找不到 forge x 的安装器」。
///
/// manifest 未覆盖该字段的场景（FTB 在线解析不下载包体、`resolve_curseforge_online`
/// 预览留空）仍回落调用方传入值，不破坏既有入口。
fn resolve_effective_game_version(game_version_in: &str, parsed: Option<&ParsedModpack>) -> String {
    parsed
        .map(|p| p.game_version.clone())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| game_version_in.to_string())
}

/// 主安装管道（后台任务 runner）。任一步失败 → Err(msg) → tracker 置 Failed。
///
/// 成功返回 `(content_rels, effective_game_version)`：生效版本是管线内按
/// `resolve_effective_game_version`（manifest 优先）确定的，调用方必须用它
/// 回写实例记录与托管清单元数据——否则两处持久化仍标请求原始值（如 1.12），
/// 与实际安装的 1.12.2 不一致（CodeRabbit 评审 #183 指出）。
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
    file_download_source: i32,
    icon_data: Option<String>,
    optional_file_ids: Option<&[i64]>,
) -> Result<(Vec<String>, String), String> {
    let src = source.to_ascii_lowercase();
    let mut zip_path: Option<PathBuf> = None;
    let mut parsed: Option<ParsedModpack> = None;

    // 分步计划（下载中心卡片步骤列表）。本地导入跳过包体下载/解析两步；
    // 游戏本体安装不设占位步骤——嵌套 run_install_pipeline 以 step_budget 权重
    // 把自己的子步骤直接追加进同一张步骤表（平铺渲染、全局合成进度）。
    let mut specs: Vec<InstallStepSpec> = if local_pack_path.is_some() {
        vec![
            InstallStepSpec {
                id: "download-files",
                weight: 30.0,
            },
            InstallStepSpec {
                id: "overrides",
                weight: 15.0,
            },
        ]
    } else {
        vec![
            InstallStepSpec {
                id: "download-modpack",
                weight: 12.0,
            },
            InstallStepSpec {
                id: "parse-modpack",
                weight: 3.0,
            },
            InstallStepSpec {
                id: "download-files",
                weight: 30.0,
            },
            InstallStepSpec {
                id: "overrides",
                weight: 15.0,
            },
        ]
    };
    // FTB 等源无 zip 包体、无 overrides 释放段，计划中剔除该步
    let has_overrides = matches!(src.as_str(), "modrinth" | "curseforge" | "qml");
    if !has_overrides {
        specs.retain(|s| s.id != "overrides");
    }
    handle.define_steps(
        &specs,
        crate::services::install_service::INSTALL_STEP_BUDGET_TOP,
    );

    // === 1. 获取整合包包体（本地导入直接用已上传/给定文件；在线下载）===
    if let Some(local) = local_pack_path {
        zip_path = Some(PathBuf::from(local));
        // 本地导入同样要解析 manifest：版本补全 + 文件清单都依赖 parsed。
        // 此前仅在线路径解析，本地导入 CF/mrpack 会在文件下载分支因
        // parsed=None 而失败（qml 分支本就有现解析 fallback，此处跳过）。
        let local_src_ok = matches!(src.as_str(), "modrinth" | "curseforge");
        if local_src_ok {
            handle.set_stage("parsing-modpack");
            handle.mark_step("parse-modpack", "active");
            let path = PathBuf::from(local);
            parsed = Some(if src == "modrinth" {
                parse_modrinth_index(&path).map_err(|e| {
                    format!(
                        "解析 modrinth.index.json 失败: {e}（包体 {}）",
                        path.display()
                    )
                })?
            } else {
                parse_curseforge_manifest(&path)
                    .map_err(|e| format!("解析 manifest.json 失败: {e}"))?
            });
            handle.mark_step("parse-modpack", "done");
        }
    } else if src == "modrinth" || src == "curseforge" {
        handle.set_stage("downloading-modpack");
        handle.mark_step("download-modpack", "active");
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
        // 包包体也是 Modrinth/CF CDN 文件，同样按资源下载源重写；headers 按原始 host 判断。
        let mirror_url = crate::services::file_mirror::rewrite_file_cdn(url, file_download_source);
        download_batch(
            handle,
            mgr,
            vec![(mirror_url, path.clone(), modpack_headers(url, cf_api_key))],
            Some("download-modpack"),
        )
        .await?;
        handle.mark_step("download-modpack", "done");

        // === 2. 解析 manifest，补全游戏版本/加载器 ==="
        handle.set_stage("parsing-modpack");
        handle.mark_step("parse-modpack", "active");
        parsed = Some(if src == "modrinth" {
            parse_modrinth_index(&path)
                .map_err(|e| format!("解析 modrinth.index.json 失败: {e}（包体来源 {url}）"))?
        } else {
            parse_curseforge_manifest(&path).map_err(|e| format!("解析 manifest.json 失败: {e}"))?
        });
        handle.mark_step("parse-modpack", "done");
        zip_path = Some(path);
    }

    // === 2.5 合并用户在导入预览中勾选的可选条目（CF，issue #129）===
    // 必须紧跟在 parsed 就绪之后、进入文件下载分支之前：CF 下载分支直接消费
    // `p.files`，在这里并入即对下载段透明（与必需项同一条 projectID:fileID 路径）。
    if let Some(p) = parsed.as_mut() {
        apply_optional_selection(p, optional_file_ids);
    }

    // === 3. 确定 game_version / loader / loader_version ===
    // 详见 resolve_effective_game_version 的文档：game_version 以 manifest 优先。
    let mut game_version = resolve_effective_game_version(game_version_in, parsed.as_ref());
    let mut loader = loader_in.unwrap_or_default().to_string();
    let mut loader_version = loader_version_in.unwrap_or_default().to_string();
    if let Some(p) = parsed.as_ref() {
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

    // === 并行段 ================================================================
    // [E] 游戏本体安装（嵌套实例管线，以 step_budget 把子步骤追加进步骤表）
    // [G] 整合包文件/mods 下载（CF/QML 的链接反查保持串行防限流，下载本身并发）
    // [F] overrides 解压释放
    // 用户决策：三路全并行（放弃 overrides 对 mods 的覆盖优先保证，接受同名文件
    // 写竞争的小概率风险）；任一分支失败快速失败。
    const GAME_BUDGET: f64 = 40.0;

    let h_e = handle.clone();
    let mgr_e = mgr.clone();
    let hc_e = http_client.clone();
    let loader_msg = format!("安装 Minecraft {game_version} + {loader}");
    let data_e = InstallRequestData {
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
    let branch_game = async move {
        h_e.update(|f| {
            f.set_status(InstallStatus::Installing);
            f.current_file = loader_msg;
        });
        run_install_pipeline(&h_e, mgr_e, hc_e, cf_api_key, data_e, GAME_BUDGET).await
    };

    let h_g = handle.clone();
    let mgr_g = mgr.clone();
    let core_g = core.clone();
    let hc_g = http_client.clone();
    let gd_g = game_dir.to_string();
    let vdn_g = version_dir_name.to_string();
    let src_g = src.clone();
    let zip_g = zip_path.clone();
    let parsed_g = parsed.take();
    let branch_files = async move {
        h_g.mark_step("download-files", "active");
        h_g.set_stage("modpack-files");
        let result: Result<Vec<String>, String> = match src_g.as_str() {
            "modrinth" => {
                let p = parsed_g.as_ref().expect("modrinth 必有解析结果");
                // 计划落盘的相对路径（清单基线用）与下载目标一并构建：下载后
                // `files` 被 download_batch 消费，相对路径必须提前留一份。
                let planned: Vec<(String, PathBuf, Vec<(String, String)>, String)> = p
                    .files
                    .iter()
                    .filter_map(|f| {
                        let url = f.download_url.clone()?;
                        if url.is_empty() {
                            return None;
                        }
                        let rel = f.path.clone();
                        let dest = modpack_target_path(&gd_g, &vdn_g, version_isolation, &rel);
                        let (url, headers) = mirror_mod_url(url, cf_api_key, file_download_source);
                        Some((url, dest, headers, rel))
                    })
                    .collect();
                let rels: Vec<String> = planned.iter().map(|(_, _, _, r)| r.clone()).collect();
                let files: Vec<(String, PathBuf, Vec<(String, String)>)> =
                    planned.into_iter().map(|(u, d, h, _)| (u, d, h)).collect();
                if !files.is_empty() {
                    download_batch(&h_g, &mgr_g, files, Some("download-files")).await?;
                }
                Ok(rels)
            }
            "curseforge" => {
                let p = parsed_g.as_ref().ok_or("整合包清单未解析（curseforge）")?;
                // CF manifest 的 files 是 (projectID,fileID) 引用：一次批量接口解析全部
                // 链接/文件名（每批 100 自动分批；318 文件 ≈4 次调用 ≈4s，
                // 替代此前 636 次串行查询 ≈10 分钟且零进度反馈）。
                let fids: Vec<i64> = p
                    .files
                    .iter()
                    .filter_map(|f| f.path.split_once(':'))
                    .filter_map(|(_, fid)| fid.parse::<i64>().ok())
                    .collect();
                let cf = core_g.create_curseforge_source(cf_api_key);
                h_g.update(|f| {
                    f.current_file = format!("批量解析 CurseForge 文件链接 ({} 个)...", fids.len());
                });
                let info_map = cf
                    .get_files_batch(&fids)
                    .await
                    .map_err(|e| format!("批量获取 CurseForge 文件信息失败: {e}"))?;

                let mut files = Vec::new();
                let mut rels: Vec<String> = Vec::new();
                let mut missing = 0usize;
                for f in &p.files {
                    let Some((_, fid)) = f.path.split_once(':') else {
                        continue;
                    };
                    let Ok(fidn) = fid.parse::<i64>() else {
                        continue;
                    };
                    let Some(info) = info_map.get(&fidn) else {
                        missing += 1;
                        continue;
                    };
                    let Some(download_url) = info.download_url.as_deref().filter(|u| !u.is_empty())
                    else {
                        missing += 1;
                        continue;
                    };
                    let filename = info.file_name.clone().unwrap_or_else(|| {
                        download_url
                            .rsplit('/')
                            .next()
                            .unwrap_or("mod.jar")
                            .to_string()
                    });
                    let rel = format!("mods/{filename}");
                    let dest = modpack_target_path(&gd_g, &vdn_g, version_isolation, &rel);
                    let (download_url, headers) =
                        mirror_mod_url(download_url.to_string(), cf_api_key, file_download_source);
                    files.push((download_url, dest, headers));
                    rels.push(rel);
                }
                if missing > 0 {
                    tracing::warn!(
                        "CurseForge 整合包有 {missing}/{} 个文件未取得下载链接（已跳过）",
                        p.files.len()
                    );
                }
                if !files.is_empty() {
                    download_batch(&h_g, &mgr_g, files, Some("download-files")).await?;
                }
                Ok(rels)
            }
            "ftb" => {
                // core FtbModpackInstaller：FTB API 文件清单 + CF 批量查询 mods 链接
                let factory = DefaultInstallerFactory;
                let inst =
                    factory.create_ftb_modpack(&gd_g, version_isolation, hc_g.clone(), cf_api_key);
                let libs = inst
                    .get_miss_libraries(Some(&vdn_g), project_id, file_id)
                    .await
                    .map_err(|e| format!("获取 FTB 整合包文件清单失败: {e}"))?;
                let files: Vec<(String, PathBuf, Vec<(String, String)>)> = libs
                    .iter()
                    .map(|l| {
                        let (url, headers) =
                            mirror_mod_url(l.url.clone(), cf_api_key, file_download_source);
                        (url, PathBuf::from(&l.path), headers)
                    })
                    .collect();
                // FTB 的 lib 路径是绝对路径，清单需要相对实例目录的形式：
                // 相对 version 目录（隔离）/ 相对 game_dir（非隔离）都是相对实例根的。
                let mut rels: Vec<String> = Vec::new();
                for l in &libs {
                    let abs = Path::new(&l.path);
                    if let Some(rel) = relative_to_instance(abs, &gd_g, &vdn_g, version_isolation) {
                        rels.push(rel);
                    }
                }
                if !files.is_empty() {
                    download_batch(&h_g, &mgr_g, files, Some("download-files")).await?;
                }
                Ok(rels)
            }
            "qml" => {
                // QML：files[] 混合来源——modrinth 直链 + curseforge 占位反查
                let p: ParsedModpack = match parsed_g {
                    Some(p) => p,
                    None => {
                        // 本地导入时管道未预解析：从包体 zip 现解析 qmodpack.index.json
                        let zp = zip_g.as_ref().ok_or("整合包文件缺失")?;
                        parse_qmodpack_index(zp)
                            .map_err(|e| format!("解析 qmodpack.index.json 失败: {e}"))?
                    }
                };
                let cf = core_g.create_curseforge_source(cf_api_key);
                // 先分拣：modrinth 直链直接入列；curseforge 占位收集 fileId 后一次批量解析
                let mut files = Vec::new();
                let mut rels: Vec<String> = Vec::new();
                let mut placeholder_fids: Vec<i64> = Vec::new();
                for f in &p.files {
                    if let Some(url) = f.download_url.as_deref() {
                        if url.is_empty() {
                            continue;
                        }
                        let rel = f.path.clone();
                        let dest = modpack_target_path(&gd_g, &vdn_g, version_isolation, &rel);
                        let (u, h) =
                            mirror_mod_url(url.to_string(), cf_api_key, file_download_source);
                        files.push((u, dest, h));
                        rels.push(rel);
                    } else if let Some((_, fid)) = f.path.split_once(':') {
                        // curseforge 占位：path = "projectID:fileID"
                        if let Ok(fidn) = fid.parse::<i64>() {
                            placeholder_fids.push(fidn);
                        }
                    }
                }
                if !placeholder_fids.is_empty() {
                    h_g.update(|f| {
                        f.current_file = format!(
                            "批量解析 CurseForge 文件链接 ({} 个)...",
                            placeholder_fids.len()
                        );
                    });
                    let info_map = cf
                        .get_files_batch(&placeholder_fids)
                        .await
                        .map_err(|e| format!("批量获取 CurseForge 文件信息失败: {e}"))?;
                    let mut missing = 0usize;
                    for fidn in &placeholder_fids {
                        let Some(info) = info_map.get(fidn) else {
                            missing += 1;
                            continue;
                        };
                        let Some(download_url) =
                            info.download_url.as_deref().filter(|u| !u.is_empty())
                        else {
                            missing += 1;
                            continue;
                        };
                        let filename = info.file_name.clone().unwrap_or_else(|| {
                            download_url
                                .rsplit('/')
                                .next()
                                .unwrap_or("mod.jar")
                                .to_string()
                        });
                        let rel = format!("mods/{filename}");
                        let dest = modpack_target_path(&gd_g, &vdn_g, version_isolation, &rel);
                        let (download_url, headers) = mirror_mod_url(
                            download_url.to_string(),
                            cf_api_key,
                            file_download_source,
                        );
                        files.push((download_url, dest, headers));
                        rels.push(rel);
                    }
                    if missing > 0 {
                        tracing::warn!(
                            "QML 整合包有 {missing}/{} 个 CurseForge 占位文件未取得下载链接（已跳过）",
                            placeholder_fids.len()
                        );
                    }
                }
                if !files.is_empty() {
                    download_batch(&h_g, &mgr_g, files, Some("download-files")).await?;
                }
                Ok(rels)
            }
            _ => Ok(Vec::new()),
        };
        if result.is_ok() {
            h_g.mark_step("download-files", "done");
        }
        result
    };

    let h_o = handle.clone();
    let gd_o = game_dir.to_string();
    let vdn_o = version_dir_name.to_string();
    let src_o = src.clone();
    let zip_o = zip_path.clone();
    let branch_overrides = async move {
        if !has_overrides {
            return Ok(());
        }
        h_o.mark_step("overrides", "active");
        h_o.set_stage("modpack-overrides");
        if src_o == "modrinth" || src_o == "curseforge" {
            let factory = DefaultInstallerFactory;
            let zip_str = zip_o
                .as_ref()
                .and_then(|p| p.to_str())
                .ok_or("整合包文件缺失")?;
            let inst = if src_o == "modrinth" {
                factory.create_modrinth_modpack(&gd_o, version_isolation, zip_str)
            } else {
                factory.create_curseforge_modpack(&gd_o, version_isolation, zip_str)
            };
            inst.install(&vdn_o, "", None, None, None, None)
                .await
                .map_err(|e| format!("释放整合包覆盖文件失败: {e}"))?;
        } else if src_o == "qml" {
            // QML 结构简单（qmodpack.index.json + overrides/**），自行释放 overrides
            let zip_str = zip_o
                .as_ref()
                .and_then(|p| p.to_str())
                .ok_or("整合包文件缺失")?;
            release_qml_overrides(zip_str, &gd_o, &vdn_o, version_isolation)?;
        }
        h_o.mark_step("overrides", "done");
        Ok(())
    };

    let (res_e, res_g, res_o) = tokio::join!(branch_game, branch_files, branch_overrides);
    // 快速失败：首个非取消类错误胜出；同时置位取消标志让仍在跑的分支尽快退出
    let first_err = [
        res_e.as_ref().err(),
        res_g.as_ref().err(),
        res_o.as_ref().err(),
    ]
    .into_iter()
    .flatten()
    .find(|e| e.as_str() != "安装已取消")
    .cloned();
    if let Some(e) = first_err {
        handle.request_cancel();
        return Err(e);
    }
    ensure_not_cancelled(handle)?;
    res_e?;
    let content_rels = res_g?;
    res_o?;

    handle.update(|f| {
        f.set_status(InstallStatus::Finishing);
        f.stage = "finishing".to_string();
        f.current_file = "整合包安装完成".to_string();
    });
    // 图标落盘 versions/{name}/icon.png（HMCL 约定，扫描兜底读取；CF/MR 与 MultiMC 导入一致）。
    write_pack_icon(game_dir, version_dir_name, icon_data.as_deref())?;
    Ok((content_rels, game_version))
}

/// 把一个绝对路径折算成相对**实例根目录**的相对路径（清单基线用）。
///
/// 实例根 = 隔离时 `{gameDir}/versions/{name}`，否则 `{gameDir}`。
/// 不在实例根内 → `None`（该文件不属于本实例内容，不入清单）。
fn relative_to_instance(
    abs: &Path,
    game_dir: &str,
    version_dir_name: &str,
    version_isolation: bool,
) -> Option<String> {
    let instance_dir = modpack_target_path(game_dir, version_dir_name, version_isolation, "");
    let rel = abs.strip_prefix(&instance_dir).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 释放 QML `.qmodpack` 的 `overrides/**` 到目标目录（结构简单，不走 core 安装器）。
fn release_qml_overrides(
    zip_path: &str,
    game_dir: &str,
    version_dir_name: &str,
    version_isolation: bool,
) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开整合包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取整合包条目失败: {e}"))?;
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix("overrides/") else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let dest = modpack_target_path(game_dir, version_dir_name, version_isolation, rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|e| format!("创建目录失败 {}: {e}", dest.display()))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("创建文件失败 {}: {e}", dest.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("释放文件失败 {}: {e}", dest.display()))?;
    }
    Ok(())
}

/// 解析 Modrinth `.mrpack` 的 `modrinth.index.json`。
pub(crate) fn parse_modrinth_index(zip_path: &Path) -> Result<ParsedModpack, String> {
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
        optional_files: Vec::new(),
    })
}

/// 解析 Qomicex `.qmodpack` 的 `qmodpack.index.json`。
///
/// files[] 语义（导出端与 qml 格式一致）：
/// - `source: "modrinth"` → 直链下载（`downloads[0]`），与 mrpack 分支同路径；
/// - `source: "curseforge"` → `projectId:fileId` 占位（`download_url = None`），
///   由安装管道按 CF API 反查下载（与 CF manifest 分支一致，零管道改动）。
fn parse_qmodpack_index(zip_path: &Path) -> Result<ParsedModpack, String> {
    let root = read_zip_json(zip_path, "qmodpack.index.json")?;
    let game_version = root
        .get("gameVersion")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let loader = normalize_loader(
        root.get("loader")
            .and_then(|v| v.as_str())
            .unwrap_or_default(),
    );
    let loader_version = root
        .get("loaderVersion")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let mut files = Vec::new();
    if let Some(arr) = root.get("files").and_then(|f| f.as_array()) {
        for f in arr {
            let path = f
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or_default()
                .to_string();
            let size = f.get("size").and_then(|s| s.as_i64());
            let source = f.get("source").and_then(|s| s.as_str()).unwrap_or_default();
            match source {
                "modrinth" => {
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
                        size,
                    });
                }
                "curseforge" => {
                    let pid = f.get("projectId").and_then(|v| v.as_i64());
                    let fid = f.get("fileId").and_then(|v| v.as_i64());
                    let (Some(pid), Some(fid)) = (pid, fid) else {
                        continue;
                    };
                    // 与 CF manifest 占位一致：管道识别 download_url=None → CF 反查
                    // （目标文件名由 CF API 的 file_name 决定，同 CF zip 导入语义）
                    files.push(ModpackFileEntry {
                        path: format!("{pid}:{fid}"),
                        download_url: None,
                        size,
                    });
                }
                _ => continue,
            }
        }
    }

    Ok(ParsedModpack {
        game_version,
        loader,
        loader_version,
        files,
        optional_files: Vec::new(),
    })
}

/// 解析 CurseForge 整合包 zip 的 `manifest.json`。
pub(crate) fn parse_curseforge_manifest(zip_path: &Path) -> Result<ParsedModpack, String> {
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
    let mut optional_files = Vec::new();
    if let Some(arr) = root.get("files").and_then(|f| f.as_array()) {
        for f in arr {
            let proj = f.get("projectID").and_then(|v| v.as_i64()).unwrap_or(0);
            let fid = f.get("fileID").and_then(|v| v.as_i64()).unwrap_or(0);
            if proj <= 0 || fid <= 0 {
                continue;
            }
            // required 缺省按必需处理（CF 规范默认值）；false 进可选清单，
            // 由用户在导入预览中勾选后才安装（issue #129）。
            let required = f.get("required").and_then(|r| r.as_bool()).unwrap_or(true);
            if !required {
                optional_files.push(ModpackOptionalFile {
                    project_id: proj,
                    file_id: fid,
                    // 名称/体积待 CF 批量接口补全（manifest 只有 id）；补不到即用占位。
                    name: cf_placeholder_path(proj, fid),
                    size: None,
                });
                continue;
            }
            files.push(ModpackFileEntry {
                path: cf_placeholder_path(proj, fid),
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
        optional_files,
    })
}

/// 用 CF 批量文件接口补全可选条目的展示名与体积（issue #129）。
///
/// 失败一律降级：保留占位 `name`、`size=None`，**不**让解析失败——可选清单只是
/// 安装预览的辅助信息，CF 接口抖动不应阻塞导入。
async fn enrich_optional_files(
    core: &Arc<GameCore>,
    cf_api_key: &str,
    optional_files: &mut [ModpackOptionalFile],
) {
    if optional_files.is_empty() {
        return;
    }
    let fids: Vec<i64> = optional_files.iter().map(|o| o.file_id).collect();
    let cf = core.create_curseforge_source(cf_api_key);
    let info_map = match cf.get_files_batch(&fids).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("补全 CurseForge 可选模组信息失败（保留占位名称）: {e}");
            return;
        }
    };
    for o in optional_files.iter_mut() {
        let Some(info) = info_map.get(&o.file_id) else {
            continue;
        };
        if let Some(name) = info.file_name.as_deref().filter(|n| !n.is_empty()) {
            o.name = name.to_string();
        }
        if let Some(len) = info.file_length.filter(|l| *l > 0) {
            o.size = Some(len);
        }
    }
}

/// 按用户在导入预览中的勾选，把命中的可选条目并入 `files`（issue #129）。
///
/// `selected` 为空（未传 / 空数组）→ 一条都不加，与引入本功能前的行为一致。
/// `selected = None` 与 `Some(空)` 语义相同，均表示"全不装"。
fn apply_optional_selection(pack: &mut ParsedModpack, selected: Option<&[i64]>) {
    let Some(selected) = selected else {
        return;
    };
    if selected.is_empty() || pack.optional_files.is_empty() {
        return;
    }
    let wanted: HashSet<i64> = selected.iter().copied().collect();
    for o in &pack.optional_files {
        if wanted.contains(&o.file_id) {
            pack.files.push(ModpackFileEntry {
                path: cf_placeholder_path(o.project_id, o.file_id),
                download_url: None,
                size: o.size,
            });
        }
    }
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
            // CF 可选条目：由 parse/parse_path 在补全名称后回填（issue #129）
            optional_files: self.pack.optional_files,
            has_overrides: self.has_overrides,
            file_count: self.file_count,
            overrides_zip: None,
            icon_data: None,
            file_id: None,
            pack_type: None,
            source_id: None,
            source_path: None,
        }
    }
}

/// 解析本地 `.zip`（CurseForge）/`.mrpack`（Modrinth）文件：探测格式 + 提取
/// meta（名称/版本/作者/简介）与管道用 ParsedModpack。
fn parse_local_pack_file(path: &Path) -> Result<LocalPackParse, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开整合包文件失败: {e}"))?;
    let archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;
    // 条目探测只读中央目录：by_index() 会逐条目 seek+读本地文件头，大包（GTNH
    // 1.6 万条目）下这次全表扫描就是「解析请求超时」的主要耗时（issue #119）。
    let mut has_mr = false;
    let mut has_cf = false;
    let mut has_qml = false;
    let mut has_mr_overrides = false;
    let mut has_cf_overrides = false;
    for name in archive.file_names() {
        match name {
            "modrinth.index.json" => has_mr = true,
            "manifest.json" => has_cf = true,
            "qmodpack.index.json" => has_qml = true,
            _ => {}
        }
        // Modrinth 规范目录名为 `overrides/`（support.modrinth.com/en/articles/8802351），
        // 兼容旧实现/非标准包的 `override/`；CurseForge 由 manifest `overrides` 字段指定
        // （缺省即 `overrides/`）。
        if name_has_prefix_ci(name, "overrides/") || name_has_prefix_ci(name, "override/") {
            has_mr_overrides = true;
        }
        if name_has_prefix_ci(name, "overrides/") {
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

    if has_qml {
        let root = read_zip_json(path, "qmodpack.index.json")?;
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
        let summary = root
            .get("summary")
            .and_then(|v| v.as_str())
            .map(String::from);
        let pack = parse_qmodpack_index(path)?;
        let file_count = pack.files.len() as i32;
        return Ok(LocalPackParse {
            source: "qml".to_string(),
            name,
            summary,
            author,
            version,
            has_overrides: has_cf_overrides,
            file_count,
            pack,
        });
    }

    Err("无法识别的整合包格式：需包含 qmodpack.index.json（Qomicex）、modrinth.index.json（Modrinth）或 manifest.json（CurseForge）".to_string())
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
    /// CurseForge 可选条目（manifest `required: false`，issue #129）。用户在导入
    /// 预览中勾选后，经 `ModpackInstallRequest.optionalFileIds` 回传安装。
    /// 其余来源恒为空数组。
    #[serde(default)]
    pub optional_files: Vec<ModpackOptionalFile>,
    pub has_overrides: bool,
    pub file_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides_zip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    /// 本地导入时上传临时文件的句柄（随 /modpack/install 传回）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    /// 整合包类型：modrinth / curseforge / qomicex / multimc。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_type: Option<String>,
    /// MultiMC 导入：`{BaseDir}/temp/multimc-imports/{uuid}` 解压根句柄。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// MultiMC 导入：源 zip / 文件夹绝对路径（解析阶段不落盘时用）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
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

/// CurseForge `manifest.json` 中 `required: false` 的可选条目（issue #129）。
///
/// `manifest.json` 只含 id，`name` / `size` 由 `/modpack/parse` 经 CF 批量文件接口
/// 补全；补全失败时 `name` 退化为 `projectID:fileID` 占位，不阻断解析。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModpackOptionalFile {
    pub project_id: i64,
    pub file_id: i64,
    /// 展示名：CF 返回的 `fileName`；缺省为 `{projectID}:{fileID}`。
    pub name: String,
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
    /// CurseForge 可选条目的选择（issue #129）：用户在导入预览中勾选的 `fileId` 列表。
    /// 不传 / 空数组 = 全部不安装（与引入本功能前行为一致）；仅对 `required: false`
    /// 的条目生效，必需条目恒装。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional_file_ids: Option<Vec<i64>>,
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
    /// 本地导入：整合包绝对路径。前端经 parse-path 解析后回传（`localPath`），
    /// install-direct 内部亦直传；供管道直接读本地包体，避免误走在线下载分支。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    /// 安装来源标记（issue #118）：**仅**资源中心的两个安装对话框发送
    /// `"resource-center"`，后端据此写入实例的可更新来源字段。
    /// 本地导入 / 拖入 / MultiMC / install-direct 一律不发送 → 这些实例不可更新。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 所选平台版本的发布时间（RFC3339，issue #118）。
    /// 当前版本将来若被平台删除，用它作为「更新判定」的排序回退。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_published_at: Option<String>,
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

/// MultiMC 导入解析结果（zip 上传返回 sourceId，文件夹返回 sourcePath）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiMcParseResult {
    /// zip 上传：`{BaseDir}/temp/multimc-imports/{uuid}` 句柄。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// 文件夹：实例根目录绝对路径。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub name: String,
    pub game_version: String,
    pub loader: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
}

/// POST /modpack/multimc/parse-folder 请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiMcParseFolderRequest {
    pub path: String,
}

/// POST /modpack/multimc/import 请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiMcImportRequest {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    pub name: String,
    pub game_dir: String,
    #[serde(default)]
    pub version_isolation: Option<bool>,
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

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;

    use super::{
        apply_optional_selection, cf_placeholder_path, is_multimc_zip, is_updatable_origin,
        modpack_target_path, parse_curseforge_manifest, parse_local_pack_file,
        release_qml_overrides, resolve_effective_game_version, ModpackInstallRequest,
        ModpackOptionalFile, ParsedModpack,
    };

    /// issue #176 复盘回归：gameVersion 决策必须 manifest 优先。
    ///
    /// 实测背景：CF `sortableGameVersions` = ["1.12", "Forge", "1.12.2"]，
    /// 前端传 gameVersions[0]（"1.12"），包内 manifest 是权威值 "1.12.2"。
    /// 修复前「调用方优先」会用 1.12 查 Forge 列表（112 候选无 14.23.5.2860）
    /// →「找不到 forge 14.23.5.2860 的安装器」。
    #[test]
    fn effective_game_version_prefers_manifest_over_caller() {
        let parsed = ParsedModpack {
            game_version: "1.12.2".to_string(),
            loader: "forge".to_string(),
            loader_version: "14.23.5.2860".to_string(),
            files: Vec::new(),
            optional_files: Vec::new(),
        };

        // 调用方传了错误值（前端 gameVersions[0]="1.12"）→ manifest 赢
        assert_eq!(
            resolve_effective_game_version("1.12", Some(&parsed)),
            "1.12.2",
            "manifest 的权威版本必须覆盖调用方传入值"
        );
        // 调用方传了正确值 → 仍以 manifest 为准（口径唯一，不依赖前端正确性）
        assert_eq!(
            resolve_effective_game_version("1.12.2", Some(&parsed)),
            "1.12.2"
        );

        // manifest 未覆盖该字段（FTB 在线解析 / 预览留空）→ 调用方值兜底
        let empty = ParsedModpack {
            game_version: String::new(),
            loader: String::new(),
            loader_version: String::new(),
            files: Vec::new(),
            optional_files: Vec::new(),
        };
        assert_eq!(
            resolve_effective_game_version("1.12.2", Some(&empty)),
            "1.12.2",
            "manifest 为空时回落调用方传入值"
        );
        assert_eq!(resolve_effective_game_version("1.12.2", None), "1.12.2");
    }

    /// 构造「资源中心在线安装」的合法请求，测试在此基础上逐项破坏。
    fn updatable_req() -> ModpackInstallRequest {
        ModpackInstallRequest {
            name: "Pack".to_string(),
            game_version: "1.20.1".to_string(),
            loader: Some("forge".to_string()),
            loader_version: Some("47.1.0".to_string()),
            max_memory: None,
            game_dir: ".minecraft".to_string(),
            version_isolation: true,
            modpack_files: None,
            overrides_zip: None,
            optional_file_ids: None,
            icon_data: None,
            modpack_name: Some("Pack".to_string()),
            modpack_version: Some("1.0".to_string()),
            modpack_author: None,
            modpack_summary: None,
            source: Some("curseforge".to_string()),
            project_id: Some("123".to_string()),
            version_id: Some("456".to_string()),
            optifine_version: None,
            file_id: None,
            local_path: None,
            origin: Some("resource-center".to_string()),
            version_published_at: Some("2026-01-01T00:00:00Z".to_string()),
        }
    }

    /// issue #118：只有「资源中心在线安装 + 版本隔离」才标记为可更新。
    /// 逐项破坏每个前置条件，验证任一不满足即不可更新 —— 这是「不为手动导入
    /// 提供更新」这条工单要求的唯一防线。
    #[test]
    fn updatable_origin_requires_all_preconditions() {
        // 基准：全部满足 → 可更新
        assert!(
            is_updatable_origin(&updatable_req()),
            "资源中心在线安装应可更新"
        );

        // 1. 无 origin 标记（本地导入/拖入/MultiMC/install-direct）→ 不可更新
        let mut r = updatable_req();
        r.origin = None;
        assert!(!is_updatable_origin(&r), "无来源标记不得可更新");

        // 标记大小写不敏感
        let mut r = updatable_req();
        r.origin = Some("Resource-Center".to_string());
        assert!(is_updatable_origin(&r), "来源标记应大小写不敏感");

        // 2. 非 modrinth/curseforge（如 ftb / qml）→ 不可更新
        for src in ["ftb", "qml", "unknown", ""] {
            let mut r = updatable_req();
            r.source = Some(src.to_string());
            assert!(!is_updatable_origin(&r), "source={src} 不得可更新");
        }

        // 3. 缺 projectId / versionId（含空白串）→ 不可更新
        let mut r = updatable_req();
        r.project_id = None;
        assert!(!is_updatable_origin(&r), "缺 projectId 不得可更新");

        let mut r = updatable_req();
        r.version_id = None;
        assert!(!is_updatable_origin(&r), "缺 versionId 不得可更新");

        let mut r = updatable_req();
        r.version_id = Some("   ".to_string());
        assert!(!is_updatable_origin(&r), "空白 versionId 不得可更新");

        // 4. 带 fileId / localPath（本地包体导入）→ 不可更新
        let mut r = updatable_req();
        r.file_id = Some("upload-uuid".to_string());
        assert!(!is_updatable_origin(&r), "带 fileId 不得可更新");

        let mut r = updatable_req();
        r.local_path = Some("D:/packs/x.zip".to_string());
        assert!(!is_updatable_origin(&r), "带 localPath 不得可更新");

        // 5. 非版本隔离 → 不可更新（会改到共享目录、波及其他实例）
        let mut r = updatable_req();
        r.version_isolation = false;
        assert!(!is_updatable_origin(&r), "非隔离实例不得可更新");
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-qml-release-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// release_qml_overrides：解压 overrides/** 到目标目录，忽略 qmodpack.index.json 与非 overrides 条目。
    #[test]
    fn release_qml_overrides_extracts_override_tree() {
        let root = temp_dir("extract");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("overrides/config")).unwrap();
        std::fs::create_dir_all(src.join("overrides/mods")).unwrap();
        std::fs::write(src.join("overrides/config/opt.toml"), b"a=1").unwrap();
        std::fs::write(src.join("overrides/mods/keep.jar"), b"jar").unwrap();
        std::fs::write(src.join("qmodpack.index.json"), b"{}").unwrap();
        std::fs::write(src.join("manifest.json"), b"{}").unwrap();

        let zip_path = root.join("pack.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        fn add_tree(
            zip: &mut zip::ZipWriter<std::fs::File>,
            dir: &PathBuf,
            base: &str,
            opts: &zip::write::SimpleFileOptions,
        ) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                let rel = if base.is_empty() {
                    name.clone()
                } else {
                    format!("{base}/{name}")
                };
                if path.is_dir() {
                    zip.add_directory(format!("{rel}/"), *opts).unwrap();
                    add_tree(zip, &path, &rel, opts);
                } else {
                    zip.start_file(rel, *opts).unwrap();
                    zip.write_all(&std::fs::read(&path).unwrap()).unwrap();
                }
            }
        }
        add_tree(&mut zip, &src, "", &opts);
        zip.finish().unwrap();

        // 释放到 game_dir（非隔离）
        let game_dir = root.join("game");
        release_qml_overrides(
            zip_path.to_str().unwrap(),
            game_dir.to_str().unwrap(),
            "v",
            false,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(game_dir.join("config/opt.toml")).unwrap(),
            "a=1"
        );
        assert_eq!(
            std::fs::read_to_string(game_dir.join("mods/keep.jar")).unwrap(),
            "jar"
        );
        // 非 overrides 条目不释放
        assert!(!game_dir.join("qmodpack.index.json").exists());
        assert!(!game_dir.join("manifest.json").exists());
    }

    /// modpack_target_path：隔离/非隔离目标路径。
    #[test]
    fn target_path_respects_isolation() {
        let isolated = modpack_target_path("G", "1.20.1-Forge-47.1.0", true, "config/x.toml");
        assert_eq!(
            isolated,
            PathBuf::from("G/versions/1.20.1-Forge-47.1.0/config/x.toml")
        );
        let plain = modpack_target_path("G", "v", false, "config/x.toml");
        assert_eq!(plain, PathBuf::from("G/config/x.toml"));
    }

    /// 大包回归（issue #119）：1.6 万条目的 zip 里格式探测 / overrides 判定仍须正确。
    /// 这条用例同时锁住「探测只读中央目录」的实现——改用 by_index() 逐条目读本地头，
    /// 这种规模下 classify / install-direct 的解析耗时会越过前端 15s 请求超时。
    ///
    /// filler 条目用 `Stored` 而非 `Deflated`：被测性质是「中央目录里有 1.6 万个条目」，
    /// 与压缩方式无关；deflate 上万个小条目会把用例本身拖到秒级（CI 更慢）。
    /// MultiMC 标识放在嵌套目录里，顺带覆盖 `is_multimc_zip` 的**正向**分支。
    #[test]
    fn zip_probing_handles_many_entries() {
        let root = temp_dir("many-entries");
        let zip_path = root.join("pack.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let filler = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        // 模拟 GTNH 的 `.minecraft/` 内容：上万个小条目。
        for i in 0..16_000 {
            zip.start_file(
                format!("GT New Horizons 2.9.0-RC-1/.minecraft/config/file{i}.cfg"),
                filler,
            )
            .unwrap();
            zip.write_all(b"key=value\n").unwrap();
        }
        zip.start_file("overrides/mods/keep.jar", filler).unwrap();
        zip.write_all(b"jar").unwrap();
        // 索引埋在大量条目之后：探测必须覆盖全表而不是只看前几个条目。
        let index = br#"{"game":"minecraft","name":"BigPack","versionId":"1.0","dependencies":{"minecraft":"1.20.1","fabric-loader":"0.15.0"},"files":[{"path":"mods/a.jar","downloads":["https://example.invalid/a.jar"]}]}"#;
        zip.start_file("modrinth.index.json", filler).unwrap();
        zip.write_all(index).unwrap();
        // MultiMC 标识嵌套在前导目录里（MultiMC 导出的常见形态），且排在 1.6 万条目之后。
        zip.start_file("GT New Horizons 2.9.0-RC-1/mmc-pack.json", filler)
            .unwrap();
        zip.write_all(br#"{"components":[{"uid":"net.minecraft","version":"1.7.10"}]}"#)
            .unwrap();
        zip.finish().unwrap();

        // 嵌套的 mmc-pack.json 也必须被识别为 MultiMC 包（正向分支）。
        assert!(is_multimc_zip(&zip_path));

        // 同时存在 modrinth 索引时按 Modrinth 解析（manifest 优先于 mmc 标识）。
        let parsed = parse_local_pack_file(&zip_path).unwrap();
        assert_eq!(parsed.source, "modrinth");
        assert_eq!(parsed.pack.game_version, "1.20.1");
        assert_eq!(parsed.pack.loader, "fabric");
        assert_eq!(parsed.pack.loader_version, "0.15.0");
        assert_eq!(parsed.pack.files.len(), 1);
        assert_eq!(parsed.pack.files[0].path, "mods/a.jar");
        assert!(parsed.has_overrides);
    }

    /// `is_multimc_zip` 的反向分支：没有 mmc-pack.json 就不是 MultiMC 包
    /// （普通的 Modrinth / CurseForge 包可能恰好含 instance.cfg 之类的同名文件）。
    #[test]
    fn is_multimc_zip_rejects_pack_without_marker() {
        let root = temp_dir("no-mmc-marker");
        let zip_path = root.join("pack.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(
            "modrinth.index.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(
            br#"{"game":"minecraft","name":"P","versionId":"1","dependencies":{},"files":[]}"#,
        )
        .unwrap();
        zip.start_file("instance.cfg", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"name=P\n").unwrap();
        zip.finish().unwrap();

        assert!(!is_multimc_zip(&zip_path));
    }

    // -----------------------------------------------------------------------
    // issue #129：CurseForge 可选模组
    // -----------------------------------------------------------------------

    /// 写一个 CF manifest zip，files[] 含必需与可选（required:false / 缺省）三类条目。
    fn write_cf_pack(dir: &PathBuf, manifest: &str) -> PathBuf {
        let zip_path = dir.join("pack.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.finish().unwrap();
        zip_path
    }

    /// 解析必须**保留** required:false 条目（此前被 `continue` 直接丢弃），
    /// 且 required 缺省按必需处理、必需项仍进 files。
    #[test]
    fn cf_manifest_keeps_optional_entries() {
        let root = temp_dir("cf-optional-parse");
        let zip_path = write_cf_pack(
            &root,
            r#"{"manifestType":"minecraftModpack","name":"P","version":"1.0",
                "minecraft":{"version":"1.20.1","modLoaders":[{"id":"forge-47.1.0"}]},
                "files":[
                  {"projectID":1,"fileID":11,"required":true},
                  {"projectID":2,"fileID":22,"required":false},
                  {"projectID":3,"fileID":33}
                ]}"#,
        );

        let pack = parse_curseforge_manifest(&zip_path).unwrap();
        assert_eq!(pack.game_version, "1.20.1");
        assert_eq!(pack.loader, "forge");
        assert_eq!(pack.loader_version, "47.1.0");
        // 必需项：显式 required:true + 缺省（按必需）
        assert_eq!(pack.files.len(), 2);
        assert_eq!(pack.files[0].path, "1:11");
        assert_eq!(pack.files[1].path, "3:33");
        // 可选清单：仅 required:false
        assert_eq!(pack.optional_files.len(), 1);
        assert_eq!(pack.optional_files[0].project_id, 2);
        assert_eq!(pack.optional_files[0].file_id, 22);
        // 解析阶段尚未补全名称 → 占位
        assert_eq!(pack.optional_files[0].name, "2:22");
        assert_eq!(pack.optional_files[0].size, None);
    }

    /// 端到端组合（复刻管道顺序）：真实 manifest → 解析 → 按勾选合并，
    /// 断言最终送进下载分支的 `files` 内容。
    #[test]
    fn cf_parse_then_select_produces_expected_download_set() {
        let root = temp_dir("cf-parse-then-select");
        let zip_path = write_cf_pack(
            &root,
            r#"{"manifestType":"minecraftModpack","name":"P","version":"1.0",
                "minecraft":{"version":"1.20.1","modLoaders":[{"id":"forge-47.1.0"}]},
                "files":[
                  {"projectID":10,"fileID":101,"required":true},
                  {"projectID":20,"fileID":201,"required":false},
                  {"projectID":30,"fileID":301,"required":false}
                ]}"#,
        );

        // 1) 未勾选任何可选 → 只装必需项（= 引入本功能前的行为）
        let mut pack = parse_curseforge_manifest(&zip_path).unwrap();
        apply_optional_selection(&mut pack, None);
        let paths: Vec<&str> = pack.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["10:101"]);

        // 2) 勾选其中一个可选 → 必需项 + 该可选，且不带另一个
        let mut pack = parse_curseforge_manifest(&zip_path).unwrap();
        apply_optional_selection(&mut pack, Some(&[301]));
        let paths: Vec<&str> = pack.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["10:101", "30:301"]);
        assert!(
            !paths.contains(&"20:201"),
            "未勾选的可选模组不得进入下载清单"
        );

        // 3) 全选 → 三项齐全
        let mut pack = parse_curseforge_manifest(&zip_path).unwrap();
        apply_optional_selection(&mut pack, Some(&[201, 301]));
        assert_eq!(pack.files.len(), 3);
    }

    /// 选择集为 None / 空 → 一条都不加（= 引入本功能前的行为，向后兼容）。
    #[test]
    fn optional_selection_defaults_to_none_installed() {
        let mut pack = ParsedModpack {
            game_version: "1.20.1".into(),
            loader: "forge".into(),
            loader_version: "47.1.0".into(),
            files: vec![],
            optional_files: vec![ModpackOptionalFile {
                project_id: 2,
                file_id: 22,
                name: "Dyn".into(),
                size: Some(100),
            }],
        };
        apply_optional_selection(&mut pack, None);
        assert!(pack.files.is_empty(), "None 不应安装任何可选模组");

        apply_optional_selection(&mut pack, Some(&[]));
        assert!(pack.files.is_empty(), "空选择集不应安装任何可选模组");
    }

    /// 命中选择：选中项并入 files（与必需项同格式），未选中项保持不装。
    #[test]
    fn optional_selection_merges_only_checked_entries() {
        let mut pack = ParsedModpack {
            game_version: "1.20.1".into(),
            loader: "forge".into(),
            loader_version: "47.1.0".into(),
            files: vec![],
            optional_files: vec![
                ModpackOptionalFile {
                    project_id: 2,
                    file_id: 22,
                    name: "A".into(),
                    size: Some(100),
                },
                ModpackOptionalFile {
                    project_id: 3,
                    file_id: 33,
                    name: "B".into(),
                    size: Some(200),
                },
            ],
        };
        apply_optional_selection(&mut pack, Some(&[33]));

        assert_eq!(pack.files.len(), 1, "只应并入被勾选的那一条");
        assert_eq!(pack.files[0].path, cf_placeholder_path(3, 33));
        assert_eq!(pack.files[0].download_url, None, "保留 CF 反查占位语义");
        assert_eq!(pack.files[0].size, Some(200));
    }

    /// 选择集里的未知 fileId 不应凭空造出条目。
    #[test]
    fn optional_selection_ignores_unknown_ids() {
        let mut pack = ParsedModpack {
            game_version: "1.20.1".into(),
            loader: "forge".into(),
            loader_version: "47.1.0".into(),
            files: vec![],
            optional_files: vec![ModpackOptionalFile {
                project_id: 2,
                file_id: 22,
                name: "A".into(),
                size: None,
            }],
        };
        apply_optional_selection(&mut pack, Some(&[999, 22]));
        assert_eq!(pack.files.len(), 1);
        assert_eq!(pack.files[0].path, "2:22");
    }
}
