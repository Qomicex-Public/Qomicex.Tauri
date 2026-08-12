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

#[derive(Clone, Serialize, Deserialize)]
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

#[derive(Deserialize, Default)]
struct AddressQuery {
    #[serde(default)]
    address: Option<String>,
}

#[derive(Deserialize, Default)]
struct IpQuery {
    #[serde(default)]
    ip: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddServerRequest {
    name: Option<String>,
    ip: Option<String>,
}

/// 服务器条目 DTO（C# OldServerEntryDto，camelCase）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OldServerEntryDto {
    name: String,
    ip: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_base64: Option<String>,
    accept_textures: bool,
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
// Mods list disk cache (6h TTL) + stale-while-revalidate refresh lock
// =====================================================================

const MODS_CACHE_TTL_SECS: i64 = 6 * 3600;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModsCacheEntry {
    fetched_at: i64,
    entries: Vec<ModMetadataDto>,
}

static REFRESH_LOCK: LazyLock<Mutex<HashMap<String, ()>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn mods_cache_path(data_dir: &PathBuf, instance_id: &str) -> PathBuf {
    data_dir
        .join("QML")
        .join("mods-cache")
        .join(format!("{instance_id}-mods.json"))
}

fn read_mods_cache(data_dir: &PathBuf, instance_id: &str) -> Option<Vec<ModMetadataDto>> {
    let path = mods_cache_path(data_dir, instance_id);
    let bytes = std::fs::read(path).ok()?;
    let cache: ModsCacheEntry = serde_json::from_slice(&bytes).ok()?;
    let now = now_secs();
    if now - cache.fetched_at < MODS_CACHE_TTL_SECS {
        Some(cache.entries)
    } else {
        None
    }
}

fn read_mods_cache_stale(data_dir: &PathBuf, instance_id: &str) -> Option<Vec<ModMetadataDto>> {
    let path = mods_cache_path(data_dir, instance_id);
    let bytes = std::fs::read(path).ok()?;
    let cache: ModsCacheEntry = serde_json::from_slice(&bytes).ok()?;
    Some(cache.entries)
}

fn write_mods_cache(data_dir: &PathBuf, instance_id: &str, entries: Vec<ModMetadataDto>) {
    let path = mods_cache_path(data_dir, instance_id);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let cache = ModsCacheEntry {
        fetched_at: now_secs(),
        entries,
    };
    if let Ok(json) = serde_json::to_vec(&cache) {
        let _ = std::fs::write(path, json);
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn refresh_mods_cache(
    state: &SharedState,
    instance_id: &str,
) -> ApiResult<Vec<ModMetadataDto>> {
    let r = resolve(instance_id, state)?;
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&r.version, r.isolated, &state.curse_forge_api_key);
    let mut list = mods
        .get_mod_list(None)
        .await
        .map_err(map_core_error)?;
    mods.enrich_mod_ids(&mut list).await;
    let mut dtos = map_mod_dtos(&list);
    fill_remote_icons(&state.http_client, &state.curse_forge_api_key, &mut dtos).await;
    let mcmod = crate::endpoints::mcmod::mcmod_data();
    let result: Vec<ModMetadataDto> = dtos
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
            ModMetadataDto {
                file_name: d.file_name.clone(),
                name: d.name.clone(),
                version: d.version.clone(),
                description: d.description.clone(),
                authors: d.authors.clone(),
                icon_url: d.icon_url.clone(),
                icon_base64: d.icon_base64.clone(),
                curse_forge_id: d.curse_forge_id,
                modrinth_id: d.modrinth_id.clone(),
                modrinth_version_id: d.modrinth_version_id.clone(),
                curse_forge_file_id: d.curse_forge_file_id,
                source: d.source.clone(),
                mcmod_id: cn.as_ref().map(|(_, id)| *id),
                chinese_name: cn.as_ref().map(|(c, _)| c.clone()),
                active: d.active,
                file_size: d.file_size,
                last_modified: d.last_modified.clone(),
            }
        })
        .collect();
    write_mods_cache(&state.data_dir, instance_id, result.clone());
    Ok(result)
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
        .route(
            "/instance/{id}/files/mods/check-updates",
            get(check_mod_updates),
        )
        .route(
            "/instance/{id}/files/mods/batch-update",
            post(batch_update_mods),
        )
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
        // servers
        .route(
            "/instance/{id}/files/servers",
            get(list_servers).post(add_server),
        )
        .route(
            "/instance/{id}/files/servers",
            delete(delete_server),
        )
        .route("/instance/{id}/files/server-ping", get(server_ping))
        .route("/instance/{id}/files/lan-games", get(lan_games))
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
    // Disk cache (6h TTL): fresh hit skips scan + network entirely.
    if let Some(entries) = read_mods_cache(&state.data_dir, &id) {
        return Ok(Json(entries).into_response());
    }
    // Stale hit: return stale + spawn background refresh (stale-while-revalidate).
    if let Some(entries) = read_mods_cache_stale(&state.data_dir, &id) {
        let state2 = state.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            let _ = refresh_mods_cache(&state2, &id2).await;
        });
        return Ok(Json(entries).into_response());
    }
    // No cache: full scan + write cache.
    let entries = refresh_mods_cache(&state, &id).await?;
    Ok(Json(entries).into_response())
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

