//! Resource endpoints (source: Endpoints/ResourceEndpoints.cs).
//!
//! Implements resource completion checks and install kick-off against the
//! core version facade, plus a static progress placeholder.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::ApiResult;
use crate::state::SharedState;

// =====================================================================
// DTO
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceCompleteRequest {
    version_id: String,
    #[serde(default)]
    check_only: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckResourcesResponse {
    complete: bool,
    version_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressResponse {
    task_id: String,
    percentage: u32,
    downloaded: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_file: Option<String>,
    status: String,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/resources/complete", post(complete))
        .route("/resources/complete/progress", get(complete_progress))
}

// =====================================================================
// Handlers
// =====================================================================

/// POST /resources/complete: check whether a version is installed, or kick
/// off a background install when checkOnly is false.
async fn complete(
    State(state): State<SharedState>,
    Json(req): Json<ResourceCompleteRequest>,
) -> ApiResult<Response> {
    if req.check_only.unwrap_or(false) {
        let installed = state.core.version().is_version_installed(&req.version_id);
        return Ok(Json(CheckResourcesResponse {
            complete: installed,
            version_id: req.version_id.clone(),
        })
        .into_response());
    }

    // Fire-and-forget install: spawn on the tokio runtime; errors are
    // swallowed to keep the acceptance response synchronous.
    let core = state.core.clone();
    let version_id = req.version_id.clone();
    let version_id_for_msg = version_id.clone();
    tokio::spawn(async move {
        let _ = core.version().install_version(&version_id, None).await;
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(MessageResponse {
            message: format!("Resource completion started for {}", version_id_for_msg),
            version_id: Some(version_id_for_msg),
        }),
    )
        .into_response())
}

/// GET /resources/complete/progress: static progress placeholder.
async fn complete_progress() -> ApiResult<Json<ProgressResponse>> {
    Ok(Json(ProgressResponse {
        task_id: "resource-complete".to_string(),
        percentage: 0,
        downloaded: 0,
        total: 0,
        current_file: None,
        status: "started".to_string(),
    }))
}
