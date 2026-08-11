//! Instance files endpoints (source: Endpoints/InstanceFilesEndpoints.cs).
//!
//! Provides per-instance local file management for a single instance's
//! category directories (mods, resourcepacks, shaderpacks, datapacks,
//! screenshots, saves) plus metadata enumeration. Path resolution follows the
//! version-isolation rules in AGENTS.md: isolated categories live under
//! `{gameDir}/versions/{inst.Name}/{sub}`, otherwise directly under
//! `{gameDir}/{sub}`.
//!
//! NOT YET PORTED (501 placeholders):
//! - Upload/multipart: the C# source file has NO upload routes, so none are
//!   declared here.
//! - Servers / server-ping / lan-games: rely on a per-instance ServerManager
//!   (the core exposes a singleton only), left as 501.
//! - Options: rely on a per-instance OptionsProvider, left as 501.
//! - mcmod Chinese-name lookup in mods/metadata: McmodService has no Rust peer
//!   yet, that enrichment is skipped (see TODO in mods_metadata).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::settings;
use crate::state::SharedState;

// =====================================================================
// DTO (matching Models/InstanceFilesDtos.cs, camelCase)
// =====================================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModLoadProgressDto {
    current: i32,
    total: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntryDto {
    name: String,
    size: i64,
    last_modified: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<String>,
    is_directory: bool,
    extension: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModMetadataDto {
    file_name: String,
    name: String,
    version: String,
    description: String,
    authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_id: Option<String>,
    /// Modrinth 版本（文件）id（enrich 反查后填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_version_id: Option<String>,
    /// CurseForge 文件 id（enrich 反查后填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_file_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mcmod_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chinese_name: Option<String>,
    active: bool,
    file_size: i64,
    last_modified: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcePackMetadataDto {
    file_name: String,
    name: String,
    description: String,
    version: String,
    pack_format: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShaderMetadataDto {
    file_name: String,
    name: String,
    description: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataPackMetadataDto {
    file_name: String,
    name: String,
    description: String,
    version: String,
    pack_format: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotMetadataDto {
    file_name: String,
    file_path: String,
    created_at: String,
    file_size: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveMetadataDto {
    name: String,
    file_path: String,
    last_played: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_base64: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveCopyRequest {
    name: String,
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRenameRequest {
    old_name: String,
    new_name: String,
}

#[derive(Deserialize, Default)]
struct NameQuery {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize, Default)]
struct CategoryQuery {
    #[serde(default)]
    category: Option<String>,
}

// =====================================================================
// In-memory mod-load progress store (C# ModLoadProgressStore)
// =====================================================================

static MOD_PROGRESS: LazyLock<Mutex<HashMap<String, ModLoadProgressDto>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn set_progress(id: &str, current: i32, total: i32) {
    if let Ok(mut m) = MOD_PROGRESS.lock() {
        m.insert(id.to_string(), ModLoadProgressDto { current, total });
    }
}

fn remove_progress(id: &str) {
    if let Ok(mut m) = MOD_PROGRESS.lock() {
        m.remove(id);
    }
}

// =====================================================================
// Router (C# MapGroup prefix is "/api/instance/{id}/files")
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        // mods
        .route("/instance/{id}/files/mods", get(list_mods))
        .route("/instance/{id}/files/mods/count", get(mods_count))
        .route("/instance/{id}/files/mods/progress", get(mods_progress))
        .route("/instance/{id}/files/installed-names", get(installed_names))
        .route("/instance/{id}/files/mods/metadata", get(mods_metadata))
        .route("/instance/{id}/files/mods/enrich", post(mods_enrich))
        .route("/instance/{id}/files/mods/enable", post(enable_mod))
        .route("/instance/{id}/files/mods/disable", post(disable_mod))
        .route(
            "/instance/{id}/files/mods/batch-enable",
            post(batch_enable_mods),
        )
        .route(
            "/instance/{id}/files/mods/batch-disable",
            post(batch_disable_mods),
        )
        .route(
            "/instance/{id}/files/mods/batch-delete",
            post(batch_delete_mods),
        )
        .route("/instance/{id}/files/mods", delete(delete_mod))
        // resourcepacks
        .route(
            "/instance/{id}/files/resourcepacks",
            get(list_resourcepacks),
        )
        .route(
            "/instance/{id}/files/resourcepacks/metadata",
            get(resourcepacks_metadata),
        )
        .route(
            "/instance/{id}/files/resourcepacks",
            delete(delete_resourcepack),
        )
        // shaderpacks
        .route("/instance/{id}/files/shaderpacks", get(list_shaderpacks))
        .route(
            "/instance/{id}/files/shaderpacks/metadata",
            get(shaderpacks_metadata),
        )
        .route(
            "/instance/{id}/files/shaderpacks",
            delete(delete_shaderpack),
        )
        // datapacks
        .route("/instance/{id}/files/datapacks", get(list_datapacks))
        .route(
            "/instance/{id}/files/datapacks/metadata",
            get(datapacks_metadata),
        )
        .route("/instance/{id}/files/datapacks", delete(delete_datapack))
        // screenshots
        .route(
            "/instance/{id}/files/screenshots",
            get(list_screenshots),
        )
        .route(
            "/instance/{id}/files/screenshots/metadata",
            get(screenshots_metadata),
        )
        .route(
            "/instance/{id}/files/screenshots/{fileName}",
            get(get_screenshot),
        )
        .route(
            "/instance/{id}/files/screenshots",
            delete(delete_screenshot),
        )
        // saves
        .route("/instance/{id}/files/saves", get(list_saves))
        .route("/instance/{id}/files/saves/metadata", get(saves_metadata))
        .route("/instance/{id}/files/saves/copy", post(copy_save))
        .route("/instance/{id}/files/saves/rename", post(rename_save))
        .route("/instance/{id}/files/saves/backup", post(backup_save))
        .route("/instance/{id}/files/saves", delete(delete_save))
        // servers (stubs; rely on a not-yet-portable per-instance ServerManager)
        .route(
            "/instance/{id}/files/servers",
            get(servers_501).post(servers_501),
        )
        .route(
            "/instance/{id}/files/servers",
            delete(servers_delete_501),
        )
        .route("/instance/{id}/files/server-ping", get(server_ping_501))
        .route("/instance/{id}/files/lan-games", get(lan_games_501))
        // options (stubs; rely on a not-yet-portable per-instance OptionsProvider)
        .route("/instance/{id}/files/options", get(options_list_501))
        .route(
            "/instance/{id}/files/options/{name}",
            get(options_get_501).put(options_put_501),
        )
}

// =====================================================================
// Path resolution
// =====================================================================

struct Resolved {
    game_dir: PathBuf,
    version: String,
    isolated: bool,
}

fn resolve(id: &str, state: &crate::state::AppState) -> ApiResult<Resolved> {
    let inst = state
        .instance
        .get_by_id(id)
        .ok_or_else(|| instance_not_found(id))?;
    let isolated = inst
        .version_isolation
        .unwrap_or_else(settings::get_global_version_isolation);
    // When isolated, base on the game root (C# GetCategoryDir appends
    // versions/{version}). When not isolated, use the resolved game dir which
    // may already point at versions/{name}.
    let base = if isolated {
        PathBuf::from(&inst.game_dir)
    } else {
        PathBuf::from(
            inst.resolved_game_dir
                .clone()
                .unwrap_or_else(|| inst.game_dir.clone()),
        )
    };
    Ok(Resolved {
        game_dir: to_absolute(&base),
        version: inst.name,
        isolated,
    })
}

/// Syntactic absolute-path resolution (C# Path.GetFullPath). Does not follow
/// symlinks, so it tolerates targets that do not exist yet.
fn to_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else if let Ok(cwd) = std::env::current_dir() {
        cwd.join(path)
    } else {
        path.to_path_buf()
    }
}

/// Resolve the category directory, creating it if missing (C# GetCategoryDir).
fn category_dir(r: &Resolved, sub: &str) -> PathBuf {
    let full = if r.isolated {
        r.game_dir.join("versions").join(&r.version).join(sub)
    } else {
        r.game_dir.join(sub)
    };
    let _ = std::fs::create_dir_all(&full);
    full
}

/// Enumerate a category directory into FileEntryDto (directories first, then
/// files), mirroring C# GetFileEntries.
fn file_entries(dir: &Path) -> Vec<FileEntryDto> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut entries = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let file_type = match e.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                entries.push(FileEntryDto {
                    name: e.file_name().to_string_lossy().into_owned(),
                    size: 0,
                    last_modified: fmt_epoch(),
                    created: None,
                    is_directory: true,
                    extension: String::new(),
                });
            } else if file_type.is_file() {
                let (size, last_modified) = match e.metadata() {
                    Ok(m) => (
                        m.len() as i64,
                        fmt_time(m.modified().unwrap_or(std::time::UNIX_EPOCH)),
                    ),
                    Err(_) => (0, fmt_epoch()),
                };
                let name = e.file_name().to_string_lossy().into_owned();
                let ext = Path::new(&name)
                    .extension()
                    .map(|x| x.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                entries.push(FileEntryDto {
                    name,
                    size,
                    last_modified,
                    created: None,
                    is_directory: false,
                    extension: ext,
                });
            }
        }
    }
    entries
}

fn fmt_time(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.to_rfc3339()
}

fn fmt_epoch() -> String {
    fmt_time(std::time::UNIX_EPOCH)
}

fn count_children(dir: &Path, ext: &str) -> i64 {
    if !dir.is_dir() {
        return 0;
    }
    let mut n = 0i64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            if e.file_type().map(|t| t.is_file()).unwrap_or(false)
                && Path::new(&e.file_name())
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case(ext))
            {
                n += 1;
            }
        }
    }
    n
}

