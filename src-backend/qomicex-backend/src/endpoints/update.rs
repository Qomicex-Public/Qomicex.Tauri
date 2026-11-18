// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
const RELEASE_NOTES_PATH: &str = "/api/client/release-notes";

/// 启动器一次展示的版本数量上限：超出部分由前端折叠成「还有 N 个更早的版本」。
const CHANGELOG_MAX_ENTRIES: usize = 10;
/// 向上游要的历史窗口。单版本 notes 动辄数 KB，50 条足够覆盖常见升级跨度。
const CHANGELOG_UPSTREAM_LIMIT: usize = 50;
const CHANGELOG_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

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
        .route("/update/changelog", get(changelog))
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
    let request = state
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
/// 见 ADR-085 的回归记录）。
fn train_reject_reason(
    candidate: &str,
    current: &str,
    requested_channel: &str,
) -> Option<&'static str> {
    let candidate_train = update_channel::train_of(candidate);
    // 通道字符串先归一化（`stable`→`release`、大小写不敏感、无法识别→None）。
    //
    // 必须在这里做，不能在调用方：`/update/manifest` 的 `manifest_channel()`
    // 默认返回 `"stable"`，而 Tauri updater 的 endpoint（tauri.conf.json）
    // 并不带 `X-Updater-Channel` header。若此处只认 `"release"`，这类请求的
    // requested_train 会落成 Unknown → 把所有合法 release 候选一律 204 拒掉，
    // stable 通道的 manifest 更新永远到不了拉取步骤。
    let requested_train = match update_channel::normalize_channel(requested_channel).as_deref() {
        Some("release") => update_channel::Train::Release,
        Some("beta") => update_channel::Train::Beta,
        Some("alpha") => update_channel::Train::Alpha,
        Some("dev") => update_channel::Train::Dev,
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

// ---------------------------------------------------------------------------
// 跨版本更新内容（issue #357）
// ---------------------------------------------------------------------------

/// 上游 `/api/client/release-notes` 的单条记录。
///
/// 只声明用得上的字段：上游还给了 `type` / `title`，但跨版本展示只需要版本号、
/// 正文与时间；多余字段会让 `dead_code` 告警挂在 CI 上。
///
/// `notes` 必须是 `Option<String>`：`release_history.notes` 是可空列，SQL NULL
/// 在上游 JSON 里是 `null`，而 `#[serde(default)]` 只兜「字段缺失」不兜 `null`
/// —— 一个 null 就会让整个响应反序列化失败，全部历史被静默降级成空。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamReleaseNote {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamReleaseNotesResponse {
    #[serde(default)]
    entries: Vec<UpstreamReleaseNote>,
}

/// 返回给前端的一条版本记录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    pub version: String,
    pub notes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

/// `GET /api/update/changelog` 的响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogResponse {
    /// true = entries 真的跨了多个版本；false = 单条（或空），前端按原样渲染。
    pub spanning: bool,
    pub entries: Vec<ChangelogEntry>,
    /// 过滤前的候选总数（诊断用）。
    pub total: usize,
    /// true = 还有更早的版本没展示：本次区间被展示上限截断，或上游历史窗口
    /// 被拉满（历史表里还有更早的）。前端据此渲染「更早版本见发布页」提示。
    pub truncated: bool,
}

