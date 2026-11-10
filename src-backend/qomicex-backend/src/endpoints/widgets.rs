// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 主页自定义组件（QWidget）的远程抓取代理。
//!
//! 组件 XML 与 `<Data>` 数据源都由前端发起，但 WebView 直连外部 https 会遇到
//! CORS；统一走这里。端点只接受 https:443、不跟随重定向，并在连接前把主机名
//! 解析成 IP 后钉住（`resolve`），防止 DNS 重绑定把请求带到回环/内网地址。

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::error::{ApiError, ApiResult};
use crate::state::{proxy_settings, SharedState, USER_AGENT};

/// 文本/JSON/XML 响应体上限。
const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// 图片/音频/视频等二进制响应体上限。
const MAX_BINARY_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct ProxyRequest {
    url: String,
    #[serde(default)]
    binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResponse {
    content_type: String,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<usize>,
}

pub fn router() -> Router<SharedState> {
    Router::new().route("/widgets/proxy", post(proxy))
}

async fn proxy(
    State(state): State<SharedState>,
    Json(req): Json<ProxyRequest>,
) -> ApiResult<Json<ProxyResponse>> {
    let url = validate_target_url(&req.url)?;
    let limit = if req.binary {
        MAX_BINARY_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    let host = match url.host() {
        Some(Host::Domain(d)) => d.to_string(),
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => ip.to_string(),
        None => {
            return Err(ApiError::bad_request(
                "WIDGET_URL_INVALID",
                "URL 缺少主机名",
            ))
        }
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let pinned = resolve_public_addr(&host, port).await?;
    let client = build_client(&state, &host, pinned).await?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError::upstream_cause("组件数据源请求失败", &e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(ApiError::upstream(format!(
            "组件数据源返回 HTTP {}",
            status.as_u16()
        )));
    }
    if let Some(len) = response.content_length() {
        if len > limit as u64 {
            return Err(ApiError::bad_request(
                "WIDGET_RESPONSE_TOO_LARGE",
                if req.binary {
                    "组件二进制响应超过 8MB"
                } else {
                    "组件文本响应超过 1MB"
                },
            ));
        }
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::upstream_cause("读取组件数据源失败", &e))?;
        if body.len() + chunk.len() > limit {
            return Err(ApiError::bad_request(
                "WIDGET_RESPONSE_TOO_LARGE",
                if req.binary {
                    "组件二进制响应超过 8MB"
                } else {
                    "组件文本响应超过 1MB"
                },
            ));
        }
        body.extend_from_slice(&chunk);
    }
    if req.binary {
        let size = body.len();
        return Ok(Json(ProxyResponse {
            content_type,
            body: String::new(),
            base64: Some(base64::engine::general_purpose::STANDARD.encode(body)),
            size: Some(size),
        }));
    }
    let body =
        String::from_utf8(body).map_err(|_| ApiError::upstream("组件数据源响应不是 UTF-8 文本"))?;
    Ok(Json(ProxyResponse {
        content_type,
        body,
        base64: None,
        size: None,
    }))
}

/// 只允许 `https://host[:443]/...`：不允许 http、非 443 端口、用户信息与本地主机名。
fn validate_target_url(raw: &str) -> ApiResult<Url> {
    let url = Url::parse(raw.trim())
        .map_err(|_| ApiError::bad_request("WIDGET_URL_INVALID", "URL 格式非法"))?;
    if url.scheme() != "https" {
        return Err(ApiError::bad_request(
            "WIDGET_URL_SCHEME",
            "组件只允许 https 地址",
        ));
    }
    if url.port().is_some_and(|p| p != 443) {
        return Err(ApiError::bad_request(
            "WIDGET_URL_PORT",
            "组件只允许 https:443",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::bad_request(
            "WIDGET_URL_CREDENTIALS",
            "URL 不允许携带用户信息",
        ));
    }
    let host = match url.host() {
        Some(h) => h,
        None => {
            return Err(ApiError::bad_request(
                "WIDGET_URL_INVALID",
                "URL 缺少主机名",
            ))
        }
    };
    match host {
        Host::Ipv4(ip) => reject_blocked_ip(IpAddr::V4(ip))?,
        Host::Ipv6(ip) => reject_blocked_ip(IpAddr::V6(ip))?,
        Host::Domain(domain) => {
            let name = domain.trim_end_matches('.').to_ascii_lowercase();
            if name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
                || name.ends_with(".internal")
                || name.is_empty()
            {
                return Err(ApiError::forbidden(
                    "WIDGET_URL_BLOCKED",
                    "不允许访问本地/内网主机",
                ));
            }
        }
    }
    Ok(url)
}

async fn resolve_public_addr(host: &str, port: u16) -> ApiResult<SocketAddr> {
    let addrs = tokio::net::lookup_host((host, port)).await.map_err(|e| {
        ApiError::bad_request("WIDGET_HOST_UNRESOLVED", format!("主机名解析失败: {e}"))
    })?;
    let mut pinned = None;
    for addr in addrs {
        reject_blocked_ip(addr.ip())?;
        if pinned.is_none() {
            pinned = Some(addr);
        }
    }
    pinned.ok_or_else(|| ApiError::bad_request("WIDGET_HOST_UNRESOLVED", "主机名没有可用地址"))
}

fn reject_blocked_ip(ip: IpAddr) -> ApiResult<()> {
    if is_blocked_ip(ip) {
        return Err(ApiError::forbidden(
            "WIDGET_URL_BLOCKED",
            "不允许访问回环/内网/保留地址",
        ));
    }
    Ok(())
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10
                || v6.to_ipv4_mapped().is_some_and(is_blocked_v4)
        }
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0
        || (o[0] == 100 && (64..=127).contains(&o[1])) // 100.64.0.0/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // 198.18.0.0/15 基准测试
}

async fn build_client(
    state: &SharedState,
    host: &str,
    pinned: SocketAddr,
) -> ApiResult<reqwest::Client> {
    let (proxy, no_proxy) = {
        let settings = state.settings.read().await;
        proxy_settings(&settings)
    };
    let mut builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .resolve(host, pinned);
    if no_proxy {
        builder = builder.no_proxy();
    }
    if let Some(url) = proxy {
        if let Ok(p) = reqwest::Proxy::all(url) {
            builder = builder.proxy(p);
        }
    }
    builder
        .build()
        .map_err(|error| ApiError::internal(format!("构建组件代理客户端失败: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_443() {
        assert!(validate_target_url("https://example.com/news.json").is_ok());
        assert!(validate_target_url("https://example.com:443/news.json").is_ok());
    }

    #[test]
    fn rejects_non_https_and_odd_ports() {
        assert_eq!(
            validate_target_url("http://example.com/a")
                .unwrap_err()
                .code,
            "WIDGET_URL_SCHEME"
        );
        assert_eq!(
            validate_target_url("https://example.com:8443/a")
                .unwrap_err()
                .code,
            "WIDGET_URL_PORT"
        );
    }

    #[test]
    fn rejects_local_hosts_and_credentials() {
        assert_eq!(
            validate_target_url("https://localhost/a").unwrap_err().code,
            "WIDGET_URL_BLOCKED"
        );
        assert_eq!(
            validate_target_url("https://printer.local/a")
                .unwrap_err()
                .code,
            "WIDGET_URL_BLOCKED"
        );
        assert_eq!(
            validate_target_url("https://user:pass@example.com/a")
                .unwrap_err()
                .code,
            "WIDGET_URL_CREDENTIALS"
        );
    }

    #[test]
    fn rejects_literal_private_ips() {
        for url in [
            "https://127.0.0.1/a",
            "https://10.0.0.1/a",
            "https://192.168.1.1/a",
            "https://169.254.1.1/a",
            "https://[::1]/a",
            "https://[fe80::1]/a",
            "https://[fd00::1]/a",
        ] {
            assert_eq!(
                validate_target_url(url).unwrap_err().code,
                "WIDGET_URL_BLOCKED",
                "{url}"
            );
        }
    }

    #[test]
    fn blocks_reserved_ranges() {
        for ip in [
            "0.0.0.0",
            "100.64.0.1",
            "192.0.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "::",
            "ff02::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(is_blocked_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(!is_blocked_ip("1.1.1.1".parse().unwrap()));
        assert!(!is_blocked_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}
