//! Loader 端点（对应源 Endpoints/LoaderEndpoints.cs）。
//!
//! 提供模组加载器（Forge / NeoForge / Fabric / Quilt / LiteLoader / OptiFine /
//! Cleanroom / LegacyFabric / Babric）可用版本枚举与下载信息，以及加载器相关
//! 附加组件（OptiFine / fabric-api / qsl）的信息。
//!
//! 路径挂载 `/loader/...`（源 C# 为 `/api/loaders/...`，按切片规划统一为 `/loader`）。
//!
//! 依赖说明：
//! - `GameCore::installer_provider()` → `qomicex_core::api::installer::InstallerProvider`，
//!   `get_available_mod_loaders(&self, game_version, r#type) -> Result<Vec<ModLoaderResult>, Error>`。
//! - `GameCore::create_modrinth_source()` → `Box<dyn ModrinthSource>`,
//!   `get_project_info(&self, project_id) -> Result<ProjectInfo, Error>`。
//!
//! 与源差异：
//! - Rust 侧 `installer_provider()` 恒非空（无 C# 的 null 分支），故直接调用。
//! - 源各 modrinth/optifine 调用外层 try/catch 吞错 → Rust 用 `.ok()` 等价忽略失败。
//! - 源 `GetProjectInfoAsync` 返回可空 `ProjectInfo?`；Rust `get_project_info` 返回非空
//!   `ProjectInfo`，`Ok` 恒有值，故无条件加入列表。

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use qomicex_core::models::installer::ModLoaderType;

use crate::error::{ApiError, ApiResult};
use crate::state::SharedState;

/// Loader 版本信息 DTO（源：Models/LoaderVersionInfo，camelCase）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderVersionInfo {
    pub r#type: i32,
    pub version: String,
    pub minecraft_version: String,
    pub download_url: String,
    pub sha1: String,
    pub is_recommended: bool,
    pub published_at: String,
}

/// Loader 附加组件信息 DTO（源：Models/LoaderAddonInfo，camelCase）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderAddonInfo {
    pub id: String,
    pub label: String,
    pub recommended: bool,
    pub description: String,
    pub icon_url: String,
    pub project_url: String,
    pub downloads: i32,
}

/// `/loader/versions` 查询参数。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionsQuery {
    game_version: Option<String>,
    loader: Option<String>,
    lang: Option<String>,
    refresh: Option<String>,
}

/// `/loader/addons` 查询参数。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddonsQuery {
    loader: String,
    game_version: Option<String>,
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/loaders/versions", get(loader_versions))
        .route("/loaders/addons", get(loader_addons))
}

/// GET `/loader/versions`：枚举指定游戏版本可用的加载器版本（源 LoaderEndpoints `/versions`）。
async fn loader_versions(
    State(state): State<SharedState>,
    Query(q): Query<VersionsQuery>,
) -> ApiResult<Json<Vec<LoaderVersionInfo>>> {
    let game_version = q.game_version.unwrap_or_default();
    if game_version.trim().is_empty() {
        return Err(ApiError::bad_request(
            "LOADER_VERSION_MISSING_GAME_VERSION",
            "gameVersion is required",
        ));
    }

    let loader_str = q.loader.as_deref().unwrap_or("All");
    let loader_type = parse_loader(loader_str).ok_or_else(|| {
        ApiError::bad_request(
            "LOADER_VERSION_INVALID_LOADER",
            format!("Invalid loader: {loader_str}"),
        )
    })?;

    // NeoForge：中文环境（zh* 变体）优先 BMCLAPI（ENH-07）+ 版本缓存（ENH-09）
    let results = if loader_type == ModLoaderType::NeoForge {
        let prefer_bmclapi = is_chinese_lang(q.lang.as_deref().unwrap_or(""));
        let force_refresh = q.refresh.as_deref() == Some("1");
        state
            .core
            .installer_provider()
            .get_neoforge_versions_with_priority(&game_version, prefer_bmclapi, force_refresh)
            .await
            .map_err(map_core_error)?
    } else {
        state
            .core
            .installer_provider()
            .get_available_mod_loaders(&game_version, loader_type)
            .await
            .map_err(map_core_error)?
    };

    let infos = results
        .into_iter()
        .map(|r| LoaderVersionInfo {
            r#type: r.r#type as i32,
            version: r.version,
            minecraft_version: r.game_version,
            download_url: r.url,
            sha1: r.sha1,
            is_recommended: r.is_recommand,
            published_at: r.release_time,
        })
        .collect();

    Ok(Json(infos))
}

