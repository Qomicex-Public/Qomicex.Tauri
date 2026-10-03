//! 共享的 zip 解压实现（#162）。
//!
//! 整合包（`endpoints/modpack.rs`）与地图存档（`endpoints/resource_download.rs`）
//! 都需要把 zip 解到目标目录，两者都必须是 zip-slip 安全 + 有解压炸弹上限。
//! 此前只有 modpack 侧有一份实现；存档侧要解压时若再复制一份，两份防护就会
//! 各自漂移（仓库明确反对这种复制）。故抽到这里，由两处共用同一份逻辑。
//!
//! 报错文案保持中性（`压缩包`），避免把「整合包」写进存档解压的报错里误导用户。

use std::io::{Read, Seek};
use std::path::Path;

/// zip 炸弹防护阈值（远高于正常整合包：GTNH 约 1.2 万条目 / 解压 0.72GB）。
pub const MAX_ZIP_ENTRIES: usize = 200_000;
pub const MAX_ENTRY_UNCOMPRESSED: u64 = 8 * 1024 * 1024 * 1024; // 单文件 8 GiB
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 64 * 1024 * 1024 * 1024; // 总解压 64 GiB

/// 把已打开的 zip 解压到 `dest`，可选逐条目进度回调 `(已完成, 总数)`。
///
/// 防 zip-slip：只接受 `enclosed_name()`（任何 `..` / 绝对路径都会被拒绝），
/// 不做「先拼接再规范化」的等价替代——那在 Windows 上有盘符与 UNC 的边角情况。
pub fn extract_archive<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    dest: &Path,
    mut progress: Option<&mut dyn FnMut(usize, usize)>,
) -> Result<(), String> {
    let total_entries = archive.len();
    if total_entries > MAX_ZIP_ENTRIES {
        return Err(format!(
            "压缩包条目数过多（{total_entries} > {MAX_ZIP_ENTRIES}），疑似异常压缩包"
        ));
    }
    let mut total_uncompressed: u64 = 0;
    let mut done: usize = 0;
    for i in 0..total_entries {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩包条目失败: {e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("压缩包内含非法路径（zip-slip）".to_string());
        };
        let rel: &Path = enclosed.as_ref();
        let target = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("创建目录失败 {}: {e}", target.display()))?;
            done += 1;
            if let Some(p) = progress.as_deref_mut() {
                p(done, total_entries);
            }
            continue;
        }
        let size = entry.size();
        if size > MAX_ENTRY_UNCOMPRESSED {
            return Err(format!(
                "压缩包内文件过大（{} > {MAX_ENTRY_UNCOMPRESSED} B）：{}",
                size,
                entry.name()
            ));
        }
        total_uncompressed += size;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
            return Err("压缩包解压总大小超出限制，疑似异常压缩包".to_string());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("创建文件失败 {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("解压文件失败 {}: {e}", target.display()))?;
        done += 1;
        if let Some(p) = progress.as_deref_mut() {
            p(done, total_entries);
        }
    }
    Ok(())
}

/// 从磁盘 zip 文件解压到目标目录（无进度回调）。
pub fn extract_zip_file(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开压缩包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败: {e}"))?;
    extract_archive(&mut archive, dest, None)
}

/// 从磁盘 zip 文件解压到目标目录并逐条目上报进度 `(已完成条目, 总条目)`。
pub fn extract_zip_file_progressed(
    zip_path: &Path,
    dest: &Path,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开压缩包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败: {e}"))?;
    extract_archive(&mut archive, dest, Some(progress))
}

/// 从内存字节解压到目标目录。
pub fn extract_zip(data: &[u8], dest: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("读取压缩包失败: {e}"))?;
    extract_archive(&mut archive, dest, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 在临时目录建一个 zip，条目为 `(name, content)`。
    fn make_zip(dir: &Path, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let path = dir.join("test.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(content).unwrap();
        }
        w.finish().unwrap();
        path
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "qomicex-archive-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 正常解压：目录与文件都落盘，内容一致。
    #[test]
    fn extracts_files_and_dirs() {
        let root = temp_dir("ok");
        let zip = make_zip(
            &root,
            &[("level.dat", b"world"), ("region/r.0.0.mca", b"chunk")],
        );
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        extract_zip_file(&zip, &out).unwrap();
        assert_eq!(std::fs::read(out.join("level.dat")).unwrap(), b"world");
        assert_eq!(
            std::fs::read(out.join("region/r.0.0.mca")).unwrap(),
            b"chunk"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 进度回调必须被调用，且最后一次是 `(总数, 总数)`。
    #[test]
    fn reports_progress_upto_total() {
        let root = temp_dir("prog");
        let zip = make_zip(&root, &[("a.txt", b"1"), ("b.txt", b"2")]);
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let mut seen: Vec<(usize, usize)> = Vec::new();
        extract_zip_file_progressed(&zip, &out, &mut |done, total| seen.push((done, total)))
            .unwrap();
        assert_eq!(seen.last().copied(), Some((2, 2)));
        assert_eq!(seen.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// zip-slip：含 `..` 的条目必须整包拒绝，且不得在目标目录外写出任何文件。
    #[test]
    fn rejects_zip_slip_entry() {
        let root = temp_dir("slip");
        let zip = make_zip(&root, &[("../escaped.txt", b"pwned")]);
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let err = extract_zip_file(&zip, &out).expect_err("zip-slip 必须被拒绝");
        assert!(err.contains("zip-slip"), "错误信息应说明原因，实际: {err}");
        assert!(
            !root.join("escaped.txt").exists(),
            "绝不能在目标目录之外写出文件"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 拒绝的同时不得留下半成品：这个包只有一个条目，拒绝即不应产生任何输出文件。
    #[test]
    fn rejection_leaves_no_partial_output() {
        let root = temp_dir("partial");
        let zip = make_zip(&root, &[("../evil.txt", b"x")]);
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let _ = extract_zip_file(&zip, &out);
        let produced: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert!(produced.is_empty(), "不应留下半成品: {produced:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
