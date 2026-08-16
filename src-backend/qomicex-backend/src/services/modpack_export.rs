//! 整合包导出服务：把已安装实例打包为 CurseForge zip 或 Modrinth mrpack。
//!
//! 两种格式都生成 `overrides/` 内容目录；mods 通过哈希反查填充清单：
//! - CurseForge：CF fingerprint（32 位 MurmurHash2，种子 1，忽略空白字节）→
//!   `POST /v1/fingerprints` 得 projectID/fileID，写入 `manifest.json` 的
//!   `files[]`（mods 同时留在 `overrides/mods`，CF 惯例双份）。
//! - Modrinth：SHA1 → `POST v2/version_files` 得下载 URL / 哈希 / 大小，写入
//!   `modrinth.index.json` 的 `files[]`；反查命中的 mods 不再进 overrides。
//!   反查不到的 mods 一律留在 `overrides/mods`（保证离线可装）。
//!
//! 反查为 best-effort：失败只影响 files[]，mods 回落 overrides，导出不中断。
//!
//! 源目录 = `{gameDir}/versions/{inst.name}`（版本隔离）或 `{gameDir}`。
//! 排除项：版本 json/jar、`libraries|versions|assets|logs|temp|crash-reports`、
//! 账户缓存（usercache/usernamecache/launcher_*），以及未勾选的
//! `saves`/`screenshots`。

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use qomicex_core::core::GameCore;
use sha1::{Digest, Sha1};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::services::instance::GameInstance;

/// 导出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    CurseForge,
    Modrinth,
}

/// 反查批大小（CF fingerprint 与 Modrinth hash 接口均有请求体上限，保守分批）。
const LOOKUP_BATCH: usize = 50;

/// 内容目录中需要排除的顶层目录（大小写不敏感）。
const EXCLUDED_DIRS: &[&str] = &[
    "libraries",
    "versions",
    "assets",
    "logs",
    "temp",
    "crash-reports",
];

/// 隐私/账户缓存文件（根目录，大小写不敏感）。
const EXCLUDED_ROOT_FILES: &[&str] = &[
    "usercache.json",
    "usernamecache.json",
    "launcher_accounts.json",
    "launcher_profiles.json",
];

/// 构建导出 zip 字节。
pub async fn build_export_zip(
    core: &Arc<GameCore>,
    cf_api_key: &str,
    instance: &GameInstance,
    format: ExportFormat,
    include_saves: bool,
    include_screenshots: bool,
) -> Result<Vec<u8>, String> {
    let source_dir = instance_source_dir(instance);
    if !source_dir.is_dir() {
        return Err(format!(
            "实例目录不存在：{}",
            source_dir.to_string_lossy()
        ));
    }

    // 1. 收集内容条目（含 mods 清单）
    let mut content: Vec<ContentEntry> = Vec::new();
    collect_content(&source_dir, &instance.name, include_saves, include_screenshots, &mut content)?;

    let mod_jars: Vec<ContentEntry> = content
        .iter()
        .filter(|e| !e.is_dir && e.rel.starts_with("mods/") && e.rel.ends_with(".jar"))
        .cloned()
        .collect();

    // 2. 反查 mods（best-effort：反查失败只影响 files[]，mods 回落 overrides，
    //    导出不整体失败——离线/无 API key/限流时仍可打包）
    let resolved: HashMap<String, ResolvedMod> = match format {
        ExportFormat::CurseForge => {
            match cf_reverse_lookup(core, cf_api_key, &mod_jars).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[ModpackExport] CF fingerprint lookup skipped: {e}");
                    HashMap::new()
                }
            }
        }
        ExportFormat::Modrinth => match mr_reverse_lookup(core, &mod_jars).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[ModpackExport] Modrinth hash lookup skipped: {e}");
                HashMap::new()
            }
        },
    };

    // 3. 生成 zip
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    match format {
        ExportFormat::CurseForge => {
            write_cf_manifest(&mut zip, &opts, instance, &resolved)?;
            write_overrides(&mut zip, &opts, &source_dir, &content, &HashSet::new())?;
        }
        ExportFormat::Modrinth => {
            // 反查命中的 mods 走 files[]，不再进 overrides（避免重复）。
            let resolved_rel: HashSet<&str> = resolved.keys().map(|s| s.as_str()).collect();
            write_mr_index(&mut zip, &opts, instance, &resolved)?;
            write_overrides(&mut zip, &opts, &source_dir, &content, &resolved_rel)?;
        }
    }

    let bytes = zip
        .finish()
        .map_err(|e| format!("生成 zip 失败: {e}"))?
        .into_inner();
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// 内容收集
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ContentEntry {
    /// 相对路径（`/` 分隔）。
    rel: String,
    /// 绝对路径。
    abs: PathBuf,
    is_dir: bool,
}

