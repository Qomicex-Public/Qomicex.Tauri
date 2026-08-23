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
//! - mcmod Chinese-name lookup in mods/metadata: McmodService has no Rust peer
//!   yet, that enrichment is skipped (see TODO in mods_metadata).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use qomicex_core::models::expansion::curseforge::mod_loader_type;
use qomicex_core::models::expansion::local::LevelDatSettings;

use crate::error::{ApiError, ApiResult};
use crate::services::schematic_assets;
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

/// POST /instance/{id}/schematics/assets — blocks to extract (full names like
/// "minecraft:stone_bricks").
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchematicAssetsRequest {
    blocks: Vec<String>,
}

/// 单个原理图文件最大体积（导入 / 预览字节下载上限）。
const SCHEMATIC_MAX_BYTES: u64 = 512 * 1024 * 1024;

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
/// 扫描结果为空时的短缓存：避免临时失败（网络抖动/目录错位）把空列表冻结 6 小时。
const MODS_CACHE_EMPTY_TTL_SECS: i64 = 5 * 60;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModsCacheEntry {
    fetched_at: i64,
    entries: Vec<ModMetadataDto>,
    /// 缓存有效期（秒）；缺省 = MODS_CACHE_TTL_SECS（兼容旧缓存文件）。
    #[serde(default)]
    ttl_secs: Option<i64>,
    /// 写入时 mods 目录内容指纹；命中时与当前目录比对，不一致视为过期。
    /// 缺省 = 未记录（兼容旧缓存文件 → 直接 miss 重扫）。
    #[serde(default)]
    dir_signature: Option<u64>,
}

static REFRESH_LOCK: LazyLock<Mutex<HashMap<String, ()>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn mods_cache_path(data_dir: &PathBuf, instance_id: &str) -> PathBuf {
    data_dir
        .join("QML")
        .join("mods-cache")
        .join(format!("{instance_id}-mods.json"))
}

fn read_mods_cache(
    data_dir: &PathBuf,
    instance_id: &str,
    expected_signature: u64,
) -> Option<Vec<ModMetadataDto>> {
    let path = mods_cache_path(data_dir, instance_id);
    let bytes = std::fs::read(path).ok()?;
    let cache: ModsCacheEntry = serde_json::from_slice(&bytes).ok()?;
    let now = now_secs();
    let ttl = cache.ttl_secs.unwrap_or(MODS_CACHE_TTL_SECS);
    // TTL 内还须目录指纹一致：用户在文件系统增删/改名/移动 mod 后立即失效。
    if now - cache.fetched_at < ttl && cache.dir_signature == Some(expected_signature) {
        Some(cache.entries)
    } else {
        None
    }
}

fn read_mods_cache_stale(
    data_dir: &PathBuf,
    instance_id: &str,
    expected_signature: u64,
) -> Option<Vec<ModMetadataDto>> {
    let path = mods_cache_path(data_dir, instance_id);
    let bytes = std::fs::read(path).ok()?;
    let cache: ModsCacheEntry = serde_json::from_slice(&bytes).ok()?;
    // 仅"目录未动、纯 TTL 过期"走 stale-while-revalidate；
    // 签名不一致说明用户刚改过文件，必须同步重扫（见调用方）。
    if cache.dir_signature != Some(expected_signature) {
        return None;
    }
    Some(cache.entries)
}

fn write_mods_cache(
    data_dir: &PathBuf,
    instance_id: &str,
    entries: Vec<ModMetadataDto>,
    ttl_secs: i64,
    dir_signature: u64,
) {
    let path = mods_cache_path(data_dir, instance_id);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let cache = ModsCacheEntry {
        fetched_at: now_secs(),
        entries,
        ttl_secs: Some(ttl_secs),
        dir_signature: Some(dir_signature),
    };
    if let Ok(json) = serde_json::to_vec(&cache) {
        let _ = std::fs::write(path, json);
    }
}

