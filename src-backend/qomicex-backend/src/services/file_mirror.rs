// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 模组文件 CDN 的镜像链、加载器 meta/installer 的 QML-Mirror 通道、
//! 以及原版资源的官方/BMCLAPI 互换。
//!
//! 分工（流量保护策略，见 docs guide/mirror.mdx）：
//! - **模组文件**（cdn.modrinth.com / forgecdn）：镜像链只保留 **MCIM**
//!   （大型公益镜像，为文件流量设计）；自有 QML 节点已撤下，未覆盖域名走官方。
//! - **加载器 meta 与 installer**（小体积、边缘强缓存）：走 **QML-Mirror**
//!   （`mirror.shenv.top` 前缀路由）。官方兜底保留；文档标注「暂不可用」的前缀
//!   （neoforge/legacyfabric/babric/cleanroom/sponge/libraries/assets）不接入。
//! - **原版文件**：官方 ↔ BMCLAPI 互换（既有行为）。
//!
//! 具体「先官方还是先镜像」由 [`crate::services::source_policy`] 决定，本模块只
//! 负责生成有序候选；**偏好只是优先级，两个方向都保留兜底**。

use std::sync::atomic::{AtomicBool, Ordering};

/// MCIM 公共镜像（模组文件）。
const MCIM_HOST: &str = "mod.mcimirror.top";
/// QML-Mirror（加载器 meta/installer，路径前缀路由）。
const QML_MIRROR_HOST: &str = "mirror.shenv.top";

/// Modrinth 官方文件 CDN 域名。
const MODRINTH_CDN_HOSTS: &[&str] = &["cdn.modrinth.com", "cdn-alt.modrinth.com"];
/// CurseForge 官方文件 CDN 落地域名。
const CURSEFORGE_CDN_HOSTS: &[&str] = &["mediafilez.forgecdn.net", "edge.forgecdn.net"];

/// 已撤下的自有镜像节点（仅用于把历史形态 URL 归一回官方，不再生成候选）。
const RETIRED_QML_MODRINTH_HOSTS: &[&str] =
    &["modrinth.qomicex.dpdns.org", "modrinth1.qomicex.dpdns.org"];
const RETIRED_QML_GENERIC_HOSTS: &[&str] =
    &["mirror.qomicex.dpdns.org", "mirror1.qomicex.dpdns.org"];

/// 加载器 meta / maven 官方域名 → QML-Mirror 路径前缀。
///
/// 只收录 mirror.mdx 标注**可用**的前缀；「暂不可用」的（neoforge、legacyfabric、
/// babric、cleanroom、sponge、libraries、assets）不接——接了只会引入必挂的候选。
const LOADER_MIRROR_PREFIXES: &[(&str, &str)] = &[
    ("meta.fabricmc.net", "mc-fabric-meta"),
    ("meta.quiltmc.org", "mc-quilt-meta"),
    ("maven.minecraftforge.net", "mc-forge"),
    ("files.minecraftforge.net", "mc-forge-files"),
    ("maven.fabricmc.net", "mc-fabric"),
    ("maven.quiltmc.org", "mc-quilt"),
    ("repo.maven.apache.org", "mc-apache"),
];

/// BMPLAPI 的三个路径前缀（与 core `bmclapi_download_source` 一致）。
const BMCLAPI_HOST: &str = "bmclapi2.bangbang93.com";
/// Forge 官方 maven（安装器与 loader 依赖）。
const FORGE_MAVEN_HOST: &str = "maven.minecraftforge.net";
/// NeoForge 官方 maven（制品位于 releases/ 下）。
const NEOFORGE_MAVEN_HOST: &str = "maven.neoforged.net";
/// NeoForge maven 的 ForgeCDN 镜像（路径与官方 maven 完全同构：`releases/...`）。
///
/// 为什么需要它：`maven.neoforged.net` 在部分网络下完全不可达（实测 DNS 可解析
/// 但 TLS 连接超时），而 `neoforged.forgecdn.net` 是 NeoForge 官方 CDN、可用且
/// 更快。QML-Mirror 的 `mc-neoforge` 前缀在 mirror.mdx 里标注「暂不可用」，
/// BMCLAPI 的 `/maven` 也代理了 NeoForge，但两者都不如官方 CDN 稳定。
const NEOFORGE_FORGECDN_HOST: &str = "neoforged.forgecdn.net";

/// 镜像健康探针的 canary 文件（公开、稳定、几十 KB 的 CF 文件）。
///
/// 用真实文件而不是站点根路径：故障形态是「回 200 + Content-Length，body 永不到达」，
/// 只探根路径会误判为健康。探针打在 MCIM（模组链唯一镜像）上。
const MIRROR_CANARY_PATH: &str = "files/2503/41/MmmMmmMmmMmm-1.12-1.14.jar";
const MIRROR_CANARY_ORIGIN: &str = "edge.forgecdn.net";

