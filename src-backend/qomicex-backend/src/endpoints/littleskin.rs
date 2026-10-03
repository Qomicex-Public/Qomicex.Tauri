//! LittleSkin OAuth 设备代码流登录（issue #145，决策见 ADR-098）。
//!
//! LittleSkin 支持通过 OAuth（Yggdrasil Connect）获取访问 Yggdrasil API 的
//! Minecraft 令牌，从而避免把账号密码交给启动器。本模块实现设备代码流
//! （Device Authorization Grant，RFC 8628）：
//!
//! - `POST /api/auth/littleskin/device-code` 请求设备代码对（user_code + device_code）
//! - `POST /api/auth/littleskin/poll` 轮询授权结果，成功后取 OAuth 令牌并拉角色列表
//! - `POST /api/auth/littleskin/select` 用 OAuth 令牌为每个选中角色换取 Minecraft 令牌并落库
//!
//! 为什么用设备代码流而不是授权代码流：LittleSkin 官方尚未支持 PKCE，授权代码流
//! 必须内嵌 `client_secret`，而启动器是分发给用户的二进制，secret 无法保密。设备流
//! 属 RFC 8628 公共客户端，token 端点请求体只有 `grant_type` + `client_id` +
//! `device_code`，不需要 secret；`client_id` 依 RFC 6749 §2.2 本就是公开值。
//!
//! 官方要求应用把回调 URL 设为 `https://open.littleskin.cn/oauth/callback`（指向
//! LittleSkin 自家授权落地页），该值**不出现在客户端代码中**——设备流没有任何
//! redirect 环节。
//!
//! ⚠️ 上游前置：应用必须事先申请「设备代码流白名单」，否则 `device_code` 端点返回
//! `400 invalid_client`。此情况映射为 `LITTLESKIN_OAUTH_NOT_WHITELISTED` 供前端提示。

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::endpoints::auth::YggdrasilProfileInfo;
use crate::error::{ApiError, ApiResult};
use crate::services::account::StoredAccount;
use crate::state::SharedState;

/// OAuth 端点根（OpenID 提供者）。
const LITTLESKIN_OAUTH_BASE: &str = "https://open.littleskin.cn";
/// Yggdrasil API 根（会话/令牌端点所在）。
const LITTLESKIN_API_ROOT: &str = "https://littleskin.cn/api/yggdrasil";
/// 失败时回退的轮询间隔（秒），仅在响应缺少 `interval` 时使用。
const DEFAULT_INTERVAL: u64 = 5;

/// 单次请求允许选中的角色数上限（防御性上限，见 `select` 处理器）。
const MAX_SELECTED_PROFILES: usize = 64;

/// LittleSkin 为 Qomicex Launcher 分配的客户端 ID（issue #145 工单）。
///
/// 依 RFC 6749 §2.2 这是**公开值**（会出现在浏览器授权 URL 里），可入库；对齐
/// `auth.rs` 中 `const YGGDRASIL_DEFAULT` 的既有做法。可用 `LITTLESKIN_CLIENT_ID`
/// 环境变量覆盖（便于换用测试应用或本地联调）。
const LITTLESKIN_CLIENT_ID: &str = "1580";

/// 申请的权限范围。
///
/// - `openid`：OIDC 必需（也用于换取 ID 令牌，本实现不消费它）
/// - `offline_access`：必需，否则不发 `refresh_token`，自动续期无从谈起
/// - `Yggdrasil.PlayerProfiles.Read`：读用户名下全部角色 → 启动器内做角色多选
/// - `Yggdrasil.MinecraftToken.Create`：换取 Minecraft 令牌
/// - `Yggdrasil.Server.Join`：必需，否则会话服务器拒绝该令牌进服
///
/// ⚠️ 不要加 `Yggdrasil.PlayerProfiles.Select`：它与 `.Read` 互斥，同时申请设备流
/// 直接返回 `invalid_scope`。
pub(crate) const LITTLESKIN_SCOPE: &str = "openid offline_access \
     Yggdrasil.PlayerProfiles.Read Yggdrasil.MinecraftToken.Create Yggdrasil.Server.Join";

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/auth/littleskin/device-code", post(device_code))
        .route("/auth/littleskin/poll", post(poll))
        .route("/auth/littleskin/select", post(select))
}