/// GET `/loader/addons`：返回指定加载器的推荐附加组件（源 LoaderEndpoints `/addons`）。
///
/// 各上游调用失败时静默忽略（源对应 try {} catch {}），返回已收集到的可用条目。
async fn loader_addons(
    State(state): State<SharedState>,
    Query(q): Query<AddonsQuery>,
) -> ApiResult<Json<Vec<LoaderAddonInfo>>> {
    let mut result: Vec<LoaderAddonInfo> = Vec::new();

    if q.loader.eq_ignore_ascii_case("Forge") {
        if let Some(gv) = q
            .game_version
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Ok(optifine_versions) = state
                .core
                .installer_provider()
                .get_available_mod_loaders(gv, ModLoaderType::OptiFine)
                .await
            {
                if let Some(latest) = optifine_versions
                    .iter()
                    .max_by(|a, b| a.version.cmp(&b.version))
                {
                    result.push(LoaderAddonInfo {
                        id: "optifine".to_string(),
                        label: "OptiFine".to_string(),
                        recommended: latest.is_recommand,
                        description: "Minecraft 性能优化与光影支持，提升 FPS 并支持光影着色器"
                            .to_string(),
                        icon_url: "https://optifine.net/favicon.ico".to_string(),
                        project_url: latest.url.clone(),
                        downloads: 0,
                    });
                }
            }
        }
    }

    let modrinth_source = state.core.create_modrinth_source();

    if q.loader.eq_ignore_ascii_case("Fabric") {
        if let Ok(info) = modrinth_source.get_project_info("fabric-api").await {
            result.push(LoaderAddonInfo {
                id: "fabric-api".to_string(),
                label: info.name,
                recommended: true,
                description: info.description,
                icon_url: info.icon_url.unwrap_or_default(),
                project_url: "https://modrinth.com/mod/fabric-api".to_string(),
                downloads: info.download_count,
            });
        }
    }

    if q.loader.eq_ignore_ascii_case("Quilt") {
        if let Ok(info) = modrinth_source.get_project_info("qsl").await {
            result.push(LoaderAddonInfo {
                id: "qsl".to_string(),
                label: info.name,
                recommended: true,
                description: info.description,
                icon_url: info.icon_url.unwrap_or_default(),
                project_url: "https://modrinth.com/mod/qsl".to_string(),
                downloads: info.download_count,
            });
        }
    }

    Ok(Json(result))
}

/// 判断语言是否为中文（覆盖 zh / zh-CN / zh_CN / zh-TW / zh-HK 等变体，GC-05）。
fn is_chinese_lang(lang: &str) -> bool {
    lang.trim().to_ascii_lowercase().starts_with("zh")
}

/// 解析加载器类型字符串（源 `Enum.Parse<ModLoaderType>(ignoreCase: true)`）。
///
/// 忽略大小写匹配；识别失败返回 `None`（等价 C# 的 catch → INVALID_LOADER）。
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

/// 将 core 层错误映射为后端 API 错误（语义对应源 ErrorHandlingMiddleware 默认 500 / HttpRequestException 502）。
fn map_core_error(e: qomicex_core::error::Error) -> ApiError {
    let is_upstream =
        matches!(&e, qomicex_core::error::Error::Http { status: Some(s), .. } if *s >= 500);
    if is_upstream {
        ApiError::upstream(e.to_string())
    } else {
        ApiError::internal(e.to_string())
    }
}
