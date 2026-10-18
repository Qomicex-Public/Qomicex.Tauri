// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 模组文件 CDN 的镜像链与原版资源的官方/BMCLAPI 互换。
//!
//! 镜像链固定为 **MCIM → QML → 官方**：MCIM 覆盖 `cdn.modrinth.com` 与
//! `edge.forgecdn.net`；`cdn-alt.modrinth.com` 与 `mediafilez.forgecdn.net`
//! 不在其覆盖范围（后者被 MCIM 明确禁止接管），直接进 QML 层。
//!
//! 具体「先官方还是先镜像」由 [`crate::services::source_policy`] 决定，本模块只
//! 负责生成有序候选；**偏好只是优先级，两个方向都保留兜底**。

use std::sync::atomic::{AtomicBool, Ordering};

/// QML Mirror 的 Modrinth 主节点。
const MIRROR_MODRINTH: &str = "modrinth.qomicex.dpdns.org";
/// QML Mirror 的通用（CurseForge 等）主节点。
const MIRROR_CURSEFORGE: &str = "mirror.qomicex.dpdns.org";
/// MCIM 公共镜像。
const MCIM_HOST: &str = "mod.mcimirror.top";

/// Modrinth 官方文件 CDN 域名。
const MODRINTH_CDN_HOSTS: &[&str] = &["cdn.modrinth.com", "cdn-alt.modrinth.com"];
/// CurseForge 官方文件 CDN 落地域名。
const CURSEFORGE_CDN_HOSTS: &[&str] = &["mediafilez.forgecdn.net", "edge.forgecdn.net"];

/// Modrinth 镜像节点（按优先级）。
const MODRINTH_MIRROR_HOSTS: &[&str] =
    &["modrinth.qomicex.dpdns.org", "modrinth1.qomicex.dpdns.org"];
/// CurseForge（及通用）镜像节点（按优先级）。
const GENERIC_MIRROR_HOSTS: &[&str] = &["mirror.qomicex.dpdns.org", "mirror1.qomicex.dpdns.org"];

/// BMPLAPI 的三个路径前缀（与 core `bmclapi_download_source` 一致）。
const BMCLAPI_HOST: &str = "bmclapi2.bangbang93.com";

/// 镜像健康探针的 canary 文件（公开、稳定、几十 KB 的 CF 文件）。
///
/// 用真实文件而不是站点根路径：故障形态是「回 200 + Content-Length，body 永不到达」，
/// 只探根路径会误判为健康。
const MIRROR_CANARY_PATH: &str = "files/2503/41/MmmMmmMmmMmm-1.12-1.14.jar";
const MIRROR_CANARY_ORIGIN: &str = "mediafilez.forgecdn.net";

/// 镜像当前是否可用。`true` 是默认值（保持既有行为：镜像优先）。
static MIRROR_AVAILABLE: AtomicBool = AtomicBool::new(true);

pub fn set_mirror_available(available: bool) {
    MIRROR_AVAILABLE.store(available, Ordering::Relaxed);
}

pub fn mirror_available() -> bool {
    MIRROR_AVAILABLE.load(Ordering::Relaxed)
}

/// 探针目标：canary 在 QML 通用节点上的地址。
pub fn mirror_canary_url() -> String {
    format!("https://{MIRROR_CURSEFORGE}/{MIRROR_CANARY_PATH}")
}

/// 官方对照 URL（探针失败时用于日志）。
pub fn mirror_canary_origin_url() -> String {
    format!("https://{MIRROR_CANARY_ORIGIN}/{MIRROR_CANARY_PATH}")
}

// ===================== 模组文件：有序候选 =====================