// ---------------------------------------------------------------------------
// Request / Response DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LittleSkinDeviceCodeResponse {
    pub user_code: String,
    pub device_code: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LittleSkinPollRequest {
    pub device_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LittleSkinPollResponse {
    /// 授权完成且令牌与角色列表均已就绪时为 true。
    pub success: bool,
    /// 用户尚未完成授权（`authorization_pending` / `slow_down`）。
    pub is_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<YggdrasilProfileInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 轮询间隔（秒）；`slow_down` 时前端应采用返回的新值。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LittleSkinSelectRequest {
    /// OAuth 访问令牌（用于换取 Minecraft 令牌）。
    pub access_token: String,
    /// OAuth 刷新令牌（`offline_access`）；用于启动前自动续期。
    #[serde(default)]
    pub refresh_token: Option<String>,
    pub server_url: String,
    pub selected_profiles: Vec<YggdrasilProfileInfo>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/auth/littleskin/device-code
async fn device_code(
    State(state): State<SharedState>,
) -> ApiResult<Json<LittleSkinDeviceCodeResponse>> {
    let client_id = resolve_client_id();
    let url = format!("{LITTLESKIN_OAUTH_BASE}/oauth/device_code");

    let resp = state
        .http_client
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", LITTLESKIN_SCOPE),
        ])
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
        return Err(oauth_error(&doc, status, "获取设备代码失败"));
    }

    let user_code = json_str(&doc, "user_code")
        .ok_or_else(|| ApiError::upstream("LittleSkin 响应缺少 user_code"))?;
    let device_code = json_str(&doc, "device_code")
        .ok_or_else(|| ApiError::upstream("LittleSkin 响应缺少 device_code"))?;
    let verification_uri = json_str(&doc, "verification_uri")
        .ok_or_else(|| ApiError::upstream("LittleSkin 响应缺少 verification_uri"))?;

    Ok(Json(LittleSkinDeviceCodeResponse {
        user_code,
        device_code,
        verification_uri,
        verification_uri_complete: json_str(&doc, "verification_uri_complete"),
        expires_in: json_u64(&doc, "expires_in").unwrap_or(300),
        interval: json_u64(&doc, "interval").unwrap_or(DEFAULT_INTERVAL),
    }))
}

/// POST /api/auth/littleskin/poll
///
/// 轮询授权结果。授权完成后取回 OAuth 令牌，并立即用该令牌拉取用户名下的
/// 角色列表，一并返回给前端做角色多选。
async fn poll(
    State(state): State<SharedState>,
    Json(req): Json<LittleSkinPollRequest>,
) -> ApiResult<Json<LittleSkinPollResponse>> {
    if req.device_code.trim().is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_PARAMETER",
            "deviceCode is required",
        ));
    }
    let client_id = resolve_client_id();
    let url = format!("{LITTLESKIN_OAUTH_BASE}/oauth/token");

    let resp = state
        .http_client
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id.as_str()),
            ("device_code", req.device_code.as_str()),
        ])
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
        let err = json_str(&doc, "error").unwrap_or_default();
        // 用户尚未完成授权（或轮询过快）都不是错误，继续轮询。
        if err == "authorization_pending" || err == "slow_down" {
            return Ok(Json(LittleSkinPollResponse {
                success: false,
                is_pending: true,
                access_token: None,
                refresh_token: None,
                profiles: None,
                error_message: None,
                interval: json_u64(&doc, "interval"),
            }));
        }
        return Err(oauth_error(&doc, status, "授权失败"));
    }

    let access_token = json_str(&doc, "access_token")
        .ok_or_else(|| ApiError::upstream("LittleSkin 响应缺少 access_token"))?;
    let refresh_token = json_str(&doc, "refresh_token");

    // 拉角色列表：失败即整体失败，避免前端拿到令牌却无从选角色。
    let profiles = fetch_profiles(&state, &access_token).await?;

    Ok(Json(LittleSkinPollResponse {
        success: true,
        is_pending: false,
        access_token: Some(access_token),
        refresh_token,
        profiles: Some(profiles),
        error_message: None,
        interval: None,
    }))
}

