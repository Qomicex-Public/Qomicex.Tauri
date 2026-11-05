// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 插件权限的用户层覆盖。
//!
//! manifest 声明的是**安装时授权**的上限，这里保存用户在此基础上做的收窄
//! （`disabled`）以及 proxyFetch 的出网策略。有效权限 = manifest − disabled，
//! 永远不会超过 manifest —— 提权仍然只能靠重新安装/改包。
//!
//! 单独落盘（`plugin-permissions.json`）而不是塞进插件目录的 `settings.json`：
//! 后者插件自己能通过 `setSettings` 写，等于让插件给自己开权限。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::settings;

const MAX_DISABLED: usize = 256;
const MAX_ALLOWLIST: usize = 64;
const MAX_ENTRY_LEN: usize = 260;

/// 单个插件的权限配置。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginPermissionConfig {
    /// 用户关闭的权限 id（需与 manifest 声明同名才会生效）。
    pub disabled: Vec<String>,
    /// proxyFetch 出网策略。
    pub cors_proxy: CorsProxyPolicy,
}

/// proxyFetch 对「内网/保留地址」的放行策略。
///
/// 判定顺序：白名单命中 → 直接放行；否则看 `allow_private`；都不满足才走
/// 默认的 [`crate::endpoints::plugin`] SSRF 校验。白名单优先于开关，是为了让
/// 「只放行 localhost:8080」不必连带打开整个内网。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CorsProxyPolicy {
    /// 允许该插件访问任意内网/保留地址（含 DNS 解析后落在内网的域名）。
    pub allow_private: bool,
    /// 始终放行的主机：`host`、`host:port` 或 `*.suffix`（同时匹配 apex）。
    /// IPv6 字面量不支持（写成 `[::1]` 会被端口解析拒绝），需要时用 `allow_private`。
    pub allowlist: Vec<String>,
}

pub struct PluginPermissionStore {
    file: PathBuf,
    cache: Mutex<Option<HashMap<String, PluginPermissionConfig>>>,
}

impl PluginPermissionStore {
    pub fn new() -> Self {
        Self::with_file(settings::resolve_base_dir().join("plugin-permissions.json"))
    }

    /// 测试专用：把落盘路径重定向到临时目录。
    pub fn with_file(file: PathBuf) -> Self {
        Self {
            file,
            cache: Mutex::new(None),
        }
    }

    pub fn get(&self, plugin_id: &str) -> PluginPermissionConfig {
        self.load().get(plugin_id).cloned().unwrap_or_default()
    }

    pub fn set(
        &self,
        plugin_id: &str,
        config: PluginPermissionConfig,
    ) -> Result<PluginPermissionConfig, ApiError> {
        let normalized = normalize(config);
        let mut all = self.load();
        all.insert(plugin_id.to_string(), normalized.clone());
        self.persist(&all)?;
        Ok(normalized)
    }

    pub fn remove(&self, plugin_id: &str) {
        let mut all = self.load();
        if all.remove(plugin_id).is_none() {
            return;
        }
        let _ = self.persist(&all);
    }

    /// 未登记策略（或请求未带 pluginId）→ 默认严格策略。
    pub fn cors_policy(&self, plugin_id: Option<&str>) -> CorsProxyPolicy {
        plugin_id
            .map(|id| self.get(id).cors_proxy)
            .unwrap_or_default()
    }

    fn load(&self) -> HashMap<String, PluginPermissionConfig> {
        let mut guard = match self.cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
        let parsed = std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, PluginPermissionConfig>>(&s).ok())
            .map(|raw| {
                raw.into_iter()
                    .map(|(id, cfg)| (id, normalize(cfg)))
                    .collect::<HashMap<String, PluginPermissionConfig>>()
            })
            .unwrap_or_default();
        *guard = Some(parsed.clone());
        parsed
    }

    fn persist(&self, all: &HashMap<String, PluginPermissionConfig>) -> Result<(), ApiError> {
        if let Some(parent) = self.file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json =
            serde_json::to_string_pretty(all).map_err(|e| ApiError::internal(e.to_string()))?;
        std::fs::write(&self.file, json).map_err(ApiError::from)?;
        if let Ok(mut guard) = self.cache.lock() {
            *guard = Some(all.clone());
        }
        Ok(())
    }
}

