//! 整合包原地更新 —— 检查与预览（issue #118，方案 C）。
//!
//! 本模块**只读**：不修改实例文件，只回答「能不能更新」「有哪些更新」
//! 「更新会改什么」。真正的执行在后续阶段（暂存 + 备份 + journal 回滚）。
//!
//! ## 资格判定（任一不满足 → `eligible: false` + 原因码）
//!
//! 1. `modpack_origin == "resource-center"`：只有资源中心在线安装的实例可更新，
//!    手动导入/拖入/MultiMC 一律不可（issue 明确要求）；
//! 2. `modpack_source` 为 modrinth / curseforge：平台版本列表可查；
//! 3. 记录里有 `project_id` 与 `version_id`：更新的身份标识；
//! 4. 启用版本隔离：非隔离实例会改到共享目录、波及其他实例；
//! 5. 托管文件清单存在且可解析：没有基线就无法安全地 diff 与回滚。
//!
//! ## 为什么用「平台 id 定身份、datePublished 定先后」
//!
//! 版本名/`versionNumber` 在 CurseForge 上就是文件名，且平台返回的列表
//! **不保证有序**；版本名也可能被作者改动。只有平台 id 是稳定身份、
//! `datePublished` 才反映先后。`datePublished` 缺失/非法的版本不参与
//! 「更新」判定（宁可漏报，不可乱报）。

use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::instance::GameInstance;
use crate::services::modpack_manifest::{self, ModpackManifest};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/instance/{id}/modpack/update-check", get(update_check))
        .route(
            "/instance/{id}/modpack/update-preview",
            post(update_preview),
        )
}

// =====================================================================
// DTO
// =====================================================================

/// 不可更新的原因码（前端据此显示本地化文案）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NotEligibleReason {
    /// 非资源中心安装（手动导入/拖入/MultiMC/install-direct）。
    NotResourceCenter,
    /// 来源平台不支持（如 ftb / qml）。
    UnsupportedSource,
    /// 缺少项目 id 或版本 id。
    MissingIdentity,
    /// 未启用版本隔离。
    NotVersionIsolated,
    /// 托管文件清单缺失或损坏（旧实例，安装时尚未引入清单）。
    MissingManifest,
}

/// 一个可更新到的候选版本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidate {
    pub version_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    /// 该候选是否变更 Minecraft 版本（前端需显式标记 + 更强警告）。
    pub changes_game_version: bool,
    /// 该候选是否变更加载器类型。
    pub changes_loader: bool,
}

/// 当前已安装版本的信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentVersion {
    pub version_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    /// 当前版本是否仍存在于平台版本列表中（被删除时为 false，用记录里的时间兜底）。
    pub present_on_platform: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResponse {
    pub eligible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<NotEligibleReason>,
    pub current: Option<CurrentVersion>,
    pub updates: Vec<UpdateCandidate>,
    /// 平台版本列表是否可能缺项（CF 分页失败）。为 true 时「没有更新」不可信，
    /// 前端必须提示用户。
    pub incomplete: bool,
}

// =====================================================================
// 资格判定
// =====================================================================

/// 判定实例是否可原地更新。返回 `Ok(())` 或原因码。
fn eligibility(
    inst: &GameInstance,
    manifest: Option<&ModpackManifest>,
) -> Result<(), NotEligibleReason> {
    let origin_ok = inst
        .modpack_origin
        .as_deref()
        .is_some_and(|o| o == "resource-center");
    if !origin_ok {
        return Err(NotEligibleReason::NotResourceCenter);
    }
    let source = inst
        .modpack_source
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(source.as_str(), "modrinth" | "curseforge") {
        return Err(NotEligibleReason::UnsupportedSource);
    }
    let has_ids = inst
        .modpack_project_id
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
        && inst
            .modpack_version_id
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
    if !has_ids {
        return Err(NotEligibleReason::MissingIdentity);
    }
    if !inst
        .version_isolation
        .unwrap_or_else(crate::settings::get_global_version_isolation)
    {
        return Err(NotEligibleReason::NotVersionIsolated);
    }
    if manifest.is_none() {
        return Err(NotEligibleReason::MissingManifest);
    }
    Ok(())
}