/// Mods 目录内容指纹：全部文件 (文件名, 大小, mtime) 排序后哈希。
/// 目录不存在/读失败 → 空列表的哈希（与"空目录"一致，安全侧）。
fn mods_dir_signature(r: &Resolved) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut items: Vec<(String, u64, i64)> = std::fs::read_dir(category_dir(r, "mods"))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let md = e.metadata().ok()?;
                    if !md.is_file() {
                        return None;
                    }
                    let mtime = md
                        .modified()
                        .ok()?
                        .duration_since(std::time::UNIX_EPOCH)
                        .ok()?
                        .as_secs() as i64;
                    Some((
                        e.file_name().to_string_lossy().into_owned(),
                        md.len(),
                        mtime,
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    items.sort();
    let mut h = DefaultHasher::new();
    items.hash(&mut h);
    h.finish()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// =====================================================================
// Mods update-check disk cache (6h TTL) — 独立于 mods-cache。
// 结构见 ModUpdateEntryDto；check-updates 缓存命中直接返回，不联网。
// =====================================================================

const UPDATE_CACHE_TTL_SECS: i64 = 6 * 3600;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCacheEntry {
    fetched_at: i64,
    updates: Vec<ModUpdateEntryDto>,
}

fn update_cache_path(data_dir: &PathBuf, instance_id: &str) -> PathBuf {
    data_dir
        .join("QML")
        .join("mods-update-cache")
        .join(format!("{instance_id}-updates.json"))
}

fn read_update_cache(data_dir: &PathBuf, instance_id: &str) -> Option<UpdateCacheEntry> {
    let path = update_cache_path(data_dir, instance_id);
    let bytes = std::fs::read(path).ok()?;
    let cache: UpdateCacheEntry = serde_json::from_slice(&bytes).ok()?;
    let now = now_secs();
    if now - cache.fetched_at < UPDATE_CACHE_TTL_SECS {
        Some(cache)
    } else {
        None
    }
}

fn read_update_cache_stale(data_dir: &PathBuf, instance_id: &str) -> Option<UpdateCacheEntry> {
    let path = update_cache_path(data_dir, instance_id);
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_update_cache(data_dir: &PathBuf, instance_id: &str, updates: Vec<ModUpdateEntryDto>) {
    let path = update_cache_path(data_dir, instance_id);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let cache = UpdateCacheEntry {
        fetched_at: now_secs(),
        updates,
    };
    if let Ok(json) = serde_json::to_vec(&cache) {
        let _ = std::fs::write(path, json);
    }
}

async fn refresh_mods_cache(
    state: &SharedState,
    instance_id: &str,
) -> ApiResult<Vec<ModMetadataDto>> {
    let r = resolve(instance_id, state)?;
    let mods = state.core.local_resource_provider().create_mods(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
    let mut list = mods.get_mod_list(None).await.map_err(map_core_error)?;
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
                    .find(|m| {
                        Path::new(&m.file_path)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            == Some(d.file_name.clone())
                    })
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
    // 空结果只写短缓存（临时失败不冻结 6 小时）；非空结果写 6h 长缓存。
    let ttl = if result.is_empty() {
        MODS_CACHE_EMPTY_TTL_SECS
    } else {
        MODS_CACHE_TTL_SECS
    };
    let sig = mods_dir_signature(&r);
    write_mods_cache(&state.data_dir, instance_id, result.clone(), ttl, sig);
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
            "/instance/{id}/files/mods/update-cache",
            get(mods_update_cache).delete(mods_update_cache_invalidate),
        )
        .route(
            "/instance/{id}/files/mods/check-updates",
            get(check_mod_updates),
        )
        .route(
            "/instance/{id}/files/mods/batch-update",
            post(batch_update_mods),
        )
        .route("/instance/{id}/files/import-local", post(import_local))
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
        .route("/instance/{id}/files/screenshots", get(list_screenshots))
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
        // schematics (投影原理图 / Litematica)
        .route("/instance/{id}/files/schematics", get(list_schematics))
        .route("/instance/{id}/files/schematics", delete(delete_schematic))
        .route(
            "/instance/{id}/files/schematics/rename",
            post(rename_schematic),
        )
        .route(
            "/instance/{id}/files/schematics/import",
            post(import_schematic).route_layer(DefaultBodyLimit::max(SCHEMATIC_MAX_BYTES as usize)),
        )
        .route(
            "/instance/{id}/files/schematics/{name}/bytes",
            get(schematic_bytes),
        )
        .route("/instance/{id}/schematics/assets", post(schematic_assets))
        // saves
        .route("/instance/{id}/files/saves", get(list_saves))
        .route("/instance/{id}/files/saves/metadata", get(saves_metadata))
        .route("/instance/{id}/files/saves/copy", post(copy_save))
        .route("/instance/{id}/files/saves/rename", post(rename_save))
        .route("/instance/{id}/files/saves/backup", post(backup_save))
        .route("/instance/{id}/files/saves", delete(delete_save))
        // save settings (level.dat NBT; see services/local/level_dat.rs in core)
        .route(
            "/instance/{id}/files/saves/{name}/settings",
            get(save_settings_get).put(save_settings_put),
        )
        .route(
            "/instance/{id}/files/saves/{name}/settings/restore",
            post(save_settings_restore),
        )
        // servers
        .route(
            "/instance/{id}/files/servers",
            get(list_servers).post(add_server),
        )
        .route("/instance/{id}/files/servers", delete(delete_server))
        .route("/instance/{id}/files/server-ping", get(server_ping))
        .route("/instance/{id}/files/lan-games", get(lan_games))
        // options (per-instance OptionsProvider; see services/options.rs)
        .route("/instance/{id}/files/options", get(options_list))
        .route(
            "/instance/{id}/files/options/{name}",
            get(options_get).put(options_put),
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
    } else {
        crate::settings::resolve_base_dir().join(path)
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
// Handler: local file import (drag-and-drop install)
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportLocalRequest {
    category: String,
    source_path: String,
    #[serde(default)]
    file_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportLocalResponse {
    file_name: String,
    target_path: String,
}

/// POST /instance/{id}/files/import-local — copy a local file into the
/// instance's (version-isolated) category directory. Backs the launcher's
/// drag-and-drop installer; the source file is left untouched.
async fn import_local(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<ImportLocalRequest>,
) -> ApiResult<Json<ImportLocalResponse>> {
    let cat = match req.category.to_ascii_lowercase().as_str() {
        "mods" => "mods",
        "resourcepacks" | "resourcepack" => "resourcepacks",
        "shaderpacks" | "shaderpack" | "shader" => "shaderpacks",
        _ => {
            return Err(ApiError::bad_request(
                "IMPORT_CATEGORY_INVALID",
                "category must be one of mods/resourcepacks/shaderpacks",
            ))
        }
    };
    let src = PathBuf::from(req.source_path.trim());
    if !src.is_file() {
        return Err(ApiError::not_found(
            "FILE_NOT_FOUND",
            "Source file does not exist",
        ));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let allowed: &[&str] = if cat == "mods" {
        &["jar", "litemod"]
    } else {
        &["zip"]
    };
    if !allowed.contains(&ext.as_str()) {
        return Err(ApiError::bad_request(
            "IMPORT_EXTENSION_MISMATCH",
            format!(".{ext} is not a valid {cat} file"),
        ));
    }
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, cat);
    let original = req.file_name.clone().unwrap_or_else(|| {
        src.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let dest = unique_destination(&dir, &original);
    std::fs::copy(&src, &dest)?;
    Ok(Json(ImportLocalResponse {
        file_name: dest
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        target_path: dest.to_string_lossy().into_owned(),
    }))
}

/// `name (n).ext` suffixing so repeated drops never silently overwrite.
fn unique_destination(dir: &Path, file_name: &str) -> PathBuf {
    let mut n = 0u32;
    loop {
        let candidate = if n == 0 {
            dir.join(file_name)
        } else {
            let p = Path::new(file_name);
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
            match p.extension().and_then(|s| s.to_str()) {
                Some(ext) => dir.join(format!("{stem} ({n}).{ext}")),
                None => dir.join(format!("{stem} ({n})")),
            }
        };
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
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
    Ok(Json(
        count_children(&dir, "jar") + count_children(&dir, "disabled"),
    ))
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
        "schematics" | "schematic" => "schematics",
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
    // 目录指纹：文件系统变动（增删/改名/移动）立即使磁盘缓存失效。
    let sig = mods_dir_signature(&resolve(&id, &state)?);
    // Disk cache (6h TTL): fresh hit skips scan + network entirely.
    if let Some(entries) = read_mods_cache(&state.data_dir, &id, sig) {
        return Ok(Json(entries).into_response());
    }
    // Stale hit（仅目录未动的纯 TTL 过期）: return stale + spawn background refresh.
    if let Some(entries) = read_mods_cache_stale(&state.data_dir, &id, sig) {
        let state2 = state.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            let _ = refresh_mods_cache(&state2, &id2).await;
        });
        return Ok(Json(entries).into_response());
    }
    // No cache / 目录已变动: 同步全量扫描 + write cache（一次返回正确数据）。
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

/// check-updates 响应：更新列表 + 本次是否真实联网（缓存命中时 refreshed=false）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModUpdatesResponse {
    updates: Vec<ModUpdateEntryDto>,
    refreshed: bool,
}

/// update-cache 响应：最近一次结果 + 是否过期（缓存缺失或超过 6h → stale=true）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModUpdatesCacheResponse {
    updates: Vec<ModUpdateEntryDto>,
    stale: bool,
}

#[derive(Deserialize)]
struct CheckUpdatesQuery {
    force: Option<i32>,
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
    // 目录指纹：文件系统变动立即使磁盘缓存失效（与 mods_metadata 同一语义）。
    let sig = mods_dir_signature(&resolve(&id, &state)?);
    // Disk cache (6h TTL): fresh hit skips scan + network entirely.
    if let Some(entries) = read_mods_cache(&state.data_dir, &id, sig) {
        return Ok(Json(entries_to_enrich(entries)));
    }
    // Stale hit（仅目录未动的纯 TTL 过期）: return stale + spawn background refresh.
    if let Some(entries) = read_mods_cache_stale(&state.data_dir, &id, sig) {
        let state2 = state.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            let _ = refresh_mods_cache(&state2, &id2).await;
        });
        return Ok(Json(entries_to_enrich(entries)));
    }
    // No cache / 目录已变动: 同步全量扫描 + enrich + write cache。
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

/// GET /instance/{id}/files/mods/update-cache — 只读最近一次更新检查结果 + 是否过期。
/// 列表加载后的自动检查用它判断是否需联网（stale）；缓存命中时直接取 updates 标记。
async fn mods_update_cache(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<ModUpdatesCacheResponse>> {
    if let Some(entry) = read_update_cache_stale(&state.data_dir, &id) {
        let stale = now_secs() - entry.fetched_at >= UPDATE_CACHE_TTL_SECS;
        Ok(Json(ModUpdatesCacheResponse {
            updates: entry.updates,
            stale,
        }))
    } else {
        Ok(Json(ModUpdatesCacheResponse {
            updates: Vec::new(),
            stale: true,
        }))
    }
}

/// DELETE /instance/{id}/files/mods/update-cache — 删除该实例的更新检查磁盘缓存。
/// 模组更新成功（新文件已替换旧文件）后调用，避免下次自动检查返回过期的更新条目。
async fn mods_update_cache_invalidate(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<StatusCode> {
    let path = update_cache_path(&state.data_dir, &id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StatusCode::NO_CONTENT),
        Err(_) => Ok(StatusCode::NO_CONTENT),
    }
}

/// GET /instance/{id}/files/mods/check-updates?force=0|1 — 检查模组更新。
///
/// 批次哈希匹配：Modrinth SHA1 两步（`version_files` → 当前版本，
/// `version_files/update` → 匹配加载器/游戏版本的最新版本）；CurseForge 指纹 →
/// 命中 file + latestFiles。判定规则（每个本地文件）：updateFile.Available 为真 &&
/// 新版本发布时间晚于本地文件 && 新版本文件哈希 ≠ 本地文件哈希。
/// 结果写入独立 update 缓存（6h TTL）。force=1 绕过缓存强制联网；
/// force=0 缓存命中（<6h）直接返回 refreshed=false。
async fn check_mod_updates(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<CheckUpdatesQuery>,
) -> ApiResult<Json<ModUpdatesResponse>> {
    let force = q.force.unwrap_or(0) != 0;
    if !force {
        if let Some(entry) = read_update_cache(&state.data_dir, &id) {
            return Ok(Json(ModUpdatesResponse {
                updates: entry.updates,
                refreshed: false,
            }));
        }
    }
    let updates = refresh_mod_updates(&state, &id).await?;
    write_update_cache(&state.data_dir, &id, updates.clone());
    Ok(Json(ModUpdatesResponse {
        updates,
        refreshed: true,
    }))
}

/// 联网执行更新检查（light 扫描 + Modrinth/CurseForge 批次反查），返回结果列表。
async fn refresh_mod_updates(
    state: &SharedState,
    instance_id: &str,
) -> ApiResult<Vec<ModUpdateEntryDto>> {
    let r = resolve(instance_id, state)?;
    let inst = state
        .instance
        .get_by_id(instance_id)
        .ok_or_else(|| instance_not_found(instance_id))?;
    let game_version = inst.game_version.clone();
    let loader = inst.loader.clone().unwrap_or_default();

    let mods = state.core.local_resource_provider().create_mods(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
    let list = mods.get_mod_list_light().await.map_err(map_core_error)?;

    let mut updates: Vec<ModUpdateEntryDto> = Vec::new();

    // ── Modrinth 严格两步（批次）──
    let mr = state.core.create_modrinth_source();
    let sha1s: Vec<String> = list
        .iter()
        .filter(|m| !m.sha1_hash.is_empty())
        .map(|m| m.sha1_hash.clone())
        .collect();
    let loaders: Vec<String> = if loader.is_empty() {
        Vec::new()
    } else {
        vec![loader.to_lowercase()]
    };
    let game_versions: Vec<String> = if game_version.is_empty() {
        Vec::new()
    } else {
        vec![game_version.clone()]
    };
    let (cur_map, latest_map_res) = tokio::join!(
        mr.get_project_versions_from_hashes_dict(&sha1s),
        mr.get_latest_versions_from_hashes(&sha1s, &loaders, &game_versions),
    );
    // 兼容性回退：实例 loader（如 Cleanroom/LiteLoader）不是 Modrinth 已知加载器，
    // 严格按 loader 过滤可能一个都不匹配；对漏掉的哈希改用「任意 loader + 同游戏版本」重查，
    // 使 Forge 系 mod（如 JEI）仍能检出更新。
    let mut latest_map = match latest_map_res {
        Ok(m) => m,
        Err(_) => HashMap::new(),
    };
    if !loaders.is_empty() {
        let missed: Vec<String> = sha1s
            .iter()
            .filter(|h| !latest_map.contains_key(*h))
            .cloned()
            .collect();
        if !missed.is_empty() {
            if let Ok(extra) = mr
                .get_latest_versions_from_hashes(&missed, &[], &game_versions)
                .await
            {
                latest_map.extend(extra);
            }
        }
    }
    if let Ok(cur_map) = cur_map {
        for info in list.iter().filter(|m| !m.sha1_hash.is_empty()) {
            let Some(cur) = cur_map.get(&info.sha1_hash) else {
                continue;
            };
            let Some(latest) = latest_map.get(&info.sha1_hash) else {
                continue;
            };
            // updateFile.Available：最新版本至少有一个文件
            let latest_file = latest
                .files
                .as_ref()
                .and_then(|f| f.iter().find(|f| f.is_primary).or_else(|| f.first()));
            let Some(latest_file) = latest_file else {
                continue;
            };
            // 发布时间晚于本地版本
            if latest.published_at <= cur.published_at {
                continue;
            }
            // 哈希不同
            let latest_sha1 = latest_file
                .hashes
                .as_ref()
                .and_then(|h| h.sha1.clone())
                .unwrap_or_default();
            if latest_sha1.is_empty() || latest_sha1 == info.sha1_hash {
                continue;
            }
            let latest_version = latest.version_number.clone().unwrap_or_default();
            if latest_version.is_empty() {
                continue;
            }
            updates.push(ModUpdateEntryDto {
                file_name: file_name_of(&info.file_path),
                name: info.name.clone(),
                current_version: info.version.clone(),
                latest_version,
                project_id: cur.project_id.clone(),
                source: "modrinth".to_string(),
                download_url: latest_file.download_url.clone(),
                new_file_name: latest_file.filename.clone(),
            });
        }
    }

    // ── CurseForge 指纹批次 ──
    if !state.curse_forge_api_key.is_empty() {
        let cf = state
            .core
            .create_curseforge_source(&state.curse_forge_api_key);
        let cf_hashes: Vec<i64> = list
            .iter()
            .filter(|m| m.cf_hash != 0)
            .map(|m| m.cf_hash)
            .collect();
        if let Ok(matches) = cf.get_fingerprint_matches(&cf_hashes).await {
            for m in matches {
                let Some(info) = list.iter().find(|i| i.cf_hash == m.fingerprint) else {
                    continue;
                };
                let Some(cur) = m.file.as_ref() else {
                    continue;
                };
                // updateFile = latestFiles 中匹配实例游戏版本/加载器、最新发布且 Available 的候选
                // （CF 指纹接口的 latestFiles 不随 gameVersion/modLoader 参数过滤，需在此自行过滤）
                let latest = m
                    .latest_files
                    .iter()
                    .filter(|f| f.is_available)
                    .filter(|f| f.game_versions.iter().any(|g| g == &game_version))
                    .filter(|f| {
                        // 实例 loader 非已知 CF 加载器（如 Cleanroom）时视为 Forge 兼容，不按加载器过滤
                        let is_known_loader = mod_loader_type::ALL
                            .iter()
                            .any(|l| l.eq_ignore_ascii_case(&loader));
                        let declared: Vec<&str> = f
                            .game_versions
                            .iter()
                            .map(|s| s.as_str())
                            .filter(|g| mod_loader_type::ALL.contains(g))
                            .collect();
                        !is_known_loader
                            || declared.is_empty()
                            || declared.iter().any(|g| g.eq_ignore_ascii_case(&loader))
                    })
                    .max_by(|a, b| a.file_date.cmp(&b.file_date));
                let Some(latest) = latest else {
                    continue;
                };
                let latest_date = latest.file_date.clone().unwrap_or_default();
                let cur_date = cur.file_date.clone().unwrap_or_default();
                // 发布时间晚于本地文件
                if latest_date.is_empty() || cur_date.is_empty() || latest_date <= cur_date {
                    continue;
                }
                // 哈希不同（algo 1 = SHA1）
                let latest_sha1 = latest
                    .hashes
                    .iter()
                    .find(|h| h.algo == 1)
                    .map(|h| h.value.clone())
                    .unwrap_or_default();
                if latest_sha1.is_empty() || latest_sha1 == info.sha1_hash {
                    continue;
                }
                let latest_version = latest
                    .display_name
                    .clone()
                    .or_else(|| latest.file_name.clone())
                    .unwrap_or_default();
                if latest_version.is_empty() {
                    continue;
                }
                updates.push(ModUpdateEntryDto {
                    file_name: file_name_of(&info.file_path),
                    name: info.name.clone(),
                    current_version: info.version.clone(),
                    latest_version,
                    project_id: cur.mod_id.to_string(),
                    source: "curseforge".to_string(),
                    download_url: latest.download_url.clone().unwrap_or_default(),
                    new_file_name: latest.file_name.clone().unwrap_or_default(),
                });
            }
        }
    }

    Ok(updates)
}

async fn enable_mod(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    let r = resolve(&id, &state)?;
    let path = category_dir(&r, "mods")
        .join(&name)
        .to_string_lossy()
        .into_owned();
    let mods = state.core.local_resource_provider().create_mods(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let path = category_dir(&r, "mods")
        .join(&name)
        .to_string_lossy()
        .into_owned();
    let mods = state.core.local_resource_provider().create_mods(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let mods = state.core.local_resource_provider().create_mods(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let mods = state.core.local_resource_provider().create_mods(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let rp = state.core.local_resource_provider().create_resourcepack(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let s = state.core.local_resource_provider().create_shaders(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let dp = state.core.local_resource_provider().create_data_packs(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let sc = state.core.local_resource_provider().create_screenshots(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
// Handlers: schematics (投影原理图 / Litematica)
// =====================================================================

async fn list_schematics(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FileEntryDto>>> {
    let r = resolve(&id, &state)?;
    Ok(Json(file_entries(&category_dir(&r, "schematics"))))
}

async fn delete_schematic(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Query(q): Query<NameQuery>,
) -> ApiResult<StatusCode> {
    let name = required_name(q.name)?;
    if !schematic_assets::is_plain_file_name(&name) {
        return Err(ApiError::bad_request("INVALID_NAME", "非法的文件名"));
    }
    let r = resolve(&id, &state)?;
    delete_file(&category_dir(&r, "schematics").join(&name));
    Ok(StatusCode::NO_CONTENT)
}

async fn rename_schematic(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<SaveRenameRequest>,
) -> ApiResult<StatusCode> {
    if !schematic_assets::is_plain_file_name(&req.old_name)
        || !schematic_assets::is_plain_file_name(&req.new_name)
    {
        return Err(ApiError::bad_request("INVALID_NAME", "非法的文件名"));
    }
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, "schematics");
    let src = dir.join(&req.old_name);
    if !src.is_file() {
        return Err(ApiError::not_found(
            "SCHEMATIC_NOT_FOUND",
            format!("原理图 '{}' 不存在", req.old_name),
        ));
    }
    let dst = dir.join(&req.new_name);
    if dst.exists() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "SCHEMATIC_EXISTS",
            format!("已存在同名文件 '{}'", req.new_name),
        ));
    }
    std::fs::rename(&src, &dst).map_err(|e| ApiError::internal(format!("重命名失败: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn import_schematic(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    mut multipart: Multipart,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    let dir = category_dir(&r, "schematics");
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request("MULTIPART_ERROR", e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let file_name = field
            .file_name()
            .map(String::from)
            .ok_or_else(|| ApiError::bad_request("MISSING_FILENAME", "缺少文件名"))?;
        if !schematic_assets::is_plain_file_name(&file_name) {
            return Err(ApiError::bad_request("INVALID_NAME", "非法的文件名"));
        }
        if !schematic_assets::is_valid_schematic_ext(&file_name) {
            return Err(ApiError::bad_request(
                "SCHEMATIC_BAD_EXTENSION",
                "仅支持 .litematic / .schematic / .schem / .nbt 文件",
            ));
        }
        let data = field
            .bytes()
            .await
            .map_err(|e| ApiError::bad_request("UPLOAD_READ_ERROR", e.to_string()))?;
        if data.is_empty() {
            return Err(ApiError::bad_request("EMPTY_FILE", "文件为空"));
        }
        if data.len() as u64 > SCHEMATIC_MAX_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "SCHEMATIC_TOO_LARGE",
                "原理图文件过大",
            ));
        }
        let dst = dir.join(&file_name);
        if dst.exists() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "SCHEMATIC_EXISTS",
                format!("已存在同名文件 '{file_name}'，请先重命名或删除"),
            ));
        }
        std::fs::write(&dst, &data).map_err(|e| ApiError::internal(format!("写入失败: {e}")))?;
        return Ok(StatusCode::NO_CONTENT);
    }
    Err(ApiError::bad_request(
        "MISSING_FILE",
        "缺少上传文件 (name=file)",
    ))
}

async fn schematic_bytes(
    AxumPath((id, name)): AxumPath<(String, String)>,
    State(state): State<SharedState>,
) -> ApiResult<Response> {
    if !schematic_assets::is_plain_file_name(&name) {
        return Err(ApiError::bad_request("INVALID_NAME", "非法的文件名"));
    }
    let r = resolve(&id, &state)?;
    let path = category_dir(&r, "schematics").join(&name);
    if !path.is_file() {
        return Err(ApiError::not_found(
            "SCHEMATIC_NOT_FOUND",
            format!("原理图 '{name}' 不存在"),
        ));
    }
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return Err(ApiError::internal(format!("读取失败: {e}"))),
    };
    if meta.len() > SCHEMATIC_MAX_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "SCHEMATIC_TOO_LARGE",
            "原理图文件过大，无法预览",
        ));
    }
    let bytes = std::fs::read(&path)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    )
        .into_response())
}

/// POST /instance/{id}/schematics/assets — 按调色板子集从用户游戏文件提取
/// blockstates/models/纹理（base64），磁盘缓存避免重复解 jar。
async fn schematic_assets(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<SchematicAssetsRequest>,
) -> ApiResult<Json<schematic_assets::SchematicAssetsBundle>> {
    let inst = state
        .instance
        .get_by_id(&id)
        .ok_or_else(|| instance_not_found(&id))?;
    let game_version = inst.game_version.clone();
    if game_version.trim().is_empty() {
        return Err(ApiError::bad_request(
            "GAME_VERSION_MISSING",
            "实例缺少游戏版本，无法定位材质",
        ));
    }
    let game_root = {
        let base = PathBuf::from(&inst.game_dir);
        if base.is_absolute() {
            base
        } else {
            crate::settings::resolve_base_dir().join(base)
        }
    };
    if req.blocks.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_BLOCKS",
            "缺少要提取的方块列表",
        ));
    }
    // 去重、排序后与缓存匹配
    let mut blocks = req.blocks.clone();
    blocks.sort();
    blocks.dedup();
    // 始终附带 mogic stone 兜底：前端把缺材质的方块渲染为石头。
    if !blocks.iter().any(|b| b == "minecraft:stone") {
        blocks.push("minecraft:stone".to_string());
        blocks.sort();
    }
    let cache_key = schematic_assets::bundle_cache_key(&game_root, &game_version, &blocks);
    let cache_path = schematic_assets::bundle_cache_path(&state.data_dir, &cache_key);
    if let Some(cached) = schematic_assets::read_bundle_cache(&cache_path) {
        return Ok(Json(cached));
    }
    let source = schematic_assets::locate_asset_source(&game_root, &game_version)
        .map_err(|msg| ApiError::not_found("SCHEMATIC_ASSETS_NOT_FOUND", msg))?;
    let bundle = schematic_assets::extract_bundle(&source, &blocks)
        .map_err(|e| ApiError::internal(format!("材质提取失败: {e}")))?;
    schematic_assets::write_bundle_cache(&cache_path, &bundle);
    Ok(Json(bundle))
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
    let saves = state.core.local_resource_provider().create_saves(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
        return Err(ApiError::not_found(
            "SAVE_NOT_FOUND",
            "Save directory not found",
        ));
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
    let saves = state.core.local_resource_provider().create_saves(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
    let saves = state.core.local_resource_provider().create_saves(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    );
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
// Handlers: save settings (level.dat NBT, core services/local/level_dat.rs)
// =====================================================================

/// 解析存档目录并校验存在（不存在 → 404 SAVE_NOT_FOUND）。
fn save_settings_dir(r: &Resolved, name: &str) -> ApiResult<PathBuf> {
    let dir = category_dir(r, "saves").join(name);
    if !dir.is_dir() {
        return Err(ApiError::not_found(
            "SAVE_NOT_FOUND",
            format!("Save directory '{name}' not found"),
        ));
    }
    Ok(dir)
}

/// 创建 Saves 管理器（与 saves_metadata 一致）。
fn saves_manager(
    state: &crate::state::AppState,
    r: &Resolved,
) -> Box<dyn qomicex_core::api::local::SavesManager + Send + Sync> {
    state.core.local_resource_provider().create_saves(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &state.curse_forge_api_key,
    )
}

/// core 存档设置错误映射：文件级业务错误（Params）→ 400；其余 → 500。
fn map_level_dat_error(e: qomicex_core::error::Error) -> ApiError {
    match &e {
        qomicex_core::error::Error::Params { .. } => {
            ApiError::bad_request("BAD_REQUEST", e.to_string())
        }
        _ => ApiError::internal(e.to_string()),
    }
}

/// GET /instance/{id}/files/saves/{name}/settings — 读取存档设置。
async fn save_settings_get(
    AxumPath((id, name)): AxumPath<(String, String)>,
    State(state): State<SharedState>,
) -> ApiResult<Json<LevelDatSettings>> {
    let r = resolve(&id, &state)?;
    let save_dir = save_settings_dir(&r, &name)?;
    if !save_dir.join("level.dat").is_file() {
        return Err(ApiError::not_found(
            "SAVE_LEVEL_DAT_NOT_FOUND",
            format!("level.dat not found in save '{name}'"),
        ));
    }
    let saves = saves_manager(&state, &r);
    let settings = saves
        .read_level_dat_settings(&save_dir.to_string_lossy())
        .map_err(map_level_dat_error)?;
    Ok(Json(settings))
}

/// PUT /instance/{id}/files/saves/{name}/settings — 更新存档设置（写前备份+失败回滚）。
async fn save_settings_put(
    AxumPath((id, name)): AxumPath<(String, String)>,
    State(state): State<SharedState>,
    Json(req): Json<LevelDatSettings>,
) -> ApiResult<Json<LevelDatSettings>> {
    let r = resolve(&id, &state)?;
    let save_dir = save_settings_dir(&r, &name)?;
    if !save_dir.join("level.dat").is_file() {
        return Err(ApiError::not_found(
            "SAVE_LEVEL_DAT_NOT_FOUND",
            format!("level.dat not found in save '{name}'"),
        ));
    }
    let saves = saves_manager(&state, &r);
    let path = save_dir.to_string_lossy().into_owned();
    saves
        .update_level_dat_settings(&path, &req)
        .map_err(map_level_dat_error)?;
    // 返回服务器侧最新值（写回后重读，含默认补齐字段）。
    let updated = saves
        .read_level_dat_settings(&path)
        .map_err(map_level_dat_error)?;
    Ok(Json(updated))
}

/// POST /instance/{id}/files/saves/{name}/settings/restore — 从 level.dat_old 恢复。
async fn save_settings_restore(
    AxumPath((id, name)): AxumPath<(String, String)>,
    State(state): State<SharedState>,
) -> ApiResult<Json<LevelDatSettings>> {
    let r = resolve(&id, &state)?;
    let save_dir = save_settings_dir(&r, &name)?;
    if !save_dir.join("level.dat_old").is_file() {
        return Err(ApiError::not_found(
            "SAVE_LEVEL_DAT_OLD_NOT_FOUND",
            format!("level.dat_old not found in save '{name}'"),
        ));
    }
    let saves = saves_manager(&state, &r);
    let path = save_dir.to_string_lossy().into_owned();
    saves
        .restore_level_dat_from_old(&path)
        .map_err(map_level_dat_error)?;
    let settings = saves
        .read_level_dat_settings(&path)
        .map_err(map_level_dat_error)?;
    Ok(Json(settings))
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
    let sm = state.core.local_resource_provider().create_server_manager(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
    );
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
    let sm = state.core.local_resource_provider().create_server_manager(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
    );
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
    let ip =
        q.ip.ok_or_else(|| ApiError::bad_request("MISSING_IP", "ip is required"))?;
    let r = resolve(&id, &state)?;
    let sm = state.core.local_resource_provider().create_server_manager(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
    );
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
    let sm = state.core.local_resource_provider().create_server_manager(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
    );
    Ok(Json(sm.get_server_state_by_address_async(&address).await))
}

/// 发现局域网服务器（C# DiscoverLanServers(TimeSpan.FromSeconds(5))）。
async fn lan_games(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<qomicex_core::models::local::LanServerEntry>>> {
    let r = resolve(&id, &state)?;
    let sm = state.core.local_resource_provider().create_server_manager(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
    );
    Ok(Json(
        sm.discover_lan_servers(std::time::Duration::from_secs(5)),
    ))
}

// =====================================================================
// Options (per-instance options.txt; source: C# CreateGameSettingsOptions)
// =====================================================================

/// GET /instance/{id}/files/options — list all game settings.
async fn options_list(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<Vec<qomicex_core::models::local::OptionViewItem>>> {
    let r = resolve(&id, &state)?;
    let inst = state
        .instance
        .get_by_id(&id)
        .ok_or_else(|| instance_not_found(&id))?;
    let language = settings::load_settings().language;
    let items = crate::services::options::list_options(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &inst.game_version,
        &language,
    );
    Ok(Json(items))
}

/// GET /instance/{id}/files/options/{name} — single option definition.
async fn options_get(
    State(state): State<SharedState>,
    AxumPath((id, name)): AxumPath<(String, String)>,
) -> ApiResult<Json<qomicex_core::models::local::OptionViewItem>> {
    let r = resolve(&id, &state)?;
    let inst = state
        .instance
        .get_by_id(&id)
        .ok_or_else(|| instance_not_found(&id))?;
    let language = settings::load_settings().language;
    let item = crate::services::options::get_option(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &inst.game_version,
        &language,
        &name,
    )
    .ok_or_else(|| ApiError::not_found("OPTION_NOT_FOUND", format!("Option '{name}' not found")))?;
    Ok(Json(item))
}

/// PUT /instance/{id}/files/options/{name} — set an option value.
async fn options_put(
    State(state): State<SharedState>,
    AxumPath((id, name)): AxumPath<(String, String)>,
    Json(body): Json<OptionsPutBody>,
) -> ApiResult<StatusCode> {
    let r = resolve(&id, &state)?;
    crate::services::options::set_option(
        r.game_dir.to_str().unwrap_or_default(),
        &r.version,
        r.isolated,
        &name,
        &body.value,
    )
    .map_err(|e| ApiError::internal(format!("写入 options.txt 失败: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct OptionsPutBody {
    value: String,
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

/// Fallback remote-icon enrichment for mods without a local icon. Mirrors C#
/// FillRemoteIcons: CurseForge by mod id, then Modrinth by project id/slug.
/// CF 与 MR 反查并行（tokio::join!）。All errors are swallowed so a lookup
/// failure cannot break the metadata flow.
async fn fill_remote_icons(client: &reqwest::Client, api_key: &str, result: &mut [ModMetadataDto]) {
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