/// check-updates 结果条目（对应前端 ModUpdateEntry）。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModUpdateEntryDto {
    file_name: String,
    name: String,
    current_version: String,
    latest_version: String,
    project_id: String,
    source: String,
    download_url: String,
    new_file_name: String,
}

/// 简易版本比较（按数值段比较，同 services/plugin.rs version_compare）。
fn version_compare(a: &str, b: &str) -> i32 {
    let pa = version_parse(a);
    let pb = version_parse(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va != vb {
            return if va < vb { -1 } else { 1 };
        }
    }
    0
}

fn version_parse(version: &str) -> Vec<i32> {
    let cleaned = version
        .trim()
        .split('-')
        .next()
        .unwrap_or("")
        .split('+')
        .next()
        .unwrap_or("");
    let mut nums = Vec::new();
    for seg in cleaned.split('.') {
        match seg.parse::<i32>() {
            Ok(n) => nums.push(n),
            Err(_) => break,
        }
    }
    if nums.is_empty() {
        nums.push(0);
    }
    nums
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
    // Disk cache (6h TTL): fresh hit skips scan + network entirely.
    if let Some(entries) = read_mods_cache(&state.data_dir, &id) {
        return Ok(Json(entries_to_enrich(entries)));
    }
    // Stale hit: return stale + spawn background refresh.
    if let Some(entries) = read_mods_cache_stale(&state.data_dir, &id) {
        let state2 = state.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            let _ = refresh_mods_cache(&state2, &id2).await;
        });
        return Ok(Json(entries_to_enrich(entries)));
    }
    // No cache: full scan + enrich + write cache.
    let entries = refresh_mods_cache(&state, &id).await?;
    Ok(Json(entries_to_enrich(entries)))
}

fn entries_to_enrich(entries: Vec<ModMetadataDto>) -> Vec<ModEnrichDto> {
    entries
        .into_iter()
        .map(|d| ModEnrichDto {
            file_name: d.file_name,
            curse_forge_id: d.curse_forge_id,
            modrinth_id: d.modrinth_id,
            modrinth_version_id: d.modrinth_version_id,
            curse_forge_file_id: d.curse_forge_file_id,
            source: d.source,
            icon_url: d.icon_url,
            name: Some(d.name),
            chinese_name: d.chinese_name,
            mcmod_id: d.mcmod_id,
        })
        .collect()
}

/// GET /instance/{id}/files/mods/check-updates — 检查模组更新（补全前端 ModUpdateDialog 缺失路由）。
async fn check_mod_updates(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<ModUpdateEntryDto>>> {
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

    let mut updates = Vec::new();
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(5));
    let client = state.http_client.clone();
    let api_key = state.curse_forge_api_key.clone();

    let mut handles = Vec::new();
    for info in list.iter() {
        if info.modrinth_id.is_empty() && info.curse_forge_id == 0 {
            continue;
        }
        let info = info.clone();
        let client = client.clone();
        let api_key = api_key.clone();
        let permit = sem.clone().acquire_owned().await;
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            if !info.modrinth_id.is_empty() {
                check_modrinth_update(&client, &info).await
            } else if info.curse_forge_id != 0 {
                check_curseforge_update(&client, &info, &api_key).await
            } else {
                None
            }
        }));
    }

    for handle in handles {
        if let Ok(Some(update)) = handle.await {
            updates.push(update);
        }
    }

    Ok(Json(updates))
}

