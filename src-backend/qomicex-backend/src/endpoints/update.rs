//! Update endpoints (translated from Endpoints/UpdateEndpoints.cs +
//! Services/UpdateService.cs).
//!
//! Routes are declared relative to the "/api" nest (see app.rs), matching the
//! C# `MapGroup("/api")`. The upstream version API decides whether an update
//! exists by comparing the caller-provided `current` version; it is NOT
//! compared against `state.app_version` in the C# source (kept identical here).
//!
//! Public routes:
//! - GET /api/update/check?current=...&channel=...
//! - GET /api/update/manifest?current=...&target=...&arch=...
//!   (channel read from header X-Updater-Channel, default "stable")
//!
//! Self-contained slice: the update service (including the 30-minute proxy
//! prefix cache) lives here as a private module-level singleton.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::update_channel;
use crate::state::SharedState;

const UPSTREAM_BASE: &str = "https://api.qomicex.top";
const VERSION_CHECK_PATH: &str = "/api/client/version/check";
const UPDATE_PLAN_PATH: &str = "/api/client/update/plan";

/// Proxy prefixes raced to find the fastest mirror for the download URL.
const PROXY_PREFIXES: &[&str] = &[
    "",
    "https://edgeone.gh-proxy.org/",
    "https://cdn.gh-proxy.org/",
    "https://hk.gh-proxy.org/",
    "https://v6.gh-proxy.org/",
    "https://ghfast.top/",
];

const PROXY_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const PROXY_RACE_TIMEOUT: Duration = Duration::from_secs(5);

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/update/check", get(check))
        .route("/update/manifest", get(manifest))
        .route("/update/plan", get(plan))
}

/// GET /api/update/plan?channel=... — launcher self-update plan for the new
/// download-center + Qomicex.Updater pipeline.
///
/// Forwards to upstream `/api/client/update/plan` (rollout-weight gated) and
/// returns the package url + minisign signature + install strategy for this
/// machine. OS/arch/mode are detected locally; channel is forwarded and gates
/// which release train (channel) upstream may answer with.
///
/// # 通道（train）裁决
///
/// 每条通道是独立的发布列车，序数各自计数（`beta31.0` vs `release1.0` 的
/// 31/1 不可比）。上游按 `channel` 选该通道的最新版本；本地再做一层不变量
/// 守卫，防止上游配置回退时把错误通道的版本推给用户（曾致 beta 用户被提示
/// "更新到正式版"——实为降级）。见 `services/update_channel.rs`。
async fn plan(
    State(state): State<SharedState>,
    Query(q): Query<PlanQuery>,
) -> ApiResult<Json<UpdatePlanResponse>> {
    let current = state.app_version.as_str();
    // 显式 channel（用户在设置里切换通道）优先；否则跟随已安装构建所属列车。
    let Some(channel) = update_channel::effective_channel(q.channel.as_deref(), current) else {
        // dev 构建（裸 X.Y.Z，无 pre-release 后缀）不属于任何已发布列车，
        // 且用户未显式选择通道 → 不检查更新，也不打上游。
        tracing::info!(
            "update plan: dev build (current={current}), no channel selected — skipping check"
        );
        return Ok(Json(UpdatePlanResponse::no_update("dev-build")));
    };

    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = std::env::consts::ARCH;
    // Linux has two install forms: AppImage (single file, $APPIMAGE set) and
    // system packages (deb/rpm). Other platforms ignore mode upstream.
    let mode = if os == "linux" && std::env::var("APPIMAGE").is_err() {
        "system"
    } else {
        ""
    };

    tracing::info!("checking update plan for current={current} channel={channel} os={os} arch={arch} mode={mode}");
    let mut request = state
        .http_client
        .get(format!("{UPSTREAM_BASE}{UPDATE_PLAN_PATH}"))
        .query(&[
            ("current", current),
            ("target", os),
            ("arch", arch),
            ("mode", mode),
            ("channel", channel.as_str()),
        ])
        // 上游用 Bearer machineCode 做许可证通道钉住（alpha 许可证恒收 alpha）
        // 与灰度门控（weight + machineHash 取模）。缺失时灰度静默失效：
        // weight<100 的版本对无 machineHash 的请求恒 204。
        .bearer_auth(license_machine_code());
    let response = request
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;

    let status = response.status();
    if status == StatusCode::NO_CONTENT {
        return Ok(Json(UpdatePlanResponse::no_update("up-to-date")));
    }
    let text = response
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    if !status.is_success() {
        return Err(ApiError::upstream(format!("HTTP {status}")));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| ApiError::upstream(format!("update plan parse failed: {e}")))?;
    // Upstream 200 bodies carry only metadata — the key is absent, so a 200
    // IS the "update available" signal; an explicit hasUpdate=false (future
    // contract) still wins.
    let explicit = value.get("hasUpdate").and_then(|v| v.as_bool());
    let mut plan: UpdatePlanResponse = serde_json::from_value(value)
        .map_err(|e| ApiError::upstream(format!("update plan parse failed: {e}")))?;
    plan.has_update = explicit.unwrap_or(true);

    // 本地不变量守卫：上游若因配置回退/灰度命中而返回了别的通道，或同通道内
    // 并不更新的版本，一律按"无更新"处理并留痕（不向用户展示错误计划）。
    if plan.has_update {
        plan = guard_train_plan(plan, current, &channel);
    }

    // Only route through the fastest mirror when there actually is an update;
    // upstream may answer 200 with hasUpdate=false instead of 204.
    if plan.has_update {
        if let Some(url) = plan.package_url.take() {
            let prefix = get_fastest_proxy_prefix(&url).await;
            plan.package_url = Some(format!("{prefix}{url}"));
        }
    }
    Ok(Json(plan))
}

