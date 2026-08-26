//! Auth endpoints (port of Endpoints/AuthEndpoints.cs).
//!
//! Handles offline / Microsoft (device-code + poll + info + refresh) /
//! Yggdrasil (external auth) / tongyi login, token validation and
//! invalidation. Persists accounts through `state.account` and performs
//! authentication through `state.core.auth()` (qomicex_core AuthProvider),
//! except the two raw Yggdrasil-proxy routes (yggdrasil / tongyi) which call
//! the auth server directly like the C# source does.
//!
//! NOTE ON PREFIX: routes are declared relative to the "/api" nest and start
//! with "/auth/...", producing the public paths /api/auth/... (see app.rs).

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::account::StoredAccount;
use crate::state::SharedState;

const YGGDRASIL_DEFAULT: &str = "https://littleskin.cn/api/yggdrasil";

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/auth/offline", post(offline))
        .route("/auth/microsoft/device-code", post(microsoft_device_code))
        .route("/auth/microsoft/poll", post(microsoft_poll))
        .route("/auth/microsoft/info", post(microsoft_info))
        .route("/auth/microsoft/refresh", post(microsoft_refresh))
        .route("/auth/yggdrasil", post(yggdrasil))
        .route("/auth/yggdrasil/select", post(yggdrasil_select))
        .route("/auth/tongyi", post(tongyi))
        .route("/auth/validate", post(validate))
        .route("/auth/invalidate", post(invalidate))
}

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub username: Option<String>,
    pub password: Option<String>,
    pub access_token: Option<String>,
    pub server_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftInfoRequest {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftRefreshRequest {
    pub account_uuid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YggdrasilSelectRequest {
    pub access_token: String,
    #[serde(default)]
    pub client_token: Option<String>,
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default)]
    pub selected_profiles: Vec<YggdrasilProfileInfo>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YggdrasilProfileInfo {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TongyiLoginRequest {
    pub server_id: String,
    pub email: String,
    pub password: String,
}

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_pending: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrosoftRefreshResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expired: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YggdrasilProfilesResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<YggdrasilProfileInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateResponse {
    pub valid: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    pub message: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/auth/offline
///
/// Offline login does not depend on the (Microsoft-bound) singleton
/// `core.auth()`. It computes the offline UUID directly (MD5 of
/// "OfflinePlayer:{name}", v3, 32-hex no-dash — matching the core
/// OfflineAuthProvider.generate_uuid), then persists the account.
async fn offline(
    State(state): State<SharedState>,
    Json(req): Json<AuthRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let name = req.username.clone().unwrap_or_else(|| "Player".to_string());
    let uuid = offline_uuid(&name);
    let access_token = uuid::Uuid::new_v4().to_string();

    let response = AuthResponse {
        success: true,
        username: Some(name.clone()),
        access_token: Some(access_token.clone()),
        uuid: Some(uuid.clone()),
        user_type: Some("legacy".to_string()),
        error_message: None,
        refresh_token: None,
        device_code: None,
        user_code: None,
        verification_uri: None,
        interval: None,
        expires_in: None,
        is_pending: None,
    };

    // Persist the offline account and make it default when none exists yet.
    let mut account = StoredAccount {
        name,
        uuid: uuid.clone(),
        token: access_token.clone(),
        access_token,
        refresh_token: String::new(),
        login_method: "Offline".to_string(),
        last_used: now_unix(),
        is_default: false,
        server_url: None,
    };
    let _ = state.account.auto_set_default_on_save(&mut account).await;

    Ok(Json(response))
}

/// Offline UUID: MD5("OfflinePlayer:{name}"), version-nibble 3, 32-hex no dash.
/// Matches the core OfflineAuthProvider.generate_uuid output.
fn offline_uuid(name: &str) -> String {
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(format!("OfflinePlayer:{name}"));
    let digest = hasher.finalize();
    let mut hash = [0u8; 16];
    hash.copy_from_slice(digest.as_slice());
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    let mut s = String::with_capacity(32);
    use std::fmt::Write as _;
    for b in hash {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// POST /api/auth/microsoft/device-code
async fn microsoft_device_code(State(state): State<SharedState>) -> ApiResult<Json<AuthResponse>> {
    let device = state
        .core
        .auth()
        .start_device_code()
        .await
        .map_err(map_core_err)?
        .ok_or_else(|| {
            ApiError::bad_request(
                "NOT_SUPPORTED",
                "Device code flow not supported by current auth provider",
            )
        })?;
    Ok(Json(AuthResponse {
        success: true,
        username: None,
        access_token: None,
        uuid: None,
        user_type: Some("microsoft".to_string()),
        error_message: None,
        refresh_token: None,
        device_code: Some(device.device_code),
        user_code: Some(device.user_code),
        verification_uri: Some(device.verification_uri),
        interval: Some(device.interval),
        expires_in: Some(device.expires_in),
        is_pending: None,
    }))
}

/// POST /api/auth/microsoft/poll
async fn microsoft_poll(
    State(state): State<SharedState>,
    Json(req): Json<AuthRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let device_code = req.access_token.as_deref().unwrap_or("");
    if device_code.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_PARAMETER",
            "deviceCode is required",
        ));
    }
    let poll = state
        .core
        .auth()
        .poll_for_token(device_code)
        .await
        .map_err(map_core_err)?
        .ok_or_else(|| {
            ApiError::bad_request(
                "NOT_SUPPORTED",
                "Polling not supported by current auth provider",
            )
        })?;

    if poll.is_completed {
        if let Some(access_token) = poll.access_token.as_deref() {
            let refresh = poll.refresh_token.as_deref().unwrap_or("");
            let auth = state
                .core
                .auth()
                .complete_login(access_token, refresh)
                .await
                .map_err(map_core_err)?;
            return Ok(Json(AuthResponse {
                success: auth.success,
                username: auth.username,
                access_token: auth.access_token,
                uuid: auth.uuid,
                user_type: auth
                    .user_type
                    .clone()
                    .or_else(|| Some("microsoft".to_string())),
                error_message: auth.error_message,
                refresh_token: auth.refresh_token,
                device_code: None,
                user_code: None,
                verification_uri: None,
                interval: None,
                expires_in: None,
                is_pending: None,
            }));
        }
    }
    Ok(Json(AuthResponse {
        success: false,
        username: None,
        access_token: None,
        uuid: None,
        user_type: Some("microsoft".to_string()),
        error_message: poll.error,
        refresh_token: None,
        device_code: None,
        user_code: None,
        verification_uri: None,
        interval: None,
        expires_in: None,
        is_pending: Some(poll.is_pending),
    }))
}

/// POST /api/auth/microsoft/info
async fn microsoft_info(
    State(state): State<SharedState>,
    Json(req): Json<MicrosoftInfoRequest>,
) -> ApiResult<Json<StoredAccount>> {
    let resp = state
        .http_client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&req.access_token)
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(ApiError::bad_request(
            "NO_MINECRAFT_PROFILE",
            "This Microsoft account has no linked Minecraft profile",
        ));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let doc: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| ApiError::internal(e.to_string()))?;
    let uuid = doc.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if uuid.is_empty() {
        return Err(ApiError::bad_request(
            "NO_MINECRAFT_PROFILE",
            "This Microsoft account has no linked Minecraft profile",
        ));
    }
    let mut stored = StoredAccount {
        name: doc
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        uuid: uuid.to_string(),
        token: req.access_token.clone(),
        access_token: req.access_token,
        refresh_token: req.refresh_token.clone().unwrap_or_default(),
        login_method: "Microsoft".to_string(),
        last_used: 0,
        is_default: false,
        server_url: None,
    };
    state.account.save_account(&mut stored).await?;
    Ok(Json(stored))
}

