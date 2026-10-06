//! 资源（mod 文件 CDN）下载源重写。
//!
//! 按「文件下载源」设置（`settings.file_download_source`）把 Modrinth / CurseForge 的
//! 文件 CDN 域名重写到镜像。镜像源（1）= **MCIM 优先**，MCIM 不覆盖的域名由 QML
//! Mirror 承接；运行期容错由下载器 `mirror_urls` 回退链提供（镜像节点互备 → 官方
//! CDN 兜底），见 [`mirror_fallback_urls`]。api key（x-api-key）判断仍基于重写前的
//! 原始 host（镜像透传 key），见 resource_download / modpack 的调用点。

/// QML Mirror 镜像域名（常量映射；用户自建，镜像透传 api key，支持 HTTP/2）。
const MIRROR_MODRINTH: &str = "modrinth.lenmei233.dpdns.org";
const MIRROR_CURSEFORGE: &str = "mirror.lenmei233.dpdns.org";

/// MCIM（公共镜像）域名。覆盖范围严格按其官方文档
/// (mcimirror.top/guide/platform/{files,modrinth,curseforge}) 声明：
/// `cdn.modrinth.com` 与 `edge.forgecdn.net` 走 MCIM（302 到文件镜像）；
/// **禁止**替换 `mediafilez.forgecdn.net`；文件下载本身不保证稳定，故必须保留
/// 回退链而不是只押 MCIM。
const MCIM_HOST: &str = "mod.mcimirror.top";

/// Modrinth 官方文件 CDN 域名（镜像源下 `cdn.modrinth.com` 优先重写到 MCIM，
/// `cdn-alt.modrinth.com` 不在 MCIM 文档覆盖范围内、走 QML Mirror）。
const MODRINTH_CDN_HOSTS: &[&str] = &["cdn.modrinth.com", "cdn-alt.modrinth.com"];
/// CurseForge 官方文件 CDN 落地域名（MCIM 明确禁止接管，恒走 QML Mirror）。
const CURSEFORGE_CDN_HOSTS: &[&str] = &["mediafilez.forgecdn.net"];

/// Modrinth CDN 镜像节点（互为故障转移；见 docs.qomicex.top/guide/mirror.html）。
const MODRINTH_MIRROR_HOSTS: &[&str] = &[
    "modrinth.lenmei233.dpdns.org",
    "modrinth.qomicex.dpdns.org",
    "modrinth1.qomicex.dpdns.org",
];
/// CurseForge（及通用）镜像节点（互为故障转移）。
const GENERIC_MIRROR_HOSTS: &[&str] = &[
    "mirror.lenmei233.dpdns.org",
    "mirror.qomicex.dpdns.org",
    "mirror1.qomicex.dpdns.org",
];

/// 已知镜像 URL → 同组其余节点重写后的 URL（故障转移备选）。
///
/// 官方文档明确「多个节点自动故障转移，某个不可用时换另一个」；实测
/// `modrinth.qomicex.dpdns.org` 高并发下会间歇性断连/截断响应体（40 并发约 8 失败），
/// 而同批文件的 `modrinth1.qomicex.dpdns.org` / `modrinth.lenmei233.dpdns.org` 正常。
/// 下载器支持 `mirror_urls`（重试耗尽后轮换）。MCIM 主节点同样享受此机制：主重写
/// 目标抽风时逐节点轮换，最终官方 CDN 兜底。非镜像 URL 返回空（官方源无需备选）。
pub fn mirror_fallback_urls(url: &str) -> Vec<String> {
    let Some(host) = url_host(url) else {
        return Vec::new();
    };
    if host == MCIM_HOST {
        // MCIM 主节点未命中（限流/故障）时按文件来源回退：MCIM 对 Modrinth 与 CF
        // 文件共用一个 host，仅路径首段不同（Modrinth=/data/...，CF=/files/...），
        // 官方兜底域名也必须按此区分，否则会把 `/data/` 路径兜到 mediafilez 上 404。
        let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
        let is_cf_file = rest
            .split_once('/')
            .map(|(_, path)| path.starts_with("files/") || path.starts_with("files?"))
            .unwrap_or(false);
        let (nodes, official): (&[&str], &[&str]) = if is_cf_file {
            (GENERIC_MIRROR_HOSTS, CURSEFORGE_CDN_HOSTS)
        } else {
            (MODRINTH_MIRROR_HOSTS, MODRINTH_CDN_HOSTS)
        };
        return nodes
            .iter()
            .filter_map(|h| rewrite_host(url, &[host], h))
            .chain(
                official
                    .iter()
                    .filter_map(|h| rewrite_host(url, &[host], h)),
            )
            .collect();
    }
    let group: &[&str] = if MODRINTH_MIRROR_HOSTS.contains(&host) {
        MODRINTH_MIRROR_HOSTS
    } else if GENERIC_MIRROR_HOSTS.contains(&host) {
        GENERIC_MIRROR_HOSTS
    } else {
        return Vec::new();
    };
    let mut urls: Vec<String> = group
        .iter()
        .filter(|h| **h != host)
        .filter_map(|h| rewrite_host(url, &[host], h))
        .collect();
    // 镜像节点全部不可用时回退官方 CDN（比直接失败好，尤其自动测速误选到抽风节点时）。
    let official: &[&str] = if MODRINTH_MIRROR_HOSTS.contains(&host) {
        MODRINTH_CDN_HOSTS
    } else {
        CURSEFORGE_CDN_HOSTS
    };
    urls.extend(
        official
            .iter()
            .filter_map(|h| rewrite_host(url, &[host], h)),
    );
    urls
}

