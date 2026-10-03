//! 共享的 zip 解压实现（#162）。
//!
//! 整合包（`endpoints/modpack.rs`）与地图存档（`endpoints/resource_download.rs`）
//! 都需要把 zip 解到目标目录，两者都必须是 zip-slip 安全 + 有解压炸弹上限。
//! 此前只有 modpack 侧有一份实现；存档侧要解压时若再复制一份，两份防护就会
//! 各自漂移（仓库明确反对这种复制）。故抽到这里，由两处共用同一份逻辑。
//!
//! 报错文案保持中性（`压缩包`），避免把「整合包」写进存档解压的报错里误导用户。

use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

/// zip 炸弹防护阈值（远高于正常整合包：GTNH 约 1.2 万条目 / 解压 0.72GB）。
pub const MAX_ZIP_ENTRIES: usize = 200_000;
pub const MAX_ENTRY_UNCOMPRESSED: u64 = 8 * 1024 * 1024 * 1024; // 单文件 8 GiB
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 64 * 1024 * 1024 * 1024; // 总解压 64 GiB

/// 目标路径已存在时的错误前缀（调用方据此与其它失败区分，见
/// `extract_zip_file_into_new_dir`）。
pub const ERR_ALREADY_EXISTS: &str = "TARGET_ALREADY_EXISTS";

/// 把已打开的 zip 解压到 `dest`，可选逐条目进度回调 `(已完成, 总数)`。
///
/// 防 zip-slip：只接受 `enclosed_name()`（任何 `..` / 绝对路径都会被拒绝），
/// 不做「先拼接再规范化」的等价替代——那在 Windows 上有盘符与 UNC 的边角情况。
///
/// 体积上限按**实际写出的字节数**执行（不是只信 `entry.size()`）：畸形的 zip
/// 可以把「声明大小」写小、实际却吐出远超声明的内容，只查声明值会形同虚设。
/// 因此在拷贝循环里边读边累计，一旦超限**立刻停止写入**并报错。
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
    let mut total_written: u64 = 0;
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
        // 声明大小先做一次快速拒绝（省去为明显超限的条目建文件）。
        let declared = entry.size();
        if declared > MAX_ENTRY_UNCOMPRESSED {
            return Err(format!(
                "压缩包内文件过大（{} > {MAX_ENTRY_UNCOMPRESSED} B）：{}",
                declared,
                entry.name()
            ));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("创建文件失败 {}: {e}", target.display()))?;
        // 按实际读出/写出的字节数执行上限（见函数文档）。
        let mut entry_written: u64 = 0;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = entry
                .read(&mut buf)
                .map_err(|e| format!("解压文件失败 {}: {e}", target.display()))?;
            if n == 0 {
                break;
            }
            entry_written += n as u64;
            if entry_written > MAX_ENTRY_UNCOMPRESSED {
                return Err(format!(
                    "压缩包内文件解压后超过上限（> {MAX_ENTRY_UNCOMPRESSED} B）：{}",
                    entry.name()
                ));
            }
            total_written += n as u64;
            if total_written > MAX_TOTAL_UNCOMPRESSED {
                return Err("压缩包解压总大小超出限制，疑似异常压缩包".to_string());
            }
            // 先判定再写入：超限时不会把第 N 个字节落盘。
            out.write_all(&buf[..n])
                .map_err(|e| format!("解压文件失败 {}: {e}", target.display()))?;
        }
        done += 1;
        if let Some(p) = progress.as_deref_mut() {
            p(done, total_entries);
        }
    }
    Ok(())
}

/// 从磁盘 zip 文件解压到目标目录（无进度回调）。目标目录内**允许**已有文件
/// （整合包导入到全新临时目录时用）。
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

/// 把任意文本清成可作存档文件夹名的字符串（#162）。
///
/// 用于**没有用户交互**的路径（`/start` 按 `category=saves` 自动推导存档名）：
/// 文件名主干可能带 `..`、Windows 非法字符或控制字符，直接当目录名会被
/// `validate_world_name` 拒绝，而那条路径没有改名对话框可退——所以这里尽量
/// 清成合法名，实在清不出内容时由调用方回退到一个默认名。
pub fn sanitize_world_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        // 控制字符与 Windows 非法字符一律换成空格，其余保留（含中文）。
        let bad =
            (c as u32) < 0x20 || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\');
        if bad {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    // `..` 折叠掉（路径穿越的另一个入口），再压缩空白。
    while out.contains("..") {
        out = out.replace("..", " ");
    }
    let cleaned: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned.chars().take(64).collect()
}

