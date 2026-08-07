//! System/Diagnostics 域 DTO（对应源 JsonContext 中相关 record）。

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub timestamp: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub ok: bool,
    pub latency: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsHealthResponse {
    pub backend: bool,
    pub modrinth: PingResult,
    pub curseforge: PingResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfoResponse {
    pub os: String,
    pub architecture: String,
    pub os_name: String,
    pub os_version: String,
    pub os_version_id: String,
    pub os_display_name: String,
    pub git_commit: String,
    pub memory: i64,
    pub available_memory: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirResponse {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirRequest {
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathResponse {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathRequest {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUrlRequest {
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSourcePing {
    pub id: i32,
    pub name: String,
    pub url: String,
    pub latency: i64,
    pub ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSourcePing {
    pub id: i32,
    pub name: String,
    pub url: String,
    pub ok: bool,
    pub latency: i64,
    pub can_connect: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectResponse {
    pub id: i32,
    pub latency_ms: i64,
}