/// 提取 URL 的 host（无 `://` 返回 None）。
fn url_host(url: &str) -> Option<&str> {
    let (_scheme, rest) = url.split_once("://")?;
    Some(match rest.find('/') {
        Some(i) => &rest[..i],
        None => rest,
    })
}

/// 按文件下载源重写一个下载 URL。
///
/// - `file_download_source == 1`（镜像源，MCIM 优先）：
///   `cdn.modrinth.com` → `mod.mcimirror.top`（MCIM 文档覆盖）、
///   `edge.forgecdn.net` → `mod.mcimirror.top`；`cdn-alt.modrinth.com` 与
///   `mediafilez.forgecdn.net` 不在 MCIM 覆盖范围内（后者被 MCIM 明确禁止），
///   改走 QML Mirror 域名。仅替换 host，保留 scheme/路径/查询。
/// - 其他值（0 = 官方源）：原样返回。旧值 2（QML Mirror HK）已并入镜像源，
///   settings 加载时迁移为 1。
pub fn rewrite_file_cdn(url: &str, file_download_source: i32) -> String {
    if file_download_source != 1 {
        return url.to_string();
    }
    rewrite_host(url, &["cdn.modrinth.com", "edge.forgecdn.net"], MCIM_HOST)
        .or_else(|| rewrite_host(url, MODRINTH_CDN_HOSTS, MIRROR_MODRINTH))
        .or_else(|| rewrite_host(url, CURSEFORGE_CDN_HOSTS, MIRROR_CURSEFORGE))
        .unwrap_or_else(|| url.to_string())
}