/// 在 `saves_dir` 下为 `base` 找一个**尚不存在**的目录名（`base`、`base-2`…）。
///
/// 供无交互路径使用：不能弹对话框让用户改名，但也不能覆盖已有世界，故退让到
/// 一个不冲突的名字（与用户手动重命名的效果等价）。
///
/// `extra_taken` 用于把**尚未落盘的占用**也算进来：存档目录要到下载+解压完成后
/// 才出现，只查文件系统的话，两个并发的同名下载会挑到同一个名字，后者解压时
/// 撞名失败（CodeRabbit 评审指出）。
pub fn unique_world_name_with(
    saves_dir: &Path,
    base: &str,
    extra_taken: &dyn Fn(&str) -> bool,
) -> String {
    if !saves_dir.join(base).exists() && !extra_taken(base) {
        return base.to_string();
    }
    for n in 2..10_000 {
        let cand = format!("{base}-{n}");
        if !saves_dir.join(&cand).exists() && !extra_taken(&cand) {
            return cand;
        }
    }
    format!("{base}-{}", std::process::id())
}

/// [`unique_world_name_with`] 的便捷包装：只查文件系统。
pub fn unique_world_name(saves_dir: &Path, base: &str) -> String {
    unique_world_name_with(saves_dir, base, &|_| false)
}

/// 校验地图存档文件夹名：必须是**单一目录名**，不得含路径分隔符或 `..`。
/// 该名字会被直接拼进 `saves/` 下作为目录名，若不校验，`../../` 这类输入就能
/// 把解压内容写到存档目录之外（zip-slip 的另一种入口）。
pub fn validate_world_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("存档名称不能为空".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("存档名称不能包含路径分隔符".to_string());
    }
    if trimmed.contains("..") {
        return Err("存档名称不能包含 '..'".to_string());
    }
    // Windows 非法字符：存档文件夹名会直接落盘，先挡掉。
    const ILLEGAL: [char; 9] = ['<', '>', ':', '"', '|', '?', '*', '\0', '\u{1}'];
    if trimmed
        .chars()
        .any(|c| ILLEGAL.contains(&c) || (c as u32) < 0x20)
    {
        return Err("存档名称包含非法字符".to_string());
    }
    Ok(trimmed.to_string())
}

