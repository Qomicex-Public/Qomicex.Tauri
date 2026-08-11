//! Launch endpoints (translated from Endpoints/LaunchEndpoints.cs).
//!
//! POST /api/launch                 -> launch a game instance via core.launch()
//! POST /api/launch/{pid}/kill      -> kill a game process by pid
//!
//! Routes are declared relative to the "/api" nest (see app.rs); the C# group
//! prefix is `/api/launch`.

use axum::extract::{Path as AxumPath, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use qomicex_core::models::auth::{AuthMode, AuthOptions};
use qomicex_core::models::launch::{JavaOptions, LaunchOptions};

use crate::error::{ApiError, ApiResult};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/launch", post(launch))
        .route("/launch/{pid}/kill", post(kill_process))
}

/// POST /api/launch  (LaunchRequest -> LaunchResultDto)
async fn launch(
    State(state): State<SharedState>,
    Json(req): Json<LaunchRequest>,
) -> ApiResult<Json<LaunchResultDto>> {
    // Note: C# calls LicenseValidator.ValidateAsync here. No Rust license
    // component exists in this backend state yet; licensing is left to a
    // follow-up that confirms the secret policy first.
    let instance = state
        .instance
        .get_by_id(&req.instance_id)
        .ok_or_else(|| ApiError::not_found("INSTANCE_NOT_FOUND", "Instance not found"))?;
    let _ = instance; // resolved for parity future use (e.g. game root / isolation).

    let java_options = JavaOptions {
        java_path: req.java_path,
        max_memory_mb: req.max_memory,
        extra_jvm_args: req
            .jvm_args
            .map(|s| s.split(' ').filter(|t| !t.is_empty()).map(String::from).collect()),
    };

    let auth_options = if req.auth_token.as_deref().is_none_or(|t| t.is_empty()) {
        None
    } else {
        Some(AuthOptions {
            mode: AuthMode::Offline,
            name: Some(req.auth_name.clone().unwrap_or_else(|| "Player".to_string())),
            uuid: req.auth_uuid.clone(),
            access_token: req.auth_token.clone(),
            ..Default::default()
        })
    };

    let options = LaunchOptions {
        version: req.version_id,
        version_isolation: req.version_isolation,
        join_server: req.join_server,
        join_world: req.join_world,
        java_options: Some(java_options),
        auth_options,
        ..Default::default()
    };

    let result = state
        .core
        .launch()
        .launch(options)
        .await
        .map_err(map_core_error)?;

    Ok(Json(LaunchResultDto {
        success: result.success,
        process_id: result.process_id,
        error: result.message,
        detail: None,
    }))
}

/// POST /api/launch/{pid}/kill  (MessageResponse | 404)
async fn kill_process(
    State(state): State<SharedState>,
    AxumPath(pid): AxumPath<i32>,
) -> ApiResult<Json<MessageResponse>> {
    let killed = state
        .core
        .launch()
        .kill(pid)
        .await
        .map_err(map_core_error)?;
    if !killed {
        return Err(ApiError::not_found("PROCESS_NOT_FOUND", "Process not found or could not be killed"));
    }
    Ok(Json(MessageResponse {
        message: format!("Process {pid} killed"),
    }))
}

fn map_core_error(e: qomicex_core::error::Error) -> ApiError {
    match e {
        qomicex_core::error::Error::VersionNotFound { message, .. } => {
            ApiError::not_found("VERSION_NOT_FOUND", message)
        }
        other => ApiError::internal(other.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchRequest {
    instance_id: String,
    version_id: String,
    java_path: String,
    #[serde(default = "default_memory")]
    max_memory: i32,
    #[serde(default)]
    jvm_args: Option<String>,
    #[serde(default)]
    version_isolation: bool,
    #[serde(default)]
    auth_uuid: Option<String>,
    #[serde(default)]
    auth_name: Option<String>,
    #[serde(default)]
    auth_token: Option<String>,
    #[serde(default)]
    join_server: Option<String>,
    #[serde(default)]
    join_world: Option<String>,
}

fn default_memory() -> i32 {
    4096
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchResultDto {
    success: bool,
    process_id: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    message: String,
}