/// 硬件绑定的机器码（供上游许可证通道钉住 + 灰度门控）。
///
/// `machine_code()` 无 feature gate（C# 的 GetMachineCode 同样不受
/// LICENSE_REQUIRED 约束），未激活许可证时也会返回稳定值。
fn license_machine_code() -> String {
    crate::services::license_core::machine_code()
}

/// 通道守卫的**纯裁决**部分：校验候选版本是否属于被请求的通道，且（同通道时）
/// 确实比已安装构建更新。
///
/// 返回 `None` = 通过；`Some(reason)` = 拒绝的原因（诊断用）。
///
/// `plan()` / `check()` / `manifest()` 三处共用，保证"是否有更新"的结论一致——
/// 漏掉任一路径都会重新打开跨通道降级的口子（`/update/manifest` 正是如此，
/// 见 ADR-081 的回归记录）。
fn train_reject_reason(
    candidate: &str,
    current: &str,
    requested_channel: &str,
) -> Option<&'static str> {
    let candidate_train = update_channel::train_of(candidate);
    let requested_train = match requested_channel {
        "release" => update_channel::Train::Release,
        "beta" => update_channel::Train::Beta,
        "alpha" => update_channel::Train::Alpha,
        "dev" => update_channel::Train::Dev,
        _ => update_channel::Train::Unknown,
    };

    // ① 通道不匹配：上游给了别的通道（配置回退时曾把 release 推给 beta 请求）。
    if candidate_train != requested_train {
        return Some("channel-mismatch");
    }

    // ② 同通道且候选不比当前新（相等/更旧）。
    if update_channel::train_of(current) == candidate_train
        && !update_channel::is_train_upgrade(current, candidate)
    {
        return Some("not-newer");
    }

    None
}

