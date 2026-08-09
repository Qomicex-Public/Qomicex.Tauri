//! CurseForge 版本异步拉取服务（对应 C# CurseForgeVersionFetchService）。
//!
//! 前端调 `POST /resources/{id}/versions/start-fetch` 启动后台分页拉取，
//! 然后轮询 `fetch-progress/{taskId}` 和 `fetch-result/{taskId}`。
//!
//! 缓存约定：`version_cache` 只存 **CurseForge 上游原始 file 对象**，映射成前端 DTO
//! 一律在读取侧完成。本服务与 `endpoints::resource_center::cf_versions_raw` 共用这份
//! 缓存，两边必须保持同一种编码，否则交叉命中会读出 shape 不匹配的废数据。
//! 缓存键只含 (modId, gameVersion)：gameVersion 会下推到上游 URL，而 loader 是纯本地
//! 后置过滤，放进键里只会降低命中率并让同一份未过滤数据被复制多份。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Semaphore;

const DEFAULT_CONCURRENCY: usize = 10;
const DEFAULT_CACHE_TTL_SECONDS: u64 = 300; // 5 分钟
const PAGE_SIZE: usize = 50;

/// 任务进入终态后在状态表里的保留时长：给前端留出取结果的窗口，之后回收。
const TASK_RETENTION: Duration = Duration::from_secs(600);
/// 任务从创建起的硬超时：worker 若 panic 就永远不会置 done，靠这个兜底，
/// 否则前端会无限轮询、状态表也永不回收。
const TASK_HARD_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchProgressResponse {
    pub loaded_version_count: usize,
    pub total_version_count: usize,
    pub done: bool,
    /// 拉取失败的原因。`done == true` 且此项非 None 时结果不可用，前端应据此报错，
    /// 而不是把空结果当成「该资源没有版本」。
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchStartResponse {
    pub task_id: String,
    pub total_version_count: usize,
    pub loaded_version_count: usize,
}

struct FetchState {
    total_version_count: usize,
    loaded_version_count: usize,
    done: bool,
    error: Option<String>,
    results: Vec<serde_json::Value>,
    created_at: Instant,
    /// 进入终态的时刻；`None` 表示仍在拉取中。
    finished_at: Option<Instant>,
}

impl FetchState {
    fn new() -> Self {
        Self {
            total_version_count: 0,
            loaded_version_count: 0,
            done: false,
            error: None,
            results: Vec::new(),
            created_at: Instant::now(),
            finished_at: None,
        }
    }

    /// 已超过硬超时但 worker 从未置 done（通常意味着 worker panic 了）。
    fn is_stuck(&self) -> bool {
        !self.done && self.created_at.elapsed() > TASK_HARD_TIMEOUT
    }

    fn is_collectable(&self) -> bool {
        match self.finished_at {
            Some(at) => at.elapsed() > TASK_RETENTION,
            None => self.created_at.elapsed() > TASK_HARD_TIMEOUT + TASK_RETENTION,
        }
    }
}

#[derive(Clone, Copy)]
pub struct CurseForgeFetchConfig {
    pub concurrency: usize,
    pub cache_ttl: Duration,
}

impl Default for CurseForgeFetchConfig {
    fn default() -> Self {
        Self {
            concurrency: DEFAULT_CONCURRENCY,
            cache_ttl: Duration::from_secs(DEFAULT_CACHE_TTL_SECONDS),
        }
    }
}

pub struct CurseForgeVersionFetchService {
    states: Arc<tokio::sync::RwLock<HashMap<String, FetchState>>>,
    http: reqwest::Client,
    api_key: String,
    /// 运行期可变配置：`PUT /settings` 会调 [`Self::set_config`] 热更新，
    /// 不需要重启后端。
    concurrency: AtomicUsize,
    cache_ttl_secs: AtomicU64,
    version_cache: Arc<std::sync::RwLock<HashMap<String, (Vec<serde_json::Value>, Instant)>>>,
}

impl CurseForgeVersionFetchService {
    pub fn new_with_config(
        http: reqwest::Client,
        api_key: String,
        config: CurseForgeFetchConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            states: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            http,
            api_key,
            concurrency: AtomicUsize::new(config.concurrency.max(1)),
            cache_ttl_secs: AtomicU64::new(config.cache_ttl.as_secs()),
            version_cache: Arc::new(std::sync::RwLock::new(HashMap::new())),
        })
    }

    /// 热更新配置。并发数在此统一钳位，调用方无需自己保证下界。
    pub fn set_config(&self, config: CurseForgeFetchConfig) {
        self.concurrency
            .store(config.concurrency.max(1), Ordering::Relaxed);
        self.cache_ttl_secs
            .store(config.cache_ttl.as_secs(), Ordering::Relaxed);
    }

    /// 当前分页并发数，恒 >= 1。所有拉取路径都必须经由此处取值，不要各自从
    /// settings 里 `as usize`——负数转 usize 会变成天文数字并让 Semaphore::new panic。
    pub fn concurrency(&self) -> usize {
        self.concurrency.load(Ordering::Relaxed).max(1)
    }

    fn cache_ttl(&self) -> Duration {
        Duration::from_secs(self.cache_ttl_secs.load(Ordering::Relaxed))
    }

    /// 清空版本缓存，返回被清除的条目数。
    pub fn clear_cache(&self) -> usize {
        let mut map = self.version_cache.write().expect("version_cache poisoned");
        let n = map.len();
        map.clear();
        n
    }

    pub fn cache_key(mod_id: &str, game_version: Option<&str>) -> String {
        format!("cf_ver:{}:{}", mod_id, game_version.unwrap_or_default())
    }

    /// 读取缓存的**上游原始 file 对象**。TTL 为 0 表示永久缓存（直到重启或手动清除）。
    pub fn get_cached(&self, key: &str) -> Option<Vec<serde_json::Value>> {
        let ttl = self.cache_ttl();
        let map = self.version_cache.read().expect("version_cache poisoned");
        if let Some((data, ts)) = map.get(key) {
            if ttl.is_zero() || ts.elapsed() < ttl {
                return Some(data.clone());
            }
        }
        None
    }

    /// 写入缓存。`data` 必须是上游原始 file 对象，不是映射后的 DTO。
    pub fn set_cached(&self, key: String, data: Vec<serde_json::Value>) {
        self.version_cache
            .write()
            .expect("version_cache poisoned")
            .insert(key, (data, Instant::now()));
    }

    /// 回收已到期的任务状态。每次 `start` 时顺带执行，避免状态表无界增长——
    /// 前端在拉取途中离开页面就不会再来取结果，那份 FetchState 否则会永久驻留。
    async fn sweep_states(&self) {
        let mut map = self.states.write().await;
        map.retain(|_, s| !s.is_collectable());
    }

    pub async fn start(
        &self,
        mod_id: &str,
        game_version: Option<&str>,
        loader: Option<&str>,
    ) -> FetchStartResponse {
        self.sweep_states().await;

        let key = Self::cache_key(mod_id, game_version);
        let task_id = uuid::Uuid::new_v4().to_string();

        // 缓存命中：直接完成。缓存里是原始对象，这里同样要走映射+过滤，
        // 不能把原始 shape 直接交给前端。
        if let Some(cached) = self.get_cached(&key) {
            let results = map_and_filter(&cached, game_version, loader);
            let count = results.len();
            let mut state = FetchState::new();
            state.total_version_count = count;
            state.loaded_version_count = count;
            state.done = true;
            state.results = results;
            state.finished_at = Some(Instant::now());
            self.states.write().await.insert(task_id.clone(), state);
            return FetchStartResponse {
                task_id,
                total_version_count: count,
                loaded_version_count: count,
            };
        }

        let mod_id = mod_id.to_string();
        let gv = game_version.map(String::from);
        let ld = loader.map(String::from);
        let states = self.states.clone();
        let http = self.http.clone();
        let api_key = self.api_key.clone();
        let concurrency = self.concurrency();
        let cache = self.version_cache.clone();

        self.states
            .write()
            .await
            .insert(task_id.clone(), FetchState::new());

        let tid = task_id.clone();
        tokio::spawn(async move {
            let result = fetch_all_pages(
                &http,
                &api_key,
                &mod_id,
                gv.as_deref(),
                &states,
                &tid,
                concurrency,
            )
            .await;

            let mut map = states.write().await;
            let Some(s) = map.get_mut(&tid) else { return };
            s.finished_at = Some(Instant::now());
            s.done = true;
            match result {
                Ok(raw_items) => {
                    if !raw_items.is_empty() {
                        cache
                            .write()
                            .expect("version_cache poisoned")
                            .insert(key, (raw_items.clone(), Instant::now()));
                    }
                    s.results = map_and_filter(&raw_items, gv.as_deref(), ld.as_deref());
                    s.total_version_count = s.loaded_version_count;
                }
                Err(e) => s.error = Some(e),
            }
        });

        FetchStartResponse {
            task_id,
            total_version_count: 0,
            loaded_version_count: 0,
        }
    }

    pub async fn get_progress(&self, task_id: &str) -> Option<FetchProgressResponse> {
        let map = self.states.read().await;
        let s = map.get(task_id)?;
        // 卡死的任务对外呈现为「已结束 + 报错」，否则前端会一直轮询下去。
        if s.is_stuck() {
            return Some(FetchProgressResponse {
                loaded_version_count: s.loaded_version_count,
                total_version_count: s.total_version_count,
                done: true,
                error: Some("版本拉取超时".to_string()),
            });
        }
        Some(FetchProgressResponse {
            loaded_version_count: s.loaded_version_count,
            total_version_count: s.total_version_count,
            done: s.done,
            error: s.error.clone(),
        })
    }

    /// 取结果。成功取走后立即移除状态；失败的任务保留 error 供 progress 查询，
    /// 由 [`Self::sweep_states`] 到期回收。
    pub async fn get_result(&self, task_id: &str) -> Option<Vec<serde_json::Value>> {
        let mut map = self.states.write().await;
        let s = map.get(task_id)?;
        if !s.done || s.error.is_some() {
            return None;
        }
        let results = s.results.clone();
        map.remove(task_id);
        Some(results)
    }
}

