//! 资源（mod 文件 CDN）下载源重写。
//!
//! 按「资源下载源」设置（`settings.file_download_source`）把 Modrinth / CurseForge 的
//! 文件 CDN 域名重写到用户自建镜像（QML Mirror）。API key（x-api-key）判断仍基于
//! 重写前的原始 host（镜像透传 key），见 [`is_cf_file_source`]。

/// QML Mirror 镜像域名（常量映射；用户自建，镜像透传 api key，支持 HTTP/2）。
const MIRROR_MODRINTH: &str = "modrinth.lenmei233.dpdns.org";
const MIRROR_CURSEFORGE: &str = "mirror.lenmei233.dpdns.org";
/// QML Mirror HK 镜像域名（第二个自建镜像，行为与 QML Mirror 一致）。
const MIRROR_HK_MODRINTH: &str = "modrinth.qomicex.dpdns.org";
const MIRROR_HK_CURSEFORGE: &str = "mirror.qomicex.dpdns.org";

/// Modrinth 官方文件 CDN 域名（需重写到 QML Mirror）。
const MODRINTH_CDN_HOSTS: &[&str] = &["cdn.modrinth.com", "cdn-alt.modrinth.com"];
/// CurseForge 官方文件 CDN 落地域名。
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
/// 下载器支持 `mirror_urls`（重试耗尽后轮换），此前 backend 从未填充 → 主节点抽风即
/// 整体安装失败。非镜像 URL 返回空（官方源无需备选）。
pub fn mirror_fallback_urls(url: &str) -> Vec<String> {
    let Some(host) = url_host(url) else {
        return Vec::new();
    };
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
/// - `file_download_source == 1`（QML Mirror）：把 `cdn.modrinth.com`/`cdn-alt.modrinth.com`
///   替换为 `modrinth.lenmei233.dpdns.org`，`mediafilez.forgecdn.net` 替换为
///   `mirror.lenmei233.dpdns.org`（仅 host，保留 scheme/路径/查询）。
/// - `file_download_source == 2`（QML Mirror HK）：同 QML Mirror，但域名换成
///   `modrinth.qomicex.dpdns.org` / `mirror.qomicex.dpdns.org`。
/// - 其他值（0 = 官方源）：原样返回。
pub fn rewrite_file_cdn(url: &str, file_download_source: i32) -> String {
    let (modrinth, curseforge) = match file_download_source {
        1 => (MIRROR_MODRINTH, MIRROR_CURSEFORGE),
        2 => (MIRROR_HK_MODRINTH, MIRROR_HK_CURSEFORGE),
        _ => return url.to_string(),
    };
    rewrite_host(url, MODRINTH_CDN_HOSTS, modrinth).unwrap_or_else(|| {
        rewrite_host(url, CURSEFORGE_CDN_HOSTS, curseforge).unwrap_or_else(|| url.to_string())
    })
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
        assert_eq!(
            rewrite_file_cdn("https://cdn.modrinth.com/data/abc/1.0.jar", 1),
            "https://modrinth.lenmei233.dpdns.org/data/abc/1.0.jar"
        );
        assert_eq!(
            rewrite_file_cdn("https://cdn-alt.modrinth.com/data/xyz/file.jar?x=1", 1),
            "https://modrinth.lenmei233.dpdns.org/data/xyz/file.jar?x=1"
        );
    }

    #[test]
    fn mirror_rewrites_curseforge_host() {
        assert_eq!(
            rewrite_file_cdn("https://mediafilez.forgecdn.net/files/1234/5678/a.jar", 1),
            "https://mirror.lenmei233.dpdns.org/files/1234/5678/a.jar"
        );
    }

    #[test]
    fn mirror_hk_rewrites_modrinth_and_curseforge_host() {
        assert_eq!(
            rewrite_file_cdn("https://cdn.modrinth.com/data/abc/1.0.jar", 2),
            "https://modrinth.qomicex.dpdns.org/data/abc/1.0.jar"
        );
        assert_eq!(
            rewrite_file_cdn("https://mediafilez.forgecdn.net/files/1234/5678/a.jar", 2),
            "https://mirror.qomicex.dpdns.org/files/1234/5678/a.jar"
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
}