/// 通道守卫（`/update/plan` 用）：校验候选版本，通过时补齐
/// `channel` / `channelSwitch`；不通过时返回 `has_update=false` + `reason`
/// 并 `warn!` 留痕。
fn guard_train_plan(
    mut plan: UpdatePlanResponse,
    current: &str,
    requested_channel: &str,
) -> UpdatePlanResponse {
    let Some(version) = plan.version.as_deref() else {
        tracing::warn!("update plan guard: 200 response without version — treating as no update");
        return UpdatePlanResponse::no_update("no-version");
    };

    if let Some(reason) = train_reject_reason(version, current, requested_channel) {
        tracing::warn!(
            "update plan guard: rejected ({reason}) — requested={requested_channel} \
             current={current} candidate={version}"
        );
        return UpdatePlanResponse::no_update(reason);
    }

    // ③ 跨通道 = 用户主动切换通道（显式选了别的 channel）。新鲜度由上游按
    //    发布时间裁决，本地不再二次判断，只打标记让 UI 说明这是"切换通道"。
    let candidate_train = update_channel::train_of(version);
    let channel_switch = update_channel::train_of(current) != candidate_train;
    plan.channel = candidate_train.as_str().map(str::to_string);
    plan.channel_switch = Some(channel_switch);
    tracing::info!(
        "update plan: current={current} candidate={version} \
         channel={requested_channel} channel_switch={channel_switch}"
    );
    plan
}
/// GET /api/update/check?current=...&channel=...
///
/// `current` 由调用方给出（前端传已安装版本）；`channel` 显式指定订阅的通道，
/// 缺省时回落到 `current` 所属列车。与 `/update/plan` 共用同一套通道守卫，
/// 保证两个端点的"是否有更新"结论一致。
async fn check(
    State(state): State<SharedState>,
    Query(q): Query<CheckQuery>,
) -> ApiResult<Json<UpdateCheckResponse>> {
    let Some(channel) = update_channel::effective_channel(q.channel.as_deref(), &q.current) else {
        // dev 构建且未显式选择通道 → 无更新，不打上游。
        tracing::info!(
            "update check: dev build (current={}), no channel selected — no update",
            q.current
        );
        return Ok(Json(UpdateCheckResponse {
            has_update: false,
            ..Default::default()
        }));
    };
    let mut result = check_update(&state, &q.current, &channel).await?;

    // 与 plan() 相同的不变量守卫：候选必须属于被请求通道，且（同通道时）更新。
    if result.has_update {
        let reason = result
            .version
            .as_deref()
            .and_then(|v| train_reject_reason(v, &q.current, &channel));
        if let Some(reason) = reason {
            tracing::warn!(
                "update check guard: rejected ({reason}) — requested={channel} \
                 current={} candidate={:?} — no update",
                q.current,
                result.version
            );
            result.has_update = false;
        }
    }
    Ok(Json(result))
}

