//! Announcement endpoints (corresponding source: Endpoints/AnnouncementEndpoints.cs).
//!
//! Source registers the route directly via `app.MapGet("/api/client/announcements", ...)`
//! (no MapGroup). Inside the axum "/api" nest the route is therefore declared as
//! "/client/announcements", producing the public path `/api/client/announcements`.
//!
//! The handler proxies an upstream announcement feed:
//! - Base address: `https://api.qomicex.top` (file Services/LicenseConfig.cs, QomicexWebBaseUrl).
//! - Path: `/api/client/announcements`; an optional `channel` query parameter is appended
//!   with percent-encoding (source uses `Uri.EscapeDataString`).
//!
//! Differences from source:
//! - Source returns an empty list (HTTP 200) when the upstream call fails or returns an
//!   invalid payload. We preserve that behaviour and additionally fall back to a per-channel
//!   cache file under `{BaseDir}` so a transient upstream outage still serves the last
//!   successfully fetched announcements. Fresh successful responses are written back to cache.
//! - The percent-encoding of the channel query value is inlined (`percent_encode`), since no
//!   external percent-encoding crate is added.

use std::path::PathBuf;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::ApiResult;
use crate::state::SharedState;

const QOMICEX_WEB_BASE_URL: &str = "https://api.qomicex.top";
const ANNOUNCEMENT_PATH: &str = "/api/client/announcements";

// =====================================================================
// DTO (matching AnnouncementDto, camelCase; Channel is nullable)
// =====================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementDto {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct AnnouncementQuery {
    channel: Option<String>,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new().route("/client/announcements", get(announcements))
}

// =====================================================================
// Handler
// =====================================================================

async fn announcements(
    State(state): State<SharedState>,
    Query(q): Query<AnnouncementQuery>,
) -> ApiResult<Json<Vec<AnnouncementDto>>> {
    let mut url = format!("{}{}", QOMICEX_WEB_BASE_URL, ANNOUNCEMENT_PATH);
    if let Some(channel) = &q.channel {
        if !channel.is_empty() {
            url.push_str("?channel=");
            url.push_str(&percent_encode(channel));
        }
    }

    match fetch_remote(&state.http_client, &url).await {
        Ok(list) => {
            cache_write(&state.data_dir, q.channel.as_deref(), &list);
            Ok(Json(list))
        }
        Err(_) => {
            if let Some(cached) = cache_read(&state.data_dir, q.channel.as_deref()) {
                Ok(Json(cached))
            } else {
                Ok(Json(Vec::new()))
            }
        }
    }
}

// =====================================================================
// Upstream fetch
// =====================================================================

async fn fetch_remote(client: &reqwest::Client, url: &str) -> Result<Vec<AnnouncementDto>, ()> {
    let resp = client.get(url).send().await.map_err(|_| ())?;
    if !resp.status().is_success() {
        return Err(());
    }
    let text = resp.text().await.map_err(|_| ())?;
    // Prefer a top-level list; fall back to unwrap in case upstream wraps it.
    let parsed: Option<Vec<AnnouncementDto>> = serde_json::from_str(&text).ok().or_else(|| {
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
    });
    parsed.ok_or(())
}

// =====================================================================
// Cache helpers ({BaseDir})
// =====================================================================

fn cache_path(data_dir: &PathBuf, channel: Option<&str>) -> PathBuf {
    let dir = data_dir.join("QML").join("announcements");
    let name = match channel {
        Some(c) if !c.is_empty() => format!("announcements-{}.json", c),
        _ => "announcements.json".to_string(),
    };
    dir.join(name)
}

fn cache_write(data_dir: &PathBuf, channel: Option<&str>, list: &[AnnouncementDto]) {
    let path = cache_path(data_dir, channel);
    let dir = path.parent().map(|p| p.to_path_buf());
    if let Some(parent) = dir {
        if std::fs::create_dir_all(&parent).is_err() {
            return;
        }
    }
    if let Ok(json) = serde_json::to_vec(&list) {
        let _ = std::fs::write(&path, json);
    }
}

fn cache_read(data_dir: &PathBuf, channel: Option<&str>) -> Option<Vec<AnnouncementDto>> {
    let path = cache_path(data_dir, channel);
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// =====================================================================
// Minimal percent-encoding (RFC 3986 unreserved chars are kept, others %XX)
// =====================================================================

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}