/// POST /api/auth/microsoft/refresh
async fn microsoft_refresh(
    State(state): State<SharedState>,
    Json(req): Json<MicrosoftRefreshRequest>,
) -> ApiResult<Json<MicrosoftRefreshResponse>> {
    let mut account = state
        .account
        .get_account(&req.account_uuid)
        .await?
        .ok_or_else(|| ApiError::not_found("ACCOUNT_NOT_FOUND", "Account not found"))?;
    if account.login_method != "Microsoft" {
        return Err(ApiError::bad_request(
            "INVALID_ACCOUNT_TYPE",
            "Not a Microsoft account",
        ));
    }
    if account.refresh_token.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_REFRESH_TOKEN",
            "Missing refresh token",
        ));
    }

    let result = state
        .core
        .auth()
        .refresh_login(&account.refresh_token.clone())
        .await
        .map_err(map_core_err)?;
    if !result.success {
        return Ok(Json(MicrosoftRefreshResponse {
            success: false,
            expired: Some(true),
            error_code: Some("TOKEN_EXPIRED".to_string()),
        }));
    }
    if let Some(t) = result.access_token {
        account.access_token = t;
    }
    if let Some(t) = result.refresh_token {
        account.refresh_token = t;
    }
    if let Some(name) = result.username {
        account.name = name;
    }
    // 不覆盖 uuid：refresh 返回的 uuid 是微软 XUID，与启动器用作账户稳定标识的
    // Minecraft profile UUID 不一致；覆盖会污染账户标识，使重新登录/刷新修不好该账户。
    state.account.save_account(&mut account).await?;
    Ok(Json(MicrosoftRefreshResponse {
        success: true,
        expired: None,
        error_code: None,
    }))
}

