//! Version 端点（对应源 Endpoints/VersionEndpoints.cs）。
//! 版本清单/最新/已安装/远程/扫描（loader 探测 + 6 级回退）/元数据/安装/卸载。
//!
//! 依赖：core version 门面（AppState.core.version()）、InstanceService（AppState.instance，
//! 用于 /versions/scan 的实例自动修复）。
//!
//! 与源的差异：
//! - ResolveGameVersion 第 1 级 `GameVersionHelper.FromJar`（读 JAR 内 version 数据）Rust 侧
//!   无现成实现，且不引入 zip 依赖 → 以待补 TODO 跳过（见 `from_jar_game_version`），
//!   该级暂不生效，回退到 clientVersion → minecraftVersion → inheritsFrom → arguments → regex。
//! - `/versions/{name}` 及子路由通过 axum 静态路由优先匹配，与较长的
//!   `/latest`/`/installed`/`/remote`/`/scan` 无冲突。

use std::path::Path;

use axum::extract::{Path as AxumPath, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;

use qomicex_core::models::local::LocalVersionInfo;
use qomicex_core::models::version_manifest::{LatestVersionInfo, ManifestVersionInfo};
use qomicex_core::models::version_metadata::CompleteVersionMetadata;

use crate::error::{ApiError, ApiResult};
use crate::services::instance::InstanceService;
use crate::state::SharedState;

// =====================================================================
// DTO
// =====================================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ScannedVersionEntry {
    name: String,
    game_version: String,
    state: String,
    state_describe: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    loaders: Option<Vec<ScannedLoaderEntry>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ScannedLoaderEntry {
    r#type: String,
    version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanVersionsResponse {
    path: String,
    versions: Vec<ScannedVersionEntry>,
    no_json_dirs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForceRefreshQuery {
    force_refresh: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanQuery {
    game_dir: String,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/versions", get(versions))
        .route("/versions/latest", get(latest))
        .route("/versions/installed", get(installed))
        .route("/versions/remote", get(remote))
        .route("/versions/scan", get(scan))
        .route("/versions/{name}", get(version_metadata))
        .route("/versions/{name}/install", post(install_version))
        .route("/versions/{name}/uninstall", post(uninstall_version))
}

// =====================================================================
// Handlers
// =====================================================================

async fn versions(
    State(state): State<SharedState>,
    Query(q): Query<ForceRefreshQuery>,
) -> ApiResult<Json<Vec<ManifestVersionInfo>>> {
    let versions = state
        .core
        .version()
        .get_available_versions(q.force_refresh.unwrap_or(false))
        .await
        .map_err(map_core_err)?;
    Ok(Json(versions))
}

async fn latest(
    State(state): State<SharedState>,
    Query(q): Query<ForceRefreshQuery>,
) -> ApiResult<Json<LatestVersionInfo>> {
    let latest = state
        .core
        .version()
        .get_latest_versions(q.force_refresh.unwrap_or(false))
        .await
        .map_err(map_core_err)?;
    Ok(Json(latest))
}

async fn installed(State(state): State<SharedState>) -> ApiResult<Json<Vec<LocalVersionInfo>>> {
    Ok(Json(state.core.version().get_installed_versions()))
}

async fn remote(
    State(state): State<SharedState>,
    Query(_q): Query<RemoteQuery>,
) -> ApiResult<Json<Vec<ManifestVersionInfo>>> {
    match state
        .core
        .version()
        .get_available_versions(false)
        .await
    {
        Ok(versions) => Ok(Json(versions)),
        Err(_) => Ok(Json(Vec::new())),
    }
}

async fn scan(
    State(state): State<SharedState>,
    Query(q): Query<ScanQuery>,
) -> ApiResult<Json<ScanVersionsResponse>> {
    let mut result: Vec<ScannedVersionEntry> = Vec::new();
    let abs_dir = std::path::absolute(&q.game_dir).unwrap_or_else(|_| Path::new(&q.game_dir).to_path_buf());
    let versions_dir = abs_dir.join("versions");

    tracing::info!(
        game_dir = %q.game_dir,
        abs_dir = %abs_dir.display(),
        versions_dir = %versions_dir.display(),
        versions_exists = versions_dir.is_dir(),
        "scan"
    );

    if versions_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&versions_dir) {
            for dir in entries.flatten() {
                let dir_path = dir.path();
                if !dir_path.is_dir() {
                    continue;
                }
                let name = dir.file_name().to_string_lossy().into_owned();
                let json_path = dir_path.join(format!("{name}.json"));
                if !json_path.is_file() {
                    result.push(ScannedVersionEntry {
                        name: name.clone(),
                        game_version: name.clone(),
                        state: "Corrupted".to_string(),
                        state_describe: "版本文件缺失".to_string(),
                        loaders: None,
                    });
                    continue;
                }

                let root = match std::fs::read(&json_path).and_then(|bytes| {
                    serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|e| {
                        std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
                    })
                }) {
                    Ok(root) => root,
                    Err(e) => {
                        tracing::warn!(name = %name, error = %e, "scan: failed to parse json");
                        continue;
                    }
                };

                let id = root
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| name.clone());
                let inherits_from = root
                    .get("inheritsFrom")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let mc_version = root
                    .get("minecraftVersion")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let client_version = root
                    .get("clientVersion")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let main_class = root
                    .get("mainClass")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let game_version = resolve_game_version(
                    &root,
                    &id,
                    inherits_from.as_deref(),
                    client_version.as_deref(),
                    mc_version.as_deref(),
                    &dir_path,
                );

                let loaders = detect_loaders(&root, &main_class, &id, inherits_from.as_deref());

                result.push(ScannedVersionEntry {
                    name: id.clone(),
                    game_version,
                    state: "Available".to_string(),
                    state_describe: String::new(),
                    loaders: if loaders.is_empty() { None } else { Some(loaders) },
                });
            }
        }

        tracing::info!(count = result.len(), "scan: found versions");
        fix_instance_game_versions(&state.instance, &result, &q.game_dir);
        fix_instance_loaders(&state.instance, &result, &q.game_dir);
    }

    Ok(Json(ScanVersionsResponse {
        path: abs_dir.to_string_lossy().into_owned(),
        versions: result,
        no_json_dirs: Vec::new(),
    }))
}

