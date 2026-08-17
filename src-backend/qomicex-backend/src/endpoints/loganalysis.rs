//! 日志分析端点（`/api/loganalysis/*`），移植自 C# `LogAnalysisController.cs`。
//!
//! - `POST /api/loganalysis/analyze` — 分析前端粘贴的日志文本。
//! - `POST /api/loganalysis/analyze-crash/{instanceId}` — 读取 LaunchTracker 中的
//!   崩溃报告并分析，同时上传 mclo.gs 生成外链（失败不阻塞本地分析）。

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::log_analysis::{self, LogAnalysisResult};
use crate::state::SharedState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeRequest {
    log_content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashAnalysisResponse {
    analysis: LogAnalysisResult,
    mclo_gs_url: Option<String>,
    qr_code_base64: Option<String>,
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/loganalysis/analyze", post(analyze))
        .route("/loganalysis/analyze-crash/{instance_id}", post(analyze_crash))
}

/// POST /api/loganalysis/analyze
async fn analyze(Json(req): Json<AnalyzeRequest>) -> ApiResult<Json<LogAnalysisResult>> {
    if req.log_content.trim().is_empty() {
        return Err(ApiError::bad_request("BAD_REQUEST", "logContent is required"));
    }
    let content = req.log_content;
    // 日志可能很大，模式扫描放到阻塞池，避免卡住 HTTP 运行时
    let analysis = tokio::task::spawn_blocking(move || log_analysis::analyze_content(&content))
        .await
        .map_err(|e| ApiError::internal(format!("分析任务失败: {e}")))?;
    Ok(Json(analysis))
}

/// POST /api/loganalysis/analyze-crash/{instanceId}
async fn analyze_crash(
    State(state): State<SharedState>,
    Path(instance_id): Path<String>,
) -> ApiResult<Json<CrashAnalysisResponse>> {
    let crash_report = state
        .launch_tracker
        .get_progress(&instance_id)
        .and_then(|p| p.crash_report)
        .filter(|c| !c.trim().is_empty());
    let Some(crash_report) = crash_report else {
        return Err(ApiError::bad_request(
            "NO_CRASH_REPORT",
            "无可用崩溃报告",
        ));
    };

    let http = state.http_client.clone();
    let analysis_content = crash_report.clone();
    let analysis =
        tokio::task::spawn_blocking(move || log_analysis::analyze_content(&analysis_content))
            .await
            .map_err(|e| ApiError::internal(format!("分析任务失败: {e}")))?;

    // mclo.gs 上传失败不影响本地分析结果
    let mclo_gs_url = upload_to_mclogs(&http, &crash_report).await;

    Ok(Json(CrashAnalysisResponse {
        analysis,
        mclo_gs_url,
        qr_code_base64: None,
    }))
}

/// 上传崩溃报告到 mclo.gs，返回分享链接（对应 C# `CrashUploadService.UploadCrashLogAsync`，
/// 二维码生成暂不实现，前端对 `qrCodeBase64` 为 null 有兜底）。
async fn upload_to_mclogs(client: &reqwest::Client, content: &str) -> Option<String> {
    let form = [
        ("content", content.to_string()),
        ("source", "Qomicex-Launcher".to_string()),
    ];
    let res = client
        .post("https://api.mclo.gs/1/log")
        .form(&form)
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()?;
    res.get("url").and_then(|u| u.as_str()).map(String::from)
}