impl ChangelogResponse {
    fn empty() -> Self {
        Self {
            spanning: false,
            entries: Vec::new(),
            total: 0,
            truncated: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangelogQuery {
    /// 已安装版本；缺省取本进程版本（与 `/update/plan` 同口径）。
    current: Option<String>,
    /// 目标版本；缺省时只保留「比 current 新」的条目（上界未知）。
    target: Option<String>,
    /// 显式通道；缺省回落到 current 所属列车。
    channel: Option<String>,
}

/// 区间过滤的纯函数部分：只保留同列车内 `current < v <= target` 的版本。
///
/// 跨列车（用户切换通道）时**只保留目标版本自身**：两条列车的序数不可比，
/// 无法用 `current` 划下界；此时用户关心的是「我要装的那个版本改了什么」，
/// 而不是目标所属列车的整段历史（那会列出 beta30/beta29 之类的噪音）。
fn filter_changelog_span(
    entries: Vec<UpstreamReleaseNote>,
    current: &str,
    target: Option<&str>,
) -> Vec<UpstreamReleaseNote> {
    // 直接用函数指针而非 `|v| train_of(v)`：后者会触发 clippy 的
    // redundant_closure（本文件此前零告警，不新开）。
    let train = update_channel::train_of;
    let Some(target) = target.filter(|t| !t.is_empty()) else {
        // 没有目标版本：上界未知，但仍要剥掉不比当前新的条目——否则会把用户
        // 早就用过的版本当成"本次更新内容"列出来。
        //
        // dev / unknown 构建没有可比序数（`is_train_upgrade` 恒 false），
        // 此时保留上游原序，避免整段被清空。
        if matches!(
            train(current),
            update_channel::Train::Dev | update_channel::Train::Unknown
        ) {
            return entries;
        }
        return entries
            .into_iter()
            .filter(|e| update_channel::is_train_upgrade(current, &e.version))
            .collect();
    };
    if train(current) != train(target) {
        // 跨列车（含 dev/unknown）：上游已按目标列车过滤，这里只留目标那一版。
        // 去 `v` 前缀后精确比对——不做前缀/模糊匹配。
        let wanted = target.trim_start_matches('v');
        return entries
            .into_iter()
            .filter(|e| e.version.trim_start_matches('v') == wanted)
            .collect();
    }
    entries
        .into_iter()
        .filter(|e| {
            // 同列车内：必须比当前新，且不比目标更新。
            update_channel::is_train_upgrade(current, &e.version)
                && !update_channel::is_train_upgrade(target, &e.version)
        })
        .collect()
}

/// 30 分钟窗口缓存：上游历史是发布产物，不会分钟级变化。
///
/// 缓存的是**上游原始列表**而不是已过滤结果：区间（`current..target`）随每次
/// 请求变化，缓存过滤后的结果会让不同跨度的用户互相污染。
struct ChangelogCache {
    channel: String,
    entries: Vec<UpstreamReleaseNote>,
    truncated: bool,
    cached_at: Instant,
}

impl ChangelogCache {
    fn get(&self, channel: &str) -> Option<Self> {
        if self.channel != channel || self.cached_at.elapsed() > CHANGELOG_CACHE_TTL {
            return None;
        }
        Some(Self {
            channel: self.channel.clone(),
            entries: self.entries.clone(),
            truncated: self.truncated,
            cached_at: self.cached_at,
        })
    }
}

fn changelog_cache() -> &'static Mutex<Option<ChangelogCache>> {
    static CACHE: OnceLock<Mutex<Option<ChangelogCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// GET /api/update/changelog?current=...&target=...&channel=...
///
/// 跨版本更新内容：从上游取该通道最近的发布历史，按 `current < v <= target`
/// 过滤后返回。**任何失败都返回空的 `spanning=false`**，让前端静默回落到
/// `/update/plan` 自带的单条 changelog——这条降级保证是刻意的：上游端点尚未
/// 部署、或临时故障时，界面行为与接入前完全一致，不会出现空面板。
async fn changelog(
    State(state): State<SharedState>,
    Query(q): Query<ChangelogQuery>,
) -> ApiResult<Json<ChangelogResponse>> {
    let current = q
        .current
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(state.app_version.as_str())
        .to_string();

    // 通道：显式 > 已安装构建所属列车。都没有（dev 构建）→ 无历史可谈。
    let Some(channel) = update_channel::effective_channel(q.channel.as_deref(), &current) else {
        tracing::info!("update changelog: no channel for current={current} — empty");
        return Ok(Json(ChangelogResponse::empty()));
    };

    // Fast path: 缓存命中（过滤在下面按本次请求重算）。
    let cached = {
        let guard = changelog_cache().lock().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().and_then(|c| c.get(&channel))
    };

    let (entries, truncated) = match cached {
        Some(c) => (c.entries, c.truncated),
        None => match fetch_release_notes(&channel).await {
            Ok(entries) => {
                // 拉满上游窗口 ≠ 一定还有更早的：恰好 50 条时上游没有更多了。
                // 用 `>=` 只是保守近似，真正的「有没有第 51 条」上游不告诉我们，
                // 所以这里按 `<` 判定，宁可少数一次提示也不误导用户去翻发布页。
                let truncated = entries.len() > CHANGELOG_UPSTREAM_LIMIT;
                {
                    let mut guard = changelog_cache().lock().unwrap_or_else(|p| p.into_inner());
                    // 不让「空结果」覆盖已有缓存：上游 5xx/表未建时返回空，
                    // 若此时把缓存清成空，30 分钟内所有人都看不到历史，
                    // 而真正的原因（上游临时故障）已经恢复。保留旧缓存更接近事实。
                    let keep_old = entries.is_empty()
                        && guard
                            .as_ref()
                            .is_some_and(|c| c.channel == channel && !c.entries.is_empty());
                    if !keep_old {
                        *guard = Some(ChangelogCache {
                            channel: channel.clone(),
                            entries: entries.clone(),
                            truncated,
                            cached_at: Instant::now(),
                        });
                    }
                }
                (entries, truncated)
            }
            Err(e) => {
                tracing::warn!("update changelog: upstream unavailable ({e}) — empty fallback");
                return Ok(Json(ChangelogResponse::empty()));
            }
        },
    };

    Ok(Json(apply_span_filter(
        entries,
        truncated,
        &current,
        q.target.as_deref(),
    )))
}

/// 把完整列表收敛成本次请求该展示的区间：过滤 → 截断 → 算 spanning。
fn apply_span_filter(
    entries: Vec<UpstreamReleaseNote>,
    truncated: bool,
    current: &str,
    target: Option<&str>,
) -> ChangelogResponse {
    let total = entries.len();
    let filtered = filter_changelog_span(entries, current, target);
    let matched = filtered.len();
    // spanning = 真的跨了版本。单条时前端按「普通单版本 notes」渲染（不显示
    // 版本段头也不出折叠），所以这里用 len > 1 而不是「过滤是否发生」。
    let spanning = matched > 1;
    let shown: Vec<ChangelogEntry> = filtered
        .into_iter()
        .take(CHANGELOG_MAX_ENTRIES)
        .map(|e| ChangelogEntry {
            version: e.version,
            // 上游对超 8KB 的 notes 做过截断并带 per-entry `truncated`。这里**有意
            // 不转发**该标记：单条 notes 被截断只影响那一版的正文完整性，而
            // 前端无论如何都只渲染文本，多一个「本条不完整」角标对用户没有可用
            // 操作（完整内容只能去发布页看，段头的「详情」链接已经提供了出口）。
            // 转发它反而要求前端为每段多一条分支，收益低于复杂度。
            notes: e.notes.unwrap_or_default(),
            published_at: e.published_at,
        })
        .collect();
    // 「还有 N 个更早的版本」：本次区间被展示上限截断，或上游窗口被拉满
    // （历史表还有更早的、这次根本没取到）。
    //
    // 不能用 `total > shown.len()`：total 是**该通道全部历史**，含比已安装版本
    // 还旧的条目——那些用户早就用过了，不是"还没看到的更新内容"。
    let has_older = truncated || matched > shown.len();
    tracing::info!(
        "update changelog: current={current} target={target:?} channel-total={total} \
         matched={matched} entries={} spanning={spanning} has-older={has_older}",
        shown.len()
    );
    ChangelogResponse {
        spanning,
        entries: shown,
        total,
        truncated: has_older,
    }
}

/// 拉上游发布历史（只读 D1，上游不实时打 GitHub）。
///
/// 返回 `String` 而不是 `ApiError`：失败一律被调用方降级为空列表，不向上传播，
/// 这里只需要可读的失败原因用于日志。
///
/// **不复用 `state.http_client`**：那个客户端在用户开启「忽略 SSL 证书」时会带
/// `danger_accept_invalid_certs(true)`（见 `state.rs` 的构建逻辑），而本请求会把
/// `license_machine_code()` 作为 Bearer 凭据发给固定上游域名。TLS 校验失效时，
/// 中间人可截获该凭据并冒充本机向 `api.qomicex.top` 发请求（许可证通道钉住与
/// 灰度门控都按 machineCode 裁决）。
///
/// 官方上游用有效证书，正常路径不受影响；与 `plugin_download_client` 的处理
/// 口径一致（同样不继承 `ignore_ssl`，理由见 `state.rs` 的字段注释）。
/// 代理设置也不继承：这条链路直连固定域名，走用户代理无收益且会扩大暴露面。
async fn fetch_release_notes(channel: &str) -> Result<Vec<UpstreamReleaseNote>, String> {
    // limit 必须先绑成 String：数组字面量里 `(&str, &str)` 与 `(&str, &String)`
    // 不会自动做 deref 归一，直接内联 `&N.to_string()` 会编译不过。
    let limit = CHANGELOG_UPSTREAM_LIMIT.to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(crate::state::USER_AGENT)
        .build()
        .map_err(|e| format!("build client failed: {e}"))?;
    let response = client
        .get(format!("{UPSTREAM_BASE}{RELEASE_NOTES_PATH}"))
        .query(&[("channel", channel), ("limit", limit.as_str())])
        .bearer_auth(license_machine_code())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    let parsed: UpstreamReleaseNotesResponse =
        serde_json::from_str(&body).map_err(|e| format!("release-notes parse failed: {e}"))?;
    Ok(parsed.entries)
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
                && latency < best_latency.load(Ordering::Relaxed)
            {
                best_latency.store(latency, Ordering::Relaxed);
                let mut guard = best_prefix.lock().unwrap();
                *guard = prefix;
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
#[derive(Default)]
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
        // `stable` 是 `release` 的 UI/header 别名：manifest_channel() 默认返回它，
        // 而 Tauri updater 不带 X-Updater-Channel header。不识别会导致 stable
        // 通道的 manifest 请求被一律 204 拒掉。
        assert_eq!(
            train_reject_reason("0.1.0-release2.0", "0.1.0-release1.0", "stable"),
            None
        );
        // 大小写不敏感
        assert_eq!(
            train_reject_reason("0.1.0-beta31.0", "0.1.0-beta23.0", "BETA"),
            None
        );
        // 空字符串同样无法识别 → 拒绝（不静默放行）
        assert_eq!(
            train_reject_reason("0.1.0-beta31.0", "0.1.0-beta23.0", ""),
            Some("channel-mismatch")
        );
        // 拒绝：请求通道本身无法识别
        assert_eq!(
            train_reject_reason("0.1.0-beta31.0", "0.1.0-beta23.0", "nightly"),
            Some("channel-mismatch")
        );
    }

    // ---- 跨版本 changelog 区间过滤（issue #357）----

    fn note(version: &str) -> UpstreamReleaseNote {
        UpstreamReleaseNote {
            version: version.to_string(),
            notes: Some(format!("## {version}")),
            published_at: None,
        }
    }

    fn versions_of(entries: &[UpstreamReleaseNote]) -> Vec<&str> {
        entries.iter().map(|e| e.version.as_str()).collect()
    }

    /// 普通同通道升级：只保留「比 current 新、且不比 target 新」的版本。
    /// 上游按发布时间倒序返回，所以 beta31 在 beta23 之前。
    #[test]
    fn span_keeps_only_the_upgrade_range() {
        let entries = vec![
            note("0.1.0-beta31.0"),
            note("0.1.0-beta30.0"),
            note("0.1.0-beta23.0"),
            note("0.1.0-beta22.0"),
        ];
        let out = filter_changelog_span(entries, "0.1.0-beta23.0", Some("0.1.0-beta31.0"));
        assert_eq!(
            versions_of(&out),
            vec!["0.1.0-beta31.0", "0.1.0-beta30.0"],
            "beta23 自身不算「更新内容」，beta22 比已安装版本还旧"
        );
    }

    /// target 落在中间：比 target 更新的版本不得出现（否则 UI 会把未来的版本
    /// 也算进「本次更新内容」）。
    #[test]
    fn span_excludes_versions_newer_than_target() {
        let entries = vec![
            note("0.1.0-beta33.0"),
            note("0.1.0-beta32.0"),
            note("0.1.0-beta31.0"),
        ];
        let out = filter_changelog_span(entries, "0.1.0-beta30.0", Some("0.1.0-beta31.0"));
        assert_eq!(versions_of(&out), vec!["0.1.0-beta31.0"]);
    }

    /// 已是最新：区间为空。前端靠 entries.len() 决定是否走跨版本渲染。
    #[test]
    fn span_is_empty_when_current_equals_target() {
        let entries = vec![note("0.1.0-beta31.0"), note("0.1.0-beta30.0")];
        let out = filter_changelog_span(entries, "0.1.0-beta31.0", Some("0.1.0-beta31.0"));
        assert!(out.is_empty());
    }

    /// 跨列车（用户切了通道）：只保留目标版本自身，不列目标列车的整段历史
    /// （beta30/beta29 对「切到 beta31」的用户是噪音，且序数不可比）。
    #[test]
    fn span_across_trains_keeps_only_target() {
        let entries = vec![
            note("0.1.0-beta31.0"),
            note("0.1.0-beta30.0"),
            note("0.1.0-release1.0"),
        ];
        let out = filter_changelog_span(entries, "0.1.0-release1.0", Some("0.1.0-beta31.0"));
        assert_eq!(
            versions_of(&out),
            vec!["0.1.0-beta31.0"],
            "跨列车只展示目标版本自身"
        );
    }

    /// 跨列车且 target 带 `v` 前缀时必须命中——这正是 `trim_start_matches('v')`
    /// 归一化的意义。断言里刻意让 target **带前缀**，否则归一化坏掉也能通过测试
    /// （回归防护：只测「条目带前缀」测不出 target 侧的归一化缺失）。
    #[test]
    fn span_across_trains_matches_prefixed_target() {
        let entries = vec![note("0.1.0-beta31.0"), note("0.1.0-beta30.0")];
        let out = filter_changelog_span(entries, "0.1.0-release1.0", Some("v0.1.0-beta31.0"));
        assert_eq!(
            versions_of(&out),
            vec!["0.1.0-beta31.0"],
            "target 的 v 前缀必须被归一化掉"
        );
    }

    /// 条目带 `v` 前缀、target 不带：两侧都要正确归一。
    #[test]
    fn span_across_trains_matches_prefixed_entries() {
        let entries = vec![note("v0.1.0-beta31.0"), note("v0.1.0-beta30.0")];
        let out = filter_changelog_span(entries, "0.1.0-release1.0", Some("0.1.0-beta31.0"));
        assert_eq!(versions_of(&out), vec!["v0.1.0-beta31.0"]);
    }

    /// 两侧都带 `v` 前缀。
    #[test]
    fn span_across_trains_matches_both_prefixed() {
        let entries = vec![note("v0.1.0-beta31.0")];
        let out = filter_changelog_span(entries, "0.1.0-release1.0", Some("v0.1.0-beta31.0"));
        assert_eq!(versions_of(&out), vec!["v0.1.0-beta31.0"]);
    }

    /// target 缺省：上界未知，但必须剥掉「不比当前新」的条目——否则弹窗会把
    /// 用户早就用过的版本当成本次更新内容列出来。
    #[test]
    fn span_without_target_still_drops_installed_and_older() {
        let entries = vec![
            note("0.1.0-beta31.0"),
            note("0.1.0-beta30.0"),
            note("0.1.0-beta23.0"),
            note("0.1.0-beta22.0"),
        ];
        let out = filter_changelog_span(entries, "0.1.0-beta23.0", None);
        assert_eq!(
            versions_of(&out),
            vec!["0.1.0-beta31.0", "0.1.0-beta30.0"],
            "current 自身与更旧版本都必须被剥掉"
        );
    }

    /// target 缺省 + dev 构建（无可比序数）：保留上游原序，不能把整段清空。
    #[test]
    fn span_without_target_keeps_entries_for_dev_build() {
        let entries = vec![note("0.1.0-beta31.0"), note("0.1.0-beta30.0")];
        let out = filter_changelog_span(entries, "0.1.0", None);
        assert_eq!(out.len(), 2);
    }

    /// 空 target 字符串与 None 等价（前端可能传空串）。
    #[test]
    fn span_treats_empty_target_as_absent() {
        let entries = vec![note("0.1.0-beta31.0"), note("0.1.0-beta23.0")];
        let out = filter_changelog_span(entries, "0.1.0-beta23.0", Some(""));
        assert_eq!(versions_of(&out), vec!["0.1.0-beta31.0"]);
    }

    /// 完整链路：过滤后截断到展示上限，并算对 spanning / truncated。
    #[test]
    fn apply_filter_truncates_and_reports_spanning() {
        let mut entries = Vec::new();
        for i in (1..=15).rev() {
            entries.push(note(&format!("0.1.0-beta{i}.0")));
        }
        // current=beta1 target=beta15 → 14 条命中，展示上限 10 条。
        let out = apply_span_filter(entries, false, "0.1.0-beta1.0", Some("0.1.0-beta15.0"));
        assert!(out.spanning);
        assert_eq!(out.entries.len(), CHANGELOG_MAX_ENTRIES);
        assert_eq!(out.total, 15);
        assert!(out.truncated, "被展示上限截断时必须标记仍有更早版本");
        assert_eq!(out.entries[0].version, "0.1.0-beta15.0");
    }

    /// 单条命中：spanning=false，前端退回单块渲染（不出折叠、不出段头）。
    #[test]
    fn apply_filter_marks_single_entry_as_not_spanning() {
        let entries = vec![note("0.1.0-beta31.0"), note("0.1.0-beta30.0")];
        let out = apply_span_filter(entries, false, "0.1.0-beta30.0", Some("0.1.0-beta31.0"));
        assert!(!out.spanning);
        assert_eq!(out.entries.len(), 1);
        assert!(!out.truncated);
    }

    /// 上游窗口被截断（拉满 limit）时，即使本次区间只有几条，也要告诉前端
    /// 「还有更早版本」——否则用户以为历史到此为止。
    #[test]
    fn upstream_truncation_propagates() {
        let entries = vec![note("0.1.0-beta31.0")];
        let out = apply_span_filter(entries, true, "0.1.0-beta30.0", Some("0.1.0-beta31.0"));
        assert!(out.truncated);
    }

    /// 上游响应契约：真实 payload 带 `type`/`title`/`truncated` 等本端未声明的
    /// 字段，serde 必须忽略它们而不是整体失败（失败会被静默降级成空列表，
    /// 表现为「功能上线了但一直没内容」）。
    ///
    /// payload 取自 Web.Backend `GET /api/client/release-notes` 的实际输出。
    #[test]
    fn upstream_payload_deserializes_with_extra_fields() {
        let raw = concat!(
            "{\"entries\":[",
            "{\"version\":\"1.2.0-beta1.0\",\"type\":\"beta\",\"title\":\"v1.2.0-beta1.0\",",
            "\"notes\":\"## v1.2.0-beta1.0\",\"publishedAt\":\"2026-11-17T08:42:17Z\",\"truncated\":false},",
            "{\"version\":\"1.1.2-beta1.0\",\"type\":\"beta\",\"title\":\"v1.1.2-beta1.0\",",
            "\"notes\":\"## v1.1.2-beta1.0\",\"publishedAt\":\"2026-11-06T16:33:52Z\",\"truncated\":false}",
            "]}"
        );
        let parsed: UpstreamReleaseNotesResponse =
            serde_json::from_str(raw).expect("真实 payload 必须能解析");
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].version, "1.2.0-beta1.0");
        assert_eq!(
            parsed.entries[0].published_at.as_deref(),
            Some("2026-11-17T08:42:17Z")
        );
        // 缺字段容错：notes/publishedAt 缺失时用默认值，不整体失败。
        let sparse: UpstreamReleaseNotesResponse =
            serde_json::from_str(r#"{"entries":[{"version":"1.0.0-beta1.0"}]}"#).unwrap();
        assert_eq!(sparse.entries[0].notes, None);
        assert!(sparse.entries[0].published_at.is_none());

        // `release_history.notes` 是可空列，SQL NULL 在上游 JSON 里是 `null`。
        // 这里必须能吃下：一个 null 不能把整个响应打回空列表（回归防护）。
        let with_null: UpstreamReleaseNotesResponse = serde_json::from_str(&concat!(
            "{\"entries\":[",
            "{\"version\":\"1.2.0-beta2.0\",\"notes\":null,\"publishedAt\":null},",
            "{\"version\":\"1.2.0-beta1.0\",\"notes\":\"ok\",\"publishedAt\":\"2026-11-17T08:42:17Z\"}",
            "]}"
        ))
        .expect("notes 为 null 时必须仍能整体解析");
        assert_eq!(with_null.entries.len(), 2, "null 不得导致整批丢失");
        assert_eq!(with_null.entries[0].notes, None);
        assert_eq!(with_null.entries[1].notes.as_deref(), Some("ok"));

        // 空 entries 也要能解析（上游历史表为空时）。
        let empty: UpstreamReleaseNotesResponse =
            serde_json::from_str(r#"{"entries":[]}"#).unwrap();
        assert!(empty.entries.is_empty());
    }
}