/// GET /api/update/manifest?current=...&target=...&arch=...
async fn manifest(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(q): Query<ManifestQuery>,
) -> ApiResult<Response> {
    // Legacy Tauri-updater clients send the channel in X-Updater-Channel.
    let channel = manifest_channel(&headers).to_string();

    // The upstream check precedes the try/catch in C#, so its failures
    // propagate (do not swallow them here).
    let has_update = check_update(&state, &q.current, &channel).await?;

    if !has_update.has_update {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    // 通道守卫：与 /update/plan、/update/check 同一套裁决。
    //
    // 历史上此路径把 channel 传给了 check_update 却**没有**过守卫——上游若对
    // beta 请求返回 release 候选（配置回退），这里会照单全收其 download_url、
    // 拉取该 manifest 并交给 Tauri updater，跨通道降级由此路径复发。
    // Tauri updater 把 204 当作终态"无更新"，所以守卫命中时返回 204 是安全的。
    let reject = has_update
        .version
        .as_deref()
        .and_then(|v| train_reject_reason(v, &q.current, &channel));
    if let Some(reason) = reject {
        tracing::warn!(
            "update manifest guard: rejected ({reason}) — requested={channel} \
             current={} candidate={:?} — 204",
            q.current,
            has_update.version
        );
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    let Some(download_url) = has_update.download_url.filter(|u| !u.is_empty()) else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    // download_url points to the Tauri latest.json manifest. Network/HTTP
    // failures MUST return an error (not 204): the Tauri updater treats 204
    // as a terminal "no update" and stops trying further endpoints, whereas
    // a 5xx makes it fall through to the next endpoint in tauri.conf.json.
    // A silent 204 here masked GitHub fetch failures as "已是最新版本".
    let mut manifest = match fetch_tauri_manifest(&state.http_client, &download_url).await {
        Ok(Some(m)) => m,
        Ok(None) => return Ok(StatusCode::NO_CONTENT.into_response()), // unparsable asset
        Err(e) => return Err(e),
    };

    // Tauri updater requires a signature for every platform entry it
    // deserializes; release assets without one (Linux AppImage) would poison
    // the whole platforms map. Drop them so signed platforms still update.
    manifest.platforms.retain(|_, e| !e.signature.is_empty());

    if manifest.platforms.is_empty() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    // Tauri updater 的 `{{target}}` 模板变量是 OS 名（windows/darwin/linux），
    // 而 latest.json 的平台 key 是 {target}-{arch}（如 windows-x86_64）。按
    // 精确 key → {target}-{arch} 组合的顺序解析，避免拿 "windows" 原样查
    // map 永远 miss → 204，令 updater 直接终态为“无更新”。
    let target_key = if manifest.platforms.contains_key(&q.target) {
        q.target.clone()
    } else {
        match &q.arch {
            Some(arch) => format!("{}-{}", q.target, arch),
            None => q.target.clone(),
        }
    };
    if !manifest.platforms.contains_key(&target_key) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    // 安装包 URL（platforms[target].url，直连 GitHub releases）也套上测速最快的
    // 代理前缀；否则测速只加速了 latest.json 清单，几十 MB 的本体仍直连 GitHub。
    if let Some(entry) = manifest.platforms.get_mut(&target_key) {
        // GitHub release asset 名不含空格（上传时 ' ' → '.'），存量 latest.json
        // 里的带空格 URL 会 404，下载前归一化。
        entry.url = entry.url.replace(' ', ".");
        let prefix = get_fastest_proxy_prefix(&entry.url).await;
        if !prefix.is_empty() {
            entry.url = format!("{prefix}{}", entry.url);
        }
    }

    Ok(Json(manifest).into_response())
}

/// Read X-Updater-Channel (default "stable") — mirrors the C# header read that
/// feeds into CheckAsync (which itself ignores the channel value).
fn manifest_channel(headers: &HeaderMap) -> &str {
    headers
        .get("x-updater-channel")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("stable")
}

/// Perform the version check (corresponds to UpdateService.CheckAsync).
///
/// `channel` 透传上游：它决定上游只在对应发布列车里挑选候选版本
/// （见 Web.Backend `getAllowedTypes`）。历史上本端点完全忽略 channel，
/// 导致 `/plan` 与 `/check` 结论可能相反。
async fn check_update(
    state: &SharedState,
    current: &str,
    channel: &str,
) -> ApiResult<UpdateCheckResponse> {
    tracing::info!("checking update for current={current} channel={channel}");
    let response = state
        .http_client
        .get(format!("{UPSTREAM_BASE}{VERSION_CHECK_PATH}"))
        .query(&[("current", current), ("channel", channel)])
        .bearer_auth(license_machine_code())
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    tracing::info!("upstream response: HTTP {status} {text}");
    if !status.is_success() {
        return Err(ApiError::upstream(format!("HTTP {status}")));
    }

    let mut result: UpdateCheckResponse =
        serde_json::from_str(&text).unwrap_or_else(|_| UpdateCheckResponse::default());

    if result.has_update {
        if let Some(dl) = result.download_url.clone().filter(|u| !u.is_empty()) {
            let prefix = get_fastest_proxy_prefix(&dl).await;
            result.download_url = Some(format!("{prefix}{dl}"));
        }
    }

    Ok(result)
}

/// Download and parse the Tauri latest.json manifest (corresponds to the
/// inline logic in MapGet /update/manifest).
async fn fetch_tauri_manifest(
    client: &reqwest::Client,
    url: &str,
) -> Result<Option<TauriManifestResponse>, ApiError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    if !status.is_success() {
        tracing::warn!("update manifest fetch failed from {url}: HTTP {status}");
        return Err(ApiError::upstream(format!("HTTP {status}")));
    }
    match serde_json::from_str::<TauriManifestResponse>(&text) {
        Ok(mut m) => {
            // 防御：manifest.version 前导 `v` 会令 Tauri updater 的 semver 解析失败 →
            // check() 无声返回“无更新”。最新发布产物应在生成时去 `v`（见 release.yml），
            // 此处归一化兜底，让存量带 `v` 的 latest.json 也能正常检出更新。
            if let Some(stripped) = m.version.strip_prefix('v') {
                m.version = stripped.to_string();
            }
            Ok(Some(m))
        }
        Err(e) => {
            tracing::warn!("update manifest parse failed from {url}: {e}");
            Ok(None)
        }
    }
}

/// 30-minute in-memory cache of the fastest proxy prefix (single slot "fastest").
async fn get_fastest_proxy_prefix(download_url: &str) -> String {
    // Fast path: cache hit.
    {
        let guard = proxy_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(cached) = guard.cached_fastest() {
            return cached;
        }
    }
    // Slow path: race proxies outside the lock (a std MutexGuard is not Send,
    // so it must not be held across the async race).
    let fastest = race_proxies(download_url).await;
    let mut guard = proxy_cache().lock().unwrap_or_else(|p| p.into_inner());
    guard.prefix = fastest.clone();
    guard.cached_at = Instant::now();
    fastest
}

/// Race all proxy prefixes with a Range: bytes=0-0 request, 5s timeout each,
/// returning the lowest-latency prefix (empty string wins ties on first hit).
///
/// Uses a single shared async client plus tokio::spawn to mirror the C#
/// Task.WhenAll concurrency without blocking a runtime worker thread.
async fn race_proxies(download_url: &str) -> String {
    let client = match reqwest::Client::builder()
        .timeout(PROXY_RACE_TIMEOUT)
        .user_agent(crate::state::USER_AGENT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    let best_prefix: std::sync::Arc<std::sync::Mutex<String>> = Default::default();
    let best_latency = std::sync::Arc::new(AtomicI64::new(i64::MAX));

    let mut handles = Vec::new();
    for prefix in PROXY_PREFIXES {
        let prefix = prefix.to_string();
        let url = format!("{prefix}{download_url}");
        let client = client.clone();
        let best_prefix = best_prefix.clone();
        let best_latency = best_latency.clone();
        handles.push(tokio::spawn(async move {
            let start = Instant::now();
            let status = client
                .get(&url)
                .header(reqwest::header::RANGE, "bytes=0-0")
                .send()
                .await
                .map(|r| r.status())
                .ok();
            let latency = start.elapsed().as_millis() as i64;
            if status
                .as_ref()
                .is_some_and(|s| s.is_success() || s.as_u16() == 206)
            {
                if latency < best_latency.load(Ordering::Relaxed) {
                    best_latency.store(latency, Ordering::Relaxed);
                    let mut guard = best_prefix.lock().unwrap();
                    *guard = prefix;
                }
            }
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    let guard = best_prefix.lock().unwrap();
    guard.clone()
}

struct ProxyCache {
    prefix: String,
    cached_at: Instant,
}

impl ProxyCache {
    fn cached_fastest(&self) -> Option<String> {
        if self.prefix.is_empty() {
            return None;
        }
        if self.cached_at.elapsed() > PROXY_CACHE_TTL {
            return None;
        }
        Some(self.prefix.clone())
    }
}

impl Default for ProxyCache {
    fn default() -> Self {
        Self {
            prefix: String::new(),
            cached_at: Instant::now(),
        }
    }
}

fn proxy_cache() -> &'static Mutex<ProxyCache> {
    static CACHE: OnceLock<Mutex<ProxyCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ProxyCache::default()))
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

/// `current` 已安装版本；`channel` 显式订阅通道（缺省回落 current 所属列车）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckQuery {
    current: String,
    channel: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanQuery {
    channel: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestQuery {
    current: String,
    target: String,
    /// Tauri updater 传 OS 名+架构（如 arch=x86_64），用于把 target=windows
    /// 解析成 latest.json 的平台 key（windows-x86_64）。
    arch: Option<String>,
}

/// Response of GET /api/update/plan. `hasUpdate=false` (all fields empty)
/// means the caller is up to date or gated out by the rollout weight.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdatePlanResponse {
    /// 204 → false. Upstream 200 bodies never carry this key (their contract:
    /// 204 = no update, 200 = the metadata below), so it is filled from the
    /// status code before parse — see `plan()`.
    #[serde(default)]
    has_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    /// dir | appimage | app | system — consumed by Qomicex.Updater.
    #[serde(skip_serializing_if = "Option::is_none")]
    strategy: Option<String>,
    /// File-layout zip package (post-proxy-rewrite).
    #[serde(skip_serializing_if = "Option::is_none")]
    package_url: Option<String>,
    /// minisign signature over the zip (armor text).
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    changelog: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    required: Option<bool>,
    /// 候选版本所属发布列车（release | beta | alpha）。前端据此渲染通道标签。
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    /// true = 跨通道更新（用户主动切换了通道，非普通版本升级）。UI 需明确标注，
    /// 否则用户会以为只是同通道的小版本升级。
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_switch: Option<bool>,
    /// hasUpdate=false 的原因（诊断用）：dev-build | up-to-date |
    /// channel-mismatch | not-newer | no-version。
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl UpdatePlanResponse {
    /// 构造一个"无更新"响应，并带上可诊断的原因。
    fn no_update(reason: &str) -> Self {
        Self {
            has_update: false,
            reason: Some(reason.to_string()),
            ..Self::default()
        }
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// UpdateCheckResponse (source Models/UpdateModels.cs). camelCase; null
/// Option fields are omitted.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResponse {
    has_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    r#type: Option<String>,
    #[serde(default)]
    required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    changelog: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_url: Option<String>,
}

impl Default for UpdateCheckResponse {
    fn default() -> Self {
        Self {
            has_update: false,
            version: None,
            r#type: None,
            required: false,
            title: None,
            changelog: None,
            download_url: None,
        }
    }
}

/// TauriManifestResponse (source Models/UpdateModels.cs). The C# record keeps
/// PascalCase names under the global CamelCase policy, except `pub_date` which
/// carries an explicit JsonPropertyName.
#[derive(Serialize, Deserialize)]
struct TauriManifestResponse {
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(rename = "pub_date")]
    pub_date: String,
    platforms: HashMap<String, TauriPlatformEntry>,
}

/// Per-platform entry in the Tauri manifest (source UpdateModels.cs).
///
/// `signature` defaults to empty: Linux AppImage release assets ship no
/// signature (updater auto-update unsupported there), and a required field
/// would fail the whole platforms map parse.
#[derive(Serialize, Deserialize)]
struct TauriPlatformEntry {
    #[serde(default)]
    signature: String,
    url: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_for(version: &str) -> UpdatePlanResponse {
        UpdatePlanResponse {
            has_update: true,
            version: Some(version.to_string()),
            strategy: Some("dir".into()),
            package_url: Some("https://example/qomicex-update.zip".into()),
            signature: Some("RWTsig".into()),
            ..Default::default()
        }
    }

    /// 同通道内的正常升级必须原样通过，并补齐 channel/channelSwitch。
    #[test]
    fn same_train_upgrade_passes_with_channel_metadata() {
        let out = guard_train_plan(plan_for("0.1.0-beta31.0"), "0.1.0-beta23.0", "beta");
        assert!(out.has_update, "beta23 → beta31 应判定为有更新");
        assert_eq!(out.version.as_deref(), Some("0.1.0-beta31.0"));
        assert_eq!(out.channel.as_deref(), Some("beta"));
        assert_eq!(out.channel_switch, Some(false));
        assert!(out.reason.is_none());
    }

    /// 跨通道 = 用户主动切换通道：允许，但必须打 channelSwitch 标记。
    #[test]
    fn cross_train_switch_is_allowed_and_flagged() {
        let out = guard_train_plan(plan_for("0.1.0-beta31.0"), "0.1.0-release1.0", "beta");
        assert!(out.has_update);
        assert_eq!(out.channel.as_deref(), Some("beta"));
        assert_eq!(out.channel_switch, Some(true));
    }

    /// 上游给了别的通道（配置回退时曾把 release 推给 beta 请求）→ 拒掉。
    /// 这是"beta 用户被提示更新到正式版"的防护。
    #[test]
    fn channel_mismatch_is_rejected() {
        let out = guard_train_plan(plan_for("0.1.0-release1.0"), "0.1.0-beta23.0", "beta");
        assert!(!out.has_update);
        assert_eq!(out.reason.as_deref(), Some("channel-mismatch"));
        assert!(out.package_url.is_none(), "拒掉的计划不得带下载地址");
    }

    /// 同通道但候选并不更新（相等/更旧）→ 拒掉。
    #[test]
    fn same_train_not_newer_is_rejected() {
        let same = guard_train_plan(plan_for("0.1.0-beta23.0"), "0.1.0-beta23.0", "beta");
        assert!(!same.has_update);
        assert_eq!(same.reason.as_deref(), Some("not-newer"));

        let older = guard_train_plan(plan_for("0.1.0-beta9.0"), "0.1.0-beta10.0", "beta");
        assert!(!older.has_update);
        assert_eq!(older.reason.as_deref(), Some("not-newer"));
    }

    /// 200 响应缺 version → 拒掉（不能拿一个没有目标版本的计划让用户点"立即更新"）。
    #[test]
    fn missing_version_is_rejected() {
        let mut p = plan_for("0.1.0-beta31.0");
        p.version = None;
        let out = guard_train_plan(p, "0.1.0-beta23.0", "beta");
        assert!(!out.has_update);
        assert_eq!(out.reason.as_deref(), Some("no-version"));
    }

    /// 候选版本无法解析 → 拒掉。
    #[test]
    fn unparsable_candidate_is_rejected() {
        let out = guard_train_plan(plan_for("0.1.0-rc1"), "0.1.0-beta23.0", "beta");
        assert!(!out.has_update);
        assert_eq!(out.reason.as_deref(), Some("channel-mismatch"));
    }

    /// dev 构建 + 显式通道：跨通道放行（联调用例），channelSwitch=true。
    #[test]
    fn dev_build_with_explicit_channel_is_a_switch() {
        let out = guard_train_plan(plan_for("0.1.0-beta31.0"), "0.1.0", "beta");
        assert!(out.has_update);
        assert_eq!(out.channel_switch, Some(true));
    }

    /// alpha 通道：同列车按日期序数比较。
    #[test]
    fn alpha_train_uses_date_ordinals() {
        let out = guard_train_plan(
            plan_for("0.1.0-alpha20260823.0"),
            "0.1.0-alpha20260822.2",
            "alpha",
        );
        assert!(out.has_update);
        assert_eq!(out.channel.as_deref(), Some("alpha"));

        let older = guard_train_plan(
            plan_for("0.1.0-alpha20260822.2"),
            "0.1.0-alpha20260823.0",
            "alpha",
        );
        assert!(!older.has_update);
        assert_eq!(older.reason.as_deref(), Some("not-newer"));
    }

    /// no_update 构造函数必须带上原因，便于诊断。
    #[test]
    fn no_update_carries_reason() {
        let out = UpdatePlanResponse::no_update("dev-build");
        assert!(!out.has_update);
        assert_eq!(out.reason.as_deref(), Some("dev-build"));
        assert!(out.version.is_none());
        assert!(out.package_url.is_none());
    }

    /// `train_reject_reason` 是 plan/check/manifest 三路共用的纯裁决，必须单独锁住。
    /// `/update/manifest` 正是曾漏掉它的路径（跨通道降级复发口子）。
    #[test]
    fn train_reject_reason_shared_by_all_three_paths() {
        // 通过：同通道升级
        assert_eq!(
            train_reject_reason("0.1.0-beta31.0", "0.1.0-beta23.0", "beta"),
            None
        );
        // 通过：跨通道切换（用户显式选了别的 channel）
        assert_eq!(
            train_reject_reason("0.1.0-beta31.0", "0.1.0-release1.0", "beta"),
            None
        );
        // 拒绝：通道不匹配（上游把 release 推给 beta 请求）
        assert_eq!(
            train_reject_reason("0.1.0-release1.0", "0.1.0-beta23.0", "beta"),
            Some("channel-mismatch")
        );
        // 拒绝：同通道但候选不更新
        assert_eq!(
            train_reject_reason("0.1.0-beta23.0", "0.1.0-beta23.0", "beta"),
            Some("not-newer")
        );
        // 拒绝：候选无法解析
        assert_eq!(
            train_reject_reason("0.1.0-rc1", "0.1.0-beta23.0", "beta"),
            Some("channel-mismatch")
        );
        // 拒绝：请求通道本身无法识别
        assert_eq!(
            train_reject_reason("0.1.0-beta31.0", "0.1.0-beta23.0", "nightly"),
            Some("channel-mismatch")
        );
    }
}
