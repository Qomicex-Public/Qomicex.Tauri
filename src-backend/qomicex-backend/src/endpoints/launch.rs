//! Launch endpoints (translated from Endpoints/LaunchEndpoints.cs).
//!
//! POST /api/launch/{pid}/kill      -> kill a game process by pid
//!
//! Routes are declared relative to the "/api" nest (see app.rs); the C# group
//! prefix is `/api/launch`.
//!
//! 曾经的 `POST /api/launch` 已移除（#237）：前端无任何调用者（启动统一走
//! `POST /api/instance/{id}/launch`），且它与那条路径行为不一致 —— 缺 `stage`
//! 字段、恒用 `AuthMode::Offline` 跳过账号令牌刷新、无 license 校验。两条并行
//! 维护的启动路径只会让后续改动漏改其中一条。

use axum::extract::{Path as AxumPath, State};
use axum::routing::post;
use axum::{Json, Router};

use crate::error::{ApiError, ApiResult};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new().route("/launch/{pid}/kill", post(kill_process))
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
        return Err(ApiError::not_found(
            "PROCESS_NOT_FOUND",
            "Process not found or could not be killed",
        ));
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    message: String,
}