/// 该模组文件 URL 的候选顺序（首项主选，其余兜底）。
///
/// `mirror_first` 为 false 时官方在前、镜像兜底；true 时镜像链在前、官方兜底。
/// 镜像不可用（健康探针失败）时只返回官方 URL。
pub fn candidates(url: &str, mirror_first: bool) -> Vec<String> {
    let official = to_official(url);
    let chain = mirror_chain(&official);
    if chain.is_empty() || !mirror_available() {
        return vec![official];
    }
    let mut out = Vec::with_capacity(chain.len() + 1);
    if mirror_first {
        out.extend(chain);
        out.push(official);
    } else {
        out.push(official);
        out.extend(chain);
    }
    dedup(out)
}

/// 主选 URL。
pub fn primary(url: &str, mirror_first: bool) -> String {
    candidates(url, mirror_first)
        .into_iter()
        .next()
        .unwrap_or_else(|| url.to_string())
}

/// 兜底 URL（已排除主选）。
pub fn fallbacks(url: &str, mirror_first: bool) -> Vec<String> {
    let mut c = candidates(url, mirror_first);
    if c.len() <= 1 {
        return Vec::new();
    }
    c.remove(0);
    c
}

/// 把任意形态（官方 / MCIM / QML 节点）的模组 URL 归一为官方 URL。
fn to_official(url: &str) -> String {
    let Some(host) = url_host(url) else {
        return url.to_string();
    };
    let Some(tail) = url_tail(url) else {
        return url.to_string();
    };
    // MCIM 按路径首段区分文件来源。
    if host == MCIM_HOST {
        let official_host = if tail.starts_with("files/") {
            "mediafilez.forgecdn.net"
        } else {
            "cdn.modrinth.com"
        };
        return format!("https://{official_host}/{tail}");
    }
    if MODRINTH_MIRROR_HOSTS.contains(&host) {
        return format!("https://cdn.modrinth.com/{tail}");
    }
    if GENERIC_MIRROR_HOSTS.contains(&host) {
        // 通用节点同时透传 Modrinth(/data/) 与 CF(/files/) 路径。
        let official_host = if tail.starts_with("data/") {
            "cdn.modrinth.com"
        } else {
            "mediafilez.forgecdn.net"
        };
        return format!("https://{official_host}/{tail}");
    }
    url.to_string()
}

/// 由官方 URL 生成镜像候选：MCIM（若覆盖）→ QML 节点。
fn mirror_chain(official: &str) -> Vec<String> {
    let Some(host) = url_host(official) else {
        return Vec::new();
    };
    let Some(tail) = url_tail(official) else {
        return Vec::new();
    };
    let mut out = Vec::new();

    // MCIM 只覆盖 cdn.modrinth.com 与 edge.forgecdn.net。
    if host == "cdn.modrinth.com" || host == "edge.forgecdn.net" {
        out.push(format!("https://{MCIM_HOST}/{tail}"));
    }

    let group: &[&str] = if MODRINTH_CDN_HOSTS.contains(&host) {
        MODRINTH_MIRROR_HOSTS
    } else if CURSEFORGE_CDN_HOSTS.contains(&host) {
        GENERIC_MIRROR_HOSTS
    } else {
        return out;
    };
    out.extend(group.iter().map(|h| format!("https://{h}/{tail}")));
    dedup(out)
}

// ===================== 原版：官方 ↔ BMCLAPI =====================

/// 原版文件「与主选相反的一侧」候选，用于兜底。
///
/// 只覆盖路径 1:1 可互换的域名：`libraries.minecraft.net` ↔
/// `bmclapi2.bangbang93.com/maven`、`resources.download.minecraft.net` ↔
/// `bmclapi2.bangbang93.com/assets`。客户端 jar 与版本清单在 BMCLAPI 上是另一套
/// 路径（`version/{id}/client`），无法纯 URL 改写，保持单源。
pub fn vanilla_fallback(
    url: &str,
    primary: crate::services::source_policy::VanillaSource,
) -> Vec<String> {
    use crate::services::source_policy::VanillaSource;
    let alt = match primary {
        VanillaSource::Official => official_to_bmclapi(url),
        VanillaSource::Bmclapi => bmclapi_to_official(url),
    };
    alt.into_iter().collect()
}