/// 实例内容源目录（版本隔离 → `{gameDir}/versions/{name}`，否则 `{gameDir}`）。
fn instance_source_dir(instance: &GameInstance) -> PathBuf {
    let game_dir = Path::new(&instance.game_dir);
    if instance.version_isolation.unwrap_or(false) {
        game_dir.join("versions").join(&instance.name)
    } else {
        game_dir.to_path_buf()
    }
}

fn collect_content(
    root: &Path,
    version_dir_name: &str,
    include_saves: bool,
    include_screenshots: bool,
    out: &mut Vec<ContentEntry>,
) -> Result<(), String> {
    let version_json = format!("{version_dir_name}.json");
    let version_jar = format!("{version_dir_name}.jar");

    fn walk(
        dir: &Path,
        rel_dir: &str,
        root: &Path,
        version_json: &str,
        version_jar: &str,
        include_saves: bool,
        include_screenshots: bool,
        out: &mut Vec<ContentEntry>,
    ) -> Result<(), String> {
        let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败 {dir:?}: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let file_type = entry
                .file_type()
                .map_err(|e| format!("读取文件类型失败 {path:?}: {e}"))?;
            if file_type.is_dir() {
                let lower = name.to_ascii_lowercase();
                if EXCLUDED_DIRS.iter().any(|d| lower == *d) {
                    continue;
                }
                if !include_saves && lower == "saves" {
                    continue;
                }
                if !include_screenshots && lower == "screenshots" {
                    continue;
                }
                out.push(ContentEntry { rel: rel.clone(), abs: path.clone(), is_dir: true });
                walk(&path, &rel, root, version_json, version_jar, include_saves, include_screenshots, out)?;
            } else if file_type.is_file() {
                // 排除版本 json/jar（仅根目录）与账户缓存
                if rel_dir.is_empty() {
                    if name == version_json || name == version_jar {
                        continue;
                    }
                    if EXCLUDED_ROOT_FILES
                        .iter()
                        .any(|f| name.eq_ignore_ascii_case(f))
                    {
                        continue;
                    }
                }
                out.push(ContentEntry { rel, abs: path, is_dir: false });
            }
        }
        Ok(())
    }

    walk(root, "", root, &version_json, &version_jar, include_saves, include_screenshots, out)
}

// ---------------------------------------------------------------------------
// 反查
// ---------------------------------------------------------------------------

/// 反查结果：相对路径 → 源信息。
struct ResolvedMod {
    /// CurseForge：projectID/fileID；Modrinth：下载 URL 等（见字段）。
    cf_project_id: Option<i32>,
    cf_file_id: Option<i32>,
    mr_sha1: Option<String>,
    mr_download_url: Option<String>,
    mr_size: Option<i64>,
}