/// POST /api/auth/yggdrasil
async fn yggdrasil(
    State(state): State<SharedState>,
    Json(req): Json<AuthRequest>,
) -> ApiResult<Json<YggdrasilProfilesResponse>> {
    let base_url = req
        .server_url
        .clone()
        .unwrap_or_else(|| YGGDRASIL_DEFAULT.to_string());
    let base_url = base_url.trim_end_matches('/');

    let payload = serde_json::json!({
        "agent": { "name": "Minecraft", "version": 1 },
        "username": req.username,
        "password": req.password,
        "clientToken": uuid_v4_nodash(),
        "requestUser": true
    });
    let url = format!("{base_url}/authserver/authenticate");
    let resp = state
        .http_client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let doc: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    if !status.is_success() {
        let err_msg = doc
            .get("errorMessage")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Authentication failed: {}", status.as_u16()));
        return Ok(Json(YggdrasilProfilesResponse {
            success: false,
            access_token: None,
            client_token: None,
            profiles: None,
            error_message: Some(err_msg),
        }));
    }

    let access_token = doc
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let client_token = doc
        .get("clientToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut profiles = Vec::new();
    if let Some(arr) = doc.get("availableProfiles").and_then(|v| v.as_array()) {
        for p in arr {
            let id = p
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = p
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            profiles.push(YggdrasilProfileInfo { id, name });
        }
    }

    Ok(Json(YggdrasilProfilesResponse {
        success: true,
        access_token: Some(access_token),
        client_token: Some(client_token),
        profiles: if profiles.is_empty() {
            None
        } else {
            Some(profiles)
        },
        error_message: None,
    }))
}

/// POST /api/auth/yggdrasil/select
async fn yggdrasil_select(
    State(state): State<SharedState>,
    Json(req): Json<YggdrasilSelectRequest>,
) -> ApiResult<Json<Vec<StoredAccount>>> {
    let mut saved = Vec::with_capacity(req.selected_profiles.len());
    for p in &req.selected_profiles {
        let mut stored = StoredAccount {
            name: p.name.clone(),
            uuid: p.id.clone(),
            token: req.access_token.clone(),
            access_token: req.access_token.clone(),
            refresh_token: req.client_token.clone().unwrap_or_default(),
            login_method: "Yggdrasil".to_string(),
            last_used: 0,
            is_default: false,
            server_url: req.server_url.clone(),
        };
        state.account.save_account(&mut stored).await?;
        saved.push(stored);
    }
    Ok(Json(saved))
}

/// POST /api/auth/tongyi
async fn tongyi(
    State(state): State<SharedState>,
    Json(req): Json<TongyiLoginRequest>,
) -> ApiResult<Json<StoredAccount>> {
    let server_url = format!("https://auth.mc-user.com:233/{}/", req.server_id);

    let payload = serde_json::json!({
        "agent": { "name": "Minecraft", "version": 1 },
        "username": req.email,
        "password": req.password,
        "clientToken": uuid_v4_nodash(),
        "requestUser": true
    });
    let url = format!("{server_url}authserver/authenticate");
    let resp = state
        .http_client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let doc: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    // Unlike the yggdrasil endpoint, tongyi fails the whole request when auth fails.
    if !status.is_success() {
        let err_msg = doc
            .get("errorMessage")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                status
                    .canonical_reason()
                    .map(|r| format!("Authentication failed: {r}"))
            })
            .unwrap_or_else(|| format!("Authentication failed: {}", status.as_u16()));
        return Err(ApiError::bad_request("AUTH_FAILED", err_msg));
    }

    let access_token = doc
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let client_token = doc
        .get("clientToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let first_profile = doc
        .get("availableProfiles")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| {
            let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() || name.is_empty() {
                None
            } else {
                Some((id, name))
            }
        });
    let Some((uuid, name)) = first_profile else {
        return Err(ApiError::bad_request(
            "AUTH_FAILED",
            "Authentication failed: no profile",
        ));
    };

    let mut stored = StoredAccount {
        name: name.to_string(),
        uuid: uuid.to_string(),
        token: access_token.clone(),
        access_token,
        refresh_token: client_token,
        login_method: "统一通行证".to_string(),
        last_used: 0,
        is_default: false,
        server_url: Some(server_url),
    };
    state.account.save_account(&mut stored).await?;
    Ok(Json(stored))
}

/// POST /api/auth/validate
async fn validate(
    State(state): State<SharedState>,
    Json(req): Json<AuthRequest>,
) -> ApiResult<Json<ValidateResponse>> {
    let token = req.access_token.as_deref().unwrap_or("");
    if token.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_PARAMETER",
            "accessToken is required",
        ));
    }
    let valid = state
        .core
        .auth()
        .validate(token)
        .await
        .map_err(map_core_err)?;
    Ok(Json(ValidateResponse { valid }))
}

/// POST /api/auth/invalidate
async fn invalidate(
    State(state): State<SharedState>,
    Json(req): Json<AuthRequest>,
) -> ApiResult<Json<MessageResponse>> {
    let token = req.access_token.as_deref().unwrap_or("");
    if token.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_PARAMETER",
            "accessToken is required",
        ));
    }
    state
        .core
        .auth()
        .invalidate(token)
        .await
        .map_err(map_core_err)?;
    Ok(Json(MessageResponse {
        message: "Token invalidated".to_string(),
    }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Map a qomicex_core Error into an ApiError (C#: unhandled -> 500).
fn map_core_err(e: qomicex_core::error::Error) -> ApiError {
    ApiError::internal(e.to_string())
}

/// Guid.NewGuid().ToString("N") equivalent (lowercase hex, no dashes).
fn uuid_v4_nodash() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}
