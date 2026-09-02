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

    let parsed = parse_local_pack_file(&path).map_err(|e| {
        let _ = std::fs::remove_file(&path);
        ApiError::bad_request("MODPACK_PARSE_FAILED", e)
    })?;

    let source = parsed.source.clone();
    let mut result = parsed.to_parse_result();
    result.file_id = Some(file_id);
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
async fn parse_path(Json(req): Json<ParsePathRequest>) -> ApiResult<Json<ModpackParseResult>> {
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

    let parsed = parse_local_pack_file(path)
        .map_err(|e| ApiError::bad_request("MODPACK_PARSE_FAILED", e))?;

    let source = parsed.source.clone();
    let mut result = parsed.to_parse_result();
    result.file_id = None;
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

    let source_dir: std::path::PathBuf =
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
                dir
            }
            (None, Some(p)) => {
                let p = validate_source_path(p)?.to_path_buf();
                if p.is_file() {
                    // source_path 指向 zip（解析阶段不落盘）→ 解压到临时目录，导入后清理。
                    let id = uuid::Uuid::new_v4().to_string();
                    let dir = multimc_imports_dir()?.join(&id);
                    if let Err(e) = extract_zip_file(&p, &dir) {
                        // 解压失败也可能留下部分目录，交给守卫清理。
                        cleanup.push_dir(dir);
                        return Err(ApiError::bad_request("MULTIMC_PARSE_EXTRACT_FAILED", e));
                    }
                    // 上传的 zip（位于 modpack-uploads/）导入完成后删除，避免累积。
                    if p.starts_with(&modpack_uploads_dir()?) {
                        cleanup.push_file(p.clone());
                    }
                    cleanup.push_dir(dir.clone());
                    dir
                } else {
                    p
                }
            }
            _ => {
                return Err(ApiError::bad_request(
                    "MULTIMC_SOURCE_REQUIRED",
                    "缺少 sourceId（zip 上传）或 sourcePath（实例目录）",
                ))
            }
        };
    let root = crate::services::multimc::locate_instance_root(&source_dir).ok_or_else(|| {
        ApiError::bad_request(
            "MULTIMC_NOT_FOUND",
            "未找到 MultiMC 实例（缺少 instance.cfg / mmc-pack.json）",
        )
    })?;
    let meta = crate::services::multimc::parse_metadata(&root)
        .map_err(|e| ApiError::bad_request("MULTIMC_PARSE_FAILED", e))?;

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
    inst.icon_data = meta.icon_data.clone();
    inst.modpack_name = Some(name.clone());
    let created = s.instance.create(inst);
    drop(_guard);
    let instance_id = created.id.clone();

    let tracker = s.install_tracker.clone();
    let mgr = s.download_manager.load_full();
    let http_client = s.http_client.clone();
    let inst_svc = s.instance.clone();
    let root_path = root.clone();
    let meta_owned = meta;
    let gd = game_dir.to_string_lossy().into_owned();
    let inst_id_inner = instance_id.clone();

    tracker.start_modpack_install(instance_id.clone(), move |handle| async move {
        let result = run_multimc_import(
            &handle,
            &mgr,
            &http_client,
            &root_path,
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
            let _ = inst_svc.delete(&inst_id_inner);
        }
        result
    });

    Ok(Json(ModpackInstallDirectResponse { instance_id }))
}

/// MultiMC 导入后台任务：组件补丁链合并（策略 B，对齐 HMCL）+ 内容/内嵌库拷贝。
#[allow(clippy::too_many_arguments)]
async fn run_multimc_import(
    handle: &InstallHandle,
    mgr: &Arc<qomicex_downloader::DownloadManager>,
    http_client: &reqwest::Client,
    root: &std::path::Path,
    meta: &crate::services::multimc::MultiMcMetadata,
    game_dir: &str,
    version_dir_name: &str,
    inst_svc: &crate::services::instance::InstanceService,
    instance_id: &str,
) -> Result<(), String> {
    use InstallStepSpec as S;
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

    // 统一路径（对齐 HMCL）：所有 MultiMC 包都走「组件补丁链合并」生成官方版本 JSON。
    // 标准安装管线捷径会对带辅助组件 / 新版 Java 参数（+jvmArgs）的包漏掉补丁
    // （LWJGL3 库、RFB 主类、--add-opens 启动参数），且 fabric/quilt 会误加默认 addon，
    // 故不再使用。
    handle.mark_step("install-game", "active");
    handle.set_stage("building-version");
    handle.set_current_file("合并 MultiMC 组件补丁...");
    let (merged, jvm_args) = crate::services::multimc::build_merged_version_json(
        http_client,
        root,
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
    let _ = crate::services::multimc::copy_embedded_libraries(root, game_root, &merged)?;

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
    crate::services::multimc::copy_instance_content(root, game_root, version_dir_name)?;
    handle.mark_step("copy-files", "done");

    // === 收尾 ===
    handle.mark_step("finalize", "active");
    handle.set_stage("finishing");
    handle.set_current_file("导入完成");
    handle.mark_step("finalize", "done");
    Ok(())
}

/// 探测 zip 是否为 MultiMC 整合包。
/// 只认 `mmc-pack.json`（MultiMC 实例的强标识，且 parse_metadata_from_zip 也以此为准）。
/// 单独的 `instance.cfg` 不作为信号：普通 Modrinth/CurseForge 包可能恰好含同名文件，
/// 误判后会被交给 parse_metadata_from_zip 并因缺 mmc-pack.json 而拒绝本应有效的整合包。
fn is_multimc_zip(zip_path: &std::path::Path) -> bool {
    let Ok(file) = std::fs::File::open(zip_path) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            continue;
        };
        let name = entry.name();
        if name == "mmc-pack.json" || name.ends_with("/mmc-pack.json") {
            return true;
        }
    }
    false
}