/// POST /api/auth/littleskin/select
///
/// 为每个选中角色换取 Minecraft 令牌并落库。
///
/// 账户沿用 `login_method = "Yggdrasil"`（不新增枚举值），额外记录
/// `oauth_provider` / `oauth_refresh_token`。这样 `resolve_auth_options`（启动）、
/// `skin.rs`（皮肤/披风）与 `connector.rs`（联机）的既有 Yggdrasil 分支全部零改动。
async fn select(
    State(state): State<SharedState>,
    Json(req): Json<LittleSkinSelectRequest>,
) -> ApiResult<Json<Vec<StoredAccount>>> {
    // 本端点会用 OAuth 令牌向固定上游换取 Minecraft 令牌；校验服务器地址，
    // 避免把 LittleSkin 的 OAuth 令牌误发给其它站点。
    if !is_littleskin_host(&req.server_url) {
        return Err(ApiError::bad_request(
            "LITTLESKIN_ONLY",
            "LittleSkin OAuth login only supports littleskin.cn",
        ));
    }
    if req.selected_profiles.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_PARAMETER",
            "selectedProfiles is required",
        ));
    }
    // 上限防御：请求体来自前端，但按其长度预分配会被超大数组放大成内存压力
    // （CodeQL rust/uncontrolled-allocation-size）。正常账号远达不到该数量。
    if req.selected_profiles.len() > MAX_SELECTED_PROFILES {
        return Err(ApiError::bad_request(
            "TOO_MANY_PROFILES",
            format!("selectedProfiles exceeds the limit of {MAX_SELECTED_PROFILES}"),
        ));
    }

    // 不用 `with_capacity(req.selected_profiles.len())`：CodeQL 会把「以请求体长度
    // 预分配」判定为 rust/uncontrolled-allocation-size（其数据流不认可上面的 guard）。
    // 空 Vec 按需增长，实际容量由通过校验的条目数（≤ MAX_SELECTED_PROFILES）决定。
    let mut saved = Vec::new();

    for profile in &req.selected_profiles {
        let mc = create_minecraft_token(&state.http_client, &req.access_token, &profile.id).await?;
        let refresh = mc.client_token().map(str::to_string);
        let mut stored = StoredAccount {
            name: mc
                .selected_profile
                .as_ref()
                .map(|p| p.name.clone())
                .unwrap_or_else(|| profile.name.clone()),
            uuid: mc
                .selected_profile
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(|| profile.id.clone()),
            // 与既有 Yggdrasil 账户保持一致：token 即访问令牌，
            // refresh_token 字段沿用 clientToken（core 桌面链路据此组装 AuthOptions）。
            token: mc.access_token().unwrap_or_default().to_string(),
            access_token: mc.access_token().unwrap_or_default().to_string(),
            refresh_token: refresh.unwrap_or_default(),
            login_method: "Yggdrasil".to_string(),
            last_used: 0,
            is_default: false,
            server_url: Some(normalize_littleskin_root(&req.server_url)),
            oauth_provider: Some("LittleSkin".to_string()),
            oauth_refresh_token: req.refresh_token.clone(),
        };
        state.account.save_account(&mut stored).await?;
        saved.push(stored.redacted());
    }

    Ok(Json(saved))
}

// ---------------------------------------------------------------------------
// Upstream helpers
// ---------------------------------------------------------------------------