async fn check_modrinth_update(
    client: &reqwest::Client,
    info: &qomicex_core::models::expansion::local::ModInfo,
) -> Option<ModUpdateEntryDto> {
    let url = format!(
        "https://api.modrinth.com/v2/project/{}/version",
        urlencode(&info.modrinth_id)
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let versions: Vec<serde_json::Value> = resp.json().await.ok()?;
    let mut latest: Option<&serde_json::Value> = None;
    for v in &versions {
        let gv = v.get("game_versions").and_then(|g| g.as_array())?;
        // 简化：取首个版本（最新发布）
        latest = Some(v);
        break;
    }
    let latest = latest?;
    let latest_version = latest
        .get("version_number")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if latest_version.is_empty() || version_compare(latest_version, &info.version) <= 0 {
        return None;
    }
    let download_url = latest
        .get("files")
        .and_then(|f| f.as_array())
        .and_then(|arr| arr.first())
        .and_then(|f| f.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("");
    let new_file_name = latest
        .get("files")
        .and_then(|f| f.as_array())
        .and_then(|arr| arr.first())
        .and_then(|f| f.get("filename"))
        .and_then(|u| u.as_str())
        .unwrap_or_default()
        .to_string();
    Some(ModUpdateEntryDto {
        file_name: Path::new(&info.file_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        name: info.name.clone(),
        current_version: info.version.clone(),
        latest_version: latest_version.to_string(),
        project_id: info.modrinth_id.clone(),
        source: "modrinth".to_string(),
        download_url: download_url.to_string(),
        new_file_name,
    })
}

async fn check_curseforge_update(
    client: &reqwest::Client,
    info: &qomicex_core::models::expansion::local::ModInfo,
    api_key: &str,
) -> Option<ModUpdateEntryDto> {
    let url = format!(
        "https://api.curseforge.com/v1/mods/{}/files?pageSize=1",
        info.curse_forge_id
    );
    let resp = client
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let files = json.get("data").and_then(|d| d.as_array())?;
    let latest = files.first()?;
    let latest_version = latest
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if latest_version.is_empty() || version_compare(latest_version, &info.version) <= 0 {
        return None;
    }
    let download_url = latest
        .get("downloadUrl")
        .and_then(|u| u.as_str())
        .unwrap_or("");
    Some(ModUpdateEntryDto {
        file_name: Path::new(&info.file_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        name: info.name.clone(),
        current_version: info.version.clone(),
        latest_version: latest_version.to_string(),
        project_id: info.curse_forge_id.to_string(),
        source: "curseforge".to_string(),
        download_url: download_url.to_string(),
        new_file_name: latest_version.to_string(),
    })
}

fn urlencode(s: &str) -> String {
    s.as_bytes()
        .iter()
        .map(|&b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
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

/// POST /instance/{id}/files/mods/batch-update — 批量更新模组（下载新版本并替换旧文件）。
async fn batch_update_mods(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(updates): Json<Vec<ModUpdateEntryDto>>,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, "mods");
    for update in updates {
        let old_path = dir.join(&update.file_name);
        delete_mod_file(&old_path);
        if update.download_url.is_empty() || update.new_file_name.is_empty() {
            continue;
        }
        let resp = state
            .http_client
            .get(&update.download_url)
            .send()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        if !resp.status().is_success() {
            continue;
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let new_path = dir.join(&update.new_file_name);
        std::fs::write(&new_path, &bytes).map_err(ApiError::from)?;
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
// Handlers: servers (C# MapServerEndpoints)
// =====================================================================

/// 获取服务器列表（C# LoadServerList → OldServerEntryDto[]）。
async fn list_servers(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<OldServerEntryDto>>> {
    let r = resolve(&id, &state)?;
    let sm = state
        .core
        .local_resource_provider()
        .create_server_manager(&r.version, r.isolated);
    let result: Vec<OldServerEntryDto> = sm
        .load_server_list()
        .into_iter()
        .map(|s| OldServerEntryDto {
            name: s.name,
            ip: s.address,
            icon_base64: s.icon_base64,
            accept_textures: s.accept_textures,
        })
        .collect();
    Ok(Json(result))
}

/// 新增或更新服务器（C# AddOrUpdateServer(ServerEntry{Name, Address=Ip,
/// AcceptTextures=true}) → 200）。
async fn add_server(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<AddServerRequest>,
) -> ApiResult<StatusCode> {
    let name = req
        .name
        .ok_or_else(|| ApiError::bad_request("MISSING_NAME", "name is required"))?;
    let ip = req
        .ip
        .ok_or_else(|| ApiError::bad_request("MISSING_IP", "ip is required"))?;
    let r = resolve(&id, &state)?;
    let sm = state
        .core
        .local_resource_provider()
        .create_server_manager(&r.version, r.isolated);
    sm.add_or_update_server(&qomicex_core::models::local::ServerEntry {
        name,
        address: ip,
        accept_textures: true,
        ..qomicex_core::models::local::ServerEntry::default()
    });
    Ok(StatusCode::OK)
}

/// 删除服务器（C# RemoveServer(ip)，?ip=xxx → 204 NoContent）。
async fn delete_server(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<IpQuery>,
) -> ApiResult<StatusCode> {
    let ip = q
        .ip
        .ok_or_else(|| ApiError::bad_request("MISSING_IP", "ip is required"))?;
    let r = resolve(&id, &state)?;
    let sm = state
        .core
        .local_resource_provider()
        .create_server_manager(&r.version, r.isolated);
    sm.remove_server(&ip);
    Ok(StatusCode::NO_CONTENT)
}

/// 查询服务器状态（C# GetServerStateByAddress，?address=xxx；
/// ServerState camelCase 序列化与前端 ServerState 一致，直通返回；
/// async 变体直调 core 编排核心，避免同步变体在 tokio worker 线程内 block_on panic）。
async fn server_ping(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<AddressQuery>,
) -> ApiResult<Json<qomicex_core::models::local::ServerState>> {
    let address = q
        .address
        .ok_or_else(|| ApiError::bad_request("MISSING_ADDRESS", "address is required"))?;
    let r = resolve(&id, &state)?;
    let sm = state
        .core
        .local_resource_provider()
        .create_server_manager(&r.version, r.isolated);
    Ok(Json(sm.get_server_state_by_address_async(&address).await))
}

/// 发现局域网服务器（C# DiscoverLanServers(TimeSpan.FromSeconds(5))）。
async fn lan_games(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<qomicex_core::models::local::LanServerEntry>>> {
    let r = resolve(&id, &state)?;
    let sm = state
        .core
        .local_resource_provider()
        .create_server_manager(&r.version, r.isolated);
    Ok(Json(
        sm.discover_lan_servers(std::time::Duration::from_secs(5)),
    ))
}

// =====================================================================
// 501 stubs: options
// =====================================================================

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
/// CF 与 MR 反查并行（tokio::join!）。All errors are swallowed so a lookup
/// failure cannot break the metadata flow.
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
    // Modrinth: GET /v2/projects?ids=[...].
    let mr_idx: Vec<usize> = empty
        .iter()
        .copied()
        .filter(|&i| result[i].icon_url.is_none() && result[i].modrinth_id.is_some())
        .collect();

    let cf_ids: Vec<i32> = cf_idx
        .iter()
        .map(|&i| result[i].curse_forge_id.unwrap_or(0))
        .collect();
    let mr_pids: Vec<String> = mr_idx
        .iter()
        .filter_map(|&i| result[i].modrinth_id.clone())
        .collect();

    let cf_fut = async {
        if cf_ids.is_empty() || api_key.is_empty() {
            return None;
        }
        let body = serde_json::json!({ "modIds": cf_ids });
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
                        return Some(array.clone());
                    }
                }
            }
        }
        None
    };

    let mr_fut = async {
        if mr_pids.is_empty() {
            return None;
        }
        let resp = client
            .get("https://api.modrinth.com/v2/projects")
            .query(&[("ids", serde_json::json!(mr_pids).to_string())])
            .send()
            .await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                if let Ok(array) = resp.json::<serde_json::Value>().await {
                    if let Some(array) = array.as_array() {
                        return Some(array.clone());
                    }
                }
            }
        }
        None
    };

    let (cf_array, mr_array) = tokio::join!(cf_fut, mr_fut);

    if let Some(array) = cf_array {
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

    if let Some(array) = mr_array {
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