async fn version_metadata(
    State(state): State<SharedState>,
    AxumPath(name): AxumPath<String>,
) -> ApiResult<Json<CompleteVersionMetadata>> {
    let metadata = state
        .core
        .version()
        .get_version_metadata(&name)
        .await
        .map_err(map_core_err)?;
    Ok(Json(metadata))
}

async fn install_version(
    State(state): State<SharedState>,
    AxumPath(name): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    state
        .core
        .version()
        .install_version(&name, None)
        .await
        .map_err(map_core_err)?;
    Ok(Json(MessageResponse {
        message: format!("Installing version {name}"),
        version_id: Some(name),
    }))
}

async fn uninstall_version(
    State(state): State<SharedState>,
    AxumPath(name): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    if !state.core.version().is_version_installed(&name) {
        return Err(ApiError::not_found(
            "VERSION_NOT_FOUND",
            format!("Version {name} is not installed"),
        ));
    }
    state
        .core
        .version()
        .uninstall_version(&name)
        .await
        .map_err(map_core_err)?;
    Ok(Json(MessageResponse {
        message: format!("Uninstalled version {name}"),
        version_id: None,
    }))
}

#[derive(Deserialize)]
struct RemoteQuery {
    #[allow(dead_code)]
    source: Option<i32>,
}

// =====================================================================
// 工具
// =====================================================================

fn map_core_err(e: qomicex_core::error::Error) -> ApiError {
    match e {
        qomicex_core::error::Error::VersionNotFound { message, .. } => {
            ApiError::not_found("VERSION_NOT_FOUND", message)
        }
        other => ApiError::internal(other.to_string()),
    }
}

