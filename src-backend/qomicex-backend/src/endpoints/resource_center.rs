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
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use qomicex_core::models::expansion::modrinth::{ProjectInfo, SearchResultInfo};

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::error::{ApiError, ApiResult};
use crate::services::resource_favorite::ResourceFavorite;
use crate::services::resource_favorite_folder::{FavoriteFolder, FolderError};
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
    categories: Vec<String>,
    project_url: String,
    slug: String,
    /// 该条目的**真实**资源类型（mod / modpack / shader / ...），由查询时使用的
    /// category 决定。分类聚合（category=aggregate）下每项类型可能不同，前端收藏
    /// 必须用这个字段而不是页面筛选值——否则同一资源会在聚合视图与分类视图里被
    /// 当成两条（收藏唯一键是 source+id+category）。
    category: String,
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
    categories: Vec<String>,
    project_url: String,
    slug: String,
    body: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceFileDto {
    pub(crate) url: String,
    #[serde(rename = "fileName")]
    pub(crate) filename: String,
    pub(crate) size: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceDependencyDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
    project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    dependency_type: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceVersionDto {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version_number: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) game_versions: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) loaders: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) downloads: Vec<ResourceFileDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dependencies: Option<Vec<ResourceDependencyDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) date_published: Option<String>,
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResourceCategoryDto {
    slug: String,
    name: String,
}

/// 加载器筛选选项（#163）。`slug` 是下发给上游筛选的值，`name` 是展示名。
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct ResourceLoaderDto {
    slug: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategoriesQuery {
    source: Option<String>,
    category: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadersQuery {
    source: Option<String>,
    category: Option<String>,
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
        .route("/resources/categories", get(categories))
        .route("/resources/loaders", get(loaders))
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
        .route(
            "/resource-favorites",
            get(list_resource_favorites)
                .post(add_resource_favorite)
                .delete(remove_resource_favorite),
        )
        .route(
            "/resource-favorite-folders",
            get(list_favorite_folders).post(create_favorite_folder),
        )
        .route(
            "/resource-favorite-folders/{id}",
            put(rename_favorite_folder).delete(delete_favorite_folder),
        )
}

// =====================================================================
// Shared mapping helpers (source Map* static methods)
// =====================================================================

/// CurseForge 的 `modLoaderTypes` 枚举（#163 issue 回复给出：
/// `0=Any, 1=Forge, 2=Cauldron, 3=LiteLoader, 4=Fabric, 5=Quilt, 6=NeoForge`）。
///
/// 只暴露**实测有数据**的项：探针显示 `2`(Cauldron) 与 `3`(LiteLoader) 在
/// mods(6)/modpacks(4471) 下 `totalCount` 恒为 0（加不加 `gameVersions` 都一样），
/// 列进选项等于给用户一个必然空结果的筛选。`0`(Any) 传给 API 同样返回 0 而非
/// 「全部」—— 它是「不限」的占位，由前端「清除筛选」承担，不作为可选项下发。
///
/// 元组为 `(slug, 展示名, modLoaderTypes 数值)`；数值随条目显式给出，
/// 不从下标推导，避免调整顺序时静默错配枚举。
const CF_LOADERS: [(&str, &str, &str); 4] = [
    ("forge", "Forge", "1"),
    ("fabric", "Fabric", "4"),
    ("quilt", "Quilt", "5"),
    ("neoforge", "NeoForge", "6"),
];

/// CurseForge 加载器筛选值：返回传给 `modLoaderTypes` 的**数字 id**。
/// 探针确认数字 id 与名称都可用，但数字 id 无歧义（名称拼错会被 CF
/// **静默忽略**并返回全部结果，筛选器形同虚设——实测 `[Bogus]` → 10000）。
fn map_cf_loader(loader: &str) -> Option<Vec<String>> {
    let norm = loader.trim().to_ascii_lowercase();
    let (_, _, id) = CF_LOADERS.iter().find(|(slug, _, _)| *slug == norm)?;
    Some(vec![id.to_string()])
}

/// CurseForge 仅「模组 / 整合包」有加载器概念（`classId` 6 / 4471）。
/// 其余类型（光影包 6552、资源包 12 等）传加载器会得到 0 条或近乎不过滤的
/// 结果（实测 shader + Forge 仅从 704 降到 702），应视为无此筛选。
/// 注意：调用方传入的是**具体资源类型**（聚合分类已按类型拆成多次查询），
/// 故这里不处理 `aggregate`。
fn cf_category_supports_loader(category: Option<&str>) -> bool {
    matches!(
        category.unwrap_or("").to_ascii_lowercase().as_str(),
        "mod" | "modpack"
    )
}

/// Modrinth：该 loader 是否支持指定资源类型（#163 后端保护）。
///
/// 前端已按类型提供合法加载器，但 URL 里可能残留上一个类型的 loader
/// （如从光影包切回模组）。Modrinth 对不兼容 facet 返回 **0 条而非报错**，
/// 会让用户看到一个莫名其妙的空列表，故这里直接丢弃无效加载器。
/// 加载器表拉取失败时**保留** loader（宁可交给上游判断，也不擅自削弱筛选）。
async fn mr_loader_supported(
    client: &reqwest::Client,
    category: Option<&str>,
    loader: &str,
) -> bool {
    let Some(category) = category else {
        return true;
    };
    let all = fetch_mr_loaders(client).await;
    if all.is_empty() {
        return true;
    }
    let slug = normalize_tag(loader);
    all.iter()
        .any(|(pt, s, _)| pt.eq_ignore_ascii_case(category) && *s == slug)
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
        "map-and-information" => Some("map-information"),
        _ => None,
    }
}

/// 全局缓存的 CurseForge 分类表，按 `class_id` 分键（slug/name 规范化 → categoryId）。
/// CurseForge 的分类 ID 是类别相关的，跨类别复用会发错 ID，故必须按类别隔离缓存。
/// 首次用时按类别拉取，成功则缓存复用；失败/空结果不缓存，下次请求重试。
fn cf_category_cache() -> &'static Mutex<HashMap<Option<i32>, HashMap<String, i32>>> {
    static CACHE: OnceLock<Mutex<HashMap<Option<i32>, HashMap<String, i32>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
        g.get(&class_id).cloned()
    };
    let map = match cached {
        Some(m) => m,
        None => {
            let m = fetch_cf_categories(client, api_key, class_id).await;
            // 失败/空结果不缓存，避免该 class_id 永久静默返回未筛选结果；下次请求重试。
            if !m.is_empty() {
                cf_category_cache()
                    .lock()
                    .unwrap()
                    .insert(class_id, m.clone());
            }
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
// Handlers: categories (resource-type category list for filtering)
// =====================================================================

/// 全局缓存的 Modrinth 分类表（tag/category 为全局资源，含 project_type 分组）。
fn mr_categories_cache() -> &'static Mutex<Option<(Instant, Vec<(String, String, String)>)>> {
    // (project_type, slug, name)
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<(String, String, String)>)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 全局缓存的 Modrinth 加载器表（`tag/loader` 为全局资源，含 supported_project_types）。
/// 缓存 (project_type, slug, name) 三元组：一个加载器可支持多种项目类型
/// （如 forge 支持 mod 与 modpack），故按其支持的每种类型各展开一行。
fn mr_loaders_cache() -> &'static Mutex<Option<(Instant, Vec<(String, String, String)>)>> {
    // (project_type, slug, name)
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<(String, String, String)>)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 拉取 Modrinth 加载器表并按 `supported_project_types` 展开（#163）。
///
/// 这是「加载器随资源类型变化」的事实来源：`/v2/tag/loader` 每个标签都带
/// `supported_project_types`（如 iris→shader、minecraft→resourcepack、
/// forge→mod+modpack）。此前前端写死一份与类型无关的列表，导致光影包选
/// forge 后 Modrinth 的 `categories:forge` facet 命中 0 条（列表空白）。
///
/// 缓存策略：成功结果缓存 6 小时；**失败/空结果也带时间戳缓存**，但用较短的
/// 抑制窗口 —— 本函数会在 `search_one`（每次搜索、聚合分类下最多 12 次）与
/// `/resources/loaders` 里被调用，上游故障时若完全不缓存，一次搜索就会放大成
/// 十几次无效请求。
async fn fetch_mr_loaders(client: &reqwest::Client) -> Vec<(String, String, String)> {
    /// 成功结果的有效期。
    const TTL_OK: Duration = Duration::from_secs(6 * 3600);
    /// 失败/空结果的抑制窗口：短到能较快自愈，长到足以挡住一次搜索里的重复调用。
    const TTL_ERR: Duration = Duration::from_secs(60);
    {
        let g = mr_loaders_cache().lock().unwrap();
        if let Some((ts, list)) = g.as_ref() {
            let ttl = if list.is_empty() { TTL_ERR } else { TTL_OK };
            if ts.elapsed() < ttl {
                return list.clone();
            }
        }
    }
    let list: Vec<(String, String, String)> = match client
        .get("https://api.modrinth.com/v2/tag/loader")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let arr: Vec<Value> = r.json().await.unwrap_or_default();
            let mut out: Vec<(String, String, String)> = Vec::new();
            for v in &arr {
                let name = v
                    .get("name")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                let slug = normalize_tag(&name);
                let Some(types) = v.get("supported_project_types").and_then(|t| t.as_array())
                else {
                    continue;
                };
                for ty in types {
                    let Some(ty) = ty.as_str() else { continue };
                    out.push((ty.to_string(), slug.clone(), name.clone()));
                }
            }
            out
        }
        _ => Vec::new(),
    };
    // 成功与失败都记录时间戳，避免上游故障时反复重试（TTL 按结果是否为空区分）。
    let mut g = mr_loaders_cache().lock().unwrap();
    *g = Some((Instant::now(), list.clone()));
    list
}

