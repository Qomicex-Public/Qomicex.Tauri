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
use crate::state::SharedState;

const UPSTREAM_BASE: &str = "https://api.qomicex.top";
const VERSION_CHECK_PATH: &str = "/api/client/version/check";

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
}

/// GET /api/update/check?current=...&channel=...
async fn check(
    State(state): State<SharedState>,
    Query(q): Query<CheckQuery>,
) -> ApiResult<Json<UpdateCheckResponse>> {
    let _channel = q.channel; // channel is accepted but unused in the C# source.
    Ok(Json(check_update(&state, &q.current).await?))
}

/// GET /api/update/manifest?current=...&target=...&arch=...
async fn manifest(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(q): Query<ManifestQuery>,
) -> ApiResult<Response> {
    let _channel = manifest_channel(&headers); // used only to mirror the C# read.

    // The upstream check precedes the try/catch in C#, so its failures
    // propagate (do not swallow them here).
    let has_update = check_update(&state, &q.current).await?;

    if !has_update.has_update {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let Some(download_url) = has_update.download_url.filter(|u| !u.is_empty()) else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };

    // download_url points to the Tauri latest.json manifest. This block maps
    // to the C# try/catch: any failure returns 204 NoContent.
    let manifest = match fetch_tauri_manifest(&state.http_client, &download_url).await {
        Ok(Some(m)) => m,
        _ => return Ok(StatusCode::NO_CONTENT.into_response()),
    };

    if manifest.platforms.is_empty() || !manifest.platforms.contains_key(&q.target) {
        return Ok(StatusCode::NO_CONTENT.into_response());
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
async fn check_update(
    state: &SharedState,
    current: &str,
) -> ApiResult<UpdateCheckResponse> {
    let response = state
        .http_client
        .get(format!("{UPSTREAM_BASE}{VERSION_CHECK_PATH}"))
        .query(&[("current", current)])
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
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
        return Err(ApiError::upstream(format!("HTTP {status}")));
    }
    match serde_json::from_str::<TauriManifestResponse>(&text) {
        Ok(m) => Ok(Some(m)),
        Err(_) => Ok(None),
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckQuery {
    current: String,
    channel: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestQuery {
    current: String,
    target: String,
    #[allow(dead_code)]
    arch: Option<String>, // accepted by the C# route but unused.
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
#[derive(Serialize, Deserialize)]
struct TauriPlatformEntry {
    signature: String,
    url: String,
}