// =====================================================================
// Handlers: mods
// =====================================================================

async fn list_mods(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FileEntryDto>>> {
    let r = resolve(&id, &state)?;
    Ok(Json(file_entries(&category_dir(&r, "mods"))))
}

async fn mods_count(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<i64>> {
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, "mods");
    Ok(Json(count_children(&dir, "jar") + count_children(&dir, "disabled")))
}

async fn mods_progress(
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<Option<ModLoadProgressDto>>> {
    let p = MOD_PROGRESS.lock().ok().and_then(|m| m.get(&id).cloned());
    Ok(Json(p))
}

async fn installed_names(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<CategoryQuery>,
) -> ApiResult<Json<Vec<String>>> {
    let r = resolve(&id, &state)?;
    let cat = match q
        .category
        .as_deref()
        .unwrap_or("mods")
        .to_ascii_lowercase()
        .as_str()
    {
        "resourcepacks" | "resourcepack" => "resourcepacks",
        "shaderpacks" | "shader" => "shaderpacks",
        "datapacks" | "datapack" => "datapacks",
        "saves" | "save" => "saves",
        "screenshots" => "screenshots",
        _ => "mods",
    };
    let dir = category_dir(&r, cat);
    let mut names: Vec<String> = if dir.is_dir() {
        std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    names.sort();
    Ok(Json(names))
}

async fn mods_metadata(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Response> {
    let r = resolve(&id, &state)?;
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&r.version, r.isolated, &state.curse_forge_api_key);
    set_progress(&id, 0, 0);
    // 列表展示用 light 扫描（本地扫描 + 元数据解析，秒级）：MR/CF 网络反查（mr/cf id、图标）
    // 会让 180+ mods 的请求耗时 20-50s，远超前端 15s 全局请求超时 → mod 列表永远显示不出来。
    // id 反查由 ModUpdateDialog 的 checkModUpdates 端点按需进行。
    let list = mods
        .get_mod_list_light()
        .await
        .map_err(map_core_error)?;
    remove_progress(&id);

    let mut result: Vec<ModMetadataDto> = map_mod_dtos(&list);

    fill_remote_icons(&state.http_client, &state.curse_forge_api_key, &mut result).await;

    Ok(Json(result).into_response())
}

/// ModInfo → ModMetadataDto 映射（mods_metadata 与 mods_enrich 共用）。
fn map_mod_dtos(list: &[qomicex_core::models::expansion::local::ModInfo]) -> Vec<ModMetadataDto> {
    list.iter()
        .map(|m| {
            let source = if m.curse_forge_id > 0 {
                Some("curseforge".to_string())
            } else if !m.modrinth_id.is_empty() {
                Some("modrinth".to_string())
            } else {
                None
            };
            let path = Path::new(&m.file_path);
            let (file_size, last_modified) = match std::fs::metadata(path) {
                Ok(md) => (
                    md.len() as i64,
                    fmt_time(md.modified().unwrap_or(std::time::UNIX_EPOCH)),
                ),
                Err(_) => (0, fmt_epoch()),
            };
            ModMetadataDto {
                file_name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                name: m.name.clone(),
                version: m.version.clone(),
                description: m.description.clone(),
                authors: m.authors.clone(),
                icon_url: None,
                icon_base64: opt_nonempty(&m.icon),
                curse_forge_id: if m.curse_forge_id > 0 {
                    Some(m.curse_forge_id)
                } else {
                    None
                },
                modrinth_id: opt_nonempty(&m.modrinth_id),
                modrinth_version_id: opt_nonempty(&m.modrinth_version_id),
                curse_forge_file_id: if m.curse_forge_file_id > 0 {
                    Some(m.curse_forge_file_id)
                } else {
                    None
                },
                source,
                // TODO: mcmod Chinese-name enrichment (McmodService has no
                // Rust peer yet), so mcmod_id / chinese_name are left empty;
                // iconUrl is filled by fill_remote_icons below.
                mcmod_id: None,
                chinese_name: None,
                active: m.is_active(),
                file_size,
                last_modified,
            }
        })
        .collect()
}

/// enrich 结果条目：按 file_name 合并到前端 mod 列表（两段式第二步）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModEnrichDto {
    file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_file_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// 远程图标 URL（本地无图标时按 id 批量反查填充；对应 C# 反查后图标兜底）
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    /// 远程项目名称（CF name / MR title 回填）
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// mcmod.cn 中文名（离线映射）
    #[serde(skip_serializing_if = "Option::is_none")]
    chinese_name: Option<String>,
    /// mcmod.cn id（右键 MC百科 跳转）
    #[serde(skip_serializing_if = "Option::is_none")]
    mcmod_id: Option<i32>,
}

/// POST /instance/{id}/files/mods/enrich — 两段式第二步：light 扫描后批量网络反查
/// 远程 id（Modrinth SHA1 → project/version id、CurseForge 指纹 → mod/file id）。
/// 独立于 metadata（metadata 保持秒回），慢反查不阻塞列表展示。
async fn mods_enrich(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<ModEnrichDto>>> {
    let r = resolve(&id, &state)?;
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&r.version, r.isolated, &state.curse_forge_api_key);
    let mut list = mods
        .get_mod_list_light()
        .await
        .map_err(map_core_error)?;
    mods.enrich_mod_ids(&mut list).await;
    // 反查 id 后填充远程图标（CF/MR 批量 logo URL；对应 C# 反查后图标兜底）
    let mut dtos = map_mod_dtos(&list);
    fill_remote_icons(&state.http_client, &state.curse_forge_api_key, &mut dtos).await;
    // mcmod 中文名离线映射（远程名优先，本地名兜底；对应 C# BatchLookupWithIds）
    let mcmod = crate::endpoints::mcmod::mcmod_data();
    let result = dtos
        .iter()
        .map(|d| {
            let cn = mcmod.lookup_with_id(&d.name);
            let cn = cn.or_else(|| {
                let local_name = list
                    .iter()
                    .find(|m| Path::new(&m.file_path).file_name().map(|n| n.to_string_lossy().into_owned()) == Some(d.file_name.clone()))
                    .map(|m| m.name.clone())
                    .unwrap_or_default();
                mcmod.lookup_with_id(&local_name)
            });
            ModEnrichDto {
                file_name: d.file_name.clone(),
                curse_forge_id: d.curse_forge_id,
                modrinth_id: d.modrinth_id.clone(),
                modrinth_version_id: d.modrinth_version_id.clone(),
                curse_forge_file_id: d.curse_forge_file_id,
                source: d.source.clone(),
                icon_url: d.icon_url.clone(),
                name: Some(d.name.clone()),
                chinese_name: cn.as_ref().map(|(c, _)| c.clone()),
                mcmod_id: cn.map(|(_, id)| id),
            }
        })
        .collect();
    Ok(Json(result))
}

async fn enable_mod(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    let path = category_dir(&r, "mods").join(&name).to_string_lossy().into_owned();
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&r.version, r.isolated, &state.curse_forge_api_key);
    mods.enable_mod(&path);
    Ok(StatusCode::OK)
}

async fn disable_mod(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    let path = category_dir(&r, "mods").join(&name).to_string_lossy().into_owned();
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&r.version, r.isolated, &state.curse_forge_api_key);
    mods.disable_mod(&path);
    Ok(StatusCode::OK)
}