/// 把上游原始 file 对象映射成前端 DTO，并套用 gameVersion / loader 过滤。
///
/// gameVersion 虽已下推到上游 URL，这里仍再过滤一遍，与
/// `resource_center::apply_cf_filters` 保持一致的语义。
fn map_and_filter(
    raw: &[serde_json::Value],
    game_version: Option<&str>,
    loader: Option<&str>,
) -> Vec<serde_json::Value> {
    let loader_norm = loader.map(|l| l.trim().to_lowercase());
    raw.iter()
        .map(cf_file_to_version_dto)
        .filter(|dto| {
            if let Some(gv) = game_version {
                let hit = dto
                    .get("gameVersions")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().any(|x| x.as_str() == Some(gv)))
                    .unwrap_or(false);
                if !hit {
                    return false;
                }
            }
            if let Some(norm) = &loader_norm {
                let matches = match dto.get("loaders").and_then(|v| v.as_array()) {
                    // 未标注 loader 的文件视为通用，与 apply_cf_filters 一致
                    None => true,
                    Some(a) if a.is_empty() => true,
                    Some(a) => a
                        .iter()
                        .filter_map(|x| x.as_str())
                        .any(|s| s.to_lowercase() == *norm),
                };
                if !matches {
                    return false;
                }
            }
            true
        })
        .collect()
}

