// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! `mods/` 下坏 jar 的检测、隔离与重下。
//!
//! ## 为什么需要单独扫描 mods/
//!
//! 版本 JSON 的缺失文件清单只覆盖游戏本体、库、资源与主 jar，`mods/` 里的文件不在其中。
//! 而 NeoForge（FML 4.x）启动时会读取 `mods/` 下**每个非空 `.jar`** 的 zip 目录：
//! `ModDirTransformerDiscoverer` → `TransformerDiscovererConstants.shouldLoadInServiceLayer`
//! → `JarContents.of(...)`，读到 `zip END header not found` 就抛 `ZipException`，被包成
//! `UncheckedIOException` 后由 early display 直接崩在
//! 「An unexpected IO error occurred trying to setup the game directory」。
//!
//! 也就是说：一个不完整的 `.jar`（下载被截断、镜像给了错误页、解压中断）足以让整个实例
//! 无法启动，且报错信息完全不提文件名。这里的扫描把「哪个文件坏了」变成可操作的信息。
//!
//! ## 修复策略
//!
//! 坏文件内容不可信，留在 `mods/` 里只会继续让启动失败。统一先隔离（改名为
//! `{name}.broken`，保留用户数据、不直接删除），能确定原始下载地址的再补下回来
//! （见 [`resolve_modrinth_urls`]）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use qomicex_core::core::GameCore;

/// 一个无法作为 zip 打开的模组文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokenJar {
    /// 文件名（`mods/` 下，不含目录）。
    pub name: String,
    /// 相对实例根目录的路径（统一 `/` 分隔），可直接用于下载目标。
    pub rel: String,
    /// 磁盘上的字节数（0 = 下载未写入任何内容）。
    pub size: u64,
}

/// 扫描 `mods_dir` 下打不开的 `.jar`。
///
/// 只有目录不存在才返回空列表（没有 `mods/` 本身不是错误）。目录存在但读不动
/// （权限、被占用）必须向上传播：吞掉会让校验接口把「读不了」报成「资源完整」。
pub fn scan_broken_jars(mods_dir: &Path) -> std::io::Result<Vec<BrokenJar>> {
    let entries = match std::fs::read_dir(mods_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out: Vec<BrokenJar> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // FML 只处理 `.jar`（大小写不敏感比较，与 Windows 文件系统一致）。
        let is_jar = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("jar"));
        if !is_jar {
            continue;
        }
        if zip_is_readable(&path) {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(BrokenJar {
            rel: format!("mods/{name}"),
            name,
            size,
        });
    }
    out.sort_by_key(|b| b.name.to_lowercase());
    Ok(out)
}

/// 能否作为 zip 打开（等价于 FML 对 `mods/` 里每个 jar 做的事）。
fn zip_is_readable(path: &Path) -> bool {
    std::fs::File::open(path)
        .ok()
        .and_then(|f| zip::ZipArchive::new(f).ok())
        .is_some()
}

/// 把坏 jar 改名为 `{name}.broken`，返回隔离后的文件名。
///
/// 不删除：坏文件里可能是用户手工改过的内容，隔离后仍可人工恢复。
/// 目标已存在（上一次隔离残留）时先删掉它，避免 `rename` 因目标占用失败。
pub fn quarantine(instance_dir: &Path, jar: &BrokenJar) -> Result<String, String> {
    let src = instance_dir.join(&jar.rel);
    let target_name = format!("{}.broken", jar.name);
    let target = src.with_file_name(&target_name);
    if target.exists() {
        std::fs::remove_file(&target)
            .map_err(|e| format!("清理旧隔离文件失败 {}: {e}", target.display()))?;
    }
    std::fs::rename(&src, &target).map_err(|e| {
        format!(
            "隔离坏模组失败 {} -> {}: {e}",
            src.display(),
            target.display()
        )
    })?;
    Ok(target_name)
}