/// 从 JAR 读取游戏版本（对应源 `GameVersionHelper.FromJar`）。
///
/// ⚠️ 差异/TODO：源从 JAR 内读取版本数据（需解析 zip），Rust 侧无现成实现且为保持零新增
/// 依赖，本函数暂不实现，恒返回 None（等效"读取失败 → 跳过该级"，回退到后续 5 级）。
/// 后续如需最高精度可引入 zip crate 并解析 `version.json` 条目后补齐。
fn from_jar_game_version(_jar_path: &Path) -> Option<String> {
    // TODO: 实现 GameVersionHelper.FromJar（zip 内 version 数据读取）。
    None
}

/// 6 级回退游戏版本探测：JAR → clientVersion → minecraftVersion → inheritsFrom → arguments → regex。
fn resolve_game_version(
    root: &serde_json::Value,
    id: &str,
    inherits_from: Option<&str>,
    client_version: Option<&str>,
    mc_version: Option<&str>,
    version_dir: &Path,
) -> String {
    // 1. JAR（最高精度；Rust 侧暂跳过）
    let jar_id = inherits_from.unwrap_or(id);
    let mut jar_path = version_dir.join(format!("{jar_id}.jar"));
    if !jar_path.is_file() && jar_id != id {
        jar_path = version_dir.join(format!("{id}.jar"));
    }
    if jar_path.is_file() {
        if let Some(v) = from_jar_game_version(&jar_path) {
            if !v.is_empty() {
                return v;
            }
        }
    }

    // 2. clientVersion（源安装器 MergeVersionJson 后写入）
    if let Some(cv) = client_version {
        if !cv.is_empty() {
            return cv.to_string();
        }
    }

    // 3. minecraftVersion（vanilla JSON 标准字段）
    if let Some(mv) = mc_version {
        if !mv.is_empty() {
            return mv.to_string();
        }
    }

    // 4. inheritsFrom（Forge/NeoForge 未合并 JSON 标准字段）
    if let Some(inf) = inherits_from {
        if !inf.is_empty() {
            return inf.to_string();
        }
    }

    // 5. arguments.game 中的 --fml.mcVersion（Forge 1.13+）
    if let Some(serde_json::Value::Array(game)) = root.pointer("/arguments/game") {
        for i in 0..game.len().saturating_sub(1) {
            if game[i].as_str() == Some("--fml.mcVersion") {
                if let Some(v) = game[i + 1].as_str() {
                    if !v.is_empty() {
                        return v.to_string();
                    }
                }
            }
        }
    }

    // 6. 从 id 正则提取前导版本号（^(\d+\.\d+(?:\.\d+)?)）
    if let Some(prefix) = extract_version_prefix(id) {
        return prefix;
    }

    id.to_string()
}

/// 手动实现源正则 `^(\d+\.\d+(?:\.\d+)?)`（避免引入 regex crate）。
fn extract_version_prefix(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut i = 0;

    fn consume_digits(bytes: &[u8], n: usize, i: &mut usize) -> Option<()> {
        let start = *i;
        while *i < n && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        if *i == start {
            None
        } else {
            Some(())
        }
    }

    consume_digits(bytes, n, &mut i)?; // \d+
    if i < n && bytes[i] == b'.' {
        i += 1;
    } else {
        return None;
    }
    consume_digits(bytes, n, &mut i)?; // \d+
    if i < n && bytes[i] == b'.' {
        let save = i;
        i += 1;
        if consume_digits(bytes, n, &mut i).is_none() {
            i = save; // 回退：不带可选 .\d+
        }
    }
    Some(s[..i].to_string())
}

