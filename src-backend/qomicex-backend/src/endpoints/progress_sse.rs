//! Progress SSE endpoint (maps to Endpoints/ProgressSseEndpoints.cs).
//!
//! Route: `/progress/stream` (mounted under `/api` => `/api/progress/stream`).
//! Streams a JSON payload excerpt: current active install tasks plus a summary.
//!
//! Scope notes:
//! - Install items come from `state.install_tracker` (`InstallTracker::get_all_active`).
//! - Java download tasks come from `endpoints::java` snapshots (all states,
//!   including terminal ones, so the download center can observe completion).
//! - Resource downloads come from `resource_download`'s registry plus the
//!   plugin download sessions (both share the `resources` channel).
//!
//! Dependencies used:
//! - `axum::response::sse` (requires axum `sse` feature -- NOT enabled in Cargo.toml).
//! - `futures::stream::unfold` (requires `futures` as a *direct* dependency --
//!   present only transitively today, not directly usable).

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

use crate::error::ApiResult;
use crate::services::install_tracker::{InstallProgress, InstallTracker};
use crate::state::SharedState;

/// SSE JSON payload (matches source `ProgressSsePayload`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressSsePayload {
    #[serde(rename = "type")]
    kind: String,
    installs: Vec<InstallProgress>,
    java_downloads: Vec<serde_json::Value>,
    resources: Vec<serde_json::Value>,
    summary: ProgressSseSummary,
}

/// Summary of the stream excerpt (matches source `ProgressSseSummary`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressSseSummary {
    active_count: usize,
    total_speed: f64,
}

const POLL_INTERVAL: Duration = Duration::from_millis(300);

pub fn router() -> Router<SharedState> {
    Router::new().route("/progress/stream", get(progress_sse))
}

/// Streaming SSE handler: emits `data: <json>` on install progress events or on
/// a periodic poll, mirroring the source's 300ms loop while also reacting
/// promptly to broadcast updates. On disconnect or broadcast channel close the
/// stream ends and the response is dropped.
async fn progress_sse(State(state): State<SharedState>) -> ApiResult<impl IntoResponse> {
    let tracker = state.install_tracker.clone();
    let mut rx = tracker.subscribe();
    let (tx, channel_rx) = mpsc::channel::<Option<Result<Event, Infallible>>>(64);

    tokio::spawn(async move {
        loop {
            let tick = tokio::select! {
                r = rx.recv() => Some(r),
                _ = tokio::time::sleep(POLL_INTERVAL) => None,
            };
            // Closed channel means no more broadcasts; end the stream.
            if matches!(tick, Some(Err(broadcast::error::RecvError::Closed))) {
                break;
            }
            let payload = build_payload(&tracker);
            let json = match serde_json::to_string(&payload) {
                Ok(j) => j,
                Err(_) => continue,
            };
            let event = Event::default().data(json);
            if tx.send(Some(Ok(event))).await.is_err() {
                break;
            }
        }
        let _ = tx.send(None).await;
    });

    let stream = mpsc_stream(channel_rx);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

/// Turn the mpsc channel of optional events into an SSE `Stream`.
///
/// `None` (sent from the worker after broadcast close or channel drop) ends the stream.
fn mpsc_stream(
    rx: mpsc::Receiver<Option<Result<Event, Infallible>>>,
) -> impl futures::stream::Stream<Item = Result<Event, Infallible>> + Send + 'static {
    futures::stream::unfold(rx, |mut rx| async move {
        match rx.recv().await {
            Some(Some(item)) => Some((item, rx)),
            Some(None) | None => None,
        }
    })
}

/// Build the full progress excerpt from the install tracker + the shared
/// resource-download registry, mirroring the C# three-channel snapshot.
fn build_payload(tracker: &InstallTracker) -> ProgressSsePayload {
    let installs = tracker.get_all_active();
    let total_speed = installs.iter().map(|i| i.speed).sum::<f64>();
    let mut active_count = installs.len();

    // Resource downloads (qomicex-downloader) mirrored in resource_download's
    // registry plus plugin-started sessions. Without the resources channel the
    // download center shows those tasks as stuck queued.
    let resources = build_resources();
    active_count += resources
        .iter()
        .filter(|v| {
            v.get("status")
                .and_then(|s| s.as_str())
                .map(|s| matches!(s, "queued" | "downloading" | "paused"))
                .unwrap_or(false)
        })
        .count();

    let java_downloads = crate::endpoints::java::active_java_download_snapshots();
    active_count += java_downloads
        .iter()
        .filter(|v| {
            v.get("status")
                .and_then(|s| s.as_str())
                .map(|s| {
                    matches!(
                        s,
                        "queued"
                            | "resolving"
                            | "downloading"
                            | "paused"
                            | "extracting"
                            | "registering"
                    )
                })
                .unwrap_or(false)
        })
        .count();

    ProgressSsePayload {
        kind: "progress".to_string(),
        installs,
        java_downloads,
        resources,
        summary: ProgressSseSummary {
            active_count,
            total_speed,
        },
    }
}

/// Resource downloads + plugin sessions (`resources` channel).
fn build_resources() -> Vec<serde_json::Value> {
    // Resource downloads (qomicex-downloader) mirrored in resource_download's
    // registry. Without this the download center shows those tasks as stuck
    // queued (the SSE `resources` array was empty).
    let mut resources: Vec<serde_json::Value> =
        crate::endpoints::resource_download::download_snapshots()
            .into_iter()
            .map(|(id, s)| {
                let progress = if s.total > 0 {
                    (s.downloaded as f64 / s.total as f64) * 100.0
                } else if s.status == "completed" {
                    100.0
                } else {
                    0.0
                };
                serde_json::json!({
                    "sessionId": id.to_string(),
                    "type": "resource",
                    "status": s.status,
                    "stage": s.status,
                    "progress": progress,
                    "speed": s.speed,
                    "currentFile": s.file_name,
                    "error": s.error,
                    "downloadedBytes": s.downloaded,
                    "totalBytes": s.total,
                })
            })
            .collect();

    // Plugin-started downloads (plugin session registry) share the same
    // `resources` channel so they appear live in the download center.
    let plugin_sessions = crate::endpoints::plugin::download_sessions_json();
    resources.extend(plugin_sessions);
    resources
}