impl Default for PluginPermissionStore {
    fn default() -> Self {
        Self::new()
    }
}

/// 请求目标是否被策略放行（放行后不再做私网校验）。
pub fn cors_target_allowed(policy: &CorsProxyPolicy, host: &str, port: u16) -> bool {
    policy.allow_private
        || policy
            .allowlist
            .iter()
            .any(|entry| allowlist_entry_matches(entry, host, port))
}

fn allowlist_entry_matches(entry: &str, host: &str, port: u16) -> bool {
    let Some((entry_host, entry_port)) = parse_entry(entry) else {
        return false;
    };
    if let Some(p) = entry_port {
        if p != port {
            return false;
        }
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    match entry_host.strip_prefix("*.") {
        Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
        None => host == entry_host,
    }
}

/// 规范化写入：权限 id 只留合法字符并去重；白名单只留可解析的主机项。
pub fn normalize(config: PluginPermissionConfig) -> PluginPermissionConfig {
    let mut disabled = Vec::new();
    for raw in config.disabled {
        if disabled.len() >= MAX_DISABLED {
            break;
        }
        let id = raw.trim().to_ascii_lowercase();
        if valid_permission_id(&id) && !disabled.contains(&id) {
            disabled.push(id);
        }
    }

    let mut allowlist = Vec::new();
    for raw in config.cors_proxy.allowlist {
        if allowlist.len() >= MAX_ALLOWLIST {
            break;
        }
        let Some(entry) = normalize_entry(&raw) else {
            continue;
        };
        if !allowlist.contains(&entry) {
            allowlist.push(entry);
        }
    }

    PluginPermissionConfig {
        disabled,
        cors_proxy: CorsProxyPolicy {
            allow_private: config.cors_proxy.allow_private,
            allowlist,
        },
    }
}

fn valid_permission_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'.' | b'-'))
}

fn normalize_entry(raw: &str) -> Option<String> {
    if raw.len() > MAX_ENTRY_LEN {
        return None;
    }
    let (host, port) = parse_entry(raw)?;
    if !valid_host(&host) {
        return None;
    }
    Some(match port {
        Some(p) => format!("{host}:{p}"),
        None => host,
    })
}

/// `host` / `host:port` → 小写主机 + 可选端口。解析失败（含 IPv6 字面量、
/// 空端口、越界端口）返回 `None`。
fn parse_entry(raw: &str) -> Option<(String, Option<u16>)> {
    let s = raw.trim().to_ascii_lowercase();
    if s.contains(char::is_whitespace) {
        return None;
    }
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(v) if v > 0 => (h.to_string(), Some(v)),
            _ => return None,
        },
        None => (s, None),
    };
    if host.is_empty() {
        return None;
    }
    Some((host, port))
}