// =====================================================================
// Handlers
// =====================================================================

/// GET /instance/{id}/modpack/update-check
async fn update_check(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<UpdateCheckResponse>> {
    let inst = state
        .instance
        .get_by_id(&id)
        .ok_or_else(|| ApiError::not_found("INSTANCE_NOT_FOUND", format!("实例 {id} 不存在")))?;

    let manifest = modpack_manifest::load_manifest(&inst.game_dir, &inst.name);
    if let Err(reason) = eligibility(&inst, manifest.as_ref()) {
        return Ok(Json(UpdateCheckResponse {
            eligible: false,
            reason: Some(reason),
            current: None,
            updates: vec![],
            incomplete: false,
        }));
    }

    let source = inst
        .modpack_source
        .clone()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let project_id = inst.modpack_project_id.clone().unwrap_or_default();
    let current_version_id = inst.modpack_version_id.clone().unwrap_or_default();

    // 拉取全量版本列表（不按 MC/加载器过滤，才能判断候选是否变更了它们）。
    let (versions, incomplete) = match source.as_str() {
        "modrinth" => {
            let mr = state.core.create_modrinth_source();
            let list = mr
                .get_project_version_info(&project_id)
                .await
                .map_err(|e| ApiError::upstream(e.to_string()))?;
            let dtos = list
                .iter()
                .map(|v| crate::endpoints::resource_center::ResourceVersionDto {
                    id: v.id.clone(),
                    name: v.name.clone(),
                    version_number: v.version_number.clone().unwrap_or_else(|| v.name.clone()),
                    game_versions: v.game_version_ids.clone().unwrap_or_default(),
                    loaders: v.loaders.clone().unwrap_or_default(),
                    downloads: vec![],
                    dependencies: None,
                    date_published: Some(v.published_at.clone()),
                })
                .collect::<Vec<_>>();
            (dtos, false)
        }
        "curseforge" => {
            let cf = resource_center_versions_all(&state, &project_id).await;
            (cf.0, cf.1)
        }
        _ => (vec![], false),
    };

    // 按发布时间排序（缺失/非法的排在最后，且不参与「更新」判定）。
    let mut with_time: Vec<(i64, &crate::endpoints::resource_center::ResourceVersionDto)> =
        versions
            .iter()
            .filter_map(|v| parse_published(v.date_published.as_deref()).map(|t| (t, v)))
            .collect();
    with_time.sort_by_key(|(t, _)| *t);

    // 当前版本发布时间：优先在列表中按 id 查；当前版本已被平台删除时回退到记录值。
    let current_in_list = with_time
        .iter()
        .find(|(_, v)| v.id == current_version_id)
        .map(|(t, v)| (*t, (*v).clone()));
    let current_published = match &current_in_list {
        Some((t, _)) => Some(*t),
        None => parse_published(inst.modpack_version_published_at.as_deref()),
    };
    let current = CurrentVersion {
        version_id: current_version_id.clone(),
        name: inst.modpack_version.clone(),
        published_at: current_published.map(ts_to_rfc3339),
        present_on_platform: current_in_list.is_some(),
    };

    // 候选 = 发布时间严格晚于当前版本的所有版本。
    let current_game = inst.game_version.clone();
    let current_loader = inst.loader.clone().unwrap_or_default().to_ascii_lowercase();
    let updates: Vec<UpdateCandidate> = match current_published {
        Some(cur_ts) => with_time
            .iter()
            .filter(|(t, _)| *t > cur_ts)
            .map(|(_, v)| {
                let gv = v.game_versions.clone();
                let loaders = v.loaders.clone();
                // 变更判定：候选声明的 MC 版本里不含当前 MC → 视为变更。
                let changes_game_version = !gv.is_empty() && !gv.iter().any(|g| g == &current_game);
                let changes_loader = !loaders.is_empty()
                    && !loaders.iter().any(|l| {
                        l.to_ascii_lowercase() == current_loader || current_loader.is_empty()
                    });
                UpdateCandidate {
                    version_id: v.id.clone(),
                    name: if v.version_number.is_empty() {
                        v.name.clone()
                    } else {
                        v.version_number.clone()
                    },
                    published_at: v.date_published.clone(),
                    game_versions: gv,
                    loaders,
                    changes_game_version,
                    changes_loader,
                }
            })
            .collect(),
        // 当前版本发布时间不可知 → 无法判定先后，返回空列表并标记不完整，
        // 让前端提示「无法确定是否有更新」而不是谎报「已是最新」。
        None => {
            return Ok(Json(UpdateCheckResponse {
                eligible: true,
                reason: None,
                current: Some(current),
                updates: vec![],
                incomplete: true,
            }))
        }
    };

    Ok(Json(UpdateCheckResponse {
        eligible: true,
        reason: None,
        current: Some(current),
        updates,
        incomplete,
    }))
}

/// 解析 RFC3339 发布时间为 epoch 秒。非法/缺失 → None（不参与排序与判定）。
fn parse_published(raw: Option<&str>) -> Option<i64> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

fn ts_to_rfc3339(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// 取 CF 全量版本列表（复用 resource_center 的服务与缓存）。
async fn resource_center_versions_all(
    state: &SharedState,
    project_id: &str,
) -> (
    Vec<crate::endpoints::resource_center::ResourceVersionDto>,
    bool,
) {
    if state.curse_forge_api_key.is_empty() {
        return (vec![], true);
    }
    let res = crate::endpoints::resource_center::cf_versions_all(
        &state.http_client,
        &state.curseforge_fetch,
        project_id,
        &state.curse_forge_api_key,
    )
    .await;
    (res.versions, res.incomplete)
}

// =====================================================================
// 更新预览（差异规划）
// =====================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreviewRequest {
    pub target_version_id: String,
}

/// 单类变更的文件条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub path: String,
    /// 变更原因（i18n 由前端映射）。
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreviewResponse {
    pub added: Vec<ChangeEntry>,
    pub updated: Vec<ChangeEntry>,
    /// 磁盘哈希 ≠ 清单哈希（用户改过），更新时会**先备份再覆盖**。
    pub locally_modified: Vec<ChangeEntry>,
    pub removed: Vec<ChangeEntry>,
    /// 新包已移除但用户改过 → **保留**，不删除。
    pub kept_modified: Vec<ChangeEntry>,
    pub changes_game_version: bool,
    pub changes_loader: bool,
}

async fn update_preview(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<UpdatePreviewRequest>,
) -> ApiResult<Json<UpdatePreviewResponse>> {
    let inst = state
        .instance
        .get_by_id(&id)
        .ok_or_else(|| ApiError::not_found("INSTANCE_NOT_FOUND", format!("实例 {id} 不存在")))?;
    let manifest = modpack_manifest::load_manifest(&inst.game_dir, &inst.name);
    if let Err(reason) = eligibility(&inst, manifest.as_ref()) {
        return Err(ApiError::bad_request(
            "MODPACK_NOT_UPDATABLE",
            format!("该实例不可原地更新: {reason:?}"),
        ));
    }
    let manifest = manifest.expect("eligibility 已确认清单存在");
    if req.target_version_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "MODPACK_TARGET_REQUIRED",
            "targetVersionId 不能为空",
        ));
    }

    // 目标版本与当前版本相同 → 无需更新（也避免把自己当基线 diff 出全量「新增」）。
    if req.target_version_id == manifest.origin.version_id.clone().unwrap_or_default() {
        return Err(ApiError::bad_request(
            "MODPACK_ALREADY_TARGET",
            "目标版本与当前版本相同",
        ));
    }

    // 计算目标版本的文件计划（复用安装管道的解析逻辑）。
    let target = resolve_target_plan(&state, &inst, &req.target_version_id).await?;

    let instance_dir = modpack_manifest::instance_version_dir(&inst.game_dir, &inst.name);
    let old_files: std::collections::HashMap<String, String> = manifest
        .files
        .iter()
        .map(|f| (f.path.clone(), f.sha1.clone()))
        .collect();

    let plan = plan_changes(
        &instance_dir,
        &old_files,
        &target.files,
        &target.game_version,
        &inst.game_version,
        &target.loader,
        inst.loader.as_deref(),
    );
    Ok(Json(plan))
}