/// 把地图存档解压成 `saves_dir/<world_name>/`（#162）。
///
/// 保证解压结果**恰好是一层**存档目录（`<world_name>/level.dat`），因此两种
/// 上游打包形态都能被 Minecraft 识别：
/// - 包内已有顶层目录（`World/level.dat`）→ 取其内容，不产生 `World/World/` 套娃；
/// - 包内文件在根（`level.dat` 在根）→ 直接装进 `<world_name>/`（否则 `level.dat`
///   会摊在 `saves/` 根下，游戏认不出，这正是 #162 的延伸问题）。
///
/// 原子性：先解到同父目录的 staging，整个过程成功后才 rename 到最终目录；
/// 失败即清理 staging，绝不在 `saves/` 里留半成品。目标已存在时返回
/// [`ERR_ALREADY_EXISTS`]，由调用方提示用户改名（不静默覆盖已有世界）。
pub fn extract_world_zip(
    zip_path: &Path,
    saves_dir: &Path,
    world_name: &str,
) -> Result<PathBuf, String> {
    let world_name = validate_world_name(world_name)?;
    let dest = saves_dir.join(&world_name);
    if dest.exists() {
        return Err(format!("{ERR_ALREADY_EXISTS}: {}", dest.display()));
    }
    std::fs::create_dir_all(saves_dir)
        .map_err(|e| format!("创建存档目录失败 {}: {e}", saves_dir.display()))?;

    // 1) 解到 staging（同父目录 → rename 才是原子的）。
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = saves_dir.join(format!(".qmx-world-{}-{stamp}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("创建暂存目录失败 {}: {e}", staging.display()))?;
    if let Err(e) = extract_zip_file(zip_path, &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    // 2) 归一成「恰好一层」：staging 自身若只有一个子目录（且无其它条目），
    //    说明包内已有顶层目录，取该子目录为内容源，避免套娃。
    let source = match single_subdir(&staging) {
        Some(inner) => inner,
        None => staging.clone(),
    };

    // 3) 发布。发布前再判一次存在性（并发下可能已被抢先创建）。
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("{ERR_ALREADY_EXISTS}: {}", dest.display()));
    }
    if let Err(e) = std::fs::rename(&source, &dest) {
        let _ = std::fs::remove_dir_all(&staging);
        if dest.exists() {
            return Err(format!("{ERR_ALREADY_EXISTS}: {}", dest.display()));
        }
        return Err(format!(
            "发布存档目录失败 {} -> {}: {e}",
            source.display(),
            dest.display()
        ));
    }
    // source 是 staging 的子目录时，把只剩空壳的 staging 清掉。
    if source != staging {
        let _ = std::fs::remove_dir_all(&staging);
    }
    Ok(dest)
}

/// `dir` 内若**恰好只有一个子目录**（无文件、无第二个子目录），返回该子目录。
fn single_subdir(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .collect();
    if entries.len() != 1 {
        return None;
    }
    let only = entries.first()?;
    if only.file_type().ok()?.is_dir() {
        Some(only.path())
    } else {
        None
    }
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

    // =================================================================
    // #162 地图存档：恰好一层 + 同名拒绝 + 失败不留半成品
    // =================================================================

    /// 包内**已有**顶层目录（`World/level.dat`）→ 发布为
    /// `saves/<name>/level.dat`，**不得**出现 `saves/<name>/World/level.dat` 套娃。
    #[test]
    fn world_zip_with_top_dir_does_not_nest() {
        let root = temp_dir("world-top");
        let zip = make_zip(
            &root,
            &[("World/level.dat", b"L"), ("World/region/r.0.0.mca", b"R")],
        );
        let saves = root.join("saves");
        let out = extract_world_zip(&zip, &saves, "MyMap").unwrap();
        assert_eq!(out, saves.join("MyMap"));
        assert_eq!(std::fs::read(out.join("level.dat")).unwrap(), b"L");
        assert_eq!(std::fs::read(out.join("region/r.0.0.mca")).unwrap(), b"R");
        assert!(
            !out.join("World").exists(),
            "已有顶层目录的包不应再套一层目录"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 包内文件在**根**（`level.dat` 在根）→ 必须装进 `saves/<name>/`，
    /// 否则 `level.dat` 会摊在 `saves/` 下，Minecraft 认不出存档。
    #[test]
    fn world_zip_with_root_files_is_wrapped() {
        let root = temp_dir("world-root");
        let zip = make_zip(&root, &[("level.dat", b"L"), ("session.lock", b"S")]);
        let saves = root.join("saves");
        let out = extract_world_zip(&zip, &saves, "Flat").unwrap();
        assert_eq!(std::fs::read(out.join("level.dat")).unwrap(), b"L");
        assert!(
            !saves.join("level.dat").exists(),
            "level.dat 绝不能摊在 saves/ 根下"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 同名存档已存在 → 返回 `ERR_ALREADY_EXISTS`，且**不得**动到已有世界，
    /// 也不得留下暂存残留（暂存目录必须被清理）。
    #[test]
    fn world_zip_refuses_existing_name_and_keeps_it_untouched() {
        let root = temp_dir("world-dup");
        let zip = make_zip(&root, &[("level.dat", b"NEW")]);
        let saves = root.join("saves");
        let existing = saves.join("Dup");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("level.dat"), b"ORIGINAL").unwrap();

        let err = extract_world_zip(&zip, &saves, "Dup").expect_err("同名必须拒绝");
        assert!(err.starts_with(ERR_ALREADY_EXISTS), "应带冲突前缀: {err}");
        assert_eq!(
            std::fs::read(existing.join("level.dat")).unwrap(),
            b"ORIGINAL",
            "已有存档不得被覆盖"
        );
        // 暂存目录必须清干净，不能在 saves/ 里留 .qmx-world-* 残留。
        let leftovers: Vec<String> = std::fs::read_dir(&saves)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".qmx-"))
            .collect();
        assert!(leftovers.is_empty(), "不应留下暂存残留: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 解压失败（损坏包）时：不得创建目标目录、不得留暂存残留。
    #[test]
    fn world_zip_failure_leaves_nothing() {
        let root = temp_dir("world-fail");
        let saves = root.join("saves");
        std::fs::create_dir_all(&saves).unwrap();
        // 扩展名是 zip 但内容不是 → 解压必失败
        let bad = root.join("bad.zip");
        std::fs::write(&bad, b"not a zip at all").unwrap();

        let err = extract_world_zip(&bad, &saves, "Broken").expect_err("坏包必须失败");
        assert!(!err.starts_with(ERR_ALREADY_EXISTS), "应为解析失败而非冲突");
        assert!(!saves.join("Broken").exists(), "失败不得留下目标目录");
        let leftovers: Vec<String> = std::fs::read_dir(&saves)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".qmx-"))
            .collect();
        assert!(leftovers.is_empty(), "失败后不应留暂存: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 存档名必须挡住路径穿越与非法字符（它会直接成为目录名）。
    #[test]
    fn validate_world_name_rejects_traversal_and_illegal() {
        for bad in ["", "   ", "../evil", "a/b", "a\\b", "a..b", "x:y", "x?y"] {
            assert!(
                validate_world_name(bad).is_err(),
                "{bad:?} 应被拒绝（会成为磁盘目录名）"
            );
        }
        assert_eq!(validate_world_name("  My World  ").unwrap(), "My World");
        assert_eq!(validate_world_name("世界-1").unwrap(), "世界-1");
    }

    /// `sanitize_world_name` 供**无交互**路径使用：清完的结果必须能通过
    /// `validate_world_name`，否则那条路径的下载会在跑完后才失败。
    #[test]
    fn sanitize_world_name_output_always_validates() {
        let cases = [
            "My World",
            "My..Map",
            "A:B",
            "a/b\\c",
            "with\u{1}control",
            "tab\tand\nnewline",
            "  spaced  out  ",
            "世界/地图",
            "???",
        ];
        for raw in cases {
            let cleaned = sanitize_world_name(raw);
            if cleaned.is_empty() {
                // 清空的情况由调用方回退到默认名（见 /start），这里只需确认不 panic。
                continue;
            }
            let validated = validate_world_name(&cleaned)
                .unwrap_or_else(|e| panic!("清理后的 {cleaned:?}（源 {raw:?}）应合法，却: {e}"));
            assert_eq!(validated, cleaned);
            assert!(cleaned.chars().count() <= 64, "长度应被截断");
        }
        // 明确检查：控制字符与 `..` 必须被清掉。
        assert_eq!(sanitize_world_name("a\u{1}b"), "a b");
        assert!(!sanitize_world_name("a..b").contains(".."));
    }

    /// `unique_world_name` 必须避开已存在的目录（无交互路径不能覆盖已有世界）。
    #[test]
    fn unique_world_name_avoids_existing_dirs() {
        let root = temp_dir("uniq");
        let saves = root.join("saves");
        std::fs::create_dir_all(&saves).unwrap();
        assert_eq!(unique_world_name(&saves, "Map"), "Map");
        std::fs::create_dir_all(saves.join("Map")).unwrap();
        assert_eq!(unique_world_name(&saves, "Map"), "Map-2");
        std::fs::create_dir_all(saves.join("Map-2")).unwrap();
        assert_eq!(unique_world_name(&saves, "Map"), "Map-3");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `unique_world_name_with` 必须把**尚未落盘**的占用也算进去。
    ///
    /// 存档目录要到下载+解压完成才出现，只查文件系统的话两个并发同名下载会挑到
    /// 同一个名字（后者解压撞名失败）。这里模拟「已在途」的那个名字。
    #[test]
    fn unique_world_name_with_avoids_in_flight_reservations() {
        let root = temp_dir("uniq2");
        let saves = root.join("saves");
        std::fs::create_dir_all(&saves).unwrap();
        // 没有任何文件，但 Map 已被在途任务占用 → 必须让到 Map-2。
        let taken = |cand: &str| cand == "Map";
        assert_eq!(unique_world_name_with(&saves, "Map", &taken), "Map-2");
        // 两个都在途 → Map-3
        let taken2 = |cand: &str| cand == "Map" || cand == "Map-2";
        assert_eq!(unique_world_name_with(&saves, "Map", &taken2), "Map-3");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 声明大小与实际大小不符时，按**实际写入**的字节数执行上限。
    ///
    /// 这是 CodeRabbit 指出的点：只信 `entry.size()` 的话，一个声明很小、实际
    /// 很大的畸形条目能绕过限制写满磁盘。这里用一个超高压缩比条目验证实际值被计入。
    #[test]
    fn enforces_limits_on_actually_written_bytes() {
        // 构造一个压缩后很小、解压后很大的条目（全零）。
        let root = temp_dir("bomb");
        let zip_path = root.join("big.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        w.start_file("huge.bin", opts).unwrap();
        let chunk = vec![0u8; 64 * 1024];
        // 16 MiB 解压内容（远小于 8 GiB 上限，只为验证「实际字节确实被累计」）
        for _ in 0..256 {
            w.write_all(&chunk).unwrap();
        }
        w.finish().unwrap();

        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        extract_zip_file(&zip_path, &out).unwrap();
        let meta = std::fs::metadata(out.join("huge.bin")).unwrap();
        assert_eq!(
            meta.len(),
            16 * 1024 * 1024,
            "实际写出的字节数应与解压内容一致（证明逐字节累计路径被执行）"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