/// 分页拉取全部 file 对象，返回上游**原始** JSON。过程中持续更新任务进度。
async fn fetch_all_pages(
    http: &reqwest::Client,
    api_key: &str,
    mod_id: &str,
    game_version: Option<&str>,
    states: &Arc<tokio::sync::RwLock<HashMap<String, FetchState>>>,
    task_id: &str,
    concurrency: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let first_url = cf_files_url(mod_id, 0, game_version);
    let first_body = cf_get(http, &first_url, api_key)
        .await
        .ok_or_else(|| "CurseForge 首页请求失败".to_string())?;

    let total_count = first_body
        .get("pagination")
        .and_then(|p| p.get("totalCount"))
        .and_then(|t| t.as_i64())
        .unwrap_or(0)
        .max(0) as usize;

    let first_data = first_body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    {
        let mut map = states.write().await;
        if let Some(s) = map.get_mut(task_id) {
            s.total_version_count = total_count;
            // 首页计数立刻计入，否则整个拉取过程进度都会少报一页。
            s.loaded_version_count = first_data.len();
        }
    }

    if first_data.is_empty() {
        return Ok(Vec::new());
    }

    let all_items = Arc::new(tokio::sync::Mutex::new(first_data));

    let total_pages = total_count.div_ceil(PAGE_SIZE);
    if total_pages > 1 {
        let sem = Arc::new(Semaphore::new(concurrency.max(1)));
        let mut handles = Vec::new();
        for page in 1..total_pages {
            let Ok(permit) = sem.clone().acquire_owned().await else {
                // semaphore 被关闭：停止派发，已派发的照常收尾
                break;
            };
            let http = http.clone();
            let api_key = api_key.to_string();
            let mod_id = mod_id.to_string();
            let gv = game_version.map(String::from);
            let all = all_items.clone();
            let states = states.clone();
            let tid = task_id.to_string();

            handles.push(tokio::spawn(async move {
                let url = cf_files_url(&mod_id, (page * PAGE_SIZE) as i64, gv.as_deref());
                let result = cf_get(&http, &url, &api_key).await;
                drop(permit);

                if let Some(body) = result {
                    let items = body
                        .get("data")
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let count = items.len();
                    all.lock().await.extend(items);
                    if let Some(s) = states.write().await.get_mut(&tid) {
                        s.loaded_version_count += count;
                    }
                }
            }));
        }

        for h in handles {
            let _ = h.await;
        }
    }

    let items = std::mem::take(&mut *all_items.lock().await);
    Ok(items)
}