/// CurseForge 文件指纹：32 位 MurmurHash2（SEED=1、MULT=1540483477），
/// 忽略空白字节（9=Tab / 10=LF / 13=CR / 32=Space）。
///
/// 参考实现：dstvx/cf_fingerprint（CF 官方 fingerprint DLL 的 Python 移植）。
fn cf_fingerprint(data: &[u8]) -> u32 {
    const MULT: u32 = 1540483477;
    const SEED: u32 = 1;

    let clean: Vec<u8> = data
        .iter()
        .copied()
        .filter(|&b| b != 9 && b != 10 && b != 13 && b != 32)
        .collect();
    let len = clean.len() as u32;
    let mut fp = SEED ^ len;

    let chunk_count = clean.len() / 4;
    let mut i = 0;
    for _ in 0..chunk_count {
        let mut val = u32::from_le_bytes([clean[i], clean[i + 1], clean[i + 2], clean[i + 3]]);
        val = val.wrapping_mul(MULT);
        val ^= val >> 24;
        val = val.wrapping_mul(MULT);
        fp = fp.wrapping_mul(MULT) ^ val;
        i += 4;
    }

    let tail = &clean[i..];
    let mut tail_word: u32 = 0;
    let tl = tail.len();
    if tl >= 3 {
        tail_word ^= (tail[2] as u32) << 16;
    }
    if tl >= 2 {
        tail_word ^= (tail[1] as u32) << 8;
    }
    if tl >= 1 {
        tail_word ^= tail[0] as u32;
    }
    if tl > 0 {
        fp = (fp ^ tail_word).wrapping_mul(MULT);
    }

    fp ^= fp >> 13;
    fp = fp.wrapping_mul(MULT);
    fp ^= fp >> 15;
    fp
}

async fn cf_reverse_lookup(
    core: &Arc<GameCore>,
    cf_api_key: &str,
    mod_jars: &[ContentEntry],
) -> Result<HashMap<String, ResolvedMod>, String> {
    let cf = core.create_curseforge_source(cf_api_key);
    let mut fingerprints: Vec<i64> = Vec::with_capacity(mod_jars.len());
    for e in mod_jars {
        let bytes = std::fs::read(&e.abs)
            .map_err(|err| format!("读取 mod 失败 {}: {err}", e.rel))?;
        fingerprints.push(cf_fingerprint(&bytes) as i64);
    }

    let mut found: HashMap<i64, (i32, i32)> = HashMap::new();
    for chunk in fingerprints.chunks(LOOKUP_BATCH) {
        let matches = cf
            .get_fingerprint_matches(chunk)
            .await
            .map_err(|e| format!("CurseForge 指纹反查失败: {e}"))?;
        for m in matches {
            if let Some(file) = m.file {
                if file.is_available {
                    found.insert(m.fingerprint, (file.mod_id as i32, file.file_id as i32));
                }
            }
        }
    }

    let mut resolved = HashMap::new();
    for (e, fp) in mod_jars.iter().zip(fingerprints) {
        if let Some((pid, fid)) = found.get(&fp) {
            resolved.insert(
                e.rel.clone(),
                ResolvedMod {
                    cf_project_id: Some(*pid),
                    cf_file_id: Some(*fid),
                    mr_sha1: None,
                    mr_download_url: None,
                    mr_size: None,
                },
            );
        }
    }
    Ok(resolved)
}