/// 只把给定 host 替换为 new_host；其余（scheme/路径/查询）原样保留。不匹配返回 None。
fn rewrite_host(url: &str, old_hosts: &[&str], new_host: &str) -> Option<String> {
    let (scheme_rest, rest) = url.split_once("://")?;
    let (host, tail) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if old_hosts.iter().any(|h| *h == host) {
        Some(format!("{scheme_rest}://{new_host}{tail}"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_source_is_unchanged() {
        let u = "https://cdn.modrinth.com/data/abc/1.0.jar";
        assert_eq!(rewrite_file_cdn(u, 0), u);
    }

    #[test]
    fn mirror_rewrites_modrinth_host() {
        // cdn.modrinth.com 在 MCIM 覆盖范围内 → MCIM 优先
        assert_eq!(
            rewrite_file_cdn("https://cdn.modrinth.com/data/abc/1.0.jar", 1),
            "https://mod.mcimirror.top/data/abc/1.0.jar"
        );
        // cdn-alt.modrinth.com 不在 MCIM 覆盖范围 → QML Mirror
        assert_eq!(
            rewrite_file_cdn("https://cdn-alt.modrinth.com/data/xyz/file.jar?x=1", 1),
            "https://modrinth.lenmei233.dpdns.org/data/xyz/file.jar?x=1"
        );
    }

    #[test]
    fn mirror_rewrites_curseforge_host() {
        // mediafilez.forgecdn.net 被 MCIM 官方明确禁止接管 → 直接走 QML Mirror
        assert_eq!(
            rewrite_file_cdn("https://mediafilez.forgecdn.net/files/1234/5678/a.jar", 1),
            "https://mirror.lenmei233.dpdns.org/files/1234/5678/a.jar"
        );
        // edge.forgecdn.net 在 MCIM 覆盖范围内 → MCIM
        assert_eq!(
            rewrite_file_cdn("https://edge.forgecdn.net/files/1234/5678/a.jar", 1),
            "https://mod.mcimirror.top/files/1234/5678/a.jar"
        );
    }

    #[test]
    fn legacy_source_2_behaves_as_official_before_migration() {
        // 老值 2 已废弃；settings 加载层负责迁移成 1，这里保证未迁移值不会误重写。
        assert_eq!(
            rewrite_file_cdn("https://cdn.modrinth.com/data/abc/1.0.jar", 2),
            "https://cdn.modrinth.com/data/abc/1.0.jar"
        );
    }

    #[test]
    fn mirror_leaves_other_hosts_untouched() {
        let u = "https://libraries.minecraft.net/net/minecraft/minecraft.jar";
        assert_eq!(rewrite_file_cdn(u, 1), u);
    }

    #[test]
    fn fallback_urls_include_sibling_nodes_and_official_cdn() {
        // 回归：日志实测 modrinth.qomicex.dpdns.org 高并发下间歇断连/截断响应体，
        // 下载器重试耗尽后整体安装失败。修复后该节点 URL 应带同组兄弟节点 + 官方 CDN 作备选。
        let u = "https://modrinth.qomicex.dpdns.org/data/abc/1.0.jar";
        let fb = mirror_fallback_urls(u);
        assert!(
            fb.contains(&"https://modrinth.lenmei233.dpdns.org/data/abc/1.0.jar".to_string()),
            "应含兄弟节点 lenmei233: {fb:?}"
        );
        assert!(
            fb.contains(&"https://modrinth1.qomicex.dpdns.org/data/abc/1.0.jar".to_string()),
            "应含兄弟节点 modrinth1: {fb:?}"
        );
        assert!(
            fb.contains(&"https://cdn.modrinth.com/data/abc/1.0.jar".to_string()),
            "应回退官方 CDN: {fb:?}"
        );
        assert!(!fb.contains(&u.to_string()), "不应含自身: {fb:?}");

        // CurseForge 镜像同理
        let c = "https://mirror.qomicex.dpdns.org/files/1/2/a.jar";
        let fbc = mirror_fallback_urls(c);
        assert!(
            fbc.contains(&"https://mirror.lenmei233.dpdns.org/files/1/2/a.jar".to_string()),
            "CF 应含兄弟节点: {fbc:?}"
        );
        assert!(
            fbc.contains(&"https://mediafilez.forgecdn.net/files/1/2/a.jar".to_string()),
            "CF 应回退官方 CDN: {fbc:?}"
        );

        // 非镜像 URL 无备选
        assert!(mirror_fallback_urls("https://cdn.modrinth.com/data/abc/1.0.jar").is_empty());
        assert!(mirror_fallback_urls("https://libraries.minecraft.net/x.jar").is_empty());
    }

    #[test]
    fn mcim_fallback_routes_by_path_segment() {
        // MCIM 主节点故障时：Modrinth 文件（/data/）回退 QML 节点 → 官方 cdn.modrinth.com；
        // CF 文件（/files/）回退 QML 节点 → 官方 mediafilez。官方兜底域名必须按路径首段区分。
        let m = mirror_fallback_urls("https://mod.mcimirror.top/data/abc/1.0.jar");
        assert_eq!(
            m,
            vec![
                "https://modrinth.lenmei233.dpdns.org/data/abc/1.0.jar",
                "https://modrinth.qomicex.dpdns.org/data/abc/1.0.jar",
                "https://modrinth1.qomicex.dpdns.org/data/abc/1.0.jar",
                "https://cdn.modrinth.com/data/abc/1.0.jar",
                "https://cdn-alt.modrinth.com/data/abc/1.0.jar",
            ]
        );
        let c = mirror_fallback_urls("https://mod.mcimirror.top/files/1/2/a.jar");
        assert_eq!(
            c,
            vec![
                "https://mirror.lenmei233.dpdns.org/files/1/2/a.jar",
                "https://mirror.qomicex.dpdns.org/files/1/2/a.jar",
                "https://mirror1.qomicex.dpdns.org/files/1/2/a.jar",
                "https://mediafilez.forgecdn.net/files/1/2/a.jar",
            ]
        );
    }
}