fn cf_file_to_version_dto(f: &serde_json::Value) -> serde_json::Value {
    let id = f.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let display_name = f
        .get("displayName")
        .and_then(|v| v.as_str())
        .or_else(|| f.get("fileName").and_then(|v| v.as_str()))
        .unwrap_or("");
    let file_name = f.get("fileName").and_then(|v| v.as_str()).unwrap_or("");
    let game_versions: Vec<String> = f
        .get("gameVersions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let loaders = extract_cf_loaders(
        f.get("gameVersions").and_then(|v| v.as_array()),
        f.get("modLoader").and_then(|v| v.as_i64()),
    );
    let download_url = f.get("downloadUrl").and_then(|v| v.as_str()).unwrap_or("");
    let file_size = f.get("fileLength").and_then(|v| v.as_i64()).unwrap_or(0);
    let file_date = f.get("fileDate").and_then(|v| v.as_str()).unwrap_or("");

    let deps = f.get("dependencies").and_then(|v| v.as_array()).map(|arr| {
        let resolved: Vec<serde_json::Value> = arr
            .iter()
            .filter(|d| d.get("relationType").and_then(|v| v.as_i64()) == Some(3))
            .map(|d| {
                serde_json::json!({
                    "projectId": d.get("modId").and_then(|v| v.as_i64()).unwrap_or(0).to_string(),
                    "dependencyType": "required"
                })
            })
            .collect();
        if resolved.is_empty() {
            None
        } else {
            Some(resolved)
        }
    });

    serde_json::json!({
        "id": id.to_string(),
        "name": display_name,
        "versionNumber": file_name,
        "gameVersions": game_versions,
        "loaders": loaders,
        "downloads": [{
            "url": download_url,
            "fileName": file_name,
            "size": file_size
        }],
        "dependencies": deps,
        "datePublished": file_date,
    })
}