/// 目标版本的文件计划（相对路径列表 + 版本信息）。
struct TargetPlan {
    files: Vec<String>,
    game_version: String,
    loader: String,
}

/// 解析目标版本，返回其文件相对路径计划与 MC/加载器信息。
async fn resolve_target_plan(
    state: &SharedState,
    inst: &GameInstance,
    target_version_id: &str,
) -> ApiResult<TargetPlan> {
    let source = inst
        .modpack_source
        .clone()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let project_id = inst.modpack_project_id.clone().unwrap_or_default();

    match source.as_str() {
        "modrinth" => {
            let mr = state.core.create_modrinth_source();
            let version = mr
                .get_version_info(target_version_id)
                .await
                .map_err(|e| ApiError::upstream(e.to_string()))?;
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

            // mrpack 的文件计划要下包体解析 modrinth.index.json；预览阶段只统计
            // 「路径集合」，包体解析与哈希校对在执行阶段完成。
            let files = mrpack_file_paths(state, target_version_id).await?;
            Ok(TargetPlan {
                files,
                game_version,
                loader,
            })
        }
        "curseforge" => {
            // CF：manifest.json 里的 files[] 是 projectID:fileID 引用，需下包体解析。
            let files = cfpack_file_paths(state, &project_id, target_version_id).await?;
            // MC/加载器从文件列表无法得知，交由包体 manifest 解析（执行阶段）。
            Ok(TargetPlan {
                files,
                game_version: String::new(),
                loader: String::new(),
            })
        }
        _ => Err(ApiError::bad_request(
            "MODPACK_SOURCE_UNSUPPORTED",
            "该来源不支持原地更新",
        )),
    }
}