/// 用 OAuth 令牌拉取用户名下全部 Yggdrasil 档案（需 `Yggdrasil.PlayerProfiles.Read`）。
async fn fetch_profiles(
    state: &SharedState,
    oauth_token: &str,
) -> ApiResult<Vec<YggdrasilProfileInfo>> {
    let url = format!("{LITTLESKIN_API_ROOT}/sessionserver/session/minecraft/profile");
    let resp = state
        .http_client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(oauth_token)
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
        return Err(ApiError::bad_request(
            "LITTLESKIN_PROFILES_FAILED",
            format!("获取角色列表失败: {}", error_message(&doc, status)),
        ));
    }

    let profiles = doc
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let id = p.get("id").and_then(|v| v.as_str())?;
                    let name = p.get("name").and_then(|v| v.as_str())?;
                    Some(YggdrasilProfileInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if profiles.is_empty() {
        return Err(ApiError::bad_request(
            "LITTLESKIN_NO_PROFILE",
            "该 LittleSkin 账号下没有可用角色",
        ));
    }
    Ok(profiles)
}

/// Yggdrasil 令牌响应（`/authserver/oauth` 与登录 API 同构，只取所需字段）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MinecraftTokenResponse {
    access_token: Option<String>,
    client_token: Option<String>,
    selected_profile: Option<YggdrasilProfileInfo>,
}

impl MinecraftTokenResponse {
    /// 取 Minecraft 访问令牌（即 Yggdrasil accessToken）。
    pub(crate) fn access_token(&self) -> Option<&str> {
        self.access_token.as_deref()
    }
    /// 取 clientToken。
    pub(crate) fn client_token(&self) -> Option<&str> {
        self.client_token.as_deref()
    }
    /// 取服务端回选的角色名（用于把账户名同步为最新值）。
    pub(crate) fn selected_profile_name(&self) -> Option<String> {
        self.selected_profile.as_ref().map(|p| p.name.clone())
    }
}

/// 用 OAuth 刷新令牌换新的 OAuth 访问令牌（供启动前自动续期使用）。
///
/// 返回 `(access_token, refresh_token)`；后者在新令牌未随响应下发时沿用旧值。
///
/// ⚠️ LittleSkin 的刷新令牌**一次性且轮换**：刷新成功后旧令牌立即失效，
/// 因此调用方必须串行化「读取 → 刷新 → 落库」，否则并发刷新会用旧值覆盖
/// 已轮换的新值，导致该账户永久无法续期。
///
/// ⚠️ 本函数**不使用共享 HTTP 客户端**：共享客户端沿用 reqwest 默认重定向策略
/// （最多 10 跳），且用户开启「忽略 SSL 证书」时会接受无效证书。`refresh_token`
/// 位于表单体中，307/308 重定向会重放请求体，而 reqwest 只在跨主机/端口时剥离
/// Authorization 等敏感**头**——不保护请求体。故此处用专用客户端：不跟随重定向
/// （端点地址固定且官方文档未定义重定向语义）+ 始终校验证书。
pub(crate) async fn refresh_oauth_token(
    refresh_token: &str,
) -> ApiResult<(String, Option<String>)> {
    let client = oauth_refresh_client()?;
    let client_id = resolve_client_id();
    let url = format!("{LITTLESKIN_OAUTH_BASE}/oauth/token");

    let resp = client
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "NETWORK_ERROR",
                format!("无法连接 LittleSkin 认证服务，请检查网络：{e}"),
            )
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let doc: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    if !status.is_success() {
        // invalid_grant / invalid_client：刷新令牌已失效 → 401 触发前端重登引导。
        let err = json_str(&doc, "error").unwrap_or_default();
        let desc = error_message(&doc, status);
        if err == "invalid_grant" || err == "invalid_client" || err == "expired_token" {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "TOKEN_EXPIRED",
                format!("LittleSkin 授权已失效，请重新登录（{desc}）"),
            ));
        }
        return Err(ApiError::bad_request("LITTLESKIN_REFRESH_FAILED", desc));
    }

    let access_token = json_str(&doc, "access_token")
        .ok_or_else(|| ApiError::upstream("LittleSkin 刷新响应缺少 access_token"))?;
    Ok((access_token, json_str(&doc, "refresh_token")))
}

/// 承载 OAuth 刷新令牌的专用 HTTP 客户端（见 [`refresh_oauth_token`] 的说明）：
/// **不跟随重定向**，且**不因用户设置而放宽证书校验**。
fn oauth_refresh_client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(crate::state::USER_AGENT)
        .build()
        .map_err(|e| ApiError::internal(format!("构建 OAuth 客户端失败: {e}")))
}

