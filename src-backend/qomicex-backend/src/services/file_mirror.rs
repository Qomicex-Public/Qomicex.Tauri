//! 资源（mod 文件 CDN）下载源重写。
//!
//! 按「资源下载源」设置（`settings.file_download_source`）把 Modrinth / CurseForge 的
//! 文件 CDN 域名重写到用户自建镜像（QML Mirror）。API key（x-api-key）判断仍基于
//! 重写前的原始 host（镜像透传 key），见 [`is_cf_file_source`]。

/// QML Mirror 镜像域名（常量映射；用户自建，镜像透传 api key，支持 HTTP/2）。
const MIRROR_MODRINTH: &str = "modrinth.lenmei233.dpdns.org";
const MIRROR_CURSEFORGE: &str = "mirror.lenmei233.dpdns.org";

/// Modrinth 官方文件 CDN 域名（需重写到 QML Mirror）。
const MODRINTH_CDN_HOSTS: &[&str] = &["cdn.modrinth.com", "cdn-alt.modrinth.com"];
/// CurseForge 官方文件 CDN 落地域名。
const CURSEFORGE_CDN_HOSTS: &[&str] = &["mediafilez.forgecdn.net"];

/// 按文件下载源重写一个下载 URL。
///
/// - `file_download_source == 1`（QML Mirror）：把 `cdn.modrinth.com`/`cdn-alt.modrinth.com`
///   替换为 `modrinth.lenmei233.dpdns.org`，`mediafilez.forgecdn.net` 替换为
///   `mirror.lenmei233.dpdns.org`（仅 host，保留 scheme/路径/查询）。
/// - 其他值（0 = 官方源）：原样返回。
pub fn rewrite_file_cdn(url: &str, file_download_source: i32) -> String {
    if file_download_source != 1 {
        return url.to_string();
    }
    rewrite_host(url, MODRINTH_CDN_HOSTS, MIRROR_MODRINTH).unwrap_or_else(|| {
        rewrite_host(url, CURSEFORGE_CDN_HOSTS, MIRROR_CURSEFORGE)
            .unwrap_or_else(|| url.to_string())
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
    fn mirror_leaves_other_hosts_untouched() {
        let u = "https://libraries.minecraft.net/net/minecraft/minecraft.jar";
        assert_eq!(rewrite_file_cdn(u, 1), u);
    }
}