/// 下载目标 mrpack 并读出 `modrinth.index.json` 的文件路径集合。
async fn mrpack_file_paths(state: &SharedState, target_version_id: &str) -> ApiResult<Vec<String>> {
    let mr = state.core.create_modrinth_source();
    let version = mr
        .get_version_info(target_version_id)
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let url = version
        .files
        .as_deref()
        .and_then(|f| f.first())
        .map(|f| f.download_url.clone())
        .filter(|u| !u.is_empty())
        .ok_or_else(|| {
            ApiError::bad_request("MODPACK_NO_DOWNLOAD", "目标版本没有可用的下载链接")
        })?;
    let index = download_and_read_zip_entry(state, &url, "modrinth.index.json").await?;
    Ok(parse_mr_index_paths(&index))
}

/// 下载目标 CF 包体并读出 `manifest.json` 的文件路径（无法预知 CF 文件名，
/// 预览阶段只返回占位集合的规模；执行阶段由 CF API 反查真实路径）。
async fn cfpack_file_paths(
    state: &SharedState,
    project_id: &str,
    version_id: &str,
) -> ApiResult<Vec<String>> {
    let url = cf_file_download_url(state, project_id, version_id).await?;
    let manifest = download_and_read_zip_entry(state, &url, "manifest.json").await?;
    let fids = parse_cf_manifest_file_ids(&manifest);
    // path 用 "projectID:fileID" 占位（与安装管道同一约定）；执行阶段反查为真实文件名。
    Ok(fids)
}

/// 查 CF 某版本文件的下载链接。
///
/// 用 `get_files_batch` 而非 `get_file_info`：后者返回的
/// `CurseForgeFileInfo` **不含 downloadUrl**（字段只到 fileLength/status），
/// 批量接口的 `CurseForgeBatchFileInfo` 才带 `download_url`。
async fn cf_file_download_url(
    state: &SharedState,
    _project_id: &str,
    version_id: &str,
) -> ApiResult<String> {
    let file_id: i64 = version_id
        .parse()
        .map_err(|_| ApiError::bad_request("MODPACK_CF_FILE_ID_INVALID", "CF 文件 id 非法"))?;
    if state.curse_forge_api_key.is_empty() {
        return Err(ApiError::upstream("缺少 CurseForge API Key"));
    }
    let cf = state
        .core
        .create_curseforge_source(&state.curse_forge_api_key);
    let map = cf
        .get_files_batch(&[file_id])
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    map.get(&file_id)
        .and_then(|i| i.download_url.clone())
        .filter(|u| !u.is_empty())
        .ok_or_else(|| ApiError::bad_request("MODPACK_NO_DOWNLOAD", "该 CF 版本没有下载链接"))
}

