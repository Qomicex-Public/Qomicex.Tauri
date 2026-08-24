//! Plugin Store 客户端服务（Issue #27，上游 plugins.qomicex.top/api/v1）。
//!
//! 职责边界：
//! - 公开读端点（列表/详情/评价/更新检查）原样透传 JSON（serde_json::Value），
//!   上游字段演进不需要改这里；
//! - 认证 token 只存后端本地（BaseDir/plugin-store-auth.json），永不下发前端；
//!   401 自动 refresh 一次并重放，失败即清空会话；
//! - 安装管线：download-info → 主/镜像 URL 下载 → SHA-256 校验 → 复用
//!   services::plugin::install_from_package（依赖预检 + zip-slip 防护都在那里）。

use std::time::Duration;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::Digest;

use crate::error::ApiError;
use crate::settings;
use crate::state::APP_VERSION;

pub const STORE_API_BASE: &str = "https://plugins.qomicex.top/api/v1";

/// 商店包体上限（上游文档：413 too_large = 超 50MB）。
const MAX_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
/// 安装下载整体超时（覆盖共享 client 默认 30s；50MB 慢速链路需要更久）。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
/// 普通 API 调用超时。
const API_TIMEOUT: Duration = Duration::from_secs(20);

fn auth_file() -> std::path::PathBuf {
    settings::resolve_base_dir().join("plugin-store-auth.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
}

fn load_tokens() -> Option<StoredTokens> {
    let json = std::fs::read_to_string(auth_file()).ok()?;
    serde_json::from_str(&json).ok()
}

fn save_tokens(tokens: &StoredTokens) -> Result<(), ApiError> {
    let path = auth_file();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
        // 凭据目录收紧为仅属主可访问（Unix；Windows 默认继承用户 profile ACL）。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let json = serde_json::to_string(tokens).map_err(|e| ApiError::internal(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        f.write_all(json.as_bytes())?;
        Ok(())
    }
    #[cfg(windows)]
    {
        std::fs::write(&path, json)?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::write(&path, json)?;
        Ok(())
    }
}

fn clear_tokens() {
    let _ = std::fs::remove_file(auth_file());
}

/// 上游错误 `{ error: { code, message } }` → 本项目 ApiError（STORE_ 前缀大写码）。
fn map_upstream_error(status: StatusCode, body: &serde_json::Value) -> Option<ApiError> {
    let err = body.get("error")?;
    let code = err
        .get("code")
        .and_then(|c| c.as_str())
        .unwrap_or("upstream");
    let message = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("插件商店请求失败");
    Some(ApiError::new(
        status,
        format!("STORE_{}", code.to_uppercase()),
        message,
    ))
}

async fn store_send(builder: reqwest::RequestBuilder) -> Result<serde_json::Value, ApiError> {
    let resp = builder
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|_| ApiError::upstream("无法连接插件商店"))?;
    let status =
        StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(map_upstream_error(status, &body)
            .unwrap_or_else(|| ApiError::new(status, "STORE_UPSTREAM_ERROR", "插件商店请求失败")));
    }
    Ok(body)
}

fn store_get(client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
    client.get(format!("{STORE_API_BASE}{path}"))
}

fn store_post(client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
    client.post(format!("{STORE_API_BASE}{path}"))
}

// =====================================================================
// 公开读端点
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreListQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default = "default_page")]
    pub page: i64,
    pub page_size: Option<i64>,
    pub min_launcher_version: Option<String>,
}

fn default_page() -> i64 {
    1
}