async fn fetch_mr_categories(client: &reqwest::Client) -> Vec<(String, String, String)> {
    const TTL: Duration = Duration::from_secs(6 * 3600);
    {
        let g = mr_categories_cache().lock().unwrap();
        if let Some((ts, list)) = g.as_ref() {
            if ts.elapsed() < TTL {
                return list.clone();
            }
        }
    }
    let list: Vec<(String, String, String)> = match client
        .get("https://api.modrinth.com/v3/tag/category")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let arr: Vec<Value> = r.json().await.unwrap_or_default();
            arr.into_iter()
                .filter_map(|v| {
                    let name = v
                        .get("name")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    if name.is_empty() {
                        return None;
                    }
                    // v3 的 category 对象无 slug 字段 → 用 name 规范化生成
                    let slug = v
                        .get("slug")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| normalize_tag(&name));
                    let pt = v
                        .get("project_type")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some((pt, slug, name))
                })
                .collect()
        }
        _ => Vec::new(),
    };
    if !list.is_empty() {
        let mut g = mr_categories_cache().lock().unwrap();
        *g = Some((Instant::now(), list.clone()));
    }
    list
}

/// GET /api/resources/categories?source={modrinth|curseforge}&category={...}
/// 返回某资源类型的类别（slug）列表，供前端渲染筛选按钮。
/// Modrinth 按 project_type 过滤；CurseForge 按 class_id 拉取（复用已有缓存）。
async fn categories(
    State(state): State<SharedState>,
    Query(q): Query<CategoriesQuery>,
) -> ApiResult<Json<Vec<ResourceCategoryDto>>> {
    let source = q.source.clone().unwrap_or_else(|| "modrinth".to_string());
    let category = q.category.clone().unwrap_or_else(|| "mod".to_string());

    // Technic 无类别体系（列表接口无分类字段，详情 tags 为自由文本且形态不稳定）
    // → 返回空列表，前端回退到静态兜底（issue #151）。
    if source.eq_ignore_ascii_case("technic") {
        return Ok(Json(Vec::new()));
    }

    if source.eq_ignore_ascii_case("curseforge") {
        let mut out: Vec<ResourceCategoryDto> = Vec::new();
        if let Some(class_id) = map_cf_class_id(Some(&category)) {
            let client = &state.http_client;
            let api_key = &state.curse_forge_api_key;
            let cached = {
                let g = cf_category_cache().lock().unwrap();
                g.get(&Some(class_id)).cloned()
            };
            let map = match cached {
                Some(m) => m,
                None => {
                    let m = fetch_cf_categories(client, api_key, Some(class_id)).await;
                    if !m.is_empty() {
                        cf_category_cache()
                            .lock()
                            .unwrap()
                            .insert(Some(class_id), m.clone());
                    }
                    m
                }
            };
            out = map
                .keys()
                .map(|k| ResourceCategoryDto {
                    slug: k.clone(),
                    name: k.clone(),
                })
                .collect();
            out.sort_by(|a, b| a.slug.cmp(&b.slug));
        }
        return Ok(Json(out));
    }

    let all = fetch_mr_categories(&state.http_client).await;
    let mut filtered: Vec<ResourceCategoryDto> = all
        .iter()
        .filter(|(pt, _, _)| pt.eq_ignore_ascii_case(&category))
        .map(|(_, slug, name)| ResourceCategoryDto {
            slug: slug.clone(),
            name: name.clone(),
        })
        .collect();
    // datapack 无专属类别（v3 tag/category 无 datapack project_type）→ 复用 mod 类别
    if filtered.is_empty() && category.eq_ignore_ascii_case("datapack") {
        filtered = all
            .iter()
            .filter(|(pt, _, _)| pt.eq_ignore_ascii_case("mod"))
            .map(|(_, slug, name)| ResourceCategoryDto {
                slug: slug.clone(),
                name: name.clone(),
            })
            .collect();
    }
    Ok(Json(filtered))
}