fn official_to_bmclapi(url: &str) -> Option<String> {
    let host = url_host(url)?;
    let tail = url_tail(url)?;
    match host {
        "libraries.minecraft.net" => Some(format!("https://{BMCLAPI_HOST}/maven/{tail}")),
        "resources.download.minecraft.net" => Some(format!("https://{BMCLAPI_HOST}/assets/{tail}")),
        _ => None,
    }
}

fn bmclapi_to_official(url: &str) -> Option<String> {
    let host = url_host(url)?;
    if host != BMCLAPI_HOST {
        return None;
    }
    let tail = url_tail(url)?;
    if let Some(rest) = tail.strip_prefix("maven/") {
        return Some(format!("https://libraries.minecraft.net/{rest}"));
    }
    if let Some(rest) = tail.strip_prefix("assets/") {
        return Some(format!("https://resources.download.minecraft.net/{rest}"));
    }
    None
}

// ===================== 工具 =====================

fn url_host(url: &str) -> Option<&str> {
    let (_scheme, rest) = url.split_once("://")?;
    Some(match rest.find('/') {
        Some(i) => &rest[..i],
        None => rest,
    })
}

fn url_tail(url: &str) -> Option<&str> {
    let (_scheme, rest) = url.split_once("://")?;
    rest.split_once('/').map(|(_, tail)| tail)
}