/// GET /plugins 市场列表（仅已发布）。
pub async fn list_plugins(
    client: &reqwest::Client,
    query: &StoreListQuery,
) -> Result<serde_json::Value, ApiError> {
    let mut path = format!(
        "/plugins?page={}&pageSize={}",
        query.page.max(1),
        query.page_size.unwrap_or(20).clamp(1, 50)
    );
    if let Some(q) = query.q.as_deref().filter(|s| !s.trim().is_empty()) {
        path.push_str(&format!("&q={}", urlencoding::encode(q.trim())));
    }
    if let Some(c) = query.category.as_deref().filter(|s| !s.trim().is_empty()) {
        path.push_str(&format!("&category={}", urlencoding::encode(c.trim())));
    }
    if let Some(t) = query.tags.as_deref().filter(|s| !s.trim().is_empty()) {
        path.push_str(&format!("&tags={}", urlencoding::encode(t.trim())));
    }
    if let Some(s) = query.sort.as_deref().filter(|s| !s.trim().is_empty()) {
        path.push_str(&format!("&sort={}", urlencoding::encode(s.trim())));
    }
    if let Some(v) = query
        .min_launcher_version
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        path.push_str(&format!(
            "&minLauncherVersion={}",
            urlencoding::encode(v.trim())
        ));
    }
    store_send(store_get(client, &path)).await
}

/// GET /plugins/:slug 详情（含已发布 versions[]）。
pub async fn plugin_detail(
    client: &reqwest::Client,
    slug: &str,
) -> Result<serde_json::Value, ApiError> {
    store_send(store_get(
        client,
        &format!("/plugins/{}", urlencoding::encode(slug)),
    ))
    .await
}

/// GET /plugins/:slug/reviews 评价列表（只读）。
pub async fn plugin_reviews(
    client: &reqwest::Client,
    slug: &str,
    page: i64,
    page_size: i64,
) -> Result<serde_json::Value, ApiError> {
    store_send(store_get(
        client,
        &format!(
            "/plugins/{}/reviews?page={}&pageSize={}",
            urlencoding::encode(slug),
            page.max(1),
            page_size.clamp(1, 50)
        ),
    ))
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledEntry {
    pub slug: String,
    pub version: String,
}

/// POST /plugins/check-updates：launcherVersion 由后端注入（CARGO_PKG_VERSION），
/// installed 由前端传本地清单（slug+version）。
pub async fn check_updates(
    client: &reqwest::Client,
    installed: Vec<InstalledEntry>,
) -> Result<serde_json::Value, ApiError> {
    let body = serde_json::json!({
        "launcherVersion": APP_VERSION,
        "installed": installed.iter()
            .map(|e| serde_json::json!({ "slug": e.slug, "version": e.version }))
            .collect::<Vec<_>>(),
    });
    store_send(store_post(client, "/plugins/check-updates").json(&body)).await
}

// =====================================================================
// 安装管线
// =====================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub url: String,
    pub mirror_url: Option<String>,
    pub sha256: String,
    pub size: i64,
}

fn parse_download_info(v: &serde_json::Value) -> Result<DownloadInfo, ApiError> {
    let url = v
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| ApiError::upstream("商店未返回下载地址"))?
        .to_string();
    // 完整性校验是安装管线的强制环节：sha256 缺失或格式非法时拒绝，
    // 绝不静默降级为"跳过校验"。
    let sha256 = v
        .get("sha256")
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_lowercase();
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "STORE_INVALID_CHECKSUM",
            "商店未返回有效的 SHA-256 校验值，已拒绝安装",
        ));
    }
    Ok(DownloadInfo {
        url,
        mirror_url: v
            .get("mirrorUrl")
            .and_then(|u| u.as_str())
            .map(String::from),
        sha256,
        size: v.get("size").and_then(|s| s.as_i64()).unwrap_or(0),
    })
}

/// GET /plugins/:slug/versions/:version/download 双通道下载信息。
pub async fn download_info(
    client: &reqwest::Client,
    slug: &str,
    version: &str,
) -> Result<DownloadInfo, ApiError> {
    let v = store_send(store_get(
        client,
        &format!(
            "/plugins/{}/versions/{}/download",
            urlencoding::encode(slug),
            urlencoding::encode(version)
        ),
    ))
    .await?;
    parse_download_info(&v)
}

