//! 赞助者鸣谢端点（对应前端「设置 → 关于 → 鸣谢（赞助者）」）。
//!
//! 转发 Qomicex Web 后端 `GET https://api.qomicex.top/api/client/sponsors`
//! （见 Web.Backend `api/src/routes/client/sponsors.ts`）。爱发电的 user_id / api_token
//! 属秘密，**只存在 Web 后端服务器**，启动器本地后端不持有任何凭证——所有用户都能看到
//! 同一份鸣谢列表。
//!
//! 与 announcement.rs 一致：上游失败时回退到 `{BaseDir}/QML/sponsors.json` 缓存，
//! 成功则写回缓存，避免上游抖动导致鸣谢列表消失。

use std::path::PathBuf;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::ApiResult;
use crate::state::SharedState;

const QOMICEX_WEB_BASE_URL: &str = "https://api.qomicex.top";
const SPONSORS_PATH: &str = "/api/client/sponsors";

// =====================================================================
// 对外 DTO（与 Web 后端响应一致，前端直接消费）
// =====================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SponsorDto {
    pub name: String,
    pub avatar: String,
    /// 累计赞助金额（折扣前，含兑换码虚拟值），保留上游字符串原样。
    pub amount: String,
    /// 当前赞助方案名；无方案时为空串。
    pub plan: String,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new().route("/client/sponsors", get(sponsors))
}

// =====================================================================
// Handler
// =====================================================================

async fn sponsors(State(state): State<SharedState>) -> ApiResult<Json<Vec<SponsorDto>>> {
    let url = format!("{}{}", QOMICEX_WEB_BASE_URL, SPONSORS_PATH);
    match fetch_remote(&state.http_client, &url).await {
        Ok(list) => {
            cache_write(&state.data_dir, &list);
            Ok(Json(list))
        }
        Err(_) => Ok(Json(cache_read(&state.data_dir).unwrap_or_default())),
    }
}

async fn fetch_remote(client: &reqwest::Client, url: &str) -> Result<Vec<SponsorDto>, ()> {
    let resp = client.get(url).send().await.map_err(|_| ())?;
    if !resp.status().is_success() {
        return Err(());
    }
    resp.json::<Vec<SponsorDto>>().await.map_err(|_| ())
}

// =====================================================================
// Cache helpers ({BaseDir}/QML/sponsors.json)
// =====================================================================

fn cache_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("QML").join("sponsors.json")
}

fn cache_write(data_dir: &PathBuf, list: &[SponsorDto]) {
    let path = cache_path(data_dir);
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(json) = serde_json::to_vec(list) {
        let _ = std::fs::write(&path, json);
    }
}

fn cache_read(data_dir: &PathBuf) -> Option<Vec<SponsorDto>> {
    let bytes = std::fs::read(cache_path(data_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}
