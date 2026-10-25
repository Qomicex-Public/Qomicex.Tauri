// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 服务端搭建端点（整合包一键开服 / 纯净服）。
//!
//! POST   /api/server/setup                    — 启动搭建任务，返回 taskId
//! GET    /api/server/setup/progress/{taskId}  — 查询进度（复用 InstallProgress）
//! DELETE /api/server/setup/progress/{taskId}  — 请求取消
//!
//! 任务注册进共享 InstallTracker（kind = "server"），自动出现在下载中心 SSE；
//! taskId 就是 tracker 里的 instance_id 槽位。产物是 `{dir}` 下的服务端目录，
//! 启动方式见 `{dir}/.qml-server/launch.json`（调用方如服务端管理插件读取）。
//!
//! 权限门禁与插件其余端点一致：后端只做输入校验，权限由前端桥强制。

use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::server_setup::{run_server_pipeline, ServerSource, ServerSetupRequest};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/server/setup", post(setup))
        .route(
            "/server/setup/progress/{taskId}",
            get(progress).delete(cancel),
        )
        .route("/server/setup/progress/{taskId}/complete", post(complete))
}

/// POST /api/server/setup/progress/{taskId}/complete — 用户手动补全缺失文件后
/// 标记任务完成（Tracker 的 awaiting-files → completed）。文件由用户自行拷入
/// 服务端目录（如 mods/），后端不做校验。
async fn complete(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    if state.install_tracker.finish_awaiting(&task_id) {
        Ok(Json(serde_json::json!({ "status": "completed" })))
    } else {
        Err(ApiError::bad_request(
            "SERVER_SETUP_NOT_AWAITING",
            "任务不在等待补全状态（可能已完成/失败/被取消）",
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerSetupStartResponse {
    task_id: String,
    dir: String,
}

/// POST /api/server/setup — 启动服务端搭建后台任务。
async fn setup(
    State(state): State<SharedState>,
    Json(req): Json<ServerSetupRequest>,
) -> ApiResult<Json<ServerSetupStartResponse>> {
    if req.name.trim().is_empty() {
        return Err(ApiError::bad_request("SERVER_NAME_REQUIRED", "name 不能为空"));
    }
    if req.dir.trim().is_empty() {
        return Err(ApiError::bad_request("SERVER_DIR_REQUIRED", "dir 不能为空"));
    }
    // 来源形状校验交给 ServerSource 的 untagged 反序列化（不匹配直接 422/400）；
    // 这里只做目录合法性：拒绝相对路径与盘符外根（服务端目录必须落在用户指定的
    // 绝对路径里，由调用方如插件默认拼到 {DataDir}/Servers/ 下）。
    let dir = req.dir.trim().to_string();
    if !std::path::Path::new(&dir).is_absolute() {
        return Err(ApiError::bad_request(
            "SERVER_DIR_NOT_ABSOLUTE",
            "dir 必须是绝对路径",
        ));
    }
    // 来源校验前置到任务启动之前：缺来源直接 400 并带上可读原因，
    // 而不是启动一个注定失败的任务。
    let source: ServerSource = req
        .source()
        .map_err(|e| ApiError::bad_request("SERVER_SOURCE_INVALID", e))?;

    let task_id = format!("server-{}", Uuid::new_v4().simple());
    let mgr = state.download_manager.load_full();
    let http = state.http_client.clone();
    let cf_key = state.curse_forge_api_key.clone();
    let core = state.core.clone();

    state
        .install_tracker
        .try_start(task_id.clone(), "server", move |handle| async move {
            run_server_pipeline(handle, mgr, http, cf_key, core, req, source).await
        })
        .map_err(|existing| {
            ApiError::conflict(
                "SERVER_SETUP_IN_PROGRESS",
                format!("该服务端已有进行中的任务（{existing}），请等待完成或先取消"),
            )
        })?;

    Ok(Json(ServerSetupStartResponse {
        task_id,
        dir,
    }))
}

/// GET /api/server/setup/progress/{taskId}。
async fn progress(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<crate::services::install_tracker::InstallProgress>> {
    state
        .install_tracker
        .get_state(&task_id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found("SERVER_SETUP_NOT_FOUND", "任务不存在或已回收"))
}

/// DELETE /api/server/setup/progress/{taskId} — 置取消标志，管线在轮询点协作退出。
async fn cancel(State(state): State<SharedState>, AxumPath(task_id): AxumPath<String>) -> ApiResult<Json<serde_json::Value>> {
    if state.install_tracker.get_handle(&task_id).is_none() {
        return Err(ApiError::not_found("SERVER_SETUP_NOT_FOUND", "任务不存在或已回收"));
    }
    state.install_tracker.cancel(&task_id);
    Ok(Json(serde_json::json!({ "status": "cancelling" })))
}