/// 用 OAuth 令牌换取某个角色的 Minecraft 令牌（需 `Yggdrasil.MinecraftToken.Create`）。
///
/// `POST {api}/authserver/oauth` body `{"uuid": "..."}`；响应与 Yggdrasil 登录 API
/// 同构，因此可以直接复用现有解析形状。
pub(crate) async fn create_minecraft_token(
    client: &reqwest::Client,
    oauth_token: &str,
    uuid: &str,
) -> ApiResult<MinecraftTokenResponse> {
    let url = format!("{LITTLESKIN_API_ROOT}/authserver/oauth");
    let resp = client
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(oauth_token)
        .json(&serde_json::json!({ "uuid": uuid }))
        .send()
        .await
        .map_err(|e| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "NETWORK_ERROR",
                format!("无法连接 LittleSkin 服务，请检查网络：{e}"),
            )
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let doc: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    if !status.is_success() {
        let msg = error_message(&doc, status);
        // 令牌失效（过期/被吊销）→ 引导重新登录，与微软链路同语义。
        if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "TOKEN_EXPIRED",
                format!("LittleSkin 授权已失效，请重新登录（{msg}）"),
            ));
        }
        return Err(ApiError::bad_request("LITTLESKIN_TOKEN_FAILED", msg));
    }

    let parsed: MinecraftTokenResponse = serde_json::from_value(doc)
        .map_err(|e| ApiError::upstream(format!("解析 Minecraft 令牌响应失败: {e}")))?;
    if parsed.access_token().unwrap_or("").is_empty() {
        return Err(ApiError::upstream("LittleSkin 响应缺少 accessToken"));
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// 解析生效的客户端 ID：`LITTLESKIN_CLIENT_ID` 环境变量优先，否则用内置值。
fn resolve_client_id() -> String {
    std::env::var("LITTLESKIN_CLIENT_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| LITTLESKIN_CLIENT_ID.to_string())
}

/// 把任意 LittleSkin 地址归一为规范的 API 根（authlib-injector 规范要求启动器
/// 存储 API 根地址）。已是 `/api/yggdrasil` 结尾时原样保留。
fn normalize_littleskin_root(server_url: &str) -> String {
    let trimmed = server_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return LITTLESKIN_API_ROOT.to_string();
    }
    if trimmed.ends_with("/api/yggdrasil") {
        return trimmed.to_string();
    }
    // 形如 https://littleskin.cn 或 https://littleskin.cn/xxx
    match url::Url::parse(trimmed) {
        Ok(u) if u.host_str().is_some() => format!(
            "{}://{}{}",
            u.scheme(),
            u.host_str().unwrap_or_default(),
            "/api/yggdrasil"
        ),
        _ => trimmed.to_string(),
    }
}

/// 服务器地址是否指向 LittleSkin（含子域）。
pub(crate) fn is_littleskin_host(server_url: &str) -> bool {
    let candidate = server_url.trim();
    if candidate.is_empty() {
        return false;
    }
    let with_scheme = if candidate.contains("://") {
        candidate.to_string()
    } else {
        format!("https://{candidate}")
    };
    url::Url::parse(&with_scheme)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .map(|h| h == "littleskin.cn" || h.ends_with(".littleskin.cn"))
        .unwrap_or(false)
}

fn json_str(doc: &serde_json::Value, key: &str) -> Option<String> {
    doc.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// 读数字字段，兼容上游把数字序列化为字符串的情况。
fn json_u64(doc: &serde_json::Value, key: &str) -> Option<u64> {
    doc.get(key).and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

/// 从 OAuth 错误响应中取出可读描述（`error_description` 优先，其次 `errorMessage`）。
fn error_message(doc: &serde_json::Value, status: StatusCode) -> String {
    json_str(doc, "error_description")
        .or_else(|| json_str(doc, "errorMessage"))
        .or_else(|| json_str(doc, "message"))
        .or_else(|| json_str(doc, "error"))
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
}

/// 把 OAuth 错误映射为带语义 code 的 ApiError（映射表见方案文档 §6）。
fn oauth_error(doc: &serde_json::Value, status: StatusCode, fallback: &str) -> ApiError {
    let err = json_str(doc, "error").unwrap_or_default();
    let desc = error_message(doc, status);
    match err.as_str() {
        // 白名单未申请/未通过：给出可操作的指引，而不是干巴巴的上游错误。
        "invalid_client" => ApiError::bad_request(
            "LITTLESKIN_OAUTH_NOT_WHITELISTED",
            format!("LittleSkin OAuth 应用未通过设备代码流白名单：{desc}"),
        ),
        "expired_token" => ApiError::bad_request(
            "LITTLESKIN_DEVICE_CODE_EXPIRED",
            format!("验证码已过期，请重新登录：{desc}"),
        ),
        "access_denied" => {
            ApiError::bad_request("LITTLESKIN_ACCESS_DENIED", format!("授权被拒绝：{desc}"))
        }
        "invalid_scope" => ApiError::bad_request(
            "LITTLESKIN_INVALID_SCOPE",
            format!("申请的权限范围无效：{desc}"),
        ),
        "invalid_grant" => ApiError::new(
            StatusCode::UNAUTHORIZED,
            "TOKEN_EXPIRED",
            format!("LittleSkin 授权已失效，请重新登录（{desc}）"),
        ),
        _ => ApiError::bad_request("LITTLESKIN_OAUTH_ERROR", format!("{fallback}：{desc}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_excludes_mutually_exclusive_select() {
        // Read 与 Select 互斥：同时申请会被 LittleSkin 以 invalid_scope 拒绝。
        assert!(LITTLESKIN_SCOPE.contains("Yggdrasil.PlayerProfiles.Read"));
        assert!(!LITTLESKIN_SCOPE.contains("Yggdrasil.PlayerProfiles.Select"));
        // Join 缺失会导致能登录但进不了服务器。
        assert!(LITTLESKIN_SCOPE.contains("Yggdrasil.Server.Join"));
        // offline_access 是拿到 refresh_token（自动续期）的前提。
        assert!(LITTLESKIN_SCOPE.contains("offline_access"));
        assert!(LITTLESKIN_SCOPE.contains("Yggdrasil.MinecraftToken.Create"));
        assert!(LITTLESKIN_SCOPE.starts_with("openid "));
    }

    #[test]
    fn scope_has_no_double_spaces() {
        // Rust 的 `\` 续行会吃掉缩进，这里守住拼接结果干净。
        assert!(!LITTLESKIN_SCOPE.contains("  "));
    }

    #[test]
    fn littleskin_host_detection() {
        assert!(is_littleskin_host("https://littleskin.cn/api/yggdrasil"));
        assert!(is_littleskin_host("littleskin.cn"));
        assert!(is_littleskin_host("https://littleskin.cn"));
        assert!(is_littleskin_host("https://open.littleskin.cn"));
        assert!(is_littleskin_host("https://LITTLESKIN.CN"));
        // 非 LittleSkin：不得把 OAuth 令牌发过去
        assert!(!is_littleskin_host(
            "https://skin.prinzeugen.net/api/yggdrasil"
        ));
        assert!(!is_littleskin_host("https://example.com"));
        // 防前缀伪装
        assert!(!is_littleskin_host("https://notlittleskin.cn"));
        assert!(!is_littleskin_host("https://littleskin.cn.evil.com"));
        assert!(!is_littleskin_host(""));
    }

    #[test]
    fn normalize_root_variants() {
        assert_eq!(
            normalize_littleskin_root("https://littleskin.cn"),
            "https://littleskin.cn/api/yggdrasil"
        );
        assert_eq!(
            normalize_littleskin_root("https://littleskin.cn/"),
            "https://littleskin.cn/api/yggdrasil"
        );
        assert_eq!(
            normalize_littleskin_root("https://littleskin.cn/api/yggdrasil"),
            "https://littleskin.cn/api/yggdrasil"
        );
        assert_eq!(normalize_littleskin_root("  "), LITTLESKIN_API_ROOT);
    }

    #[test]
    fn oauth_error_mapping() {
        let doc = serde_json::json!({
            "error": "invalid_client",
            "error_description": "Client was not found or not whitelisted"
        });
        let e = oauth_error(&doc, StatusCode::BAD_REQUEST, "x");
        assert_eq!(e.code, "LITTLESKIN_OAUTH_NOT_WHITELISTED");
        assert_eq!(e.status, StatusCode::BAD_REQUEST);

        let doc = serde_json::json!({"error": "expired_token"});
        assert_eq!(
            oauth_error(&doc, StatusCode::BAD_REQUEST, "x").code,
            "LITTLESKIN_DEVICE_CODE_EXPIRED"
        );

        let doc = serde_json::json!({"error": "access_denied"});
        assert_eq!(
            oauth_error(&doc, StatusCode::BAD_REQUEST, "x").code,
            "LITTLESKIN_ACCESS_DENIED"
        );

        let doc = serde_json::json!({"error": "invalid_scope"});
        assert_eq!(
            oauth_error(&doc, StatusCode::BAD_REQUEST, "x").code,
            "LITTLESKIN_INVALID_SCOPE"
        );

        // invalid_grant → 401 TOKEN_EXPIRED，触发前端既有重登引导
        let doc = serde_json::json!({"error": "invalid_grant"});
        let e = oauth_error(&doc, StatusCode::BAD_REQUEST, "x");
        assert_eq!(e.code, "TOKEN_EXPIRED");
        assert_eq!(e.status, StatusCode::UNAUTHORIZED);

        // 未知错误保留兜底 code，避免吞掉细节
        let doc = serde_json::json!({"error": "server_error"});
        assert_eq!(
            oauth_error(&doc, StatusCode::INTERNAL_SERVER_ERROR, "授权失败").code,
            "LITTLESKIN_OAUTH_ERROR"
        );
    }

    #[test]
    fn numeric_fields_accept_strings() {
        // 部分 OAuth 实现把 expires_in / interval 序列化为字符串。
        let doc = serde_json::json!({"expires_in": "300", "interval": 5});
        assert_eq!(json_u64(&doc, "expires_in"), Some(300));
        assert_eq!(json_u64(&doc, "interval"), Some(5));
        assert_eq!(json_u64(&doc, "missing"), None);
    }

    #[test]
    fn client_id_is_public_non_empty_value() {
        // client_id 依 RFC 6749 §2.2 是公开值；这里守住它不为空（空会直接 400）。
        assert!(!LITTLESKIN_CLIENT_ID.trim().is_empty());
        assert_eq!(resolve_client_id(), LITTLESKIN_CLIENT_ID);
    }

    #[test]
    fn selected_profiles_upper_bound_is_sane() {
        // 上限存在的目的是防「按请求长度预分配」被放大；正常账号远低于该值。
        assert!(MAX_SELECTED_PROFILES >= 16);
        assert!(MAX_SELECTED_PROFILES <= 1024);
    }

    /// 脱敏投影必须清掉刷新令牌、且不影响其它字段（响应边界契约）。
    #[test]
    fn redacted_strips_only_oauth_refresh_token() {
        use crate::services::account::StoredAccount;
        let acc = StoredAccount {
            name: "Steve".into(),
            uuid: "u".into(),
            token: "ct".into(),
            access_token: "mc".into(),
            refresh_token: "ct2".into(),
            login_method: "Yggdrasil".into(),
            last_used: 1,
            is_default: true,
            server_url: Some("https://littleskin.cn/api/yggdrasil".into()),
            oauth_provider: Some("LittleSkin".into()),
            oauth_refresh_token: Some("SECRET".into()),
        };
        let json = serde_json::to_value(acc.redacted()).unwrap();
        assert!(
            json.get("oauthRefreshToken").is_none(),
            "刷新令牌必须被清除"
        );
        // 其它字段照旧（前端依赖 oauthProvider 区分展示）
        assert_eq!(json["oauthProvider"], "LittleSkin");
        assert_eq!(json["accessToken"], "mc");
        assert_eq!(json["loginMethod"], "Yggdrasil");
    }
}