fn sha1_hex(data: &[u8]) -> String {
    let digest = Sha1::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

async fn mr_reverse_lookup(
    core: &Arc<GameCore>,
    mod_jars: &[ContentEntry],
) -> Result<HashMap<String, ResolvedMod>, String> {
    let mr = core.create_modrinth_source();
    let mut sha1s: Vec<String> = Vec::with_capacity(mod_jars.len());
    for e in mod_jars {
        let bytes = std::fs::read(&e.abs)
            .map_err(|err| format!("读取 mod 失败 {}: {err}", e.rel))?;
        sha1s.push(sha1_hex(&bytes));
    }

    let mut resolved = HashMap::new();
    for chunk in sha1s.chunks(LOOKUP_BATCH) {
        let dict = mr
            .get_project_versions_from_hashes_dict(chunk)
            .await
            .map_err(|e| format!("Modrinth 哈希反查失败: {e}"))?;
        for (hash, version) in dict {
            // 在版本文件里挑 sha1 与本次哈希一致的文件（优先 primary）。
            let matched = version.files.as_deref().and_then(|files| {
                files
                    .iter()
                    .find(|f| f.hashes.as_ref().and_then(|h| h.sha1.as_deref()) == Some(hash.as_str()))
                    .or_else(|| files.iter().find(|f| f.is_primary))
            });
            if let Some(f) = matched {
                resolved.insert(
                    hash.clone(),
                    ResolvedMod {
                        cf_project_id: None,
                        cf_file_id: None,
                        mr_sha1: Some(hash.clone()),
                        mr_download_url: Some(f.download_url.clone()),
                        mr_size: Some(f.size),
                    },
                );
            }
        }
    }

    // 反查结果按文件名归位（dict 键为哈希，需回填到 mod 相对路径）。
    let mut by_path: HashMap<String, ResolvedMod> = HashMap::new();
    for (e, sha) in mod_jars.iter().zip(sha1s) {
        if let Some(m) = resolved.get(&sha) {
            by_path.insert(
                e.rel.clone(),
                ResolvedMod {
                    cf_project_id: None,
                    cf_file_id: None,
                    mr_sha1: m.mr_sha1.clone(),
                    mr_download_url: m.mr_download_url.clone(),
                    mr_size: m.mr_size,
                },
            );
        }
    }
    Ok(by_path)
}

// ---------------------------------------------------------------------------
// 清单与 zip 写入
// ---------------------------------------------------------------------------

fn write_cf_manifest<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    opts: &SimpleFileOptions,
    instance: &GameInstance,
    resolved: &HashMap<String, ResolvedMod>,
) -> Result<(), String> {
    let loader_id = match (instance.loader.as_deref(), instance.loader_version.as_deref()) {
        (Some(l), Some(v)) if !l.is_empty() && !v.is_empty() => format!("{l}-{v}"),
        (Some(l), _) if !l.is_empty() => l.to_string(),
        _ => String::new(),
    };
    let mut mod_loaders = serde_json::Map::new();
    if !loader_id.is_empty() {
        mod_loaders.insert(
            "id".to_string(),
            serde_json::Value::String(loader_id),
        );
        mod_loaders.insert("primary".to_string(), serde_json::Value::Bool(true));
    }

    let files: Vec<serde_json::Value> = resolved
        .values()
        .filter_map(|m| {
            let pid = m.cf_project_id?;
            let fid = m.cf_file_id?;
            Some(serde_json::json!({ "projectID": pid, "fileID": fid, "required": true }))
        })
        .collect();

    let manifest = serde_json::json!({
        "minecraft": {
            "version": instance.game_version,
            "modLoaders": [mod_loaders],
        },
        "manifestType": "minecraftModpack",
        "manifestVersion": 1,
        "name": instance.modpack_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| instance.name.clone()),
        "version": instance.modpack_version.clone().unwrap_or_else(|| "1.0.0".to_string()),
        "author": instance.modpack_author.clone().unwrap_or_default(),
        "files": files,
        "overrides": "overrides",
    });

    zip.start_file("manifest.json", *opts)
        .map_err(|e| format!("写入 manifest.json 失败: {e}"))?;
    zip.write_all(serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())
        .map_err(|e| format!("写入 manifest.json 失败: {e}"))?;
    Ok(())
}

