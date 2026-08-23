//! Resource center endpoints (source: Endpoints/ResourceCenterEndpoints.cs).
//!
//! Implements multi-platform resource browsing (Modrinth / CurseForge / FTB):
//! search, project detail, version listing, file download sources, FTB version
//! export, dependency resolution, and machine-translation helpers.
//!
//! NOTE ON PREFIX: the C# source groups these routes under MapGroup("/api/resources").
//! The Rust app nests every endpoint sub-router under "/api" (see app.rs build_router),
//! so the paths declared here are relative to that nest and use "/resources/...",
//! producing the identical public routes /api/resources/... .

use axum::extract::{Path as AxumPath, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use qomicex_core::models::expansion::modrinth::SearchResultInfo;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

use crate::error::{ApiError, ApiResult};
use crate::state::SharedState;

// =====================================================================
// DTO
// =====================================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResourceItemDto {
    id: String,
    title: String,
    description: String,
    author: String,
    icon_url: String,
    download_count: i64,
    source: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    categories: Vec<String>,
    project_url: String,
    slug: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResourceSearchResponse {
    items: Vec<ResourceItemDto>,
    total: i32,
    page: i32,
    page_size: i32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResourceDetailDto {
    id: String,
    title: String,
    description: String,
    author: String,
    icon_url: String,
    download_count: i64,
    source: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    categories: Vec<String>,
    project_url: String,
    slug: String,
    body: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResourceFileDto {
    url: String,
    #[serde(rename = "fileName")]
    filename: String,
    size: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResourceDependencyDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
    project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    dependency_type: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResourceVersionDto {
    id: String,
    name: String,
    version_number: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    game_versions: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    loaders: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    downloads: Vec<ResourceFileDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dependencies: Option<Vec<ResourceDependencyDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    date_published: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResolvedDependencyDto {
    project_id: String,
    name: String,
    icon_url: String,
    version_id: String,
    version_number: String,
    download_url: String,
    file_name: String,
    category: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    curse_forge_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modrinth_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranslateResponse {
    original: Option<String>,
    translated: Option<String>,
    translated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateTextRequest {
    text: String,
}

// Query parameter structs
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    keyword: Option<String>,
    #[serde(default)]
    page: Option<i32>,
    #[serde(default)]
    page_size: Option<i32>,
    #[serde(default)]
    game_version: Option<String>,
    #[serde(default)]
    loader: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    sort: Option<String>,
    /// 逗号分隔的标签（Modrinth categories facet），如 `library,optimization`。
    #[serde(default)]
    tags: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailQuery {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    category: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionsQuery {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    game_version: Option<String>,
    #[serde(default)]
    loader: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadsQuery {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DependenciesQuery {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    game_version: Option<String>,
    #[serde(default)]
    loader: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateQuery {
    #[serde(default)]
    source: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartFetchQuery {
    #[serde(default)]
    #[allow(dead_code)]
    game_version: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    loader: Option<String>,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/resources/search", get(search))
        .route("/resources/{id}", get(detail))
        .route("/resources/{id}/versions", get(versions))
        .route(
            "/resources/{id}/versions/{version_id}/downloads",
            get(version_downloads),
        )
        .route("/resources/ftb/{project_id}/export", get(ftb_export))
        .route("/resources/{id}/dependencies", get(dependencies))
        .route(
            "/resources/{id}/versions/start-fetch",
            post(versions_start_fetch),
        )
        .route(
            "/resources/versions/fetch-progress/{task_id}",
            get(versions_fetch_progress),
        )
        .route(
            "/resources/versions/fetch-result/{task_id}",
            get(versions_fetch_result),
        )
        .route("/resources/{id}/translate", get(translate))
        .route("/resources/translate-text", post(translate_text))
}

// =====================================================================
// Shared mapping helpers (source Map* static methods)
// =====================================================================

fn map_cf_loader(loader: &str) -> Option<Vec<String>> {
    match loader.to_lowercase().as_str() {
        "forge" => Some(vec!["Forge".to_string()]),
        "fabric" => Some(vec!["Fabric".to_string()]),
        "quilt" => Some(vec!["Quilt".to_string()]),
        "neoforge" => Some(vec!["NeoForge".to_string()]),
        _ => None,
    }
}

fn map_cf_class_id(category: Option<&str>) -> Option<i32> {
    match category?.to_lowercase().as_str() {
        "mod" => Some(6),
        "modpack" => Some(4471),
        "shader" => Some(6552),
        "resourcepack" => Some(12),
        "datapack" => Some(6945),
        "save" => Some(17),
        _ => None,
    }
}

fn map_cf_url_slug(category: Option<&str>) -> &'static str {
    match category.unwrap_or("").to_lowercase().as_str() {
        "modpack" => "modpacks",
        "shader" => "shaders",
        "resourcepack" => "texture-packs",
        "datapack" => "data-packs",
        "save" => "worlds",
        _ => "mc-mods",
    }
}

fn map_mr_sort(sort: Option<&str>) -> &'static str {
    match sort.unwrap_or("").to_lowercase().as_str() {
        "downloads" => "downloads",
        "updated" => "updated",
        "newest" => "newest",
        _ => "relevance",
    }
}

fn map_cf_sort(sort: Option<&str>) -> i32 {
    match sort.unwrap_or("").to_lowercase().as_str() {
        "downloads" => 6,
        "updated" => 3,
        "name" => 4,
        "newest" => 11,
        _ => 6,
    }
}

fn map_ft_sort(sort: Option<&str>) -> &'static str {
    match sort.unwrap_or("").to_lowercase().as_str() {
        "downloads" => "downloads",
        "updated" => "updated",
        "newest" => "released",
        "name" => "name",
        _ => "downloads",
    }
}

// =====================================================================
// CurseForge category id 解析（tags slug → 数字 categoryId）
// =====================================================================

/// 规范化标签/category 名：小写、非字母数字折叠为单个连字符、去首尾连字符。
/// 用于把 Modrinth slug 与 CurseForge 的 slug/name 对齐（如 `World Generation`
/// 与 `world-generation` 都归一成 `world-generation`）。
fn normalize_tag(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    while out.starts_with('-') {
        out.remove(0);
    }
    out
}

/// Modrinth 风格 slug 到 CurseForge category key 的别名补偿（两边词汇不一致时使用）。
fn cf_tag_alias(s: &str) -> Option<&'static str> {
    match s {
        "worldgen" => Some("world-generation"),
        "library" => Some("libraries"),
        "support" => Some("addons"),
        "minigame" => Some("mini-game"),
        _ => None,
    }
}

/// 全局缓存的 CurseForge 分类表（slug/name 规范化 → categoryId）。首次用时拉取，
/// 之后复用；拉取失败则视为空表，标签对该次搜索不生效（与未支持时行为一致）。
fn cf_category_cache() -> &'static Mutex<Option<HashMap<String, i32>>> {
    static CACHE: OnceLock<Mutex<Option<HashMap<String, i32>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

async fn fetch_cf_categories(
    client: &reqwest::Client,
    api_key: &str,
    class_id: Option<i32>,
) -> HashMap<String, i32> {
    let mut url = "https://api.curseforge.com/v1/categories?gameId=432".to_string();
    if let Some(c) = class_id {
        url.push_str(&format!("&classId={}", c));
    }
    let body = match cf_get_raw(client, &url, api_key).await {
        Some(b) => b,
        None => return HashMap::new(),
    };
    let data = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let mut map = HashMap::new();
    for c in &data {
        let id = c.get("id").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        if id == 0 {
            continue;
        }
        if let Some(slug) = c.get("slug").and_then(|v| v.as_str()) {
            map.insert(normalize_tag(slug), id);
        }
        if let Some(name) = c.get("name").and_then(|v| v.as_str()) {
            map.insert(normalize_tag(name), id);
        }
    }
    map
}

async fn cf_resolve_category_ids(
    client: &reqwest::Client,
    api_key: &str,
    tags: &[String],
    class_id: Option<i32>,
) -> Option<Vec<i32>> {
    if tags.is_empty() {
        return None;
    }
    let cached = {
        let g = cf_category_cache().lock().unwrap();
        g.clone()
    };
    let map = match cached {
        Some(m) => m,
        None => {
            let m = fetch_cf_categories(client, api_key, class_id).await;
            *cf_category_cache().lock().unwrap() = Some(m.clone());
            m
        }
    };
    let ids: Vec<i32> = tags
        .iter()
        .filter_map(|t| {
            let key = normalize_tag(t);
            cf_tag_alias(&key)
                .and_then(|a| map.get(a))
                .copied()
                .or_else(|| map.get(&key).copied())
        })
        .collect();
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}

// =====================================================================
// Handlers: search
// =====================================================================

async fn search(
    State(state): State<SharedState>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<ResourceSearchResponse>> {
    // NOTE: source McmodService.ResolveChineseSearch is not ported; the raw
    // keyword is passed through unchanged (TODO: integrate Chinese->en alias).
    let keyword = q.keyword.clone().unwrap_or_default();
    let src = q.source.clone().unwrap_or_else(|| "modrinth".to_string());
    let category = q.category.clone();
    let game_version = q.game_version.clone();
    let loader = q.loader.clone();
    let sort = q.sort.clone();
    let tags = q.tags.clone();
    let page = q.page.unwrap_or(1);
    let page_size = q.page_size.unwrap_or(20);

    // "all" = 聚合源：按分类决定可聚合的源。save 仅 CurseForge；
    // modpack 额外含 FTB；其余为 Modrinth + CurseForge。
    let sources: Vec<&str> = if src.eq_ignore_ascii_case("all") {
        match category.as_deref() {
            Some(c) if c.eq_ignore_ascii_case("save") => vec!["curseforge"],
            Some(c) if c.eq_ignore_ascii_case("modpack") => {
                vec!["modrinth", "curseforge", "ftb"]
            }
            _ => vec!["modrinth", "curseforge"],
        }
    } else {
        vec![src.as_str()]
    };

    if sources.len() == 1 {
        let (items, total) = search_one(
            &state,
            sources[0],
            &keyword,
            category.as_deref(),
            game_version.as_deref(),
            loader.as_deref(),
            sort.as_deref(),
            tags.as_deref(),
            page,
            page_size,
        )
        .await?;
        return Ok(Json(ResourceSearchResponse {
            items,
            total,
            page,
            page_size,
        }));
    }

    // ponytail: 顺序聚合，各源失败即整体失败（与单源一致）；并发可用
    // tokio::join! 提升延迟，量级不大暂不做
    let mut merged: Vec<ResourceItemDto> = Vec::new();
    let mut total = 0i32;
    for source in sources {
        let (items, t) = search_one(
            &state,
            source,
            &keyword,
            category.as_deref(),
            game_version.as_deref(),
            loader.as_deref(),
            sort.as_deref(),
            tags.as_deref(),
            page,
            page_size,
        )
        .await?;
        total = total.saturating_add(t);
        merged.extend(items);
    }
    // 聚合排序统一按下载量，跨源可比
    merged.sort_by(|a, b| b.download_count.cmp(&a.download_count));
    merged.truncate(page_size as usize);
    // ponytail: total 为各源 total 之和（近似）；FTB 无分页，翻页会重复出现
    Ok(Json(ResourceSearchResponse {
        items: merged,
        total,
        page,
        page_size,
    }))
}

async fn search_one(
    state: &SharedState,
    source: &str,
    keyword: &str,
    category: Option<&str>,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    tags: Option<&str>,
    page: i32,
    page_size: i32,
) -> ApiResult<(Vec<ResourceItemDto>, i32)> {
    // 标签：Modrinth 直接用 slug 作为 categories facet；CurseForge 的 categoryIds
    // 为数字 ID，这里把 slug 映射到 CF 的 category id（按需拉取并缓存 CF 分类表）。
    let tag_vec: Vec<String> = tags
        .map(|t| {
            t.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let categories: Option<&[String]> = if tag_vec.is_empty() {
        None
    } else {
        Some(&tag_vec)
    };
    if source.eq_ignore_ascii_case("modrinth") {
        let mr = state.core.create_modrinth_source();
        let loaders: Vec<String> = loader.map(|l| vec![l.to_string()]).unwrap_or_default();
        let result = mr
            .search(
                keyword,
                category,
                game_version,
                categories,
                if loaders.is_empty() {
                    None
                } else {
                    Some(loaders.as_slice())
                },
                map_mr_sort(sort),
                page - 1,
                page_size,
            )
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let items = result
            .results
            .iter()
            .map(|r| search_info_to_item(r, "modrinth"))
            .collect();
        Ok((items, result.total_results))
    } else if source.eq_ignore_ascii_case("curseforge") {
        let cf = state
            .core
            .create_curseforge_source(&state.curse_forge_api_key);
        let cf_class_id = map_cf_class_id(category);
        let cf_url_slug = map_cf_url_slug(category);
        let loaders = loader.and_then(map_cf_loader).unwrap_or_default();
        // 把标签 slug 解析为 CurseForge 数字 categoryId（无匹配则忽略，等价于不过滤）。
        let cf_category_ids = cf_resolve_category_ids(
            &state.http_client,
            &state.curse_forge_api_key,
            &tag_vec,
            cf_class_id,
        )
        .await;
        let result = cf
            .search(
                keyword,
                game_version.map(|g| vec![g.to_string()]).as_deref(),
                cf_category_ids.as_deref(),
                if loaders.is_empty() {
                    None
                } else {
                    Some(loaders.as_slice())
                },
                Some(map_cf_sort(sort)),
                Some(page),
                Some(page_size),
                cf_class_id,
            )
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let items = result
            .results
            .iter()
            .filter_map(|r| cf_result_to_item(r, cf_url_slug))
            .collect();
        Ok((items, result.total_count))
    } else if source.eq_ignore_ascii_case("ftb") {
        if !category.unwrap_or("").eq_ignore_ascii_case("modpack") {
            return Ok((vec![], 0));
        }
        let ftb = state.core.create_ftb_source();
        let packs = ftb
            .search(
                if keyword.is_empty() {
                    None
                } else {
                    Some(keyword)
                },
                None,
                game_version,
                loader,
                map_ft_sort(sort),
                page_size,
            )
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let items: Vec<ResourceItemDto> =
            packs.iter().map(|p| ftb_pack_to_item(p, "ftb")).collect();
        let count = items.len() as i32;
        Ok((items, count))
    } else {
        Ok((vec![], 0))
    }
}

// =====================================================================
// Handlers: detail
// =====================================================================

async fn detail(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<DetailQuery>,
) -> ApiResult<Response> {
    let src = q.source.clone().unwrap_or_else(|| "modrinth".to_string());

    if src.eq_ignore_ascii_case("modrinth") {
        let mr = state.core.create_modrinth_source();
        let info = mr
            .get_project_info(&id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let author = match &info.team {
            Some(team) if !team.is_empty() => fetch_mr_author(&state.http_client, team).await,
            _ => String::new(),
        };
        let slug = info.slug.clone().unwrap_or_else(|| info.id.clone());
        return Ok(Json(ResourceDetailDto {
            id: info.id.clone(),
            title: info.name.clone(),
            description: info.description.clone(),
            author,
            icon_url: info.icon_url.clone().unwrap_or_default(),
            download_count: info.download_count as i64,
            source: "modrinth".to_string(),
            categories: info.categories.clone().unwrap_or_default(),
            project_url: format!("https://modrinth.com/project/{}", slug),
            slug: slug.clone(),
            body: info.full_description.clone().unwrap_or_default(),
        })
        .into_response());
    }

    if src.eq_ignore_ascii_case("curseforge") {
        let cf = state
            .core
            .create_curseforge_source(&state.curse_forge_api_key);
        let info = cf
            .get_mod_info(&id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let cf_url_slug = map_cf_url_slug(q.category.as_deref());
        let slug = info.slug.clone().unwrap_or_else(|| info.id.to_string());
        return Ok(Json(ResourceDetailDto {
            id: info.id.to_string(),
            title: info.name.clone(),
            description: info.summary.clone().unwrap_or_default(),
            author: info
                .authors
                .as_ref()
                .and_then(|a| a.first())
                .map(|a| a.name.clone())
                .unwrap_or_default(),
            icon_url: info
                .screenshots
                .as_ref()
                .and_then(|s| s.first())
                .and_then(|s| s.thumbnail_url.clone())
                .unwrap_or_default(),
            download_count: info.download_count as i64,
            source: "curseforge".to_string(),
            categories: info
                .categories
                .as_ref()
                .map(|c| {
                    c.iter()
                        .map(|c| c.slug.clone().unwrap_or_else(|| c.name.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            project_url: format!(
                "https://www.curseforge.com/minecraft/{cf_url_slug}/{}",
                slug
            ),
            slug: slug.clone(),
            body: String::new(),
        })
        .into_response());
    }

    if src.eq_ignore_ascii_case("ftb") {
        let ftb_id: i32 = match id.parse() {
            Ok(v) => v,
            Err(_) => return Err(ApiError::not_found("NOT_FOUND", "FTB pack not found")),
        };
        let ftb = state.core.create_ftb_source();
        let pack = ftb
            .get_pack_detail(ftb_id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let pack = match pack {
            Some(p) => p,
            None => return Err(ApiError::not_found("NOT_FOUND", "FTB pack not found")),
        };
        let slug = pack.slug.clone().unwrap_or_else(|| pack.id.to_string());
        return Ok(Json(ResourceDetailDto {
            id: pack.id.to_string(),
            title: pack.name.clone(),
            description: pack.synopsis.clone().unwrap_or_default(),
            author: pack
                .authors
                .as_ref()
                .map(|a| {
                    a.iter()
                        .take(2)
                        .map(|a| a.name.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default(),
            icon_url: ftb_square_art(&pack),
            download_count: pack.installs,
            source: "ftb".to_string(),
            categories: pack
                .tags
                .as_ref()
                .map(|t| t.iter().map(|t| t.name.clone()).collect())
                .unwrap_or_default(),
            project_url: format!("https://www.feed-the-beast.com/modpacks/{}", slug),
            slug: slug.clone(),
            body: pack.description.clone().unwrap_or_default(),
        })
        .into_response());
    }

    Err(ApiError::not_found("NOT_FOUND", "Resource not found"))
}

fn ftb_square_art(p: &qomicex_core::models::expansion::ftb::ModpackInfo) -> String {
    p.art
        .as_ref()
        .and_then(|a| a.iter().find(|a| a.r#type.as_deref() == Some("square")))
        .map(|a| a.url.clone())
        .unwrap_or_default()
}

// =====================================================================
// Handlers: versions
// =====================================================================

async fn versions(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<VersionsQuery>,
) -> ApiResult<Json<Vec<ResourceVersionDto>>> {
    let src = q.source.clone().unwrap_or_else(|| "modrinth".to_string());
    let game_version = q.game_version.clone();
    let loader = q.loader.clone();

    if src.eq_ignore_ascii_case("modrinth") {
        let mr = state.core.create_modrinth_source();
        let versions = mr
            .get_project_version_info(&id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;

        let filtered = versions.iter().filter(|v| {
            let gv_ok = game_version
                .as_ref()
                .map(|g| {
                    v.game_version_ids
                        .as_ref()
                        .map(|x| x.contains(g))
                        .unwrap_or(false)
                })
                .unwrap_or(true);
            let l_ok = loader
                .as_ref()
                .map(|l| v.loaders.as_ref().map(|x| x.contains(l)).unwrap_or(false))
                .unwrap_or(true);
            gv_ok && l_ok
        });

        let dtos = filtered
            .map(|v| ResourceVersionDto {
                id: v.id.clone(),
                name: v.name.clone(),
                version_number: v.version_number.clone().unwrap_or_else(|| v.name.clone()),
                game_versions: v.game_version_ids.clone().unwrap_or_default(),
                loaders: v.loaders.clone().unwrap_or_default(),
                downloads: v
                    .files
                    .as_ref()
                    .map(|f| {
                        f.iter()
                            .map(|x| ResourceFileDto {
                                url: x.download_url.clone(),
                                filename: x.filename.clone(),
                                size: x.size,
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                dependencies: v.dependencies_infos.as_ref().map(|d| {
                    d.iter()
                        .map(|di| ResourceDependencyDto {
                            version_id: di.version_id.clone(),
                            project_id: di.project_id.clone().unwrap_or_default(),
                            file_name: di.file_name.clone(),
                            dependency_type: di.dependency_type.clone().unwrap_or_default(),
                        })
                        .collect()
                }),
                date_published: Some(v.published_at.clone()),
            })
            .collect();

        return Ok(Json(dtos));
    }

    if src.eq_ignore_ascii_case("curseforge") {
        if state.curse_forge_api_key.is_empty() {
            return Ok(Json(vec![]));
        }
        let dtos = cf_versions_raw(
            &state.http_client,
            &state.curseforge_fetch,
            &id,
            &state.curse_forge_api_key,
            game_version.as_deref(),
            loader.as_deref(),
        )
        .await;
        return Ok(Json(dtos));
    }

    if src.eq_ignore_ascii_case("ftb") {
        let ftb_id: i32 = match id.parse() {
            Ok(v) => v,
            Err(_) => return Ok(Json(vec![])),
        };
        let ftb = state.core.create_ftb_source();
        let pack = match ftb.get_pack_detail(ftb_id).await {
            Ok(Some(p)) => p,
            _ => return Ok(Json(vec![])),
        };
        let versions = match pack.versions {
            Some(v) => v,
            None => return Ok(Json(vec![])),
        };

        let filtered = versions.into_iter().filter(|v| {
            let targets = v.targets.as_ref();
            let gv_ok = game_version
                .as_ref()
                .map(|g| {
                    targets
                        .map(|t| t.iter().any(|x| x.version.as_deref() == Some(g.as_str())))
                        .unwrap_or(false)
                })
                .unwrap_or(true);
            let l_ok = loader
                .as_ref()
                .map(|l| {
                    targets
                        .map(|t| {
                            t.iter().any(|x| {
                                x.name
                                    .as_deref()
                                    .map(|v| v.eq_ignore_ascii_case(l))
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                })
                .unwrap_or(true);
            gv_ok && l_ok
        });

        let dtos = filtered
            .map(|v| {
                let targets = v.targets.clone().unwrap_or_default();
                let mc = targets
                    .iter()
                    .find(|t| {
                        t.r#type.as_deref() == Some("game")
                            || t.name.as_deref() == Some("minecraft")
                    })
                    .and_then(|t| t.version.clone());
                let mut game_versions = Vec::new();
                if let Some(m) = mc {
                    game_versions.push(m);
                }
                let loaders = targets
                    .iter()
                    .filter(|t| {
                        matches!(
                            t.r#type.as_deref(),
                            Some("modloader") | Some("forge") | Some("fabric") | Some("neoforge")
                        )
                    })
                    .filter_map(|t| t.name.clone().or_else(|| t.version.clone()))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>();
                ResourceVersionDto {
                    id: v.id.to_string(),
                    name: v.name.clone(),
                    version_number: v.name.clone(),
                    game_versions,
                    loaders,
                    downloads: vec![],
                    dependencies: None,
                    date_published: Some(
                        chrono::DateTime::from_timestamp_secs(v.released)
                            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true))
                            .unwrap_or_default(),
                    ),
                }
            })
            .collect();

        return Ok(Json(dtos));
    }

    Ok(Json(vec![]))
}

// =====================================================================
// Handlers: version downloads / FTB export
// =====================================================================

async fn version_downloads(
    State(state): State<SharedState>,
    AxumPath(path): AxumPath<(String, String)>,
    Query(q): Query<DownloadsQuery>,
) -> ApiResult<Json<Vec<ResourceFileDto>>> {
    let (id, version_id) = path;
    let src = q.source.clone().unwrap_or_else(|| "modrinth".to_string());

    if src.eq_ignore_ascii_case("modrinth") {
        let mr = state.core.create_modrinth_source();
        let info = mr
            .get_version_info(&version_id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let files = info
            .files
            .as_ref()
            .map(|f| {
                f.iter()
                    .map(|x| ResourceFileDto {
                        url: x.download_url.clone(),
                        filename: x.filename.clone(),
                        size: x.size,
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Ok(Json(files));
    }

    if src.eq_ignore_ascii_case("curseforge") {
        let cf = state
            .core
            .create_curseforge_source(&state.curse_forge_api_key);
        let (file_info, url_result) = futures::join!(
            cf.get_file_info(&id, &version_id),
            cf.get_download_url(&id, &version_id)
        );
        let url = url_result.map_err(|e| ApiError::upstream(e.to_string()))?;
        let (file_name, size) = match file_info {
            Ok(info) => (info.file_name.unwrap_or_default(), info.file_length),
            Err(e) => {
                tracing::warn!(
                    mod_id = %id,
                    file_id = %version_id,
                    error = %e,
                    "CurseForge get_file_info 失败，文件名回退为下载链接末段"
                );
                (file_name_from_url(&url), 0)
            }
        };
        return Ok(Json(vec![ResourceFileDto {
            url,
            filename: file_name,
            size,
        }]));
    }

    if src.eq_ignore_ascii_case("ftb") {
        let ftb_id: i32 = match id.parse() {
            Ok(v) => v,
            Err(_) => return Ok(Json(vec![])),
        };
        let ftb_ver_id: i32 = match version_id.parse() {
            Ok(v) => v,
            Err(_) => return Ok(Json(vec![])),
        };
        let ftb = state.core.create_ftb_source();
        let detail = ftb
            .get_version_detail(ftb_id, ftb_ver_id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let files = detail
            .and_then(|d| d.files)
            .unwrap_or_default()
            .into_iter()
            .filter(|f| f.name.to_lowercase().ends_with(".zip"))
            .map(|f| ResourceFileDto {
                url: f.url.clone(),
                filename: f.name.clone(),
                size: f.size,
            })
            .collect();
        return Ok(Json(files));
    }

    Ok(Json(vec![]))
}

async fn ftb_export(
    State(state): State<SharedState>,
    AxumPath(project_id): AxumPath<String>,
    Query(q): Query<DownloadsQuery>,
) -> ApiResult<Response> {
    let ftb_id: i32 = match project_id.parse() {
        Ok(v) => v,
        Err(_) => return Err(ApiError::not_found("NOT_FOUND", "FTB project not found")),
    };
    // 前端把 versionId 放在 query（source=ftb 分支的 downloads 同样如此），
    // 与 C# 原版 `?versionId=` 一致；无该参数视为找不到版本。
    let ftb_ver_id: i32 = match q.version_id.as_deref().unwrap_or_default().parse() {
        Ok(v) => v,
        Err(_) => return Err(ApiError::not_found("NOT_FOUND", "FTB version not found")),
    };
    let ftb = state.core.create_ftb_source();
    let detail = ftb
        .get_version_detail(ftb_id, ftb_ver_id)
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    match detail {
        Some(d) => Ok(Json(d).into_response()),
        None => Err(ApiError::not_found(
            "NOT_FOUND",
            "FTB version detail not found",
        )),
    }
}

// =====================================================================
// Handlers: dependencies resolution
// =====================================================================

async fn dependencies(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<DependenciesQuery>,
) -> ApiResult<Json<Vec<ResolvedDependencyDto>>> {
    let src = q.source.clone().unwrap_or_else(|| "modrinth".to_string());

    if src.eq_ignore_ascii_case("modrinth") {
        let mr = state.core.create_modrinth_source();
        let mut visited = std::collections::HashSet::new();
        let deps = resolve_mr_deps(
            &*mr,
            &id,
            q.version_id.as_deref(),
            q.game_version.as_deref(),
            q.loader.as_deref(),
            &mut visited,
            0,
        )
        .await;
        return Ok(Json(deps));
    }

    if src.eq_ignore_ascii_case("curseforge") {
        let mut visited = std::collections::HashSet::new();
        let deps = resolve_cf_deps(
            &state.http_client,
            &id,
            q.version_id.as_deref(),
            q.game_version.as_deref(),
            q.loader.as_deref(),
            &state.curse_forge_api_key,
            &mut visited,
            0,
        )
        .await;
        return Ok(Json(deps));
    }

    Ok(Json(vec![]))
}

// =====================================================================
// Handlers: CurseForge async version fetch service
// =====================================================================

async fn versions_start_fetch(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<StartFetchQuery>,
) -> ApiResult<Json<crate::services::curseforge_fetch::FetchStartResponse>> {
    let resp = state
        .curseforge_fetch
        .start(&id, q.game_version.as_deref(), q.loader.as_deref())
        .await;
    Ok(Json(resp))
}

async fn versions_fetch_progress(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<crate::services::curseforge_fetch::FetchProgressResponse>> {
    match state.curseforge_fetch.get_progress(&task_id).await {
        Some(p) => Ok(Json(p)),
        None => Err(ApiError::not_found("NOT_FOUND", "任务不存在或已过期")),
    }
}

async fn versions_fetch_result(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<Vec<serde_json::Value>>> {
    match state.curseforge_fetch.get_result(&task_id).await {
        Some(r) => Ok(Json(r)),
        None => Err(ApiError::not_found("NOT_FOUND", "任务不存在或尚未完成")),
    }
}

// =====================================================================
// Handlers: translation
// =====================================================================

async fn translate(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<TranslateQuery>,
) -> ApiResult<Json<TranslateResponse>> {
    let src = q.source.clone().unwrap_or_else(|| "modrinth".to_string());
    let url = match src.to_lowercase().as_str() {
        "curseforge" => format!("https://mod.mcimirror.top/translate/curseforge/{}", id),
        _ => format!("https://mod.mcimirror.top/translate/modrinth/{}", id),
    };

    let resp = match state.http_client.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(Json(empty_translate())),
    };
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(Json(empty_translate())),
    };
    let get = |k: &str| body.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(Json(TranslateResponse {
        original: get("original"),
        translated: get("translated"),
        translated_at: get("translatedAt"),
    }))
}

fn empty_translate() -> TranslateResponse {
    TranslateResponse {
        original: None,
        translated: None,
        translated_at: None,
    }
}

async fn translate_text(
    State(state): State<SharedState>,
    req: Json<TranslateTextRequest>,
) -> ApiResult<Response> {
    let settings = state.settings.read().await;
    let provider_name = settings.translation_provider.clone();
    let bing_api_key = settings.bing_api_key.clone();
    drop(settings);

    // 源：TextProtector.Protect → service.TranslateAsync → Restore；任何失败返回
    // TranslateResponse(null, null, null)（源 catch 语义），不视为 HTTP 错误。
    let (protected_text, map) = crate::services::translation::protect(req.text.trim());
    let provider = crate::services::translation::create_provider(&provider_name, bing_api_key);
    let translated =
        crate::services::translation::translate(&state.http_client, &provider, &protected_text)
            .await;
    let translated = translated
        .map(|t| crate::services::translation::restore(&t, &map))
        .filter(|t| !t.is_empty());

    Ok(Json(TranslateResponse {
        original: Some(req.text.clone()),
        translated,
        translated_at: None,
    })
    .into_response())
}

// =====================================================================
// Item mapping helpers
// =====================================================================

fn search_info_to_item(r: &SearchResultInfo, source: &str) -> ResourceItemDto {
    let slug = r.slug.clone().unwrap_or_else(|| r.id.clone());
    ResourceItemDto {
        id: r.id.clone(),
        title: r.name.clone(),
        description: r.description.clone(),
        author: r.author.clone(),
        icon_url: r.icon_url.clone().unwrap_or_default(),
        download_count: r.download_count as i64,
        source: source.to_string(),
        categories: r.categories.clone().unwrap_or_default(),
        project_url: format!("https://modrinth.com/project/{}", slug),
        slug: slug.clone(),
    }
}

fn cf_result_to_item(
    r: &qomicex_core::models::expansion::curseforge::CurseForgeSearchResult,
    url_slug: &str,
) -> Option<ResourceItemDto> {
    let download_count = r.download_count.parse::<i64>().unwrap_or(0);
    Some(ResourceItemDto {
        id: r.id.clone(),
        title: r.name.clone(),
        description: r.summary.clone(),
        author: r
            .authors
            .first()
            .map(|a| a.name.clone())
            .unwrap_or_default(),
        icon_url: r.icon_url.clone(),
        download_count,
        source: "curseforge".to_string(),
        categories: r
            .categories
            .iter()
            .map(|c| c.slug.clone().unwrap_or_else(|| c.name.clone()))
            .collect(),
        project_url: format!("https://www.curseforge.com/minecraft/{url_slug}/{}", r.slug),
        slug: r.slug.clone(),
    })
}

fn ftb_pack_to_item(
    p: &qomicex_core::models::expansion::ftb::ModpackInfo,
    source: &str,
) -> ResourceItemDto {
    let slug = p.slug.clone().unwrap_or_else(|| p.id.to_string());
    ResourceItemDto {
        id: p.id.to_string(),
        title: p.name.clone(),
        description: p.synopsis.clone().unwrap_or_default(),
        author: p
            .authors
            .as_ref()
            .map(|a| {
                a.iter()
                    .take(2)
                    .map(|a| a.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default(),
        icon_url: ftb_square_art(p),
        download_count: p.installs,
        source: source.to_string(),
        categories: p
            .tags
            .as_ref()
            .map(|t| t.iter().map(|t| t.name.clone()).collect())
            .unwrap_or_default(),
        project_url: format!("https://www.feed-the-beast.com/modpacks/{}", slug),
        slug: slug.clone(),
    }
}

// =====================================================================
// Modrinth author / team fetch (source does a raw team members call)
// =====================================================================

async fn fetch_mr_author(client: &reqwest::Client, team_id: &str) -> String {
    let url = format!("https://api.modrinth.com/v3/team/{}/members", team_id);
    let resp = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return String::new(),
    };
    let members: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    members
        .as_array()
        .and_then(|a| a.first())
        .and_then(|m| m.get("user"))
        .and_then(|u| u.get("username"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

// =====================================================================
// CurseForge expansion: legacy raw versions fetch
// =====================================================================

/// 拉取 CurseForge 版本列表（同步路径）。
///
/// 与 [`crate::services::curseforge_fetch`] 共用 `version_cache`，缓存里存的是**上游
/// 原始 file 对象**；映射与 loader 过滤都在这里做。两边的编码必须一致，否则交叉命中
/// 会把 DTO 再喂一遍映射器，产出 id / 下载地址全空的废数据。
async fn cf_versions_raw(
    client: &reqwest::Client,
    fetch_service: &crate::services::curseforge_fetch::CurseForgeVersionFetchService,
    id: &str,
    api_key: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
) -> Vec<ResourceVersionDto> {
    let key = crate::services::curseforge_fetch::CurseForgeVersionFetchService::cache_key(
        id,
        game_version,
    );

    if let Some(cached) = fetch_service.get_cached(&key) {
        if !cached.is_empty() {
            let mut dtos: Vec<ResourceVersionDto> =
                cached.iter().map(cf_file_to_version_dto).collect();
            apply_cf_filters(&mut dtos, game_version, loader);
            return dtos;
        }
    }

    let body = match cf_get_raw(client, &cf_files_url(id, None, game_version), api_key).await {
        Some(b) => b,
        None => return vec![],
    };
    let first_data: Vec<Value> = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    if first_data.is_empty() {
        return vec![];
    }
    let total_count = body
        .get("pagination")
        .and_then(|p| p.get("totalCount"))
        .and_then(|t| t.as_i64())
        .unwrap_or(0)
        .max(0) as usize;
    if total_count == 0 {
        return vec![];
    }

    let page_size = 50usize;
    let total_pages = total_count.div_ceil(page_size);
    let mut all_items: Vec<Value> = first_data;
    if total_pages > 1 {
        // 并发数统一由 fetch service 持有并钳位，不要在此处从 settings 里 `as usize`：
        // 负的 i32 转 usize 会变成天文数字并让 Semaphore::new panic。
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(fetch_service.concurrency()));
        let mut handles = Vec::new();
        for p in 1..total_pages {
            let Ok(permit) = sem.clone().acquire_owned().await else {
                break;
            };
            let client = client.clone();
            let api_key = api_key.to_string();
            let id = id.to_string();
            let gv = game_version.map(String::from);
            handles.push(tokio::spawn(async move {
                let _permit = permit;
                let url = cf_files_url(&id, Some((p * page_size) as i64), gv.as_deref());
                let result = cf_get_raw(&client, &url, &api_key).await;
                if let Some(b) = result {
                    b.get("data")
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default()
                } else {
                    vec![]
                }
            }));
        }
        for h in handles {
            if let Ok(items) = h.await {
                all_items.extend(items);
            }
        }
    }

    // 缓存原始对象（未经 loader 过滤），键里也不含 loader
    if !all_items.is_empty() {
        fetch_service.set_cached(key, all_items.clone());
    }

    let mut dtos: Vec<ResourceVersionDto> = all_items.iter().map(cf_file_to_version_dto).collect();

    apply_cf_filters(&mut dtos, game_version, loader);
    dtos
}

fn apply_cf_filters(
    dtos: &mut Vec<ResourceVersionDto>,
    game_version: Option<&str>,
    loader: Option<&str>,
) {
    if let Some(gv) = game_version {
        dtos.retain(|v| v.game_versions.iter().any(|x| x == gv));
    }
    if let Some(l) = loader {
        let norm = l.trim().to_lowercase();
        dtos.retain(|v| v.loaders.is_empty() || v.loaders.iter().any(|x| x.to_lowercase() == norm));
    }
}

/// 从下载链接推导文件名：先去掉 query/fragment，取末段路径，再做百分号解码。
///
/// CDN 链接常把空格编码成 `%20`，直接取末段会把编码原样写到磁盘上。
fn file_name_from_url(url: &str) -> String {
    let path = url.split(|c| c == '?' || c == '#').next().unwrap_or(url);
    let last = path.rsplit('/').next().unwrap_or("");
    urlencoding::decode(last)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| last.to_string())
}

fn cf_files_url(id: &str, index: Option<i64>, game_version: Option<&str>) -> String {
    let mut url = format!(
        "https://api.curseforge.com/v1/mods/{}/files?pageSize=50{}",
        urlinterval(&id),
        index.map(|i| format!("&index={}", i)).unwrap_or_default()
    );
    if let Some(gv) = game_version {
        url.push_str(&format!("&gameVersion={}", urlinterval(gv)));
    }
    url
}

fn urlinterval(s: &str) -> String {
    // URL-encode path/query segment (source used Uri.EscapeDataString).
    s.as_bytes()
        .iter()
        .map(|&b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
}

async fn cf_get_raw(client: &reqwest::Client, url: &str, api_key: &str) -> Option<Value> {
    let resp = client
        .get(url)
        .header("x-api-key", api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

fn extract_cf_loaders(game_versions: Option<&Vec<Value>>, mod_loader: Option<i64>) -> Vec<String> {
    let mut loaders = Vec::new();
    if let Some(gvs) = game_versions {
        for gv in gvs {
            if let Some(s) = gv.as_str() {
                let lower = s.to_lowercase();
                if matches!(
                    lower.as_str(),
                    "forge" | "fabric" | "quilt" | "neoforge" | "liteloader"
                ) {
                    loaders.push(lower.clone());
                }
                if matches!(lower.as_str(), "fabric" | "quilt" | "neoforge") {
                    loaders.push(lower);
                }
            }
        }
    }
    if mod_loader == Some(2) {
        loaders.push("forge".to_string());
    }
    if mod_loader == Some(4) {
        loaders.push("fabric".to_string());
    }
    if mod_loader == Some(5) {
        loaders.push("quilt".to_string());
    }
    if mod_loader == Some(6) {
        loaders.push("neoforge".to_string());
    }
    loaders
}

fn cf_file_to_version_dto(f: &Value) -> ResourceVersionDto {
    let s = |k: &str| f.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let i = |k: &str| f.get(k).and_then(|v| v.as_i64());
    let gvs: Vec<String> = f
        .get("gameVersions")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|gv| gv.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let loaders = extract_cf_loaders(
        f.get("gameVersions").and_then(|v| v.as_array()),
        i("modLoader"),
    );

    let dependencies = f.get("dependencies").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter(|d| d.get("relationType").and_then(|v| v.as_i64()) == Some(3))
            .map(|d| ResourceDependencyDto {
                version_id: None,
                project_id: d
                    .get("modId")
                    .and_then(|v| v.as_i64())
                    .map(|x| x.to_string())
                    .unwrap_or_default(),
                file_name: None,
                dependency_type: "required".to_string(),
            })
            .collect()
    });

    let file_name = s("fileName");
    ResourceVersionDto {
        id: i("id").map(|x| x.to_string()).unwrap_or_default(),
        name: s("displayName").ifempty(&file_name),
        version_number: file_name.clone(),
        game_versions: gvs,
        loaders,
        downloads: vec![ResourceFileDto {
            url: s("downloadUrl"),
            filename: file_name,
            size: i("fileLength").unwrap_or(0),
        }],
        dependencies,
        date_published: Some(s("fileDate")).filter(|v| !v.is_empty()),
    }
}

trait StrIfEmpty {
    fn ifempty(&self, fallback: &str) -> String;
}

impl StrIfEmpty for String {
    fn ifempty(&self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self.clone()
        }
    }
}

// =====================================================================
// Dependency resolution recursion
// =====================================================================

fn resolve_mr_deps<'a>(
    mr: &'a (dyn qomicex_core::api::expansion::ModrinthSource + Send + Sync),
    project_id: &'a str,
    version_id: Option<&'a str>,
    game_version: Option<&'a str>,
    loader: Option<&'a str>,
    visited: &'a mut std::collections::HashSet<String>,
    depth: i32,
) -> Pin<Box<dyn Future<Output = Vec<ResolvedDependencyDto>> + Send + 'a>> {
    Box::pin(async move {
        if depth > 5 {
            return vec![];
        }
        if !visited.insert(project_id.to_string()) {
            return vec![];
        }

        let mut result = Vec::new();

        let versions = match mr.get_project_version_info(project_id).await {
            Ok(v) => v,
            Err(_) => return result,
        };
        if versions.is_empty() {
            return result;
        }

        // Pick the target version: explicit version id at root, otherwise the
        // newest matching game version/loader (source uses MaxBy PublishedAt).
        let best = if let (Some(vid), 0) = (version_id, depth) {
            versions.iter().find(|v| v.id == vid)
        } else {
            versions
                .iter()
                .filter(|v| {
                    let gv_ok = game_version
                        .map(|g| {
                            v.game_version_ids
                                .as_ref()
                                .map(|x| x.iter().any(|e| e == g))
                                .unwrap_or(false)
                        })
                        .unwrap_or(true);
                    let l_ok = loader
                        .map(|l| {
                            v.loaders
                                .as_ref()
                                .map(|x| x.is_empty() || x.iter().any(|x| x == l))
                                .unwrap_or(true)
                        })
                        .unwrap_or(true);
                    gv_ok && l_ok
                })
                .max_by_key(|v| &v.published_at)
                .or_else(|| versions.iter().max_by_key(|v| &v.published_at))
        };
        let best = match best {
            Some(b) => b,
            None => return result,
        };

        if depth > 0 {
            let primary_file = best
                .files
                .as_ref()
                .and_then(|fs| fs.iter().find(|f| !f.download_url.is_empty()));
            if let Some(primary_file) = primary_file {
                let (name, icon_url, category) = match mr.get_project_info(project_id).await {
                    Ok(proj) => (
                        proj.name.clone(),
                        proj.icon_url.clone().unwrap_or_default(),
                        match proj.project_type.as_deref() {
                            Some("resourcepack") => "resourcepacks",
                            Some("shader") => "shaderpacks",
                            _ => "mods",
                        }
                        .to_string(),
                    ),
                    Err(_) => (project_id.to_string(), String::new(), "mods".to_string()),
                };
                result.push(ResolvedDependencyDto {
                    project_id: project_id.to_string(),
                    name,
                    icon_url,
                    version_id: best.id.clone(),
                    version_number: best.version_number.clone().unwrap_or_default(),
                    download_url: primary_file.download_url.clone(),
                    file_name: primary_file.filename.clone(),
                    category,
                    source: "modrinth".to_string(),
                    curse_forge_id: None,
                    modrinth_id: Some(project_id.to_string()),
                });
            }
        }

        if let Some(deps) = &best.dependencies_infos {
            let required: Vec<String> = deps
                .iter()
                .filter(|d| d.dependency_type.as_deref() == Some("required"))
                .filter_map(|d| d.project_id.clone())
                .collect();
            for dep_id in required {
                let sub = resolve_mr_deps(
                    mr,
                    &dep_id,
                    None,
                    game_version,
                    loader,
                    &mut *visited,
                    depth + 1,
                )
                .await;
                result.extend(sub);
            }
        }

        result
    })
}

fn resolve_cf_deps<'a>(
    http: &'a reqwest::Client,
    mod_id: &'a str,
    file_id: Option<&'a str>,
    game_version: Option<&'a str>,
    loader: Option<&'a str>,
    api_key: &'a str,
    visited: &'a mut std::collections::HashSet<String>,
    depth: i32,
) -> Pin<Box<dyn Future<Output = Vec<ResolvedDependencyDto>> + Send + 'a>> {
    Box::pin(async move {
        if depth > 8 {
            return vec![];
        }
        if !visited.insert(mod_id.to_string()) {
            return vec![];
        }

        let mut result = Vec::new();

        // Root: resolve a pinned file's dependency list only.
        if let (Some(fid), 0) = (file_id, depth) {
            let url = format!(
                "https://api.curseforge.com/v1/mods/{}/files/{}",
                urlinterval(mod_id),
                urlinterval(fid)
            );
            let body = match cf_get_raw(http, &url, api_key).await {
                Some(b) => b,
                None => return result,
            };
            let dep_ids = extract_cf_required_deps(body.get("data").map(|d| d.clone()));
            for dep_id in dep_ids {
                let sub = resolve_cf_deps(
                    http,
                    &dep_id,
                    None,
                    game_version,
                    loader,
                    api_key,
                    &mut *visited,
                    depth + 1,
                )
                .await;
                result.extend(sub);
            }
            return result;
        }

        // Sub-level: fetch mod info + newest matching file, then recurse.
        let mod_body = match cf_get_raw(
            http,
            &format!("https://api.curseforge.com/v1/mods/{}", urlinterval(mod_id)),
            api_key,
        )
        .await
        {
            Some(b) => b,
            None => return result,
        };
        let mod_data = mod_body.get("data");
        let name = mod_data
            .and_then(|d| d.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or(mod_id)
            .to_string();
        let _slug = mod_data
            .and_then(|d| d.get("slug"))
            .and_then(|v| v.as_str())
            .unwrap_or(mod_id)
            .to_string();
        let icon = mod_data
            .and_then(|d| d.get("logo"))
            .and_then(|l| l.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let files_body =
            match cf_get_raw(http, &cf_files_url(mod_id, None, game_version), api_key).await {
                Some(b) => b,
                None => return result,
            };
        let files = files_body.get("data").and_then(|d| d.as_array()).cloned();
        let files = match files {
            Some(f) if !f.is_empty() => f,
            _ => return result,
        };

        // Newest file by fileDate (source sorts desc by DateTime).
        let best = files.iter().max_by(|a, b| {
            a.get("fileDate")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .cmp(b.get("fileDate").and_then(|v| v.as_str()).unwrap_or(""))
        });

        let best = match best {
            Some(b) => b,
            None => return result,
        };
        let best_file_id = best
            .get("id")
            .and_then(|v| v.as_i64())
            .map(|x| x.to_string())
            .unwrap_or_default();
        let best_file_name = best
            .get("fileName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let best_display = best
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| best_file_name.clone());
        let best_download_url = best
            .get("downloadUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        result.push(ResolvedDependencyDto {
            project_id: mod_id.to_string(),
            name,
            icon_url: icon,
            version_id: best_file_id.clone(),
            version_number: best_display,
            download_url: best_download_url,
            file_name: best_file_name,
            category: "mod".to_string(),
            source: "curseforge".to_string(),
            curse_forge_id: Some(mod_id.to_string()),
            modrinth_id: None,
        });

        // Recurse into this best file's own dependencies.
        let deps_url = format!(
            "https://api.curseforge.com/v1/mods/{}/files/{}",
            urlinterval(mod_id),
            urlinterval(&best_file_id)
        );
        if let Some(body) = cf_get_raw(http, &deps_url, api_key).await {
            let dep_ids = extract_cf_required_deps(body.get("data").map(|d| d.clone()));
            for dep_id in dep_ids {
                let sub = resolve_cf_deps(
                    http,
                    &dep_id,
                    None,
                    game_version,
                    loader,
                    api_key,
                    &mut *visited,
                    depth + 1,
                )
                .await;
                result.extend(sub);
            }
        }

        result
    })
}

fn extract_cf_required_deps(data: Option<Value>) -> Vec<String> {
    data.and_then(|d| d.get("dependencies").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default()
        .iter()
        .filter(|d| d.get("relationType").and_then(|v| v.as_i64()) == Some(3))
        .filter_map(|d| {
            d.get("modId")
                .and_then(|v| v.as_i64())
                .map(|x| x.to_string())
        })
        .collect()
}