async fn fetch_package(client: &reqwest::Client, info: &DownloadInfo) -> Result<Vec<u8>, ApiError> {
    let mut last_err = ApiError::upstream("下载失败");
    let urls: Vec<&str> = std::iter::once(info.url.as_str())
        .chain(info.mirror_url.as_deref())
        .collect();
    for url in urls {
        match fetch_one(client, url, &info.sha256).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

async fn fetch_one(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
) -> Result<Vec<u8>, ApiError> {
    let mut resp = client
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|_| ApiError::upstream("插件包下载失败"))?;
    if !resp.status().is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "STORE_DOWNLOAD_FAILED",
            format!("插件包下载失败 (HTTP {})", resp.status().as_u16()),
        ));
    }
    if let Some(len) = resp
        .content_length()
        .filter(|l| *l as usize > MAX_PACKAGE_BYTES)
    {
        return Err(ApiError::bad_request(
            "STORE_TOO_LARGE",
            format!("插件包超过大小上限（{len} 字节）"),
        ));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| ApiError::upstream("插件包下载中断"))?
    {
        if bytes.len() + chunk.len() > MAX_PACKAGE_BYTES {
            return Err(ApiError::bad_request(
                "STORE_TOO_LARGE",
                format!(
                    "插件包超过大小上限（{}MB）",
                    MAX_PACKAGE_BYTES / 1024 / 1024
                ),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    if !expected_sha256.is_empty() {
        let digest: String = sha2::Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest != expected_sha256 {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "STORE_SHA256_MISMATCH",
                "插件包校验失败（SHA-256 不匹配），已放弃安装",
            ));
        }
    }
    Ok(bytes)
}

/// POST /api/store/install 完整安装管线 → PluginInfo（camelCase）。
pub async fn install(
    client: &reqwest::Client,
    slug: &str,
    version: Option<&str>,
) -> Result<crate::services::plugin::PluginInfo, ApiError> {
    let version = version.filter(|v| !v.trim().is_empty()).unwrap_or("latest");
    let info = download_info(client, slug, version).await?;
    let bytes = fetch_package(client, &info).await?;
    verify_package_matches_slug(&bytes, slug)?;
    crate::services::plugin::install_from_package(&bytes)?.ok_or_else(|| {
        ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "插件包无效（缺少 manifest.json）")
    })
}

/// 校验包内 manifest.id 与请求的商店 slug 对应，防止串包安装。
fn verify_package_matches_slug(package_bytes: &[u8], slug: &str) -> Result<(), ApiError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package_bytes))
        .map_err(|_| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "插件包无效"))?;
    let id: String = {
        let mut reader = archive.by_name("manifest.json").map_err(|_| {
            ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "插件包缺少 manifest.json")
        })?;
        let mut json = String::new();
        std::io::Read::read_to_string(&mut reader, &mut json)
            .map_err(|e| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", e.to_string()))?;
        serde_json::from_str::<serde_json::Value>(&json)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
            .ok_or_else(|| {
                ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "manifest.json 缺少 id")
            })?
    };
    let slug_l = slug.to_lowercase();
    let matched = id == slug || id.to_lowercase().ends_with(&format!(".{slug_l}"));
    if !matched {
        return Err(ApiError::bad_request(
            "STORE_SLUG_MISMATCH",
            format!("包内插件 ID（{id}）与请求的商店插件（{slug}）不匹配"),
        ));
    }
    Ok(())
}

// =====================================================================
// 认证（token 仅存后端）
// =====================================================================

/// 提取登录/注册响应中的 token 对（注册未配邮件时可能没有）。
fn extract_tokens(v: &serde_json::Value) -> Option<StoredTokens> {
    Some(StoredTokens {
        access_token: v.get("accessToken")?.as_str()?.to_string(),
        refresh_token: v.get("refreshToken")?.as_str()?.to_string(),
    })
}