async fn delete_mod(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    delete_mod_file(&category_dir(&r, "mods").join(&name));
    Ok(StatusCode::NO_CONTENT)
}

async fn batch_enable_mods(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(names): Json<Vec<String>>,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, "mods");
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&r.version, r.isolated, &state.curse_forge_api_key);
    for name in names {
        let path = dir.join(&name).to_string_lossy().into_owned();
        mods.enable_mod(&path);
    }
    Ok(StatusCode::OK)
}

async fn batch_disable_mods(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(names): Json<Vec<String>>,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, "mods");
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&r.version, r.isolated, &state.curse_forge_api_key);
    for name in names {
        let path = dir.join(&name).to_string_lossy().into_owned();
        mods.disable_mod(&path);
    }
    Ok(StatusCode::OK)
}

async fn batch_delete_mods(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(names): Json<Vec<String>>,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, "mods");
    for name in names {
        delete_mod_file(&dir.join(&name));
    }
    Ok(StatusCode::OK)
}

fn delete_mod_file(path: &Path) {
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    } else {
        let mut disabled = path.to_path_buf();
        disabled.set_extension("disabled");
        if disabled.is_file() {
            let _ = std::fs::remove_file(&disabled);
        }
    }
}

// =====================================================================
// Handlers: resourcepacks / shaderpacks / datapacks
// =====================================================================