fn dedup(urls: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(urls.len());
    for u in urls {
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

// ===================== 健康探针 =====================

/// 探测一次镜像可用性。
///
/// 判定标准比「能连上」严格：要求 2xx，且**实际收到的字节数与 Content-Length 一致**。
/// 故障节点会先回 200 头再让 body 挂住，只看到达状态码会误判为健康。
pub async fn probe_mirror(client: &reqwest::Client) -> bool {
    let url = mirror_canary_url();
    let Ok(resp) = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
    else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let declared = resp.content_length();
    match resp.bytes().await {
        Ok(body) => {
            if body.is_empty() {
                return false;
            }
            declared.is_none_or(|d| d == body.len() as u64)
        }
        Err(_) => false,
    }
}

/// 启动后台健康探针（进程内只启动一次），结果写入 [`MIRROR_AVAILABLE`]。
pub fn start_health_probe(client: reqwest::Client, interval: std::time::Duration) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        loop {
            let ok = probe_mirror(&client).await;
            let was = mirror_available();
            set_mirror_available(ok);
            if was != ok {
                if ok {
                    tracing::info!(url = %mirror_canary_url(), "文件镜像恢复可用，重新启用镜像链");
                } else {
                    tracing::warn!(
                        url = %mirror_canary_url(),
                        origin = %mirror_canary_origin_url(),
                        "文件镜像探针失败（挂起/截断），临时降级为官方源"
                    );
                }
            }
            tokio::time::sleep(interval).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::source_policy::VanillaSource;

    fn m() -> (String, String) {
        (
            "https://cdn.modrinth.com/data/abc/1.0.jar".to_string(),
            "https://mediafilez.forgecdn.net/files/1/2/a.jar".to_string(),
        )
    }

    #[test]
    fn modrinth_mirror_first_orders_mcim_then_qml_then_official() {
        set_mirror_available(true);
        let (mr, _) = m();
        let c = candidates(&mr, true);
        assert_eq!(
            c[0], "https://mod.mcimirror.top/data/abc/1.0.jar",
            "MCIM 应为主选"
        );
        assert_eq!(c[1], "https://modrinth.qomicex.dpdns.org/data/abc/1.0.jar");
        assert_eq!(c[2], "https://modrinth1.qomicex.dpdns.org/data/abc/1.0.jar");
        assert_eq!(*c.last().unwrap(), mr, "官方兜底必须在最后");
    }

    #[test]
    fn official_first_keeps_mirrors_as_fallback() {
        set_mirror_available(true);
        let (mr, _) = m();
        let c = candidates(&mr, false);
        assert_eq!(c[0], mr, "官方优先时主选就是官方");
        assert!(
            c.iter().any(|u| u.contains("mod.mcimirror.top")),
            "镜像仍须作为兜底存在: {c:?}"
        );
        assert_eq!(official_first_len(&c), 1, "官方只出现一次");
    }

    fn official_first_len(c: &[String]) -> usize {
        c.iter().filter(|u| u.contains("cdn.modrinth.com")).count()
    }

    #[test]
    fn curseforge_skips_mcim_and_goes_qml() {
        set_mirror_available(true);
        let (_, cf) = m();
        let c = candidates(&cf, true);
        assert_eq!(
            c[0], "https://mirror.qomicex.dpdns.org/files/1/2/a.jar",
            "mediafilez 不在 MCIM 覆盖范围，QML 直接主选"
        );
        assert_eq!(c[1], "https://mirror1.qomicex.dpdns.org/files/1/2/a.jar");
        assert_eq!(*c.last().unwrap(), cf);
        assert!(
            !c.iter().any(|u| u.contains("mcimirror")),
            "CF 落地域名不得走 MCIM"
        );
    }

    #[test]
    fn dead_mirror_host_is_gone() {
        // lenmei233.dpdns.org 已停止服务，不得再出现在任何候选里。
        set_mirror_available(true);
        let (mr, cf) = m();
        for c in [candidates(&mr, true), candidates(&cf, true)] {
            assert!(
                !c.iter().any(|u| u.contains("lenmei233")),
                "候选里不应再有已关闭的节点: {c:?}"
            );
        }
    }

    #[test]
    fn mirror_unavailable_degrades_to_official_only() {
        set_mirror_available(false);
        let (mr, _) = m();
        assert_eq!(candidates(&mr, true), vec![mr.clone()]);
        assert_eq!(candidates(&mr, false), vec![mr]);
        set_mirror_available(true);
    }

    #[test]
    fn mirror_url_normalizes_back_to_official() {
        set_mirror_available(false);
        let qml = "https://modrinth.qomicex.dpdns.org/data/abc/1.0.jar";
        assert_eq!(
            candidates(qml, true),
            vec!["https://cdn.modrinth.com/data/abc/1.0.jar".to_string()],
            "已是镜像形态的 URL 在镜像不可用时也要能回到官方"
        );
        set_mirror_available(true);
    }

    #[test]
    fn vanilla_fallback_swaps_libraries_and_assets() {
        let lib = "https://libraries.minecraft.net/net/minecraft/minecraft.jar";
        assert_eq!(
            vanilla_fallback(lib, VanillaSource::Official),
            vec!["https://bmclapi2.bangbang93.com/maven/net/minecraft/minecraft.jar".to_string()]
        );
        let lib_bmc = "https://bmclapi2.bangbang93.com/maven/net/minecraft/minecraft.jar";
        assert_eq!(
            vanilla_fallback(lib_bmc, VanillaSource::Bmclapi),
            vec!["https://libraries.minecraft.net/net/minecraft/minecraft.jar".to_string()],
            "BMCLAPI 形态还原成官方时去掉 maven 前缀"
        );
        let asset = "https://resources.download.minecraft.net/ab/abcdef";
        assert_eq!(
            vanilla_fallback(asset, VanillaSource::Official),
            vec!["https://bmclapi2.bangbang93.com/assets/ab/abcdef".to_string()]
        );
        // 客户端 jar 路径不可 1:1 互换 → 不给兜底（宁可不猜）
        let jar = "https://piston-data.mojang.com/v1/objects/aa/bb/client.jar";
        assert!(vanilla_fallback(jar, VanillaSource::Official).is_empty());
    }
}