/// Loader 探测（逐字移植源 DetectLoaders）。
/// 提取 loader 版本（对齐 C# core `GetModloaderType`：版本号含 `-` 且恰好 2 段时取后段，
/// 否则用全名。如 `1.12.2-14.23.5.2860` → `14.23.5.2860`；`21.1.233` → `21.1.233`）。
fn extract_loader_version(raw: &str) -> String {
    let ver_parts: Vec<&str> = raw.split('-').collect();
    if ver_parts.len() == 2 {
        ver_parts[1].to_string()
    } else {
        raw.to_string()
    }
}

fn has_loader(types: &[ScannedLoaderEntry], r#type: &str) -> bool {
    types.iter().any(|t| t.r#type == r#type)
}

/// 加载器探测（对齐 C# core `DefaultVersionLocator.GetModloaderType` 的完整语义；
/// 补充 Neo 端点的 inheritsFrom 猜测作为 Unknown 兜底前的最后一级）：
/// - libraries：OptiFine / LiteLoader / Cleanroom / 老版 Forge（`parts[1]=="forge"`）/
///   新版 Forge（`fmlloader`）/ Babric / Fabric（含 LegacyFabric）/ Quilt
/// - arguments：`--fml.neoForgeVersion` / `--fml.forgeVersion` 下一元素
/// - mainClass 精确匹配（Vanilla / Quilt / NeoForge / Fabric / Forge / Cleanroom）
/// - `net.minecraft.launchwrapper.Launch`（无其他 loader 时）→ Vanilla
/// - 兜底：inheritsFrom 按 id 猜测 → 仍空则 Unknown
fn detect_loaders(
    root: &serde_json::Value,
    main_class: &str,
    id: &str,
    inherits_from: Option<&str>,
) -> Vec<ScannedLoaderEntry> {
    let mut types: Vec<ScannedLoaderEntry> = Vec::new();

    // ── 1. libraries（对齐 C#：name.ToLower() 全名 contains 预过滤 + parts 精确判定）──
    if let Some(serde_json::Value::Array(libs)) = root.get("libraries") {
        for lib in libs {
            let name = lib.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let lower = name.to_lowercase();
            let parts: Vec<&str> = name.split(':').collect();
            if parts.len() < 3 {
                continue;
            }

            if lower.contains("optifine") && parts[1] == "optifine" && !has_loader(&types, "OptiFine") {
                types.push(ScannedLoaderEntry { r#type: "OptiFine".into(), version: extract_loader_version(parts[2]) });
            }
            if lower.contains("liteloader") && parts[1] == "liteloader" && !has_loader(&types, "LiteLoader") {
                types.push(ScannedLoaderEntry { r#type: "LiteLoader".into(), version: extract_loader_version(parts[2]) });
            }
            if lower.contains("cleanroom")
                && parts[1].to_lowercase().contains("cleanroom")
                && !has_loader(&types, "Cleanroom")
            {
                types.push(ScannedLoaderEntry { r#type: "Cleanroom".into(), version: extract_loader_version(parts[2]) });
            }
            // 老版 Forge（≤1.12.2）：`net.minecraftforge:forge:1.12.2-14.23.5.2860`
            if lower.contains("forge") && parts[1] == "forge" && !has_loader(&types, "Forge") {
                types.push(ScannedLoaderEntry { r#type: "Forge".into(), version: extract_loader_version(parts[2]) });
            }
            // 新版 Forge（1.13+）：`net.minecraftforge:fmlloader:1.20.1-47.2.0`
            if lower.contains("minecraftforge")
                && parts[1] == "fmlloader"
                && !has_loader(&types, "Forge")
            {
                types.push(ScannedLoaderEntry { r#type: "Forge".into(), version: extract_loader_version(parts[2]) });
            }
            // NeoForge：`net.neoforged:neoforge:{ver}` 库形态（部分版本 JSON 无
            // --fml.neoForgeVersion 参数时靠此识别；mainClass 精确匹配兜底）
            if lower.contains("neoforge")
                && parts[1] == "neoforge"
                && !has_loader(&types, "NeoForge")
            {
                types.push(ScannedLoaderEntry { r#type: "NeoForge".into(), version: extract_loader_version(parts[2]) });
            }
            if lower.contains("babric")
                && parts[0].eq_ignore_ascii_case("babric")
                && !has_loader(&types, "Babric")
            {
                types.push(ScannedLoaderEntry { r#type: "Babric".into(), version: "Unknown".into() });
            }
            if lower.contains("fabric")
                && !has_loader(&types, "Babric")
                && (parts[1] == "fabric" || parts[1] == "fabric-loader")
            {
                if parts[0].to_lowercase().contains("legacyfabric") {
                    if !has_loader(&types, "LegacyFabric") {
                        types.push(ScannedLoaderEntry { r#type: "LegacyFabric".into(), version: parts[2].to_string() });
                    }
                } else if !has_loader(&types, "Fabric") {
                    types.push(ScannedLoaderEntry { r#type: "Fabric".into(), version: parts[2].to_string() });
                }
            }
            if lower.contains("quilt")
                && (parts[1] == "quilt" || parts[1] == "quilt-loader")
                && !has_loader(&types, "Quilt")
            {
                types.push(ScannedLoaderEntry { r#type: "Quilt".into(), version: parts[2].to_string() });
            }
        }
    }

    // ── 2. arguments（对齐 C#：--fml.neoForgeVersion / --fml.forgeVersion 的下一非参数元素）──
    if let Some(serde_json::Value::Array(game)) = root.pointer("/arguments/game") {
        let mut prev: Option<String> = None;
        for item in game {
            let Some(s) = item.as_str() else {
                prev = None;
                continue;
            };
            if prev.as_deref() == Some("--fml.neoForgeVersion") && !s.starts_with("--") {
                if !has_loader(&types, "NeoForge") {
                    types.push(ScannedLoaderEntry { r#type: "NeoForge".into(), version: s.to_string() });
                }
                break;
            }
            if prev.as_deref() == Some("--fml.forgeVersion") && !s.starts_with("--") {
                if !has_loader(&types, "Forge") {
                    types.push(ScannedLoaderEntry { r#type: "Forge".into(), version: s.to_string() });
                }
            }
            prev = Some(s.to_string());
        }
    }

    // ── 3. mainClass 精确匹配（对齐 C#：小写精确字符串）──
    let mc = main_class.to_lowercase();
    if mc == "net.minecraft.client.main.main" {
        return vec![ScannedLoaderEntry { r#type: "Vanilla".into(), version: String::new() }];
    }
    if !has_loader(&types, "Quilt") && mc == "org.quiltmc.loader.impl.launch.knot.knotclient" {
        types.push(ScannedLoaderEntry { r#type: "Quilt".into(), version: String::new() });
    }
    if !has_loader(&types, "NeoForge") && !has_loader(&types, "Forge")
        && mc == "cpw.mods.bootstraplauncher.bootstraplauncher"
    {
        types.push(ScannedLoaderEntry { r#type: "NeoForge".into(), version: String::new() });
    }
    if !has_loader(&types, "Fabric") && !has_loader(&types, "Babric")
        && mc == "net.fabricmc.loader.impl.launch.knot.knotclient"
    {
        types.push(ScannedLoaderEntry { r#type: "Fabric".into(), version: String::new() });
    }
    if !has_loader(&types, "Forge") && mc == "net.minecraftforge.bootstrap.bootstraplauncher" {
        types.push(ScannedLoaderEntry { r#type: "Forge".into(), version: String::new() });
    }
    if !has_loader(&types, "Cleanroom") && mc == "top.outlands.foundation.boot.foundation" {
        types.push(ScannedLoaderEntry { r#type: "Cleanroom".into(), version: String::new() });
    }

    // ── 4. 老版原版（≤1.12.2）：launchwrapper 且无任何 loader → Vanilla ──
    if mc == "net.minecraft.launchwrapper.launch"
        && !has_loader(&types, "OptiFine")
        && !has_loader(&types, "Forge")
        && !has_loader(&types, "NeoForge")
        && !has_loader(&types, "LiteLoader")
        && !has_loader(&types, "Fabric")
        && !has_loader(&types, "Quilt")
        && !has_loader(&types, "Cleanroom")
        && !has_loader(&types, "Babric")
    {
        return vec![ScannedLoaderEntry { r#type: "Vanilla".into(), version: String::new() }];
    }

    // ── 5. 兜底：inheritsFrom 按 id 猜测（Neo 端点级，C# core 无此级）→ 仍空则 Unknown ──
    if types.is_empty() {
        if let Some(inherits) = inherits_from {
            if inherits != id {
                let lower_id = id.to_lowercase();
                let guess = if lower_id.contains("-forge-") {
                    Some("Forge")
                } else if lower_id.contains("-fabric-") {
                    Some("Fabric")
                } else if lower_id.contains("-quilt-") {
                    Some("Quilt")
                } else if lower_id.contains("-neoforge-") {
                    Some("NeoForge")
                } else if lower_id.contains("-cleanroom") {
                    Some("Cleanroom")
                } else if lower_id.contains("-legacyfabric-") {
                    Some("LegacyFabric")
                } else if lower_id.contains("-babric-") {
                    Some("Babric")
                } else {
                    None
                };
                if let Some(g) = guess {
                    types.push(ScannedLoaderEntry { r#type: g.into(), version: id.to_string() });
                }
            }
        }
    }
    if types.is_empty() {
        types.push(ScannedLoaderEntry { r#type: "Unknown".into(), version: "Unknown".into() });
    }

    types
}

/// 自动修复 gameVersion 不匹配的既有实例（对应源 FixInstanceGameVersions）。
fn fix_instance_game_versions(
    instances: &InstanceService,
    scanned: &[ScannedVersionEntry],
    game_dir: &str,
) {
    for inst in instances.get_all() {
        if inst.game_dir != game_dir {
            continue;
        }
        let Some(scanned_version) = scanned.iter().find(|s| s.name == inst.name) else {
            continue;
        };
        if inst.game_version != scanned_version.game_version {
            tracing::info!(
                name = %inst.name,
                old = %inst.game_version,
                new = %scanned_version.game_version,
                "scan: fixing instance gameVersion"
            );
            let mut updated = inst.clone();
            updated.game_version = scanned_version.game_version.clone();
            let uid = updated.id.clone();
            instances.update(&uid, updated);
        }
    }
}

/// 自动修复 loader 缺失/不匹配的既有实例（对应源 FixInstanceLoaders）。
fn fix_instance_loaders(
    instances: &InstanceService,
    scanned: &[ScannedVersionEntry],
    game_dir: &str,
) {
    for inst in instances.get_all() {
        if inst.game_dir != game_dir {
            continue;
        }
        let Some(scanned_version) = scanned.iter().find(|s| s.name == inst.name) else {
            continue;
        };
        let Some(first) = scanned_version.loaders.as_ref().and_then(|l| l.first()) else {
            continue;
        };
        // Vanilla/Unknown 不写入实例 loader（原版实例 loader 保持空，未知版本不猜测覆盖）
        if first.r#type == "Vanilla" || first.r#type == "Unknown" {
            continue;
        }
        if inst.loader.as_deref() != Some(first.r#type.as_str())
            || inst.loader_version.as_deref() != Some(first.version.as_str())
        {
            tracing::info!(
                name = %inst.name,
                old_loader = inst.loader.as_deref().unwrap_or(""),
                old_ver = inst.loader_version.as_deref().unwrap_or(""),
                new_loader = %first.r#type,
                new_ver = %first.version,
                "scan: fixing instance loader"
            );
            let mut updated = inst.clone();
            updated.loader = Some(first.r#type.clone());
            updated.loader_version = Some(first.version.clone());
            let uid = updated.id.clone();
            instances.update(&uid, updated);
        }
    }
}