fn valid_host(host: &str) -> bool {
    // 裸 `*` 不当作白名单：等价于 allow_private，必须走显式开关。
    let target = host.strip_prefix("*.").unwrap_or(host);
    if target.is_empty() || target.len() > 253 {
        return false;
    }
    if target.parse::<std::net::Ipv4Addr>().is_ok() {
        return true;
    }
    target.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(allow_private: bool, allowlist: &[&str]) -> CorsProxyPolicy {
        CorsProxyPolicy {
            allow_private,
            allowlist: allowlist.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn default_policy_does_not_allow_private() {
        assert!(!cors_target_allowed(
            &CorsProxyPolicy::default(),
            "127.0.0.1",
            80
        ));
    }

    #[test]
    fn allow_private_covers_everything() {
        let p = policy(true, &[]);
        assert!(cors_target_allowed(&p, "127.0.0.1", 8080));
        assert!(cors_target_allowed(&p, "192.168.1.2", 80));
    }

    #[test]
    fn allowlist_matches_exact_host_and_optional_port() {
        let p = policy(false, &["localhost:8080"]);
        assert!(cors_target_allowed(&p, "localhost", 8080));
        assert!(!cors_target_allowed(&p, "localhost", 9090));
        assert!(!cors_target_allowed(&p, "127.0.0.1", 8080));
    }

    #[test]
    fn allowlist_wildcard_matches_apex_and_subdomains() {
        let p = policy(false, &["*.lan"]);
        assert!(cors_target_allowed(&p, "router.lan", 80));
        assert!(cors_target_allowed(&p, "lan", 80));
        assert!(!cors_target_allowed(&p, "notlan", 80));
        assert!(!cors_target_allowed(&p, "lan.evil.com", 80));
    }

    #[test]
    fn allowlist_is_case_insensitive_and_ignores_trailing_dot() {
        let p = policy(false, &["Api.Example.COM"]);
        assert!(cors_target_allowed(&p, "api.example.com.", 443));
    }

    #[test]
    fn normalize_drops_invalid_entries_and_dedupes() {
        let cfg = PluginPermissionConfig {
            disabled: vec![
                " network:cors_proxy ".into(),
                "network:cors_proxy".into(),
                "bad id!".into(),
                "".into(),
            ],
            cors_proxy: CorsProxyPolicy {
                allow_private: true,
                allowlist: vec![
                    "localhost:8080".into(),
                    "LOCALHOST:8080".into(),
                    "localhost:0".into(),
                    "*".into(),
                    "[::1]".into(),
                    "*.lan".into(),
                    "http://x".into(),
                ],
            },
        };
        let out = normalize(cfg);
        assert_eq!(out.disabled, vec!["network:cors_proxy".to_string()]);
        assert!(out.cors_proxy.allow_private);
        assert_eq!(
            out.cors_proxy.allowlist,
            vec!["localhost:8080".to_string(), "*.lan".to_string()]
        );
    }

    #[test]
    fn normalize_caps_list_sizes() {
        let cfg = PluginPermissionConfig {
            disabled: (0..300).map(|i| format!("perm:{i}")).collect(),
            cors_proxy: CorsProxyPolicy {
                allow_private: false,
                allowlist: (0..100).map(|i| format!("h{i}.lan")).collect(),
            },
        };
        let out = normalize(cfg);
        assert_eq!(out.disabled.len(), MAX_DISABLED);
        assert_eq!(out.cors_proxy.allowlist.len(), MAX_ALLOWLIST);
    }

    #[test]
    fn store_roundtrip_and_remove() {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-plugin-permissions-{}",
            uuid::Uuid::new_v4()
        ));
        let file = dir.join("plugin-permissions.json");
        let store = PluginPermissionStore::with_file(file.clone());

        assert_eq!(store.get("dev.test"), PluginPermissionConfig::default());

        let saved = store
            .set(
                "dev.test",
                PluginPermissionConfig {
                    disabled: vec!["shell:execute".into()],
                    cors_proxy: policy(false, &["localhost:8080"]),
                },
            )
            .unwrap();
        assert_eq!(saved.disabled, vec!["shell:execute".to_string()]);

        // 新实例从磁盘读回，验证落盘格式
        let reloaded = PluginPermissionStore::with_file(file);
        assert_eq!(reloaded.get("dev.test"), saved);
        assert!(cors_target_allowed(
            &reloaded.cors_policy(Some("dev.test")),
            "localhost",
            8080
        ));
        assert!(!cors_target_allowed(
            &reloaded.cors_policy(None),
            "localhost",
            8080
        ));

        reloaded.remove("dev.test");
        assert_eq!(reloaded.get("dev.test"), PluginPermissionConfig::default());
        let _ = std::fs::remove_dir_all(dir);
    }
}