/// 下载 zip 到临时文件并读取其中一个条目的文本内容。
async fn download_and_read_zip_entry(
    state: &SharedState,
    url: &str,
    entry: &str,
) -> ApiResult<String> {
    let bytes = state
        .http_client
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError::upstream(format!("下载整合包失败: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError::upstream(format!("下载整合包失败: {e}")))?
        .bytes()
        .await
        .map_err(|e| ApiError::upstream(format!("读取整合包失败: {e}")))?;

    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| {
        ApiError::bad_request("MODPACK_BAD_ARCHIVE", format!("不是有效的 zip: {e}"))
    })?;
    // 大小写不敏感查找（打包工具大小写不一）。
    let mut found = None;
    for i in 0..archive.len() {
        let f = archive
            .by_index(i)
            .map_err(|e| ApiError::internal(format!("读取 zip 条目失败: {e}")))?;
        if f.name().eq_ignore_ascii_case(entry) {
            found = Some(i);
            break;
        }
    }
    let idx = found.ok_or_else(|| {
        ApiError::bad_request("MODPACK_INDEX_MISSING", format!("整合包内缺少 {entry}"))
    })?;
    let mut f = archive
        .by_index(idx)
        .map_err(|e| ApiError::internal(format!("读取 zip 条目失败: {e}")))?;
    let mut out = String::new();
    use std::io::Read as _;
    f.read_to_string(&mut out)
        .map_err(|e| ApiError::internal(format!("读取 {entry} 失败: {e}")))?;
    Ok(out)
}

/// 从 modrinth.index.json 取 files[].path。
fn parse_mr_index_paths(index: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(index) else {
        return vec![];
    };
    v.get("files")
        .and_then(|f| f.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| f.get("path").and_then(|p| p.as_str()))
                .filter(|p| modpack_manifest::is_safe_rel_path(p))
                .map(|p| modpack_manifest::normalize_rel_path(p))
                .collect()
        })
        .unwrap_or_default()
}