/// 从磁盘 zip 文件解压到目标目录（防 zip-slip：仅使用 `enclosed_name` 安全路径）。
fn extract_zip_file(zip_path: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开整合包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;
    extract_archive(&mut archive, dest)
}

/// 从内存字节解压到目标目录（防 zip-slip：仅使用 `enclosed_name` 安全路径）。
fn extract_zip(data: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("读取整合包失败: {e}"))?;
    extract_archive(&mut archive, dest)
}

/// zip 炸弹防护阈值（远高于正常整合包：GTNH 约 1.2 万条目 / 解压 0.72GB）。
const MAX_ZIP_ENTRIES: usize = 200_000;
const MAX_ENTRY_UNCOMPRESSED: u64 = 8 * 1024 * 1024 * 1024; // 单文件 8 GiB
const MAX_TOTAL_UNCOMPRESSED: u64 = 64 * 1024 * 1024 * 1024; // 总解压 64 GiB

fn extract_archive<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    dest: &std::path::Path,
) -> Result<(), String> {
    let total_entries = archive.len();
    if total_entries > MAX_ZIP_ENTRIES {
        return Err(format!(
            "整合包条目数过多（{total_entries} > {MAX_ZIP_ENTRIES}），疑似异常压缩包"
        ));
    }
    let mut total_uncompressed: u64 = 0;
    for i in 0..total_entries {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取整合包条目失败: {e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("整合包内含非法路径（zip-slip）".to_string());
        };
        let rel: &std::path::Path = enclosed.as_ref();
        let target = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("创建目录失败 {}: {e}", target.display()))?;
            continue;
        }
        let size = entry.size();
        if size > MAX_ENTRY_UNCOMPRESSED {
            return Err(format!(
                "整合包内文件过大（{} > {MAX_ENTRY_UNCOMPRESSED} B）：{}",
                size,
                entry.name()
            ));
        }
        total_uncompressed += size;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
            return Err("整合包解压总大小超出限制，疑似异常压缩包".to_string());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("创建文件失败 {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("解压文件失败 {}: {e}", target.display()))?;
    }
    Ok(())
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
            pack_type: None,
            source_id: None,
            source_path: None,
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

        let file_download_source = crate::settings::get_global_file_download_source();
        let inst_svc = self.instance.clone();
        let inst_id_inner = instance_id.clone();
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
            )
            .await;
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
                let _ = inst_svc.delete(&inst_id_inner);
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
                pack_type: None,
                source_id: None,
                source_path: None,
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
#[derive(Debug, Clone)]
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
    file_download_source: i32,
) -> Result<(), String> {
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
                parse_modrinth_index(&path)
                    .map_err(|e| format!("解析 modrinth.index.json 失败: {e}"))?
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
                .map_err(|e| format!("解析 modrinth.index.json 失败: {e}"))?
        } else {
            parse_curseforge_manifest(&path).map_err(|e| format!("解析 manifest.json 失败: {e}"))?
        });
        handle.mark_step("parse-modpack", "done");
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
        let result: Result<(), String> = match src_g.as_str() {
            "modrinth" => {
                let p = parsed_g.as_ref().expect("modrinth 必有解析结果");
                let files: Vec<(String, PathBuf, Vec<(String, String)>)> = p
                    .files
                    .iter()
                    .filter_map(|f| {
                        let url = f.download_url.clone()?;
                        if url.is_empty() {
                            return None;
                        }
                        let dest = modpack_target_path(&gd_g, &vdn_g, version_isolation, &f.path);
                        let (url, headers) = mirror_mod_url(url, cf_api_key, file_download_source);
                        Some((url, dest, headers))
                    })
                    .collect();
                if !files.is_empty() {
                    download_batch(&h_g, &mgr_g, files, Some("download-files")).await?;
                }
                Ok(())
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
                    let dest = modpack_target_path(
                        &gd_g,
                        &vdn_g,
                        version_isolation,
                        &format!("mods/{filename}"),
                    );
                    let (download_url, headers) =
                        mirror_mod_url(download_url.to_string(), cf_api_key, file_download_source);
                    files.push((download_url, dest, headers));
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
                Ok(())
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
                if !files.is_empty() {
                    download_batch(&h_g, &mgr_g, files, Some("download-files")).await?;
                }
                Ok(())
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
                let mut placeholder_fids: Vec<i64> = Vec::new();
                for f in &p.files {
                    if let Some(url) = f.download_url.as_deref() {
                        if url.is_empty() {
                            continue;
                        }
                        let dest = modpack_target_path(&gd_g, &vdn_g, version_isolation, &f.path);
                        let (u, h) =
                            mirror_mod_url(url.to_string(), cf_api_key, file_download_source);
                        files.push((u, dest, h));
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
                        let dest = modpack_target_path(
                            &gd_g,
                            &vdn_g,
                            version_isolation,
                            &format!("mods/{filename}"),
                        );
                        let (download_url, headers) = mirror_mod_url(
                            download_url.to_string(),
                            cf_api_key,
                            file_download_source,
                        );
                        files.push((download_url, dest, headers));
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
                Ok(())
            }
            _ => Ok(()),
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
    res_g?;
    res_o?;

    handle.update(|f| {
        f.set_status(InstallStatus::Finishing);
        f.stage = "finishing".to_string();
        f.current_file = "整合包安装完成".to_string();
    });
    Ok(())
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
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;
    let mut has_mr = false;
    let mut has_cf = false;
    let mut has_qml = false;
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
            "qmodpack.index.json" => has_qml = true,
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

    use super::{modpack_target_path, release_qml_overrides};

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
}