fn extract_cf_loaders(
    game_versions: Option<&Vec<serde_json::Value>>,
    mod_loader: Option<i64>,
) -> Vec<String> {
    let mut loaders = Vec::new();
    if let Some(gvs) = game_versions {
        for gv in gvs {
            if let Some(s) = gv.as_str() {
                let lower = s.to_lowercase();
                if matches!(
                    lower.as_str(),
                    "forge" | "fabric" | "quilt" | "neoforge" | "liteloader"
                ) {
                    loaders.push(lower);
                }
            }
        }
    }
    let ml = match mod_loader {
        Some(1) => Some("forge"),
        Some(3) => Some("liteloader"),
        Some(4) => Some("fabric"),
        Some(5) => Some("quilt"),
        Some(6) => Some("neoforge"),
        _ => None,
    };
    if let Some(s) = ml {
        loaders.push(s.to_string());
    }
    loaders.sort();
    loaders.dedup();
    loaders
}

fn cf_files_url(mod_id: &str, index: i64, game_version: Option<&str>) -> String {
    let mut url = format!(
        "https://api.curseforge.com/v1/mods/{}/files?pageSize={}&index={}",
        url_encode(mod_id),
        PAGE_SIZE,
        index,
    );
    if let Some(gv) = game_version {
        url.push_str(&format!("&gameVersion={}", url_encode(gv)));
    }
    url
}