fn write_mr_index<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    opts: &SimpleFileOptions,
    instance: &GameInstance,
    resolved: &HashMap<String, ResolvedMod>,
) -> Result<(), String> {
    // dependencies：minecraft + 加载器（mrpack 键：fabric-loader/quilt-loader/forge/neoforge）
    let mut deps = serde_json::Map::new();
    deps.insert("minecraft".to_string(), serde_json::Value::String(instance.game_version.clone()));
    if let (Some(loader), Some(lv)) = (instance.loader.as_deref(), instance.loader_version.as_deref()) {
        let loader_lower = loader.to_ascii_lowercase();
        let key = match loader_lower.as_str() {
            "fabric" => "fabric-loader",
            "quilt" => "quilt-loader",
            other => other,
        };
        if !lv.is_empty() {
            deps.insert(key.to_string(), serde_json::Value::String(lv.to_string()));
        }
    }

    let files: Vec<serde_json::Value> = resolved
        .iter()
        .filter_map(|(path, m)| {
            let sha1 = m.mr_sha1.clone()?;
            let url = m.mr_download_url.clone()?;
            Some(serde_json::json!({
                "path": path,
                "hashes": { "sha1": sha1 },
                "env": { "client": "required", "server": "optional" },
                "downloads": [url],
                "fileSize": m.mr_size.unwrap_or(0),
            }))
        })
        .collect();

    let index = serde_json::json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": instance.modpack_version.clone().unwrap_or_else(|| "1.0.0".to_string()),
        "name": instance.modpack_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| instance.name.clone()),
        "summary": instance.modpack_summary.clone().unwrap_or_default(),
        "files": files,
        "dependencies": deps,
        "overrides": "overrides",
    });

    zip.start_file("modrinth.index.json", *opts)
        .map_err(|e| format!("写入 modrinth.index.json 失败: {e}"))?;
    zip.write_all(serde_json::to_string_pretty(&index).unwrap_or_default().as_bytes())
        .map_err(|e| format!("写入 modrinth.index.json 失败: {e}"))?;
    Ok(())
}

/// 写入 `overrides/` 内容目录；`skip_rels` 内的相对路径（mods 已入 files[]）跳过。
fn write_overrides<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    opts: &SimpleFileOptions,
    _source_dir: &Path,
    content: &[ContentEntry],
    skip_rels: &HashSet<&str>,
) -> Result<(), String> {
    for e in content {
        let entry_name = format!("overrides/{}", e.rel);
        if skip_rels.contains(e.rel.as_str()) {
            continue;
        }
        if e.is_dir {
            zip.add_directory(entry_name, *opts)
                .map_err(|err| format!("写入目录失败 {}: {err}", e.rel))?;
        } else {
            zip.start_file(entry_name, *opts)
                .map_err(|err| format!("写入文件失败 {}: {err}", e.rel))?;
            let mut file = std::fs::File::open(&e.abs)
                .map_err(|err| format!("打开文件失败 {}: {err}", e.rel))?;
            std::io::copy(&mut file, zip)
                .map_err(|err| format!("写入文件失败 {}: {err}", e.rel))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::cf_fingerprint;

    /// 测试向量来自 dstvx/cf_fingerprint 参考实现的独立 Python 移植；
    /// 其中 `fp_realmod` 已用真实 CurseForge API（POST /v1/fingerprints）
    /// 端到端验证：命中 modId=1578679 / fileId=8266592（fileFingerprint 一致）。
    #[test]
    fn cf_fingerprint_matches_reference_vectors() {
        assert_eq!(cf_fingerprint(&[0x41; 1024]), 1_458_723_592);
        let range: Vec<u8> = (0u8..=255).collect();
        let mut data = Vec::new();
        for _ in 0..4 {
            data.extend_from_slice(&range);
        }
        assert_eq!(cf_fingerprint(&data), 3_164_413_637);
        // 空白字节（9/10/13/32）被忽略
        assert_eq!(cf_fingerprint(b"hello world\n"), 2_824_650_221);
    }

    #[test]
    fn cf_fingerprint_is_uint32_range() {
        // CF API 的 fingerprints 字段为 UInt32（实测 400：超出 2^32-1 报错）
        let fp = cf_fingerprint(&[0xAB; 777]);
        assert!(fp <= u32::MAX);
        assert!(fp > 0);
    }
}
