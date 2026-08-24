//! Plugin Store endpoints（Issue #27，代理 plugins.qomicex.top/api/v1）。
//!
//! 全部路由挂在 `/api/store` 下：
//!   GET  /store/plugins                     市场列表（透传）
//!   GET  /store/plugins/{slug}              详情含 versions
//!   GET  /store/plugins/{slug}/reviews      评价列表（只读）
//!   POST /store/check-updates               launcherVersion 由后端注入
//!   GET  /store/download-info/{slug}        双通道下载信息
//!   POST /store/install                     下载+SHA256 校验+本地安装管线
//!   POST /store/auth/login|register|logout|refresh
//!   GET  /store/auth/me                     未登录返回 {user:null}
//!   GET  /store/mine                        🔒 我参与的插件

use axum::extract::{Path as AxumPath, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::services::plugin_store::{self, StoreListQuery};
use crate::state::SharedState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewsQuery {
    #[serde(default)]
    page: i64,
    #[serde(default)]
    page_size: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckUpdatesRequest {
    #[serde(default)]
    installed: Vec<plugin_store::InstalledEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadInfoQuery {
    #[serde(default)]
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRequest {
    slug: String,
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    account: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest {
    username: String,
    email: String,
    password: String,
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/store/plugins", get(list_plugins))
        .route("/store/plugins/{slug}", get(plugin_detail))
        .route("/store/plugins/{slug}/reviews", get(plugin_reviews))
        .route("/store/check-updates", post(check_updates))
        .route("/store/download-info/{slug}", get(download_info))
        .route("/store/install", post(install))
        .route("/store/auth/login", post(login))
        .route("/store/auth/register", post(register))
        .route("/store/auth/logout", post(logout))
        .route("/store/auth/refresh", post(refresh_session))
        .route("/store/auth/device/code", post(device_code))
        .route("/store/auth/device/token", post(device_token))
        .route("/store/auth/me", get(me))
        .route("/store/mine", get(my_plugins))
}

async fn list_plugins(
    State(state): State<SharedState>,
    Query(q): Query<StoreListQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(
        plugin_store::list_plugins(&state.http_client, &q).await?,
    ))
}

async fn plugin_detail(
    State(state): State<SharedState>,
    AxumPath(slug): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(
        plugin_store::plugin_detail(&state.http_client, &slug).await?,
    ))
}

async fn plugin_reviews(
    State(state): State<SharedState>,
    AxumPath(slug): AxumPath<String>,
    Query(q): Query<ReviewsQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(
        plugin_store::plugin_reviews(&state.http_client, &slug, q.page, q.page_size.unwrap_or(20))
            .await?,
    ))
}

async fn check_updates(
    State(state): State<SharedState>,
    Json(req): Json<CheckUpdatesRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(
        plugin_store::check_updates(&state.http_client, req.installed).await?,
    ))
}

async fn download_info(
    State(state): State<SharedState>,
    AxumPath(slug): AxumPath<String>,
    Query(q): Query<DownloadInfoQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let info = plugin_store::download_info(
        &state.http_client,
        &slug,
        q.version.as_deref().unwrap_or("latest"),
    )
    .await?;
    Ok(Json(serde_json::to_value(&info).unwrap_or_default()))
}

async fn install(
    State(state): State<SharedState>,
    Json(req): Json<InstallRequest>,
) -> ApiResult<Json<crate::services::plugin::PluginInfo>> {
    if req.slug.trim().is_empty() {
        return Err(ApiError::bad_request(
            "STORE_SLUG_REQUIRED",
            "slug 不能为空",
        ));
    }
    let info =
        plugin_store::install(&state.http_client, req.slug.trim(), req.version.as_deref()).await?;
    // 安装落盘后失效插件列表缓存，确保后续 /api/plugins 立即可见新插件。
    state.plugin_store.invalidate_cache();
    Ok(Json(info))
}

async fn login(
    State(state): State<SharedState>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if req.account.trim().is_empty() || req.password.is_empty() {
        return Err(ApiError::bad_request(
            "STORE_CREDENTIALS_REQUIRED",
            "账号与密码不能为空",
        ));
    }
    Ok(Json(
        plugin_store::login(&state.http_client, req.account.trim(), &req.password).await?,
    ))
}

async fn register(
    State(state): State<SharedState>,
    Json(req): Json<RegisterRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if req.username.trim().is_empty() || req.email.trim().is_empty() || req.password.is_empty() {
        return Err(ApiError::bad_request(
            "STORE_REGISTER_FIELDS_REQUIRED",
            "用户名、邮箱与密码不能为空",
        ));
    }
    Ok(Json(
        plugin_store::register(
            &state.http_client,
            req.username.trim(),
            req.email.trim(),
            &req.password,
        )
        .await?,
    ))
}

async fn logout() -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(plugin_store::logout().await?))
}

async fn refresh_session(State(state): State<SharedState>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(
        plugin_store::refresh_session(&state.http_client).await?,
    ))
}

async fn device_code(State(state): State<SharedState>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(plugin_store::device_code(&state.http_client).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceTokenRequest {
    device_code: String,
}

async fn device_token(
    State(state): State<SharedState>,
    Json(req): Json<DeviceTokenRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if req.device_code.trim().is_empty() {
        return Err(ApiError::bad_request(
            "STORE_DEVICE_CODE_REQUIRED",
            "deviceCode 不能为空",
        ));
    }
    Ok(Json(
        plugin_store::device_token(&state.http_client, req.device_code.trim()).await?,
    ))
}

async fn me(State(state): State<SharedState>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(plugin_store::me(&state.http_client).await?))
}

async fn my_plugins(State(state): State<SharedState>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(plugin_store::my_plugins(&state.http_client).await?))
}