/// 加载器 slug → 展示名。Modrinth 的 slug 是全小写连字符形式
/// （`neoforge` / `legacy-fabric`），直接展示对用户不友好；已知项给
/// 品牌正确的大小写，其余回退为逐词首字母大写。
fn loader_display_name(slug: &str) -> String {
    match slug {
        "forge" => "Forge".to_string(),
        "fabric" => "Fabric".to_string(),
        "neoforge" => "NeoForge".to_string(),
        "quilt" => "Quilt".to_string(),
        "liteloader" => "LiteLoader".to_string(),
        "legacy-fabric" => "Legacy Fabric".to_string(),
        "bta-babric" => "BTA Babric".to_string(),
        "java-agent" => "Java Agent".to_string(),
        "bungeecord" => "BungeeCord".to_string(),
        other => other
            .split('-')
            .filter(|w| !w.is_empty())
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// GET /api/resources/loaders?source={all|modrinth|curseforge|ftb}&category={...}
///
/// 返回该「来源 + 资源类型」组合下**真正可用**的加载器选项（#163）。
///
/// 修复前的加载器列表是前端写死的 5 项，与资源类型无关：光影包也会列出
/// Forge，选中后 Modrinth 的 `categories:forge` facet 命中 0 条（列表空白），
/// 且模组缺少 babric / legacy-fabric 等真实存在的加载器。
///
/// `category=aggregate`（聚合分类）跨多个类型，取各类型可用加载器的**并集**
/// —— 聚合查询会按类型分别下发同一个 loader，选中项在对应类型里仍有结果。
async fn loaders(
    State(state): State<SharedState>,
    Query(q): Query<LoadersQuery>,
) -> ApiResult<Json<Vec<ResourceLoaderDto>>> {
    let source = q.source.clone().unwrap_or_else(|| "all".to_string());
    let category = q.category.clone().unwrap_or_else(|| "mod".to_string());
    let aggregate = category.eq_ignore_ascii_case("aggregate");

    let srcs: Vec<&str> = if source.eq_ignore_ascii_case("all") {
        vec!["modrinth", "curseforge", "ftb", "technic"]
    } else {
        vec![source.as_str()]
    };

    // (slug, name)，按 slug 去重
    let mut out: Vec<(String, String)> = Vec::new();

    for src in srcs {
        if src.eq_ignore_ascii_case("modrinth") {
            let all = fetch_mr_loaders(&state.http_client).await;
            let items = all.iter().filter(|(pt, _, _)| {
                // 聚合：并集（不过滤类型）；具体类型：精确匹配
                aggregate || pt.eq_ignore_ascii_case(&category)
            });
            for (_, slug, name) in items {
                out.push((slug.clone(), name.clone()));
            }
        } else if src.eq_ignore_ascii_case("curseforge") {
            // CurseForge 只有「模组 / 整合包」有加载器概念（其余类型传加载器
            // 要么恒 0 要么近乎不过滤），聚合下保留这两类可用的项。
            let supported = aggregate || cf_category_supports_loader(Some(&category));
            if supported {
                for (slug, name, _) in CF_LOADERS {
                    out.push((slug.to_string(), name.to_string()));
                }
            }
        } else if src.eq_ignore_ascii_case("ftb") {
            // FTB 仅整合包。加载器名为自由文本 target name，实测（94 个包全覆盖）
            // 只出现 forge / fabric / neoforge（另有字面量 "unknown"，非加载器，排除）。
            if aggregate || category.eq_ignore_ascii_case("modpack") {
                for slug in ["forge", "fabric", "neoforge"] {
                    out.push((slug.to_string(), loader_display_name(slug)));
                }
            }
        } else if src.eq_ignore_ascii_case("technic") {
            // Technic 仅整合包。加载器维度**无法从列表接口得知**（列表只有 5 个字段），
            // 实测该平台以 Forge 为主（Technic 时代几乎全是 Forge/ModLoader）。
            // 这里只列出可安全筛选的项，避免给出查不到结果的选项（#163 的口径）。
            if aggregate || category.eq_ignore_ascii_case("modpack") {
                for slug in ["forge", "fabric", "neoforge"] {
                    out.push((slug.to_string(), loader_display_name(slug)));
                }
            }
        }
    }

    // 按 slug 去重（跨源交集：forge/fabric/quilt/neoforge 三源通用），
    // 再按展示名排序，保证列表稳定。
    let mut seen: HashSet<String> = HashSet::new();
    let mut list: Vec<ResourceLoaderDto> = out
        .into_iter()
        .filter(|(slug, _)| seen.insert(slug.clone()))
        .map(|(slug, name)| ResourceLoaderDto {
            name: if name.is_empty() {
                loader_display_name(&slug)
            } else {
                name
            },
            slug,
        })
        .collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(Json(list))
}

// =====================================================================
// Handlers: search
// =====================================================================

async fn search(
    State(state): State<SharedState>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<ResourceSearchResponse>> {
    let src = q.source.clone().unwrap_or_else(|| "modrinth".to_string());
    let category = q.category.clone();
    let keyword = q.keyword.clone().unwrap_or_default();
    let game_version = q.game_version.clone();
    let loader = q.loader.clone();
    let sort = q.sort.clone();
    let tags = q.tags.clone();
    let page = q.page.unwrap_or(1);
    let page_size = q.page_size.unwrap_or(20);

    // 对齐 C# McmodService.ResolveChineseSearch 接线：category 为 mod/datapack 时，
    // 用内置 mcmod 数据把中文关键词解析为英文候选（多候选，按平台 slug 批量检索）。
    // 解析不到时保持原文（与 C# 一致，仅替换命中项）。
    let cn_candidates = if category
        .as_deref()
        .map(|c| c.eq_ignore_ascii_case("mod") || c.eq_ignore_ascii_case("datapack"))
        .unwrap_or(false)
    {
        crate::endpoints::mcmod::mcmod_data()
            .resolve_chinese_search_candidates(&keyword, CN_CANDIDATE_LIMIT)
    } else {
        Vec::new()
    };
    if !cn_candidates.is_empty() {
        let (items, total) = search_cn_candidates(
            &state,
            &cn_candidates,
            &src,
            category.as_deref(),
            game_version.as_deref(),
            loader.as_deref(),
            sort.as_deref(),
            tags.as_deref(),
            page,
            page_size,
        )
        .await;
        return Ok(Json(ResourceSearchResponse {
            items,
            total,
            page,
            page_size,
        }));
    }

    // 「聚合」分类：跨资源类型并发查询，按下载量归并（见 search_aggregate_category）。
    if category
        .as_deref()
        .map(|c| c.eq_ignore_ascii_case("aggregate"))
        .unwrap_or(false)
    {
        let (items, total) = search_aggregate_category(
            &state,
            &src,
            &keyword,
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

    // "all" = 聚合源：按分类决定可聚合的源。save 仅 CurseForge；
    // modpack 额外含 FTB 与 Technic（issue #151）；其余为 Modrinth + CurseForge。
    //
    // Technic 的加入是**用户确认过的范围**（issue #151 期2）：它的搜索无分页
    // （固定 15 条），在聚合里会如实参与归并——见 search_one 的 technic 分支
    // 对分页语义的说明。
    let sources: Vec<&str> = if src.eq_ignore_ascii_case("all") {
        match category.as_deref() {
            Some(c) if c.eq_ignore_ascii_case("save") => vec!["curseforge"],
            Some(c) if c.eq_ignore_ascii_case("modpack") => {
                vec!["modrinth", "curseforge", "ftb", "technic"]
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
    //
    // 各源取**累计前缀**再全局排序切窗口（同 `search_aggregate_category`）：若各源只取
    // 「第 page 页」，`download_count=0` 的源（Technic）在全局排序后落到第一页之外时
    // 后续页永远取不到，但 total 里仍统计了它们。
    let fetch_size = (page.max(1))
        .saturating_mul(page_size.max(1))
        .min(MAX_AGGREGATE_FETCH);
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
            1,
            fetch_size,
        )
        .await?;
        total = total.saturating_add(t);
        merged.extend(items);
    }
    // 全局排序（跨源按下载量可比）后切出请求页。
    let window = aggregate_window(merged, page, page_size);
    Ok(Json(ResourceSearchResponse {
        items: window,
        // total 收敛到实际可浏览的上限（见 aggregate_honest_total 的说明）。
        total: aggregate_honest_total(total),
        page,
        page_size,
    }))
}

/// 分类聚合可覆盖的全部资源类型。
const AGGREGATE_TYPES: [&str; 6] = [
    "mod",
    "modpack",
    "shader",
    "resourcepack",
    "datapack",
    "save",
];

/// 聚合查询单源累计取回的上限（`page × page_size` 的上界）。
///
/// 聚合改为「取累计前缀 → 全局排序 → 切窗口」后，深页码会放大单源取回量；这个上限
/// 保证最坏情况仍是一次有界的请求。
///
/// ⚠️ 上限必须与 `total` **一致**（CodeRabbit 在 PR #187 指出）：若只截断取回量而
/// `total` 仍报各源总数之和，用户翻到上限之后会拿到空页，而那部分条目被 `total`
/// 统计着却永远取不到。故 [`aggregate_window`] 的调用方要用
/// [`aggregate_honest_total`] 把 total 收敛到这个上限。
const MAX_AGGREGATE_FETCH: i32 = 200;

/// 聚合窗口裁剪：按 `(source,id)` 去重 → 按下载量降序 → 切出
/// `[(page-1)×pageSize, page×pageSize)`。
///
/// **为什么必须是「先全局排序再切窗口」**：各源各自取第 N 页再合并排序时，全局顺序与
/// 「各源第 N 页」不对应——`download_count` 为 0 的条目（Technic 列表接口不提供下载量，
/// 见 ADR-103）在第一页排序后必然被 `truncate` 掉，而第 2 页又从各源的
/// `offset = pageSize` 开始，于是这些条目**永远无法被浏览到**，但 `total` 里却统计了
/// 它们（CodeRabbit 在 PR #187 指出的问题）。改为累计取前缀后切窗口，分页即连续。
fn aggregate_window(
    merged: Vec<ResourceItemDto>,
    page: i32,
    page_size: i32,
) -> Vec<ResourceItemDto> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    // 同一工程可能以多种类型命中（如既是 mod 又是 datapack），按 (source,id) 去重，
    // 保留先出现的类型，避免同一条目在列表里出现两次。
    let mut deduped: Vec<ResourceItemDto> = merged
        .into_iter()
        .filter(|it| seen.insert((it.source.clone(), it.id.clone())))
        .collect();
    deduped.sort_by(|a, b| b.download_count.cmp(&a.download_count));
    let offset = ((page - 1).max(0) as usize) * page_size.max(0) as usize;
    deduped
        .into_iter()
        .skip(offset)
        .take(page_size.max(0) as usize)
        .collect()
}

/// 聚合对外报告的 `total`：把各源 total 之和收敛到**实际可浏览**的范围内。
///
/// 聚合每次只取 `min(page × pageSize, MAX_AGGREGATE_FETCH)` 条前缀，因此可浏览的条目
/// 最多 `MAX_AGGREGATE_FETCH` 条。如实按这个上界回报，避免出现「翻到后面是空页、但
/// total 说还有更多」的虚假承诺（前端据此判断是否还有下一页）。
fn aggregate_honest_total(sum_of_totals: i32) -> i32 {
    sum_of_totals.min(MAX_AGGREGATE_FETCH)
}

/// 某资源类型实际存在的平台 —— 与 `search` 中 `all` 分支的口径保持一致：
/// save 仅 CurseForge（Modrinth 无此工程类型）；modpack 额外含 FTB 与 Technic；
/// 其余为 Modrinth + CurseForge。
///
/// Technic 仅提供整合包（无模组/光影等），故只出现在 modpack 一行。
fn platforms_for_type(ty: &str) -> &'static [&'static str] {
    match ty {
        "save" => &["curseforge"],
        "modpack" => &["modrinth", "curseforge", "ftb", "technic"],
        _ => &["modrinth", "curseforge"],
    }
}

/// 分类聚合（category=aggregate）：把「类型 × 平台」的查询全部并发发出，再按
/// (source,id) 去重、按下载量归并、切出请求页。
///
/// 分页语义：各源取**累计前缀**（`page × pageSize`）后全局排序再切窗口，保证翻页连续
/// （`total` 仍为各源 total 之和，是上界近似）。
async fn search_aggregate_category(
    state: &SharedState,
    src: &str,
    keyword: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    tags: Option<&str>,
    page: i32,
    page_size: i32,
) -> ApiResult<(Vec<ResourceItemDto>, i32)> {
    // 组装待查的 (类型, 平台) 组合；src 为具体平台时只保留该平台支持的类型，
    // 避免对 FTB 发 shader 之类的无效请求。
    let all_platforms = src.eq_ignore_ascii_case("all");
    let queries: Vec<(&'static str, &'static str)> = AGGREGATE_TYPES
        .iter()
        .flat_map(|ty| {
            platforms_for_type(ty)
                .iter()
                .filter(move |p| all_platforms || p.eq_ignore_ascii_case(src))
                .map(move |p| (*ty, *p))
        })
        .collect();

    // 中文关键词解析（与 `search` 对 mod/datapack 的口径一致）：不带上这一层，
    // 「聚合」分类下用中文名搜不到任何东西，而同关键词在「模组」分类里能搜到。
    let cn_candidates = crate::endpoints::mcmod::mcmod_data()
        .resolve_chinese_search_candidates(keyword, CN_CANDIDATE_LIMIT);
    let cn_candidates = &cn_candidates;

    // ponytail: 分类聚合把请求量放大到最多 12 组（6 类型 × 2~3 平台），顺序执行会
    // 把延迟叠成十几秒，所以这里并发发出；各请求互相独立，任一失败即整体失败
    // （与单源/聚合源的既有语义一致）。
    //
    // 各源取**累计前缀**（0 到 `page × pageSize`）而非「第 page 页」：否则全局排序后
    // 落到第一页之外的条目（典型是 download_count=0 的 Technic）会在后续页永远取不到。
    let fetch_size = (page.max(1))
        .saturating_mul(page_size.max(1))
        .min(MAX_AGGREGATE_FETCH);
    let futures = queries.into_iter().map(|(ty, platform)| async move {
        if !cn_candidates.is_empty() && (ty == "mod" || ty == "datapack") {
            // 中文候选分支必须与其它分支取**同一个累计前缀**（CodeRabbit 在 PR #187
            // 指出）：否则中文搜索的后续页不是同一累计结果集的连续窗口，会漏项/重复。
            let (items, total) = search_cn_candidates(
                state,
                cn_candidates,
                platform,
                Some(ty),
                game_version,
                loader,
                sort,
                tags,
                1,
                fetch_size,
            )
            .await;
            Ok((items, total))
        } else {
            search_one(
                state,
                platform,
                keyword,
                Some(ty),
                game_version,
                loader,
                sort,
                tags,
                // 累计前缀：page=1 起取 0..fetch_size
                1,
                fetch_size,
            )
            .await
        }
    });
    let results = futures::future::join_all(futures).await;

    let mut merged: Vec<ResourceItemDto> = Vec::new();
    let mut total = 0i32;
    for result in results {
        let (items, t) = result?;
        total = total.saturating_add(t);
        merged.extend(items);
    }
    // 全局排序后切出请求页（分页连续性见 `aggregate_window` 的说明），
    // total 收敛到实际可浏览的上限（见 `aggregate_honest_total`）。
    let window = aggregate_window(merged, page, page_size);
    Ok((window, aggregate_honest_total(total)))
}

/// 中文关键词候选检索：Modrinth 批量取回候选 slug + 首候选搜索补充；
/// CurseForge 对前几个候选逐个搜索；跨源/跨候选按 (source, id) 去重，按下载量排序截断。
const CN_CANDIDATE_LIMIT: usize = 20;
const CN_CF_MAX_SEARCH: usize = 5;

async fn search_cn_candidates(
    state: &SharedState,
    candidates: &[crate::endpoints::mcmod::CnSearchCandidate],
    src: &str,
    category: Option<&str>,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    tags: Option<&str>,
    page: i32,
    page_size: i32,
) -> (Vec<ResourceItemDto>, i32) {
    let sources: Vec<&str> = if src.eq_ignore_ascii_case("all") {
        // 中文搜索仅作用于 mod/datapack，不含 FTB（modpack 不解析中文）。
        vec!["modrinth", "curseforge"]
    } else {
        vec![src]
    };

    let mut merged: Vec<ResourceItemDto> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut push_items = |merged: &mut Vec<ResourceItemDto>, items: Vec<ResourceItemDto>| {
        for it in items {
            let key = (it.source.clone(), it.id.clone());
            if seen.insert(key) {
                merged.push(it);
            }
        }
    };

    for source in sources {
        if source.eq_ignore_ascii_case("modrinth") {
            let slugs: Vec<String> = candidates
                .iter()
                .filter_map(|c| c.mr_slug.clone())
                .collect();
            let items = fetch_mr_projects_by_slugs(
                &state.http_client,
                &slugs,
                game_version,
                loader,
                category.unwrap_or(""),
            )
            .await;
            push_items(&mut merged, items);
            // 首候选（含 mr slug 或非空 term）搜索补充：让主 mod 相关结果也能出现。
            let first = candidates.iter().find_map(|c| {
                c.mr_slug
                    .clone()
                    .or_else(|| Some(c.term.clone()))
                    .filter(|s| !s.is_empty())
            });
            if let Some(term) = first {
                if let Ok((items, _)) = search_one(
                    state,
                    "modrinth",
                    &term,
                    category,
                    game_version,
                    loader,
                    sort,
                    tags,
                    page,
                    page_size,
                )
                .await
                {
                    push_items(&mut merged, items);
                }
            }
        } else if source.eq_ignore_ascii_case("curseforge") {
            for cand in candidates.iter().take(CN_CF_MAX_SEARCH) {
                let term = cand.term.trim();
                if term.is_empty() {
                    continue;
                }
                if let Ok((items, _)) = search_one(
                    state,
                    "curseforge",
                    term,
                    category,
                    game_version,
                    loader,
                    sort,
                    tags,
                    page,
                    page_size,
                )
                .await
                {
                    push_items(&mut merged, items);
                }
            }
        }
    }

    merged.sort_by(|a, b| b.download_count.cmp(&a.download_count));
    merged.truncate(page_size as usize);
    let total = merged.len() as i32;
    (merged, total)
}

/// 按 Modrinth slug 批量取回工程（`/v2/projects?ids=[...]`），按游戏版本/加载器过滤。
/// 批量接口返回的 project 与 `/project/{id}` 同结构，可反序列化为 `ProjectInfo`。
async fn fetch_mr_projects_by_slugs(
    client: &reqwest::Client,
    slugs: &[String],
    game_version: Option<&str>,
    loader: Option<&str>,
    category: &str,
) -> Vec<ResourceItemDto> {
    if slugs.is_empty() {
        return Vec::new();
    }
    let mut unique: Vec<&str> = Vec::new();
    for s in slugs {
        if !unique.contains(&s.as_str()) && unique.len() < 200 {
            unique.push(s.as_str());
        }
    }
    if unique.is_empty() {
        return Vec::new();
    }
    let ids_json = unique
        .iter()
        .map(|s| format!("\"{}\"", s))
        .collect::<Vec<_>>()
        .join(",");
    let url = format!("https://api.modrinth.com/v2/projects?ids=[{}]", ids_json);
    let resp = match client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let projects: Vec<ProjectInfo> = match resp.json().await {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    projects
        .into_iter()
        .filter(|p| {
            let gv_ok = match game_version {
                Some(g) => p
                    .game_version_ids
                    .as_ref()
                    .map(|v| v.iter().any(|x| x == g))
                    .unwrap_or(true),
                None => true,
            };
            let l_ok = match loader {
                Some(l) => p
                    .loaders
                    .as_ref()
                    .map(|v| v.iter().any(|x| x == l))
                    .unwrap_or(true),
                None => true,
            };
            gv_ok && l_ok
        })
        .map(|p| project_info_to_item(p, category))
        .collect()
}

fn project_info_to_item(p: ProjectInfo, category: &str) -> ResourceItemDto {
    let slug = p.slug.clone().unwrap_or_else(|| p.id.clone());
    ResourceItemDto {
        id: p.id.clone(),
        title: p.name.clone(),
        description: p.description.clone(),
        author: String::new(),
        icon_url: p.icon_url.clone().unwrap_or_default(),
        download_count: p.download_count as i64,
        source: "modrinth".to_string(),
        categories: p.categories.clone().unwrap_or_default(),
        project_url: format!("https://modrinth.com/project/{}", slug),
        slug,
        category: category.to_string(),
    }
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
        // #163：丢弃与当前资源类型不兼容的 loader（如光影包 + forge），
        // 否则 Modrinth 会静默返回 0 条，用户看到空白列表。
        let effective_loader = match loader {
            Some(l)
                if !l.is_empty() && !mr_loader_supported(&state.http_client, category, l).await =>
            {
                None
            }
            other => other,
        };
        let loaders: Vec<String> = effective_loader
            .map(|l| vec![l.to_string()])
            .unwrap_or_default();
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
            .map(|r| search_info_to_item(r, "modrinth", category.unwrap_or("")))
            .collect();
        Ok((items, result.total_results))
    } else if source.eq_ignore_ascii_case("curseforge") {
        let cf = state
            .core
            .create_curseforge_source(&state.curse_forge_api_key);
        let cf_class_id = map_cf_class_id(category);
        let cf_url_slug = map_cf_url_slug(category);
        // #163：CurseForge 仅模组/整合包有加载器概念；非模组类型上忽略 loader
        // （否则会得到恒 0 的结果，如 shader + 数值 loader）。
        let loaders = if cf_category_supports_loader(category) {
            loader.and_then(map_cf_loader).unwrap_or_default()
        } else {
            Vec::new()
        };
        // 把标签 slug 解析为 CurseForge 数字 categoryId（无匹配则忽略，等价于不过滤）。
        let cf_category_ids: Option<Vec<Option<i32>>> = cf_resolve_category_ids(
            &state.http_client,
            &state.curse_forge_api_key,
            &tag_vec,
            cf_class_id,
        )
        .await
        .map(|ids| ids.into_iter().map(Some).collect());
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
            .filter_map(|r| cf_result_to_item(r, cf_url_slug, category.unwrap_or("")))
            .collect();
        Ok((items, result.total_count))
    } else if source.eq_ignore_ascii_case("ftb") {
        if !category.unwrap_or("").eq_ignore_ascii_case("modpack") {
            return Ok((vec![], 0));
        }
        let ftb = state.core.create_ftb_source();
        // core FtbSource::search 无 page 参数（全量拉取后内存过滤），此处取全量后
        // 内存切片分页；total 用真实总数，否则 total==首页条数 → 前端「加载更多」失效。
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
                i32::MAX,
            )
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let total = packs.len() as i32;
        let offset = ((page - 1).max(0) as usize) * page_size.max(0) as usize;
        let items: Vec<ResourceItemDto> = packs
            .iter()
            .skip(offset)
            .take(page_size.max(0) as usize)
            .map(|p| ftb_pack_to_item(p, "ftb", "modpack"))
            .collect();
        Ok((items, total))
    } else if source.eq_ignore_ascii_case("technic") {
        // Technic 只有整合包（issue #151）。
        if !category.unwrap_or("").eq_ignore_ascii_case("modpack") {
            return Ok((vec![], 0));
        }
        let technic = state.core.create_technic_source();
        // 无关键词 → 服务端 /search 返回 400，改走 /trending 填默认列表（实测）。
        let (packs, total) = if keyword.trim().is_empty() {
            technic.trending().await
        } else {
            technic.search(keyword).await
        }
        .map_err(|e| ApiError::upstream(e.to_string()))?;
        // ⚠️ 分页语义：Technic API **无分页**（固定 15 / 20 条，忽略 page）。
        //
        // 这里仍按 page/page_size 做内存切片，保证与其它源的契约一致；但
        // ①`total` 回报**本次实际条数**（不伪造总数，否则前端「加载更多」会
        // 无限拉取永远取不到的第 2 页）；②只有第 1 页可能非空——`page>1` 时
        // 切片结果自然为空，这正是「服务端没有更多数据」的如实表达。
        //
        // 因此**不把 technic 计入聚合分页**会更好，但用户已确认纳入聚合源
        // （见 platforms_for_type / sources）；聚合分支用的是 `search_one` 的
        // 返回值并统一按下载量归并截断，故此处语义安全。
        let offset = ((page - 1).max(0) as usize) * page_size.max(0) as usize;
        let items: Vec<ResourceItemDto> = packs
            .iter()
            .skip(offset)
            .take(page_size.max(0) as usize)
            .map(|p| technic_summary_to_item(p, category.unwrap_or("modpack")))
            .collect();
        Ok((items, total))
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
                .logo
                .as_ref()
                .and_then(|l| l.url.clone())
                .or_else(|| {
                    info.screenshots
                        .as_ref()
                        .and_then(|s| s.first())
                        .and_then(|s| s.thumbnail_url.clone())
                })
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

    if src.eq_ignore_ascii_case("technic") {
        // id 即 slug：实测数字 id 在详情接口上 404，slug 是唯一键（ADR-103）。
        let technic = state.core.create_technic_source();
        let pack = technic
            .get_pack_detail(&id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let pack = match pack {
            Some(p) => p,
            None => {
                return Err(ApiError::not_found(
                    "NOT_FOUND",
                    "Technic modpack not found",
                ))
            }
        };
        return Ok(Json(ResourceDetailDto {
            // `id` 必须是 **slug**，与列表项（`technic_summary_to_item`）保持一致。
            //
            // CodeRabbit 在 PR #187 指出（已核实为真缺陷）：列表用 slug 作 id，而这里
            // 原先用数字 id，导致详情页收藏时 `toggleFavorite(detail)` 写入数字 id 的
            // 记录，而收藏态判定用的是 URL 里的 slug → 按钮永远显示未收藏、且产生重复记录。
            // 数字 id 在 DTO 里无处需要（`project_url` 已含网页地址），故直接用 slug。
            id: pack.name.clone(),
            title: pack.instance_name().to_string(),
            description: pack.description.clone(),
            author: pack.user.clone(),
            icon_url: pack
                .icon
                .as_ref()
                .map(|a| a.url().to_string())
                .or_else(|| pack.logo.as_ref().map(|a| a.url().to_string()))
                .unwrap_or_default(),
            download_count: pack.installs,
            source: "technic".to_string(),
            // tags 实测形态不稳定（逗号/空格分隔/null），尽力拆分；拆不出就空。
            categories: pack
                .tags
                .as_deref()
                .map(qomicex_core::models::expansion::technic::split_tags)
                .unwrap_or_default(),
            project_url: pack.web_url(),
            slug: pack.name.clone(),
            body: String::new(),
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

    if src.eq_ignore_ascii_case("technic") {
        // Technic **无版本列表**：一个包只有一个 `version` 字符串 + 一个直链
        // （ADR-103 实测）。因此这里把「包本身」建模成唯一的版本条目，让前端
        // 现有的「选版本 → 安装」流程无需特殊分支即可工作。
        //
        // 版本 id 用 slug（唯一键）；SingleZip 的直链填进 downloads，使前端的
        // 「保存到本地」按钮也能用。Solder / 不可用包给空 downloads，前端据此
        // 提示「暂不支持」（期3 #181）。
        let technic = state.core.create_technic_source();
        let pack = technic
            .get_pack_detail(&id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let Some(pack) = pack else {
            return Ok(Json(vec![]));
        };
        // 版本号：API 的 version 字段（如 "4.1.0"）；空则退化为 slug。
        let version_number = if pack.version.trim().is_empty() {
            pack.name.clone()
        } else {
            pack.version.clone()
        };
        let downloads = match pack.single_zip_url() {
            Some(u) => vec![ResourceFileDto {
                url: u.to_string(),
                // 文件名：列表接口不给包体文件名，用 slug-version.zip 构造（仅展示用，
                // 真实下载由后端按 URL 落地，不经前端文件名）。
                filename: format!("{}-{}.zip", pack.name, version_number),
                size: 0,
            }],
            None => Vec::new(),
        };
        let game_versions = if pack.minecraft.trim().is_empty() {
            Vec::new()
        } else {
            vec![pack.minecraft.clone()]
        };
        return Ok(Json(vec![ResourceVersionDto {
            id: pack.name.clone(),
            name: version_number.clone(),
            version_number,
            game_versions,
            // 加载器维度需读包内 version.json，列表/详情接口拿不到 → 留空由
            // 安装管线自行识别（technic 转换器会解析出真实 loader）。
            loaders: Vec::new(),
            downloads,
            dependencies: None,
            date_published: None,
        }]));
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

    if src.eq_ignore_ascii_case("technic") {
        // Technic 无版本概念（`version_id` 即 slug 回显，见 versions 分支），
        // 直链直接由详情给出；这里同样按详情解析，保证与 versions 分支一致。
        let technic = state.core.create_technic_source();
        let pack = technic
            .get_pack_detail(&id)
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let Some(pack) = pack else {
            return Ok(Json(vec![]));
        };
        let files = match pack.single_zip_url() {
            Some(u) => vec![ResourceFileDto {
                url: u.to_string(),
                filename: format!("{}-{}.zip", pack.name, pack.version),
                size: 0,
            }],
            // Solder / 不可用：无直链（前端据此提示「暂不支持」，期3 #181）
            None => Vec::new(),
        };
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

fn search_info_to_item(r: &SearchResultInfo, source: &str, category: &str) -> ResourceItemDto {
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
        category: category.to_string(),
    }
}

fn cf_result_to_item(
    r: &qomicex_core::models::expansion::curseforge::CurseForgeSearchResult,
    url_slug: &str,
    category: &str,
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
        category: category.to_string(),
    })
}

fn ftb_pack_to_item(
    p: &qomicex_core::models::expansion::ftb::ModpackInfo,
    source: &str,
    category: &str,
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
        category: category.to_string(),
    }
}

/// Technic 列表项 → 通用资源条目（issue #151）。
///
/// Technic 列表接口只给 5 个字段（id/name/slug/url/iconUrl），没有下载量/作者/
/// 简介——**详情接口才有**。为不在搜索路径上多打 N 次详情请求，这里按可得字段
/// 填充，缺失项留空：
/// - `id` 用 **slug**（唯一可寻址键，详见 technic 模块注释）；数字 id 仅作
///   `project_url` 的组成部分。
/// - `download_count` 置 0：列表接口不提供，前端按下载量排序时该项恒排末尾
///   （不伪造数字，避免误导排序）。
/// - `project_url` 用列表项自带的网页地址（实测可靠）。
fn technic_summary_to_item(
    p: &qomicex_core::models::expansion::technic::TechnicPackSummary,
    category: &str,
) -> ResourceItemDto {
    ResourceItemDto {
        id: p.slug.clone(),
        title: p.name.clone(),
        description: String::new(),
        author: String::new(),
        icon_url: p.icon_url.clone(),
        download_count: 0,
        source: "technic".to_string(),
        categories: Vec::new(),
        project_url: p.url.clone(),
        slug: p.slug.clone(),
        category: category.to_string(),
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

/// 完整性可能受损的 CF 版本列表：`(版本列表, 是否不完整)`。
///
/// `incomplete == true` 表示部分分页请求失败——版本列表**缺项**。
/// 更新检查（issue #118）必须把这个信号透出给用户：缺项时「没找到更新的版本」
/// 不能当作「已是最新」，否则会误导用户以为已经是最新版。
pub(crate) struct CfVersionList {
    pub(crate) versions: Vec<ResourceVersionDto>,
    pub(crate) incomplete: bool,
}

/// 拉取 CF 项目的**全部**版本，不做 gameVersion / loader 过滤。
///
/// 与 [`cf_versions_raw`] 的区别：后者会按 gameVersion 过滤并复用缓存键，
/// 面向资源中心的「选版本」UI；更新检查需要**未过滤的全量列表**才能判断
/// 「新版本是否变更了 MC / 加载器」，故单独走一条路径，并显式回报完整性。
pub(crate) async fn cf_versions_all(
    client: &reqwest::Client,
    fetch_service: &crate::services::curseforge_fetch::CurseForgeVersionFetchService,
    id: &str,
    api_key: &str,
) -> CfVersionList {
    let key = crate::services::curseforge_fetch::CurseForgeVersionFetchService::cache_key(id, None);
    if let Some(cached) = fetch_service.get_cached(&key) {
        if !cached.is_empty() {
            return CfVersionList {
                versions: cached.iter().map(cf_file_to_version_dto).collect(),
                incomplete: false,
            };
        }
    }

    let Some(body) = cf_get_raw(client, &cf_files_url(id, None, None), api_key).await else {
        // 首屏失败：无法区分「项目没有文件」与「请求失败」，标记为不完整交由调用方
        // 决定；调用方对空列表 + incomplete 会返回错误而非「已是最新」。
        return CfVersionList {
            versions: vec![],
            incomplete: true,
        };
    };
    let first_data: Vec<Value> = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let total_count = body
        .get("pagination")
        .and_then(|p| p.get("totalCount"))
        .and_then(|t| t.as_i64())
        .unwrap_or(0)
        .max(0) as usize;
    let page_size = 50usize;
    let total_pages = total_count.div_ceil(page_size);
    let mut all_items: Vec<Value> = first_data;
    let mut incomplete = false;

    if total_pages > 1 {
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(fetch_service.concurrency()));
        let mut handles = Vec::new();
        for p in 1..total_pages {
            let Ok(permit) = sem.clone().acquire_owned().await else {
                incomplete = true;
                break;
            };
            let client = client.clone();
            let api_key = api_key.to_string();
            let id = id.to_string();
            handles.push(tokio::spawn(async move {
                let _permit = permit;
                let url = cf_files_url(&id, Some((p * page_size) as i64), None);
                cf_get_raw(&client, &url, &api_key).await.map(|b| {
                    b.get("data")
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default()
                })
            }));
        }
        for h in handles {
            match h.await {
                Ok(Some(items)) => all_items.extend(items),
                // 任一页失败 → 列表缺项，必须如实标注（不可静默当完整列表用）。
                _ => incomplete = true,
            }
        }
    }

    // 只有完整结果才入缓存，避免把缺项列表固化下来。
    if !all_items.is_empty() && !incomplete {
        fetch_service.set_cached(key, all_items.clone());
    }

    CfVersionList {
        versions: all_items.iter().map(cf_file_to_version_dto).collect(),
        incomplete,
    }
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

// =====================================================================
// Handlers: resource favorites（收藏，见 services/resource_favorite.rs）
//
// 路径用 `/resource-favorites` 而非 `/resources/favorites`：后者会与
// `/resources/{id}` 的通配段争抢同一路径形状，徒增路由歧义。
// =====================================================================

/// `DELETE /resource-favorites` 的唯一键查询参数。
///
/// 唯一键走 query 而不是路径段，避免资源 id / source 中的特殊字符影响路径匹配。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteKeyQuery {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    category: Option<String>,
}

impl FavoriteKeyQuery {
    /// 三个键段都必须非空，否则返回 400（而不是静默匹配到空键的记录）。
    fn validated(self) -> ApiResult<(String, String, String)> {
        let pick = |v: Option<String>, name: &str| -> ApiResult<String> {
            v.map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    ApiError::bad_request("INVALID_FAVORITE_KEY", format!("{name} 不能为空"))
                })
        };
        Ok((
            pick(self.source, "source")?,
            pick(self.id, "id")?,
            pick(self.category, "category")?,
        ))
    }
}

async fn list_resource_favorites(
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<ResourceFavorite>>> {
    Ok(Json(state.resource_favorites.get_all()))
}

async fn add_resource_favorite(
    State(state): State<SharedState>,
    req: Json<ResourceFavorite>,
) -> ApiResult<Json<ResourceFavorite>> {
    // 先裁剪再校验/落库：DELETE 侧对查询参数同样裁剪后才精确匹配，写入侧若存原值，
    // 带首尾空白的收藏将永远删不掉（`" Sodium "` 存进去、`"Sodium"` 删不掉）。
    // 裁剪实现与落库侧共用 `ResourceFavorite::normalize_key`，避免两处口径漂移。
    let mut item = req.0;
    item.normalize_key();
    if item.source.is_empty() || item.id.is_empty() || item.category.is_empty() {
        return Err(ApiError::bad_request(
            "INVALID_FAVORITE_KEY",
            "source / id / category 不能为空",
        ));
    }
    state
        .resource_favorites
        .upsert(item)
        .map(Json)
        .map_err(|e| ApiError::internal(format!("保存收藏失败: {e}")))
}

async fn remove_resource_favorite(
    State(state): State<SharedState>,
    Query(q): Query<FavoriteKeyQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let (source, id, category) = q.validated()?;
    let removed = state
        .resource_favorites
        .remove(&source, &id, &category)
        .map_err(|e| ApiError::internal(format!("删除收藏失败: {e}")))?;
    Ok(Json(serde_json::json!({ "removed": removed })))
}

// =====================================================================
// Handlers: resource favorite folders（收藏夹，P2）
//
// 收藏夹实体单独存 resource_favorite_folders.json（P1 的扁平数组格式不变）；
// 条目的 folderIds / note / tags 仍由上面的 POST /resource-favorites（upsert）写入。
// =====================================================================

/// `POST` / `PUT /resource-favorite-folders` 的请求体。
#[derive(Deserialize)]
struct FolderUpsertRequest {
    #[serde(default)]
    name: String,
}

/// 服务层错误 → HTTP：落盘失败 500，不存在 404，其余（名称非法/重名）400。
fn map_folder_error(e: FolderError) -> ApiError {
    if e.is_save_failure() {
        ApiError::internal(e.message())
    } else if e == FolderError::NotFound {
        ApiError::not_found(e.code(), e.message())
    } else {
        ApiError::bad_request(e.code(), e.message())
    }
}

async fn list_favorite_folders(
    State(state): State<SharedState>,
) -> ApiResult<Json<Vec<FavoriteFolder>>> {
    Ok(Json(state.resource_favorite_folders.get_all()))
}

async fn create_favorite_folder(
    State(state): State<SharedState>,
    req: Json<FolderUpsertRequest>,
) -> ApiResult<Json<FavoriteFolder>> {
    state
        .resource_favorite_folders
        .create(&req.name)
        .map(Json)
        .map_err(map_folder_error)
}

async fn rename_favorite_folder(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    req: Json<FolderUpsertRequest>,
) -> ApiResult<Json<FavoriteFolder>> {
    state
        .resource_favorite_folders
        .rename(&id, &req.name)
        .map(Json)
        .map_err(map_folder_error)
}

async fn delete_favorite_folder(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    // 先确认存在，避免对不存在的 id 做破坏性级联（404 语义要干净）。
    if !state.resource_favorite_folders.exists(&id) {
        return Err(ApiError::not_found(
            "FAVORITE_FOLDER_NOT_FOUND",
            "收藏夹不存在",
        ));
    }
    // 级联顺序：**先解关联（写 items）→ 再删夹子实体（写 folders）**。
    // 第二步失败时最坏是「收藏已解关联、夹子空着」这种无害残留；反序会留下指向已删夹子的
    // 悬空 folderId（详见 services/resource_favorite_folder.rs 模块注释）。
    //
    // P3 语义变更：一条收藏可归属多个夹子，级联删除会连带删掉本属于别的夹子的收藏，
    // 因此这里只**解除关联**、收藏条目本身保留（无可归属夹子的自然落到「未分组」）。
    let detached_favorites = state
        .resource_favorites
        .detach_from_folder(&id)
        .map_err(|e| ApiError::internal(format!("解除夹内收藏关联失败: {e}")))?;
    state
        .resource_favorite_folders
        .delete(&id)
        .map_err(map_folder_error)?;
    Ok(Json(serde_json::json!({
        "removed": true,
        "detachedFavorites": detached_favorites,
    })))
}

#[cfg(test)]
mod favorites_tests {
    use super::*;

    fn q(source: Option<&str>, id: Option<&str>, category: Option<&str>) -> FavoriteKeyQuery {
        FavoriteKeyQuery {
            source: source.map(str::to_string),
            id: id.map(str::to_string),
            category: category.map(str::to_string),
        }
    }

    /// `DELETE /resource-favorites` 的唯一键契约：三段必填、空白裁剪、
    /// 缺失/全空白一律 400（而不是静默匹配到空键记录）。
    #[test]
    fn favorite_key_query_validates_all_three_segments() {
        assert_eq!(
            q(Some("modrinth"), Some("AANobbMI"), Some("mod"))
                .validated()
                .unwrap(),
            (
                "modrinth".to_string(),
                "AANobbMI".to_string(),
                "mod".to_string()
            )
        );
        // 首尾空白裁剪，避免与写入时的键不一致（" mod " vs "mod"）。
        assert_eq!(
            q(Some(" modrinth "), Some(" AANobbMI "), Some(" mod "))
                .validated()
                .unwrap()
                .0,
            "modrinth"
        );
        for bad in [
            q(None, Some("AANobbMI"), Some("mod")),
            q(Some("modrinth"), None, Some("mod")),
            q(Some("modrinth"), Some("AANobbMI"), None),
            q(Some(""), Some("AANobbMI"), Some("mod")),
            q(Some("modrinth"), Some("   "), Some("mod")),
        ] {
            let err = bad.validated().expect_err("应当返回 400");
            assert_eq!(err.status, 400);
            assert_eq!(err.code, "INVALID_FAVORITE_KEY");
        }
    }

    /// query 字段名就是 `source` / `id` / `category`（前端 `URLSearchParams`
    /// 直传）；多余参数必须被忽略而不是报错。
    #[test]
    fn favorite_key_query_deserializes_from_query_params() {
        let parsed: FavoriteKeyQuery =
            serde_json::from_str(r#"{"source":"curseforge","id":"238222","category":"mod"}"#)
                .unwrap();
        assert_eq!(
            parsed.validated().unwrap(),
            (
                "curseforge".to_string(),
                "238222".to_string(),
                "mod".to_string()
            )
        );
        let extra: FavoriteKeyQuery =
            serde_json::from_str(r#"{"source":"a","id":"b","category":"c","extra":"ignored"}"#)
                .unwrap();
        assert_eq!(extra.validated().unwrap().0, "a");
    }

    /// 收藏夹错误 → HTTP 状态映射：名称非法 / 重名 → 400，不存在 → 404，
    /// 落盘失败 → 500。错误码沿用实例分组 `GROUP_*` 的命名风格。
    #[test]
    fn folder_error_maps_to_expected_status() {
        for (err, status, code) in [
            (FolderError::EmptyName, 400, "FAVORITE_FOLDER_NAME_EMPTY"),
            (
                FolderError::NameTooLong,
                400,
                "FAVORITE_FOLDER_NAME_TOO_LONG",
            ),
            (FolderError::NameTaken, 400, "FAVORITE_FOLDER_NAME_EXISTS"),
            (FolderError::NotFound, 404, "FAVORITE_FOLDER_NOT_FOUND"),
            // 落盘失败刻意走 `ApiError::internal`（code `INTERNAL_ERROR`），与 P1 收藏
            // 端点、以及仓库「意外故障用 internal」的口径一致；具体原因放 message。
            (FolderError::Save("disk full".into()), 500, "INTERNAL_ERROR"),
        ] {
            let mapped = map_folder_error(err);
            assert_eq!(mapped.status, status);
            assert_eq!(mapped.code, code);
        }
        // 500 的 message 必须带上原因与上下文，否则无从排查。
        let save_err = map_folder_error(FolderError::Save("disk full".into()));
        assert!(save_err.message.contains("收藏夹"));
        assert!(save_err.message.contains("disk full"));
    }

    /// 请求体契约：`name` 缺省为空串（由服务层判 `EmptyName` → 400，端点不重复裁剪），
    /// 未知字段忽略（前端后续加 color 等不会把请求打挂）。
    #[test]
    fn folder_upsert_request_deserializes() {
        let with_name: FolderUpsertRequest =
            serde_json::from_str(r#"{"name":"  优化  "}"#).unwrap();
        assert_eq!(with_name.name, "  优化  ", "裁剪由服务层统一做");
        let empty: FolderUpsertRequest = serde_json::from_str(r#"{}"#).unwrap();
        assert!(empty.name.is_empty());
        let extra: FolderUpsertRequest =
            serde_json::from_str(r##"{"name":"a","color":"#fff"}"##).unwrap();
        assert_eq!(extra.name, "a");
    }

    /// 收藏夹的 JSON 契约：键名 camelCase（`createdAt`），且只发 `id`/`name`
    /// 也能反序列化（`createdAt` 走 serde default）。
    #[test]
    fn favorite_folder_json_contract_is_camel_case() {
        let folder = FavoriteFolder {
            id: "f1".into(),
            name: "优化".into(),
            created_at: "2026-10-01T00:00:00+00:00".into(),
        };
        let v = serde_json::to_value(&folder).unwrap();
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("createdAt"), "键名必须 camelCase");
        assert!(!obj.contains_key("created_at"));
        assert_eq!(obj.len(), 3, "字段数变化说明契约已漂移");

        let minimal: FavoriteFolder = serde_json::from_str(r#"{"id":"x","name":"y"}"#).unwrap();
        assert_eq!(minimal.created_at, "");
    }

    // =================================================================
    // #163 加载器分类
    // =================================================================

    /// CF 加载器下发的是**数字 id**（无歧义），未知名称必须返回 None。
    ///
    /// 名称拼错会被 CurseForge 静默忽略并返回全部结果（实测 `[Bogus]` →
    /// totalCount 10000），筛选器形同虚设；故这里断言未知值不被下发。
    #[test]
    fn cf_loader_maps_to_numeric_ids_and_rejects_unknown() {
        // 枚举值来自 issue 回复：1=Forge, 4=Fabric, 5=Quilt, 6=NeoForge
        for (input, expected) in [
            ("forge", "1"),
            ("Fabric", "4"),
            ("  Quilt ", "5"),
            ("NEOFORGE", "6"),
        ] {
            assert_eq!(
                map_cf_loader(input),
                Some(vec![expected.to_string()]),
                "loader {input:?} 应映射到 modLoaderTypes=[{expected}]"
            );
        }
        // Cauldron(2) / LiteLoader(3) 实测恒为 0 条，Any(0) 也返回 0 而非「全部」，
        // 故都不是合法选项；未知值一律 None，避免被 CF 静默忽略。
        for bad in ["cauldron", "liteloader", "any", "bogus", ""] {
            assert_eq!(map_cf_loader(bad), None, "{bad:?} 不应作为加载器下发");
        }
    }

    /// CurseForge 只在模组/整合包上有加载器概念。
    #[test]
    fn cf_loader_only_applies_to_mod_and_modpack() {
        assert!(cf_category_supports_loader(Some("mod")));
        assert!(cf_category_supports_loader(Some("ModPack")));
        for unsupported in [
            "shader",
            "resourcepack",
            "datapack",
            "save",
            "aggregate",
            "",
        ] {
            assert!(
                !cf_category_supports_loader(Some(unsupported)),
                "{unsupported:?} 不应启用 CF 加载器筛选"
            );
        }
        assert!(!cf_category_supports_loader(None));
    }

    /// 展示名：品牌大小写必须正确（issue 明确点名 NeoForge / Babric / LegacyFabric）。
    #[test]
    fn loader_display_name_uses_brand_casing() {
        assert_eq!(loader_display_name("neoforge"), "NeoForge");
        assert_eq!(loader_display_name("liteloader"), "LiteLoader");
        assert_eq!(loader_display_name("legacy-fabric"), "Legacy Fabric");
        assert_eq!(loader_display_name("bta-babric"), "BTA Babric");
        assert_eq!(loader_display_name("bungeecord"), "BungeeCord");
        // 未知项回退逐词首字母大写，且不 panic
        assert_eq!(loader_display_name("ornithe"), "Ornithe");
        assert_eq!(loader_display_name("java-agent"), "Java Agent");
        assert_eq!(loader_display_name(""), "");
    }

    /// DTO 的 JSON 契约：camelCase 键名（`slug`/`name`），与前端
    /// `ResourceCategory` 的解构保持一致。
    #[test]
    fn resource_loader_dto_json_contract() {
        let dto = ResourceLoaderDto {
            slug: "neoforge".into(),
            name: "NeoForge".into(),
        };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["slug"], "neoforge");
        assert_eq!(v["name"], "NeoForge");
        assert_eq!(v.as_object().unwrap().len(), 2);
    }

    // =================================================================
    // #151 Technic 源
    // =================================================================

    /// Technic 只提供整合包：类型表必须只在 modpack 一行出现它，且不污染其它类型。
    #[test]
    fn technic_is_only_a_modpack_platform() {
        assert!(platforms_for_type("modpack").contains(&"technic"));
        for ty in ["mod", "shader", "resourcepack", "datapack", "save"] {
            assert!(
                !platforms_for_type(ty).contains(&"technic"),
                "{ty} 不应包含 technic（该平台无此类资源）"
            );
        }
    }

    /// 聚合源的 modpack 分支必须包含 technic（用户确认纳入聚合，见决策记录）。
    #[test]
    fn technic_aggregates_for_modpack() {
        // 与 `search` 中 all + modpack 的映射保持同步：四处清单任一不同步，
        // 聚合结果就会与单源结果不一致（这类漂移无编译期保护，只能靠测试守）。
        assert!(platforms_for_type("modpack").contains(&"technic"));
    }

    /// 列表项 → DTO：`id` 必须是 **slug**（唯一可寻址键），不是数字 id。
    ///
    /// 数字 id 在详情接口上 404（ADR-103 实测），若这里误用 `p.id`，
    /// 前端点进详情/安装会全部失败。
    #[test]
    fn technic_summary_maps_slug_as_id() {
        use qomicex_core::models::expansion::technic::TechnicPackSummary;
        let p = TechnicPackSummary {
            id: "1540828".into(),
            name: "Agrarian Skies".into(),
            slug: "agrarian-skies".into(),
            url: "https://www.technicpack.net/modpack/agrarian-skies.1540828".into(),
            icon_url: "https://cdn/icon.png".into(),
        };
        let item = technic_summary_to_item(&p, "modpack");
        assert_eq!(
            item.id, "agrarian-skies",
            "id 必须是 slug（数字 id 会 404）"
        );
        assert_eq!(item.slug, "agrarian-skies");
        assert_eq!(item.title, "Agrarian Skies");
        assert_eq!(item.source, "technic");
        assert_eq!(item.category, "modpack");
        assert_eq!(item.project_url, p.url);
        // 列表接口不提供下载量：如实为 0，不伪造
        assert_eq!(item.download_count, 0);
    }

    /// DTO 的 JSON 契约：前端按 camelCase 解构（`iconUrl` / `downloadCount`）。
    #[test]
    fn technic_item_json_contract_is_camel_case() {
        use qomicex_core::models::expansion::technic::TechnicPackSummary;
        let p = TechnicPackSummary {
            id: "1".into(),
            name: "X".into(),
            slug: "x".into(),
            url: "u".into(),
            icon_url: "i".into(),
        };
        let v = serde_json::to_value(technic_summary_to_item(&p, "modpack")).unwrap();
        assert!(v.as_object().unwrap().contains_key("iconUrl"));
        assert!(v.as_object().unwrap().contains_key("downloadCount"));
        assert!(v.as_object().unwrap().contains_key("projectUrl"));
        assert!(!v.as_object().unwrap().contains_key("icon_url"));
    }

    /// 聚合分页连续性（CodeRabbit PR #187 的回归护栏）。
    ///
    /// Technic 条目的 `download_count` 恒为 0（列表接口不提供，见 ADR-103），按下载量
    /// 排序后必然排在最后。若「各源只取第 page 页再排序截断」，这些条目在第 1 页被
    /// `truncate` 掉、第 2 页又从各源 offset=pageSize 开始 → **永远浏览不到，但 total
    /// 统计了它们**。`aggregate_window` 改为「累计取前缀 → 全局排序 → 切窗口」后，
    /// 逐页遍历必须能覆盖到每一条。
    #[test]
    fn aggregate_window_pages_cover_zero_download_entries() {
        let mk = |source: &str, id: &str, downloads: i64| ResourceItemDto {
            id: id.to_string(),
            title: id.to_string(),
            description: String::new(),
            author: String::new(),
            icon_url: String::new(),
            download_count: downloads,
            source: source.to_string(),
            categories: Vec::new(),
            project_url: String::new(),
            slug: id.to_string(),
            category: "modpack".to_string(),
        };

        // 30 条高下载量 + 3 条 download_count=0 的 technic 条目（模拟聚合池）
        let mut pool: Vec<ResourceItemDto> = (0..30)
            .map(|i| mk("modrinth", &format!("mr{i}"), 1000 - i as i64))
            .collect();
        pool.extend((0..3).map(|i| mk("technic", &format!("tc{i}"), 0)));

        let page_size = 10;
        // 逐页取窗口（模拟带累计前缀的真实取数：每页用完整的 pool 当「已取前缀」）
        let mut seen: Vec<String> = Vec::new();
        for page in 1..=4 {
            let w = aggregate_window(pool.clone(), page, page_size);
            for it in &w {
                assert!(!seen.contains(&it.id), "条目 {} 跨页重复", it.id);
                seen.push(it.id.clone());
            }
        }
        // 零下载量的 technic 条目必须全部可达（这正是修复前失败的点）
        for i in 0..3 {
            assert!(
                seen.contains(&format!("tc{i}")),
                "download_count=0 的 technic 条目 tc{i} 应可被翻页取到"
            );
        }
        // 第 1 页仍必须是最高下载量在前（排序语义不变）
        let first = aggregate_window(pool, 1, page_size);
        assert_eq!(first[0].download_count, 1000);
        assert!(first.iter().all(|it| it.download_count > 0));
    }

    /// 聚合窗口的边界：空输入、越界页码、page=0、pageSize=0 都不 panic 且返回空。
    #[test]
    fn aggregate_window_handles_edges() {
        let mk = |id: &str| ResourceItemDto {
            id: id.to_string(),
            title: id.to_string(),
            description: String::new(),
            author: String::new(),
            icon_url: String::new(),
            download_count: 1,
            source: "modrinth".to_string(),
            categories: Vec::new(),
            project_url: String::new(),
            slug: id.to_string(),
            category: "mod".to_string(),
        };
        assert!(aggregate_window(Vec::new(), 1, 10).is_empty());
        // 越界页
        assert!(aggregate_window(vec![mk("a")], 5, 10).is_empty());
        // page=0 视作第 1 页（offset 钳位），不 panic
        assert_eq!(aggregate_window(vec![mk("a")], 0, 10).len(), 1);
        // pageSize=0 → 空且不 panic
        assert!(aggregate_window(vec![mk("a")], 1, 0).is_empty());
    }

    /// `(source,id)` 去重：同一工程以多类型命中时只保留先出现的一条。
    #[test]
    fn aggregate_window_dedups_by_source_and_id() {
        let mk = |cat: &str, downloads: i64| ResourceItemDto {
            id: "same".to_string(),
            title: "T".to_string(),
            description: String::new(),
            author: String::new(),
            icon_url: String::new(),
            download_count: downloads,
            source: "modrinth".to_string(),
            categories: Vec::new(),
            project_url: String::new(),
            slug: "same".to_string(),
            category: cat.to_string(),
        };
        let out = aggregate_window(vec![mk("mod", 5), mk("datapack", 9)], 1, 10);
        assert_eq!(out.len(), 1, "同 (source,id) 应去重");
    }

    /// `total` 必须收敛到实际可浏览上限（CodeRabbit PR #187 第二轮 finding）。
    ///
    /// 聚合每次只取 `min(page×pageSize, MAX_AGGREGATE_FETCH)` 条前缀，因此超过 200 条的
    /// 部分永远取不到；若 total 仍报各源总数之和，前端会以为还有下一页 → 出现「翻到
    /// 后面是空页但按钮还在」的虚假承诺。
    #[test]
    fn aggregate_total_is_capped_to_reachable_range() {
        // 未达上限：如实回报
        assert_eq!(aggregate_honest_total(37), 37);
        assert_eq!(
            aggregate_honest_total(MAX_AGGREGATE_FETCH),
            MAX_AGGREGATE_FETCH
        );
        // 超过上限：收敛（否则报出取不到的条目数）
        assert_eq!(
            aggregate_honest_total(MAX_AGGREGATE_FETCH + 1),
            MAX_AGGREGATE_FETCH
        );
        assert_eq!(aggregate_honest_total(100_000), MAX_AGGREGATE_FETCH);
    }

    /// 取回上限与 `total` 口径必须一致：`fetch_size` 的封顶值就是可浏览条目数的上界。
    #[test]
    fn fetch_cap_matches_reachable_total() {
        // 深页码时 fetch_size 封顶在 MAX_AGGREGATE_FETCH
        let page: i32 = 999;
        let page_size: i32 = 20;
        let fetch_size = page.saturating_mul(page_size).min(MAX_AGGREGATE_FETCH);
        assert_eq!(
            fetch_size, MAX_AGGREGATE_FETCH,
            "深页码的单源取回量应封顶，且该封顶即 total 的上界"
        );
    }
}