/// 镜像当前是否可用。`true` 是默认值（保持既有行为：镜像优先）。
static MIRROR_AVAILABLE: AtomicBool = AtomicBool::new(true);

pub fn set_mirror_available(available: bool) {
    MIRROR_AVAILABLE.store(available, Ordering::Relaxed);
}

pub fn mirror_available() -> bool {
    MIRROR_AVAILABLE.load(Ordering::Relaxed)
}

/// 探针目标：canary 在 MCIM 上的地址。
pub fn mirror_canary_url() -> String {
    format!("https://{MCIM_HOST}/{MIRROR_CANARY_PATH}")
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

/// 把任意形态（官方 / MCIM / 已撤下的 QML 节点）的模组 URL 归一为官方 URL。
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
    if RETIRED_QML_MODRINTH_HOSTS.contains(&host) {
        return format!("https://cdn.modrinth.com/{tail}");
    }
    if RETIRED_QML_GENERIC_HOSTS.contains(&host) {
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

/// 由官方 URL 生成模组文件镜像候选：**只含 MCIM**（自有节点已撤下，
/// 见模块头注释的流量分工策略）。未覆盖域名返回空（即纯官方）。
fn mirror_chain(official: &str) -> Vec<String> {
    let Some(host) = url_host(official) else {
        return Vec::new();
    };
    let Some(tail) = url_tail(official) else {
        return Vec::new();
    };
    // MCIM 只覆盖 cdn.modrinth.com 与 edge.forgecdn.net。
    if host == "cdn.modrinth.com" || host == "edge.forgecdn.net" {
        vec![format!("https://{MCIM_HOST}/{tail}")]
    } else {
        Vec::new()
    }
}

// ===================== 加载器 meta/installer：官方 ↔ QML-Mirror =====================

/// 加载器 meta/maven 官方 URL → QML-Mirror 形态（前缀路由）。未覆盖返回 None。
pub fn loader_mirror_url(url: &str) -> Option<String> {
    let host = url_host(url)?;
    let tail = url_tail(url)?;
    let prefix = LOADER_MIRROR_PREFIXES
        .iter()
        .find(|(h, _)| *h == host)
        .map(|(_, p)| *p)?;
    Some(format!("https://{QML_MIRROR_HOST}/{prefix}/{tail}"))
}

/// QML-Mirror 形态 URL → 官方 URL（前缀反查）。非镜像形态返回 None。
fn loader_official_url(url: &str) -> Option<String> {
    if url_host(url)? != QML_MIRROR_HOST {
        return None;
    }
    let tail = url_tail(url)?;
    let (prefix, rest) = tail.split_once('/')?;
    let host = LOADER_MIRROR_PREFIXES
        .iter()
        .find(|(_, p)| *p == prefix)
        .map(|(h, _)| *h)?;
    Some(format!("https://{host}/{rest}"))
}

/// 加载器 meta/installer 的「另一侧」候选：官方 ↔ QML-Mirror 互换。
///
/// 挂在下载任务的镜像备选上：主选官方时镜像兜底、主选镜像时官方兜底。
/// 不受 [`mirror_available`] 探针控制（那是模组文件的 MCIM 探针）；
/// 加载器文件小且边缘缓存，官方兜底已足够可靠。
pub fn loader_fallback_urls(url: &str) -> Vec<String> {
    if let Some(m) = loader_mirror_url(url) {
        return vec![m];
    }
    loader_official_url(url)
        .map(|o| vec![o])
        .unwrap_or_default()
}

// ===================== 原版：官方 ↔ BMCLAPI =====================

/// 原版文件「与主选相反的一侧」候选，用于兜底。
///
/// 只覆盖路径 1:1 可互换的域名：`libraries.minecraft.net` ↔
/// `bmclapi2.bangbang93.com/maven`、`resources.download.minecraft.net` ↔
/// `bmclapi2.bangbang93.com/assets`、`maven.minecraftforge.net` / NeoForge maven
/// （`maven.neoforged.net/releases`）↔ `bmclapi2.bangbang93.com/maven`。
/// 客户端 jar 与版本清单在 BMCLAPI 上是另一套路径（`version/{id}/client`），
/// 无法纯 URL 改写，保持单源。
pub fn vanilla_fallback(
    url: &str,
    primary: crate::services::source_policy::VanillaSource,
) -> Vec<String> {
    use crate::services::source_policy::VanillaSource;
    let alt = match primary {
        VanillaSource::Official => official_to_bmclapi(url),
        VanillaSource::Bmclapi => bmclapi_to_official(url),
    };
    let mut out: Vec<String> = alt.into_iter().collect();
    // NeoForge 的 maven 额外挂 ForgeCDN（官方 CDN，路径同构）。官方 maven 在部分
    // 网络下直接不可达，BMCLAPI 是二手代理、时效性与完整度都不如官方 CDN。
    if let Some(cdn) = neoforge_maven_to_forgecdn(url) {
        if !out.iter().any(|u| u == &cdn) {
            out.push(cdn);
        }
    }
    out
}

/// `maven.neoforged.net/releases/...` ↔ `neoforged.forgecdn.net/releases/...`。
///
/// 两个 host 的路径完全一致（实测 installer 与全部依赖库都 200），所以是纯
/// host 替换；BMCLAPI 形态（`/maven/net/neoforged/...`）先还原成官方 maven 再转。
fn neoforge_maven_to_forgecdn(url: &str) -> Option<String> {
    let official = match url_host(url)? {
        NEOFORGE_MAVEN_HOST => url.to_string(),
        BMCLAPI_HOST => bmclapi_to_official(url)?,
        _ => return None,
    };
    let rest = official.strip_prefix(&format!("https://{NEOFORGE_MAVEN_HOST}/"))?;
    if rest.is_empty() {
        return None;
    }
    Some(format!("https://{NEOFORGE_FORGECDN_HOST}/{rest}"))
}

fn official_to_bmclapi(url: &str) -> Option<String> {
    let host = url_host(url)?;
    let tail = url_tail(url)?;
    match host {
        "libraries.minecraft.net" => Some(format!("https://{BMCLAPI_HOST}/maven/{tail}")),
        "resources.download.minecraft.net" => Some(format!("https://{BMCLAPI_HOST}/assets/{tail}")),
        FORGE_MAVEN_HOST => Some(format!("https://{BMCLAPI_HOST}/maven/{tail}")),
        NEOFORGE_MAVEN_HOST => {
            let rest = tail.strip_prefix("releases/")?;
            Some(format!("https://{BMCLAPI_HOST}/maven/{rest}"))
        }
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
        // BMCLAPI 的 /maven 同时代理 Mojang、Forge 与 NeoForge 的 maven 仓库，
        // 只能按坐标前缀还原到对应官方 host。
        if rest.starts_with("net/minecraftforge/") {
            return Some(format!("https://{FORGE_MAVEN_HOST}/{rest}"));
        }
        if rest.starts_with("net/neoforged/") {
            return Some(format!("https://{NEOFORGE_MAVEN_HOST}/releases/{rest}"));
        }
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

    /// 这些用例共享进程级 MIRROR_AVAILABLE 开关，并行执行会互相干扰。
    static MIRROR_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_mirror_state() -> std::sync::MutexGuard<'static, ()> {
        MIRROR_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
    use crate::services::source_policy::VanillaSource;

    fn m() -> (String, String) {
        (
            "https://cdn.modrinth.com/data/abc/1.0.jar".to_string(),
            "https://mediafilez.forgecdn.net/files/1/2/a.jar".to_string(),
        )
    }

    #[test]
    fn modrinth_mirror_first_orders_mcim_then_official() {
        let _guard = lock_mirror_state();
        set_mirror_available(true);
        let (mr, _) = m();
        let c = candidates(&mr, true);
        assert_eq!(
            c,
            vec![
                "https://mod.mcimirror.top/data/abc/1.0.jar".to_string(),
                mr.clone(),
            ],
            "模组镜像链只保留 MCIM，官方兜底在最后"
        );
    }

    #[test]
    fn official_first_keeps_mirrors_as_fallback() {
        let _guard = lock_mirror_state();
        set_mirror_available(true);
        let (mr, _) = m();
        let c = candidates(&mr, false);
        assert_eq!(c[0], mr, "官方优先时主选就是官方");
        assert!(
            c.iter().any(|u| u.contains("mod.mcimirror.top")),
            "MCIM 仍须作为兜底存在: {c:?}"
        );
        assert_eq!(official_first_len(&c), 1, "官方只出现一次");
    }

    fn official_first_len(c: &[String]) -> usize {
        c.iter().filter(|u| u.contains("cdn.modrinth.com")).count()
    }

    #[test]
    fn curseforge_edge_gets_mcim_mediafilez_official_only() {
        let _guard = lock_mirror_state();
        set_mirror_available(true);
        let (_, cf) = m();
        // mediafilez 不在 MCIM 覆盖范围：纯官方（自有节点已撤下）
        assert_eq!(candidates(&cf, true), vec![cf.clone()]);
        // edge.forgecdn.net 在 MCIM 覆盖范围：MCIM → 官方
        let edge = "https://edge.forgecdn.net/files/1/2/a.jar";
        assert_eq!(
            candidates(edge, true),
            vec![
                "https://mod.mcimirror.top/files/1/2/a.jar".to_string(),
                edge.to_string(),
            ]
        );
    }

    #[test]
    fn retired_qml_hosts_absent_from_candidates_but_normalize() {
        let _guard = lock_mirror_state();
        set_mirror_available(true);
        let (mr, cf) = m();
        for c in [candidates(&mr, true), candidates(&cf, true)] {
            assert!(
                !c.iter().any(|u| u.contains("qomicex.dpdns.org")),
                "已撤下的自有节点不得出现在候选里: {c:?}"
            );
        }
        // 历史镜像形态仍能归一回官方（老任务/缓存里的 URL 不至于死链）
        set_mirror_available(false);
        let legacy = "https://mirror.qomicex.dpdns.org/files/1/2/a.jar";
        assert_eq!(
            candidates(legacy, true),
            vec!["https://mediafilez.forgecdn.net/files/1/2/a.jar".to_string()]
        );
        set_mirror_available(true);
    }

    #[test]
    fn loader_meta_and_installer_swap_to_qml_mirror() {
        let forge_installer = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar";
        let mirrored = "https://mirror.shenv.top/mc-forge/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar";
        assert_eq!(
            loader_mirror_url(forge_installer).as_deref(),
            Some(mirrored)
        );
        // 对称：镜像形态能还原官方（兜底方向）
        assert_eq!(
            loader_official_url(mirrored).as_deref(),
            Some(forge_installer)
        );
        assert_eq!(
            loader_fallback_urls(forge_installer),
            vec![mirrored.to_string()]
        );
        assert_eq!(
            loader_fallback_urls(mirrored),
            vec![forge_installer.to_string()]
        );

        // Fabric meta（小 JSON）走 mc-fabric-meta 前缀
        let meta = "https://meta.fabricmc.net/v2/versions/installer";
        assert_eq!(
            loader_mirror_url(meta).as_deref(),
            Some("https://mirror.shenv.top/mc-fabric-meta/v2/versions/installer")
        );

        // 「暂不可用」的前缀（neoforge 等）不接入
        let neo = "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-installer.jar";
        assert_eq!(loader_mirror_url(neo), None);
        // 模组文件 host 不属于加载器通道
        let (mr, _) = m();
        assert_eq!(loader_mirror_url(&mr), None);
    }

    #[test]
    fn mirror_unavailable_degrades_to_official_only() {
        let _guard = lock_mirror_state();
        set_mirror_available(false);
        let (mr, _) = m();
        assert_eq!(candidates(&mr, true), vec![mr.clone()]);
        assert_eq!(candidates(&mr, false), vec![mr]);
        set_mirror_available(true);
    }

    #[test]
    fn mirror_url_normalizes_back_to_official() {
        let _guard = lock_mirror_state();
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
    fn forge_and_neoforge_maven_swap_to_bmclapi() {
        let forge = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar";
        let forge_bmcl = "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar";
        assert_eq!(
            vanilla_fallback(forge, VanillaSource::Official),
            vec![forge_bmcl.to_string()]
        );
        assert_eq!(
            vanilla_fallback(forge_bmcl, VanillaSource::Bmclapi),
            vec![forge.to_string()]
        );

        // NeoForge 现在有 ForgeCDN 候选（官方 CDN，官方 maven 不可达时的主力兜底），
        // 精确断言见 neoforge_maven_also_offers_forgecdn；这里只验证 BMCLAPI 兜底仍在。
        let neo = "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-installer.jar";
        let neo_bmcl =
            "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-installer.jar";
        assert!(vanilla_fallback(neo, VanillaSource::Official).contains(&neo_bmcl.to_string()));
        assert!(vanilla_fallback(neo_bmcl, VanillaSource::Bmclapi).contains(&neo.to_string()));
    }

    #[test]
    fn neoforge_maven_also_offers_forgecdn() {
        let neo = "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.233/neoforge-21.1.233-installer.jar";
        let cdn = "https://neoforged.forgecdn.net/releases/net/neoforged/neoforge/21.1.233/neoforge-21.1.233-installer.jar";
        let bmcl = "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.233/neoforge-21.1.233-installer.jar";
        let got = vanilla_fallback(neo, VanillaSource::Official);
        assert!(got.contains(&bmcl.to_string()), "BMCLAPI 兜底仍在: {got:?}");
        assert!(got.contains(&cdn.to_string()), "ForgeCDN 候选缺失: {got:?}");

        // BMCLAPI 形态也要能转到 ForgeCDN（老任务/缓存里的 URL）
        let got = vanilla_fallback(bmcl, VanillaSource::Bmclapi);
        assert!(
            got.contains(&cdn.to_string()),
            "BMCLAPI→ForgeCDN 失败: {got:?}"
        );

        // 非 NeoForge 的 maven 不得被误转
        let forge = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar";
        for u in vanilla_fallback(forge, VanillaSource::Official) {
            assert!(
                !u.contains("neoforged.forgecdn.net"),
                "Forge 不应挂 NeoForge CDN: {u}"
            );
        }
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