async fn list_resourcepacks(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FileEntryDto>>> {
    let r = resolve(&id, &state)?;
    Ok(Json(file_entries(&category_dir(&r, "resourcepacks"))))
}

async fn resourcepacks_metadata(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<ResourcePackMetadataDto>>> {
    let r = resolve(&id, &state)?;
    let rp = state
        .core
        .local_resource_provider()
        .create_resourcepack(&r.version, r.isolated, &state.curse_forge_api_key);
    let list = rp.get_resource_pack_list().await.map_err(map_core_error)?;
    let result = list
        .iter()
        .map(|x| ResourcePackMetadataDto {
            file_name: file_name_of(&x.file_path),
            name: x.name.clone(),
            description: x.description.clone(),
            version: x.version.clone(),
            pack_format: x.pack_format,
            icon_base64: opt_nonempty(&x.icon),
            curse_forge_id: positive_opt(x.curse_forge_id),
            modrinth_id: opt_nonempty(&x.modrinth_id),
            source: None,
        })
        .collect();
    Ok(Json(result))
}

async fn delete_resourcepack(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    delete_file(&category_dir(&r, "resourcepacks").join(&name));
    Ok(StatusCode::NO_CONTENT)
}

async fn list_shaderpacks(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FileEntryDto>>> {
    let r = resolve(&id, &state)?;
    Ok(Json(file_entries(&category_dir(&r, "shaderpacks"))))
}

async fn shaderpacks_metadata(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<ShaderMetadataDto>>> {
    let r = resolve(&id, &state)?;
    let s = state
        .core
        .local_resource_provider()
        .create_shaders(&r.version, r.isolated, &state.curse_forge_api_key);
    let list = s.get_shader_list().await.map_err(map_core_error)?;
    let result = list
        .iter()
        .map(|x| ShaderMetadataDto {
            file_name: file_name_of(&x.file_path),
            name: x.name.clone(),
            description: x.description.clone(),
            version: x.version.clone(),
            icon_base64: opt_nonempty(&x.icon),
            curse_forge_id: positive_opt(x.curse_forge_id),
            modrinth_id: opt_nonempty(&x.modrinth_id),
            source: None,
        })
        .collect();
    Ok(Json(result))
}

async fn delete_shaderpack(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    delete_file(&category_dir(&r, "shaderpacks").join(&name));
    Ok(StatusCode::NO_CONTENT)
}

async fn list_datapacks(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FileEntryDto>>> {
    let r = resolve(&id, &state)?;
    Ok(Json(file_entries(&category_dir(&r, "datapacks"))))
}

async fn datapacks_metadata(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<DataPackMetadataDto>>> {
    let r = resolve(&id, &state)?;
    let dp = state
        .core
        .local_resource_provider()
        .create_data_packs(&r.version, r.isolated, &state.curse_forge_api_key);
    let list = dp.get_data_pack_list().await.map_err(map_core_error)?;
    let result = list
        .iter()
        .map(|x| DataPackMetadataDto {
            file_name: file_name_of(&x.file_path),
            name: x.name.clone(),
            description: x.description.clone(),
            version: x.version.clone(),
            pack_format: x.pack_format,
            icon_base64: opt_nonempty(&x.icon),
            curse_forge_id: positive_opt(x.curse_forge_id),
            modrinth_id: opt_nonempty(&x.modrinth_id),
            source: None,
        })
        .collect();
    Ok(Json(result))
}

async fn delete_datapack(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    delete_file(&category_dir(&r, "datapacks").join(&name));
    Ok(StatusCode::NO_CONTENT)
}

// =====================================================================
// Handlers: screenshots
// =====================================================================

async fn list_screenshots(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FileEntryDto>>> {
    let r = resolve(&id, &state)?;
    Ok(Json(file_entries(&category_dir(&r, "screenshots"))))
}

async fn screenshots_metadata(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<ScreenshotMetadataDto>>> {
    let r = resolve(&id, &state)?;
    let sc = state
        .core
        .local_resource_provider()
        .create_screenshots(&r.version, r.isolated, &state.curse_forge_api_key);
    let result: Vec<ScreenshotMetadataDto> = sc
        .get_screenshot_list()
        .into_iter()
        .map(|s| ScreenshotMetadataDto {
            file_name: s.file_name,
            file_path: s.file_path,
            created_at: s.created_at,
            file_size: s.file_size,
        })
        .collect();
    Ok(Json(result))
}

async fn get_screenshot(
    AxumPath((id, file_name)): AxumPath<(String, String)>,
    State(state): State<SharedState>,
) -> ApiResult<Response> {
    let r = resolve(&id, &state)?;
    let path = category_dir(&r, "screenshots").join(&file_name);
    if !path.is_file() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let bytes = std::fs::read(&path)?;
    Ok((StatusCode::OK, [(header::CONTENT_TYPE, "image/png")], bytes).into_response())
}

async fn delete_screenshot(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    delete_file(&category_dir(&r, "screenshots").join(&name));
    Ok(StatusCode::NO_CONTENT)
}

// =====================================================================
// Handlers: saves
// =====================================================================

async fn list_saves(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FileEntryDto>>> {
    let r = resolve(&id, &state)?;
    Ok(Json(file_entries(&category_dir(&r, "saves"))))
}

async fn saves_metadata(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<SaveMetadataDto>>> {
    let r = resolve(&id, &state)?;
    let saves = state
        .core
        .local_resource_provider()
        .create_saves(&r.version, r.isolated, &state.curse_forge_api_key);
    let result: Vec<SaveMetadataDto> = saves
        .get_save_list()
        .into_iter()
        .map(|s| SaveMetadataDto {
            name: s.name,
            file_path: s.file_path,
            last_played: s.last_played,
            icon_base64: opt_nonempty(&s.icon),
        })
        .collect();
    Ok(Json(result))
}

async fn copy_save(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<SaveCopyRequest>,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    let saves_dir = category_dir(&r, "saves");
    let src = saves_dir.join(&req.name);
    if !src.is_dir() {
        return Err(ApiError::not_found("SAVE_NOT_FOUND", "Save directory not found"));
    }
    copy_dir(&src, &saves_dir.join(&req.new_name));
    Ok(StatusCode::OK)
}

async fn rename_save(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<SaveRenameRequest>,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    let saves = state
        .core
        .local_resource_provider()
        .create_saves(&r.version, r.isolated, &state.curse_forge_api_key);
    let saves_dir = category_dir(&r, "saves");
    let path = saves_dir.join(&req.old_name).to_string_lossy().into_owned();
    saves.rename_save(&path, &req.new_name);
    Ok(StatusCode::OK)
}

async fn backup_save(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    let saves = state
        .core
        .local_resource_provider()
        .create_saves(&r.version, r.isolated, &state.curse_forge_api_key);
    let saves_dir = category_dir(&r, "saves");
    let path = saves_dir.join(&name).to_string_lossy().into_owned();
    saves.backup_save(&path);
    Ok(StatusCode::OK)
}

async fn delete_save(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    let path = category_dir(&r, "saves").join(&name);
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(&path);
    }
    Ok(StatusCode::NO_CONTENT)
}

// =====================================================================
// 501 stubs: servers / options
// =====================================================================

async fn servers_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Servers list/add"))
}

async fn servers_delete_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Servers delete"))
}

async fn server_ping_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Server ping"))
}

async fn lan_games_501() -> ApiResult<StatusCode> {
    Err(not_implemented("LAN games discover"))
}

async fn options_list_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Options list"))
}

async fn options_get_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Options get by name"))
}

async fn options_put_501() -> ApiResult<StatusCode> {
    Err(not_implemented("Options set by name"))
}

// =====================================================================
// Utils / helpers
// =====================================================================

fn required_name(name: Option<String>) -> Result<String, ApiError> {
    name.ok_or_else(|| ApiError::bad_request("MISSING_NAME", "name is required"))
}

fn opt_nonempty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn positive_opt(v: i32) -> Option<i32> {
    if v > 0 {
        Some(v)
    } else {
        None
    }
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn delete_file(path: &Path) {
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
}

/// Recursive directory copy (C# CopyDirectory).
fn copy_dir(source: &Path, dest: &Path) {
    let _ = std::fs::create_dir_all(dest);
    if let Ok(rd) = std::fs::read_dir(source) {
        for e in rd.filter_map(|e| e.ok()) {
            let from = e.path();
            let to = dest.join(e.file_name());
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                copy_dir(&from, &to);
            } else {
                let _ = std::fs::copy(&from, &to);
            }
        }
    }
}

fn instance_not_found(id: &str) -> ApiError {
    ApiError::not_found("INSTANCE_NOT_FOUND", format!("Instance {id} not found"))
}

fn not_implemented(scope: &str) -> ApiError {
    ApiError {
        code: "NOT_IMPLEMENTED".to_string(),
        message: format!("{scope} is not implemented yet"),
        detail: None,
        status: StatusCode::NOT_IMPLEMENTED,
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

/// Fallback remote-icon enrichment for mods without a local icon. Mirrors C#
/// FillRemoteIcons: CurseForge by mod id, then Modrinth by project id/slug.
/// All errors are swallowed so a lookup failure cannot break the metadata flow.
async fn fill_remote_icons(
    client: &reqwest::Client,
    api_key: &str,
    result: &mut [ModMetadataDto],
) {
    let empty: Vec<usize> = result
        .iter()
        .enumerate()
        .filter(|(_, m)| m.icon_base64.is_none())
        .map(|(i, _)| i)
        .collect();
    if empty.is_empty() {
        return;
    }

    // CurseForge: POST /v1/mods with {"modIds":[...]}.
    let cf_idx: Vec<usize> = empty
        .iter()
        .copied()
        .filter(|&i| result[i].curse_forge_id.is_some())
        .collect();
    if !cf_idx.is_empty() && !api_key.is_empty() {
        let ids: Vec<i32> = cf_idx
            .iter()
            .map(|&i| result[i].curse_forge_id.unwrap_or(0))
            .collect();
        let body = serde_json::json!({ "modIds": ids });
        let resp = client
            .post("https://api.curseforge.com/v1/mods")
            .header("x-api-key", api_key)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(array) = json.get("data").and_then(|d| d.as_array()) {
                        for item in array {
                            let mod_id = item.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                            let name = item.get("name").and_then(|v| v.as_str());
                            let url = item
                                .get("logo")
                                .and_then(|l| l.get("url"))
                                .and_then(|u| u.as_str());
                            let id = mod_id as i32;
                            for &i in &cf_idx {
                                if result[i].curse_forge_id == Some(id) {
                                    // 远程名称（CF 项目标题，回填显示名）
                                    if let Some(name) = name {
                                        result[i].name = name.to_string();
                                    }
                                    if result[i].icon_url.is_none() {
                                        if let Some(url) = url {
                                            result[i].icon_url = Some(url.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Modrinth: GET /v2/projects?ids=["a","b"]. reqwest encodes the query.
    let mr_idx: Vec<usize> = empty
        .iter()
        .copied()
        .filter(|&i| result[i].icon_url.is_none() && result[i].modrinth_id.is_some())
        .collect();
    if !mr_idx.is_empty() {
        let pids: Vec<String> = mr_idx
            .iter()
            .filter_map(|&i| result[i].modrinth_id.clone())
            .collect();
        let resp = client
            .get("https://api.modrinth.com/v2/projects")
            .query(&[("ids", serde_json::json!(pids).to_string())])
            .send()
            .await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                if let Ok(array) = resp.json::<serde_json::Value>().await {
                    if let Some(array) = array.as_array() {
                        for item in array {
                            let url = item.get("icon_url").and_then(|u| u.as_str());
                            let url = match url {
                                Some(u) if !u.is_empty() => Some(u.to_string()),
                                _ => None,
                            };
                            let title = item.get("title").and_then(|v| v.as_str());
                            let pid = item.get("id").and_then(|v| v.as_str());
                            let slug = item.get("slug").and_then(|v| v.as_str());
                            for &i in &mr_idx {
                                let mine = result[i].modrinth_id.as_deref();
                                if mine.is_some() && (mine == pid || mine == slug) {
                                    // 远程名称（MR 项目标题，回填显示名）
                                    if let Some(title) = title {
                                        result[i].name = title.to_string();
                                    }
                                    if result[i].icon_url.is_none() {
                                        if let Some(url) = url.clone() {
                                            result[i].icon_url = Some(url);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}





