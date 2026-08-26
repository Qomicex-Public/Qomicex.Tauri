//! Telemetry endpoints（方案 §3.3 灰度自动暂停：匿名插件错误遥测转发）。
//!
//! POST /api/telemetry/plugin-error
//!   body `{ pluginId, pluginVersion, errorType }` → 校验白名单 →
//!   注入 launcherVersion（后端 CARGO_PKG_VERSION）→ 转发 store `/telemetry/plugin-error`。
//!   仅匿名字段（插件 id + 版本 + 错误类别），禁路径/堆栈/隐私数据。

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::services::plugin_store;
use crate::state::SharedState;

/// 允许上报的错误类别白名单（与 store 端 zod schema 一致）。
const PLUGIN_ERROR_TYPES: [&str; 3] =
    ["launch_crash", "plugin_load_failed", "plugin_runtime_error"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginErrorRequest {
    plugin_id: String,
    plugin_version: String,
    error_type: String,
}

pub fn router() -> Router<SharedState> {
    Router::new().route("/telemetry/plugin-error", post(report_plugin_error))
}

async fn report_plugin_error(
    State(state): State<SharedState>,
    Json(req): Json<PluginErrorRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if req.plugin_id.trim().is_empty() || req.plugin_version.trim().is_empty() {
        return Err(ApiError::bad_request(
            "TELEMETRY_FIELDS_REQUIRED",
            "pluginId 与 pluginVersion 不能为空",
        ));
    }
    if !PLUGIN_ERROR_TYPES.contains(&req.error_type.as_str()) {
        return Err(ApiError::bad_request(
            "TELEMETRY_INVALID_ERROR_TYPE",
            "不支持的错误类别",
        ));
    }
    Ok(Json(
        plugin_store::report_plugin_error(
            &state.http_client,
            req.plugin_id.trim(),
            req.plugin_version.trim(),
            &req.error_type,
        )
        .await?,
    ))
}