fn url_encode(s: &str) -> String {
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

async fn cf_get(http: &reqwest::Client, url: &str, api_key: &str) -> Option<serde_json::Value> {
    let resp = http
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

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: i64, name: &str, gvs: &[&str], mod_loader: Option<i64>) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "displayName": name,
            "fileName": format!("{name}.jar"),
            "gameVersions": gvs,
            "modLoader": mod_loader,
            "downloadUrl": format!("https://cdn/{name}.jar"),
            "fileLength": 100,
        })
    }

    fn svc() -> Arc<CurseForgeVersionFetchService> {
        CurseForgeVersionFetchService::new_with_config(
            reqwest::Client::new(),
            String::new(),
            CurseForgeFetchConfig::default(),
        )
    }

    #[test]
    fn cache_key_excludes_loader_but_separates_game_versions() {
        assert_eq!(
            CurseForgeVersionFetchService::cache_key("123", None),
            "cf_ver:123:"
        );
        assert_ne!(
            CurseForgeVersionFetchService::cache_key("123", Some("1.20.1")),
            CurseForgeVersionFetchService::cache_key("123", None)
        );
    }

    #[test]
    fn map_and_filter_applies_loader_filter() {
        let items = vec![
            raw(1, "fab", &["1.20.1", "Fabric"], Some(4)),
            raw(2, "frg", &["1.20.1", "Forge"], Some(1)),
            raw(3, "any", &["1.20.1"], None),
        ];
        let out = map_and_filter(&items, None, Some("fabric"));
        let names: Vec<&str> = out.iter().map(|v| v["name"].as_str().unwrap()).collect();
        // fabric 命中 + 未标注 loader 的通用文件
        assert_eq!(names, vec!["fab", "any"]);
    }

    #[test]
    fn map_and_filter_applies_game_version_filter() {
        let items = vec![
            raw(1, "old", &["1.19.2"], Some(1)),
            raw(2, "new", &["1.20.1"], Some(1)),
        ];
        let out = map_and_filter(&items, Some("1.20.1"), None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["name"], "new");
    }

    #[test]
    fn map_and_filter_produces_frontend_shape() {
        let out = map_and_filter(&[raw(42, "m", &["1.20.1"], Some(4))], None, None);
        assert_eq!(out[0]["id"], "42");
        assert_eq!(out[0]["versionNumber"], "m.jar");
        assert_eq!(out[0]["downloads"][0]["url"], "https://cdn/m.jar");
        assert_eq!(out[0]["downloads"][0]["fileName"], "m.jar");
        assert_eq!(out[0]["downloads"][0]["size"], 100);
    }

    #[test]
    fn double_mapping_would_corrupt_data() {
        // 回归护栏：缓存里必须是原始对象。若误把 DTO 再喂给映射器，
        // id 与下载地址会全部丢失——这正是两种编码共用一个 key 时的故障形态。
        let dto = map_and_filter(&[raw(42, "m", &["1.20.1"], Some(4))], None, None);
        let twice = map_and_filter(&dto, None, None);
        assert_eq!(twice[0]["id"], "0");
        assert_eq!(twice[0]["downloads"][0]["url"], "");
    }

    #[test]
    fn set_config_clamps_concurrency_and_takes_effect_live() {
        let s = svc();
        assert_eq!(s.concurrency(), DEFAULT_CONCURRENCY);
        s.set_config(CurseForgeFetchConfig {
            concurrency: 0,
            cache_ttl: Duration::from_secs(7),
        });
        assert_eq!(s.concurrency(), 1);
        assert_eq!(s.cache_ttl(), Duration::from_secs(7));
    }

    #[test]
    fn clear_cache_reports_removed_count() {
        let s = svc();
        assert_eq!(s.clear_cache(), 0);
        s.set_cached("a".into(), vec![raw(1, "x", &[], None)]);
        s.set_cached("b".into(), vec![]);
        assert_eq!(s.clear_cache(), 2);
        assert_eq!(s.clear_cache(), 0);
    }

    #[test]
    fn zero_ttl_means_cache_never_expires() {
        let s = CurseForgeVersionFetchService::new_with_config(
            reqwest::Client::new(),
            String::new(),
            CurseForgeFetchConfig {
                concurrency: 4,
                cache_ttl: Duration::ZERO,
            },
        );
        s.set_cached("k".into(), vec![raw(1, "x", &[], None)]);
        assert!(s.get_cached("k").is_some());
    }

    #[tokio::test]
    async fn sweep_collects_finished_tasks_past_retention() {
        let s = svc();
        {
            let mut map = s.states.write().await;
            let mut fresh = FetchState::new();
            fresh.done = true;
            fresh.finished_at = Some(Instant::now());
            map.insert("fresh".into(), fresh);

            let mut old = FetchState::new();
            old.done = true;
            old.finished_at = Instant::now().checked_sub(TASK_RETENTION * 2);
            map.insert("old".into(), old);
        }
        s.sweep_states().await;
        let map = s.states.read().await;
        assert!(map.contains_key("fresh"));
        assert!(
            !map.contains_key("old"),
            "到期任务应被回收，否则状态表无界增长"
        );
    }

    #[tokio::test]
    async fn stuck_task_reports_error_instead_of_polling_forever() {
        let s = svc();
        {
            let mut map = s.states.write().await;
            let mut st = FetchState::new();
            // 模拟 worker panic：created_at 很久以前，done 永远是 false
            st.created_at = Instant::now()
                .checked_sub(TASK_HARD_TIMEOUT * 2)
                .expect("clock");
            map.insert("stuck".into(), st);
        }
        let p = s.get_progress("stuck").await.expect("state exists");
        assert!(p.done);
        assert!(p.error.is_some());
    }

    #[tokio::test]
    async fn get_result_withholds_results_for_failed_task() {
        let s = svc();
        {
            let mut map = s.states.write().await;
            let mut st = FetchState::new();
            st.done = true;
            st.error = Some("boom".into());
            st.finished_at = Some(Instant::now());
            map.insert("bad".into(), st);
        }
        assert!(s.get_result("bad").await.is_none());
        // 失败任务保留下来，让 progress 能持续报出原因
        let p = s.get_progress("bad").await.expect("retained");
        assert_eq!(p.error.as_deref(), Some("boom"));
    }
}