fn session_response(v: serde_json::Value) -> serde_json::Value {
    // 下发 user + expiresIn，token 留在本地
    serde_json::json!({
        "user": v.get("user").cloned().unwrap_or(serde_json::Value::Null),
        "expiresIn": v.get("expiresIn").cloned().unwrap_or(serde_json::Value::Null),
    })
}

async fn refresh_tokens(
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<StoredTokens, ApiError> {
    let body = serde_json::json!({ "refreshToken": refresh_token });
    let resp = store_post(client, "/auth/refresh").json(&body).send().await;
    match resp {
        Ok(r) if r.status().is_success() => {
            let v: serde_json::Value = r.json().await.unwrap_or(serde_json::Value::Null);
            extract_tokens(&v)
                .ok_or_else(|| ApiError::forbidden("STORE_INVALID_REFRESH_TOKEN", "刷新凭证无效"))
        }
        _ => {
            clear_tokens();
            Err(ApiError::forbidden(
                "STORE_SESSION_EXPIRED",
                "登录状态已过期，请重新登录",
            ))
        }
    }
}

/// 带 Bearer 的请求；401 时自动 refresh 一次并重放。
async fn authed_send(
    client: &reqwest::Client,
    build: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<serde_json::Value, ApiError> {
    let tokens = load_tokens()
        .ok_or_else(|| ApiError::forbidden("STORE_UNAUTHORIZED", "尚未登录插件商店"))?;
    let first = build(&tokens.access_token)
        .timeout(API_TIMEOUT)
        .send()
        .await;
    let needs_refresh = matches!(&first, Ok(r) if r.status() == StatusCode::UNAUTHORIZED);
    if !needs_refresh {
        let resp = first.map_err(|_| ApiError::upstream("无法连接插件商店"))?;
        let status = StatusCode::from_u16(resp.status().as_u16())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            return Err(map_upstream_error(status, &body).unwrap_or_else(|| {
                ApiError::new(status, "STORE_UPSTREAM_ERROR", "插件商店请求失败")
            }));
        }
        return Ok(body);
    }
    let fresh = refresh_tokens(client, &tokens.refresh_token).await?;
    save_tokens(&fresh)?;
    let resp = build(&fresh.access_token)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|_| ApiError::upstream("无法连接插件商店"))?;
    let status =
        StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(map_upstream_error(status, &body)
            .unwrap_or_else(|| ApiError::new(status, "STORE_UPSTREAM_ERROR", "插件商店请求失败")));
    }
    Ok(body)
}

/// POST /auth/login → `{user, expiresIn}`；成功后保存 token。
pub async fn login(
    client: &reqwest::Client,
    account: &str,
    password: &str,
) -> Result<serde_json::Value, ApiError> {
    let body = serde_json::json!({ "account": account, "password": password });
    let v = store_send(store_post(client, "/auth/login").json(&body)).await?;
    if let Some(tokens) = extract_tokens(&v) {
        save_tokens(&tokens)?;
    }
    Ok(session_response(v))
}

/// POST /auth/register → 已配邮件时返回 `{checkEmail:true}`，否则同登录结构。
pub async fn register(
    client: &reqwest::Client,
    username: &str,
    email: &str,
    password: &str,
) -> Result<serde_json::Value, ApiError> {
    let body = serde_json::json!({ "username": username, "email": email, "password": password });
    let v = store_send(store_post(client, "/auth/register").json(&body)).await?;
    if v.get("checkEmail")
        .and_then(|c| c.as_bool())
        .unwrap_or(false)
    {
        return Ok(v);
    }
    if let Some(tokens) = extract_tokens(&v) {
        save_tokens(&tokens)?;
    }
    Ok(session_response(v))
}

