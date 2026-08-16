//! 严重错误日志上报端点（`POST /api/client/logs`）。
//!
//! 只用于上报"影响运行的恶性 bug"：前端渲染崩溃（ErrorBoundary fallback 页）、
//! 后端 panic。一般启动失败/安装下载错误等业务错误**不上报**。
//!
//! 流程：校验 logs → 检查设置开关 `autoReportErrors`（关闭则静默跳过）→
//! 后端统一补全 `deviceInfo`（系统/硬件信息，前端不传）→ 读 license token
//! 转发上游 `https://api.qomicex.top/api/client/logs`（Bearer 认证）。
//! 无 license token → `{ success: false, skipped: true }`（静默跳过，不算失败）。

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};
use crate::services::error_report::{self, ClientLogsRequest};
use crate::state::SharedState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientLogsResponse {
    success: bool,
    /// true = 因无 license token 或设置关闭而被跳过（不算失败，前端静默）。
    skipped: bool,
}

pub fn router() -> Router<SharedState> {
    Router::new().route("/client/logs", post(client_logs))
}

/// POST /api/client/logs
async fn client_logs(
    State(state): State<SharedState>,
    Json(req): Json<ClientLogsRequest>,
) -> ApiResult<Json<ClientLogsResponse>> {
    if req.logs.is_empty() {
        return Err(ApiError::bad_request("BAD_REQUEST", "logs is required"));
    }
    // 设置开关：关闭则静默跳过（仍返回 200，避免前端把"关闭"误判为故障）。
    let enabled = state
        .settings
        .read()
        .await
        .auto_report_errors
        .unwrap_or(true);
    if !enabled {
        return Ok(Json(ClientLogsResponse {
            success: false,
            skipped: true,
        }));
    }

    // deviceInfo 由后端统一生成（见 services::error_report::report_logs），
    // 前端无需传。
    let reported = error_report::report_logs(&state.http_client, req.logs).await?;
    Ok(Json(ClientLogsResponse {
        success: reported,
        skipped: !reported,
    }))
}