/// 用已知的正确 SHA-1 反查 Modrinth 上的原始下载地址。
///
/// 命中条件必须是「文件哈希与清单一致」：返回 `sha1（小写）→ (下载 URL, 字节数)`。
/// 只反查清单里记录的哈希——坏文件自身的哈希对不上任何在线文件，拿它去查没有意义。
///
/// 失败一律降级为空映射：反查只是「能否自动补回」的优化，不能阻断补全流程。
pub async fn resolve_modrinth_urls(
    core: &Arc<GameCore>,
    hashes: &[String],
) -> HashMap<String, (String, i64)> {
    if hashes.is_empty() {
        return HashMap::new();
    }
    let mr = core.create_modrinth_source();
    let mut wanted: Vec<String> = hashes
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect();
    wanted.sort();
    wanted.dedup();

    // Modrinth 的 version_files 接口按哈希批量查询，单次请求不宜过大。
    const CHUNK: usize = 100;
    let mut out: HashMap<String, (String, i64)> = HashMap::new();
    for chunk in wanted.chunks(CHUNK) {
        let found = match mr.get_project_versions_from_hashes_dict(chunk).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "坏模组重下：Modrinth 哈希反查失败，跳过自动补下");
                continue;
            }
        };
        // 反查只给版本 ID，文件清单要再查一次版本详情。
        let mut version_ids: Vec<String> = found.values().map(|v| v.id.clone()).collect();
        version_ids.sort();
        version_ids.dedup();
        for version_id in version_ids {
            let Ok(info) = mr.get_version_info(&version_id).await else {
                continue;
            };
            for file in info.files.unwrap_or_default() {
                let Some(sha1) = file.hashes.and_then(|h| h.sha1) else {
                    continue;
                };
                let sha1 = sha1.to_ascii_lowercase();
                if !wanted.contains(&sha1) || file.download_url.is_empty() {
                    continue;
                }
                out.entry(sha1).or_insert((file.download_url, file.size));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            use std::io::Write as _;
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn detects_truncated_and_empty_jars() {
        let dir = std::env::temp_dir().join(format!("qmx-mods-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        write_zip(&dir.join("good.jar"), &[("fabric.mod.json", b"{}")]);
        std::fs::write(dir.join("truncated.jar"), b"PK\x03\x04not-a-real-zip").unwrap();
        std::fs::write(dir.join("empty.jar"), b"").unwrap();
        std::fs::write(dir.join("notes.txt"), b"not a jar").unwrap();

        let broken = scan_broken_jars(&dir).unwrap();
        let names: Vec<&str> = broken.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["empty.jar", "truncated.jar"]);
        assert_eq!(broken[0].rel, "mods/empty.jar");
        assert_eq!(broken[0].size, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_mods_dir_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("qmx-mods-none-{}", std::process::id()));
        assert!(scan_broken_jars(&dir).unwrap().is_empty());
    }

    #[test]
    fn unreadable_mods_dir_is_an_error() {
        // 目录位置是个文件：read_dir 必然失败，此时不能报「没有坏 jar」。
        let dir = std::env::temp_dir().join(format!("qmx-mods-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let not_a_dir = dir.join("mods");
        std::fs::write(&not_a_dir, b"").unwrap();

        assert!(scan_broken_jars(&not_a_dir).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_renames_and_keeps_bytes() {
        let dir = std::env::temp_dir().join(format!("qmx-mods-quarantine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods/bad.jar"), b"half").unwrap();

        let jar = BrokenJar {
            name: "bad.jar".to_string(),
            rel: "mods/bad.jar".to_string(),
            size: 4,
        };
        let new_name = quarantine(&dir, &jar).unwrap();
        assert_eq!(new_name, "bad.jar.broken");
        assert!(!dir.join("mods/bad.jar").exists());
        assert_eq!(
            std::fs::read(dir.join("mods/bad.jar.broken")).unwrap(),
            b"half"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_overwrites_previous_leftover() {
        let dir = std::env::temp_dir().join(format!("qmx-mods-quarantine2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods/bad.jar"), b"new").unwrap();
        std::fs::write(dir.join("mods/bad.jar.broken"), b"old").unwrap();

        let jar = BrokenJar {
            name: "bad.jar".to_string(),
            rel: "mods/bad.jar".to_string(),
            size: 3,
        };
        quarantine(&dir, &jar).unwrap();
        assert_eq!(
            std::fs::read(dir.join("mods/bad.jar.broken")).unwrap(),
            b"new"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_known_good_jar() {
        let dir = std::env::temp_dir().join(format!("qmx-mods-good-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_zip(&dir.join("fine.JAR"), &[("a", b"b")]);
        assert!(scan_broken_jars(&dir).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