/// GET /auth/me → `{user: null}`（未登录/会话失效）或 `{user: {...}}`。
pub async fn me(client: &reqwest::Client) -> Result<serde_json::Value, ApiError> {
    if load_tokens().is_none() {
        return Ok(serde_json::json!({ "user": null }));
    }
    match authed_send(client, |t| store_get(client, "/auth/me").bearer_auth(t)).await {
        // 上游 /auth/me 本身返回 {user: {...}} 形状，直接透传（勿二次包装）。
        Ok(v) => Ok(v),
        // 仅会话类失效映射为未登录；网络/上游故障向上传播，避免把故障伪装成登出。
        Err(e) => match e.code.as_str() {
            "STORE_UNAUTHORIZED" | "STORE_SESSION_EXPIRED" | "STORE_INVALID_REFRESH_TOKEN" => {
                Ok(serde_json::json!({ "user": null }))
            }
            _ => Err(e),
        },
    }
}

/// 手动刷新（POST /api/store/auth/refresh）。
pub async fn refresh_session(client: &reqwest::Client) -> Result<serde_json::Value, ApiError> {
    let tokens = load_tokens()
        .ok_or_else(|| ApiError::forbidden("STORE_UNAUTHORIZED", "尚未登录插件商店"))?;
    let fresh = refresh_tokens(client, &tokens.refresh_token).await?;
    save_tokens(&fresh)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// 登出：清除本地 token（上游无吊销端点，旋转式 refresh 已足够安全）。
pub async fn logout() -> Result<serde_json::Value, ApiError> {
    clear_tokens();
    Ok(serde_json::json!({ "ok": true }))
}

// =====================================================================
// 设备流登录（RFC 8628 简化版，见 启动器接入-API.md）
// =====================================================================

/// POST /auth/device/code：发起设备会话（deviceCode/userCode/verificationUri... 原样透传）。
pub async fn device_code(client: &reqwest::Client) -> Result<serde_json::Value, ApiError> {
    store_send(store_post(client, "/auth/device/code")).await
}

/// POST /auth/device/token：按 interval 轮询。pending 原样透传；ok 时保存 token
/// 并返回 `{status:"ok", user, expiresIn}`（token 留后端）；expired 透传上游错误。
pub async fn device_token(
    client: &reqwest::Client,
    device_code: &str,
) -> Result<serde_json::Value, ApiError> {
    let body = serde_json::json!({ "deviceCode": device_code });
    let v = store_send(store_post(client, "/auth/device/token").json(&body)).await?;
    if v.get("status").and_then(|s| s.as_str()) == Some("ok") {
        if let Some(tokens) = extract_tokens(&v) {
            save_tokens(&tokens)?;
        }
        return Ok(serde_json::json!({
            "status": "ok",
            "user": v.get("user").cloned().unwrap_or(serde_json::Value::Null),
            "expiresIn": v.get("expiresIn").cloned().unwrap_or(serde_json::Value::Null),
        }));
    }
    Ok(v)
}

/// GET /plugins/mine 🔒 我参与（个人+组织）的插件。
pub async fn my_plugins(client: &reqwest::Client) -> Result<serde_json::Value, ApiError> {
    authed_send(client, |t| {
        store_get(client, "/plugins/mine").bearer_auth(t)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_info_requires_valid_sha256() {
        let cases = vec![
            serde_json::json!({"url": "https://x/y.qplugin"}),
            serde_json::json!({"url": "https://x/y.qplugin", "sha256": ""}),
            serde_json::json!({"url": "https://x/y.qplugin", "sha256": "abc123"}),
            serde_json::json!({"url": "https://x/y.qplugin", "sha256": "zz86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}),
        ];
        for v in cases {
            let err = parse_download_info(&v).unwrap_err();
            assert_eq!(err.code, "STORE_INVALID_CHECKSUM");
        }
    }

    #[test]
    fn download_info_accepts_valid_sha256() {
        let v = serde_json::json!({
            "url": "https://x/y.qplugin",
            "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "size": 123,
        });
        let info = parse_download_info(&v).unwrap();
        assert_eq!(info.size, 123);
        assert!(info.mirror_url.is_none());
    }
}