/// 从 CF manifest.json 取 files[] 的 `projectID:fileID` 占位路径。
fn parse_cf_manifest_file_ids(manifest: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(manifest) else {
        return vec![];
    };
    v.get("files")
        .and_then(|f| f.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let p = f.get("projectID").and_then(|x| x.as_i64())?;
                    let fid = f.get("fileID").and_then(|x| x.as_i64())?;
                    // 可选条目（required: false）默认不更新，与安装语义一致。
                    let required = f.get("required").and_then(|r| r.as_bool()).unwrap_or(true);
                    if !required {
                        return None;
                    }
                    Some(format!("{p}:{fid}"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 差异规划（纯函数，便于单测）。
///
/// 五分类，与 issue #118 的设计决策一一对应：
/// - `added`：新包有、旧清单没有；
/// - `updated`：两边都有（需要重新下载覆盖）；
/// - `locally_modified`：两边都有**且磁盘哈希 ≠ 清单哈希**（用户改过，覆盖前先备份）；
/// - `removed`：旧清单有、新包没有，且磁盘未被用户改过；
/// - `kept_modified`：旧清单有、新包没有，但磁盘被改过 → **保留**，绝不删除。
///
/// `saves/` 一律排除；不在清单中的文件一律不动。
fn plan_changes(
    instance_dir: &std::path::Path,
    old_files: &std::collections::HashMap<String, String>,
    target_files: &[String],
    target_game_version: &str,
    current_game_version: &str,
    target_loader: &str,
    current_loader: Option<&str>,
) -> UpdatePreviewResponse {
    let mut added = Vec::new();
    let mut updated = Vec::new();
    let mut locally_modified = Vec::new();
    let mut removed = Vec::new();
    let mut kept_modified = Vec::new();

    let target_set: std::collections::HashSet<&String> = target_files.iter().collect();

    for path in target_files {
        if modpack_manifest::is_protected_path(path) || !modpack_manifest::is_safe_rel_path(path) {
            continue;
        }
        let rel = modpack_manifest::normalize_rel_path(path);
        match old_files.get(&rel) {
            None => added.push(ChangeEntry {
                path: rel,
                kind: "added",
            }),
            Some(old_sha) => {
                // 磁盘现状：哈希不等 → 用户改过。
                let on_disk = modpack_manifest::sha1_of(instance_dir, &rel);
                let user_modified = on_disk.as_deref() != Some(old_sha.as_str());
                if user_modified && on_disk.is_some() {
                    locally_modified.push(ChangeEntry {
                        path: rel,
                        kind: "locallyModified",
                    });
                } else {
                    updated.push(ChangeEntry {
                        path: rel,
                        kind: "updated",
                    });
                }
            }
        }
    }

    for (rel, old_sha) in old_files {
        if target_set.contains(rel)
            || modpack_manifest::is_protected_path(rel)
            || !modpack_manifest::is_safe_rel_path(rel)
        {
            continue;
        }
        let on_disk = modpack_manifest::sha1_of(instance_dir, rel);
        if on_disk.is_none() {
            // 磁盘上已不存在（用户删了）→ 无需删除。
            continue;
        }
        if on_disk.as_deref() != Some(old_sha.as_str()) {
            // 用户改过且新包已移除 → 保留。
            kept_modified.push(ChangeEntry {
                path: rel.clone(),
                kind: "keptModified",
            });
        } else {
            removed.push(ChangeEntry {
                path: rel.clone(),
                kind: "removed",
            });
        }
    }

    let changes_game_version = !target_game_version.is_empty()
        && !current_game_version.is_empty()
        && target_game_version != current_game_version;
    let changes_loader = !target_loader.is_empty()
        && !current_loader
            .unwrap_or_default()
            .eq_ignore_ascii_case(target_loader);

    UpdatePreviewResponse {
        added,
        updated,
        locally_modified,
        removed,
        kept_modified,
        changes_game_version,
        changes_loader,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qomicex-update-plan-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 五分类的核心语义：新增 / 更新 / 本地已改 / 删除 / 保留用户已改。
    /// 这是 issue #118「保护存档与用户改动」的唯一实现，必须逐类锁死。
    #[test]
    fn plan_changes_classifies_five_categories() {
        let dir = temp_dir("five");
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::create_dir_all(dir.join("saves/world")).unwrap();

        // 用户未改的旧文件（将被删除）
        std::fs::write(dir.join("mods/removed.jar"), b"old").unwrap();
        // 用户改过的旧文件（新包已移除 → 保留）
        std::fs::write(dir.join("config/user-edited.toml"), b"USER-EDIT").unwrap();
        // 用户改过的旧文件（新包仍包含 → 先备份再覆盖）
        std::fs::write(dir.join("config/edited-kept.toml"), b"USER-EDIT-2").unwrap();
        // 存档（永不触碰）
        std::fs::write(dir.join("saves/world/level.dat"), b"world").unwrap();

        let sha =
            |rel: &str| crate::services::modpack_export::sha1_file_hex(&dir.join(rel)).unwrap();
        let mut old_files = HashMap::new();
        old_files.insert("mods/removed.jar".to_string(), sha("mods/removed.jar"));
        // 清单里记录的是「安装时」的哈希，与用户改后的磁盘值不同
        old_files.insert(
            "config/user-edited.toml".to_string(),
            "0000000000000000000000000000000000000000".to_string(),
        );
        old_files.insert(
            "config/edited-kept.toml".to_string(),
            "1111111111111111111111111111111111111111".to_string(),
        );
        old_files.insert(
            "mods/unchanged-not-in-target.jar".to_string(),
            "x".to_string(),
        );

        let target = vec![
            "mods/new.jar".to_string(),            // 新增
            "config/edited-kept.toml".to_string(), // 旧清单有 + 用户改过 → locally_modified
            "saves/world/level.dat".to_string(),   // 存档 → 必须被排除
        ];

        let plan = plan_changes(
            &dir,
            &old_files,
            &target,
            "1.21.0", // target MC
            "1.20.1", // current MC
            "neoforge",
            Some("forge"),
        );

        let paths = |v: &Vec<ChangeEntry>| v.iter().map(|e| e.path.clone()).collect::<Vec<_>>();

        assert_eq!(paths(&plan.added), vec!["mods/new.jar"]);
        assert_eq!(
            paths(&plan.locally_modified),
            vec!["config/edited-kept.toml"]
        );
        assert_eq!(paths(&plan.removed), vec!["mods/removed.jar"]);
        assert_eq!(paths(&plan.kept_modified), vec!["config/user-edited.toml"]);
        // 存档绝不能出现在任何一类里
        let all: Vec<String> = [
            &plan.added,
            &plan.updated,
            &plan.locally_modified,
            &plan.removed,
            &plan.kept_modified,
        ]
        .iter()
        .flat_map(|v| v.iter().map(|e| e.path.clone()))
        .collect();
        assert!(
            !all.iter().any(|p| p.starts_with("saves/")),
            "存档不得出现在任何变更类别: {all:?}"
        );
        // 跨版本被识别
        assert!(plan.changes_game_version);
        assert!(plan.changes_loader);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 磁盘上已被用户删除的旧文件不应产生「删除」条目（无文件可删）。
    #[test]
    fn plan_changes_skips_already_missing_files() {
        let dir = temp_dir("missing");
        std::fs::create_dir_all(&dir).unwrap();
        let mut old_files = HashMap::new();
        old_files.insert("mods/gone.jar".to_string(), "deadbeef".to_string());

        let plan = plan_changes(&dir, &old_files, &[], "", "", "", None);
        assert!(plan.removed.is_empty(), "不存在的文件不应被列为删除");
        assert!(plan.kept_modified.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 非法路径（逃逸）与存档都不得进入计划。
    #[test]
    fn plan_changes_rejects_unsafe_and_protected_paths() {
        let dir = temp_dir("unsafe");
        std::fs::create_dir_all(&dir).unwrap();
        let target = vec![
            "../escape.jar".to_string(),
            "/etc/passwd".to_string(),
            "saves/w.dat".to_string(),
            "mods/ok.jar".to_string(),
        ];
        let plan = plan_changes(&dir, &HashMap::new(), &target, "", "", "", None);
        let all: Vec<String> = plan.added.iter().map(|e| e.path.clone()).collect();
        assert_eq!(all, vec!["mods/ok.jar"], "非法/存档路径应被排除: {all:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_mr_index_paths_reads_and_normalizes() {
        let index = r#"{"files":[
            {"path":"mods\\win.jar"},
            {"path":"config/a.toml"},
            {"path":"../escape.jar"},
            {"nopath":1}
        ]}"#;
        let paths = parse_mr_index_paths(index);
        assert_eq!(paths, vec!["mods/win.jar", "config/a.toml"]);
    }

    #[test]
    fn parse_cf_manifest_skips_optional() {
        let manifest = r#"{"files":[
            {"projectID":1,"fileID":2,"required":true},
            {"projectID":3,"fileID":4,"required":false},
            {"projectID":5,"fileID":6}
        ]}"#;
        let ids = parse_cf_manifest_file_ids(manifest);
        assert_eq!(ids, vec!["1:2", "5:6"], "可选条目不应进入更新计划");
    }

    #[test]
    fn parse_published_rejects_invalid() {
        assert!(parse_published(None).is_none());
        assert!(parse_published(Some("")).is_none());
        assert!(parse_published(Some("  ")).is_none());
        assert!(parse_published(Some("not-a-date")).is_none());
        assert!(parse_published(Some("2026-01-01T00:00:00Z")).is_some());
    }
}
