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
//! 账户缓存（usercache/usernamecache/launcher_*）。
//!
//! 文件勾选（HMCL 风格）：`list_export_tree` 返回完整文件树供前端展示勾选；
//! 导出请求可携带 `includeFiles` 白名单（相对路径）精确控制包含内容。
//! 白名单为 None 时保持旧语义（saves/screenshots 由独立开关控制），
//! 传入时由白名单唯一决定包含（覆盖 saves/screenshots 开关）。

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use qomicex_core::core::GameCore;
use serde::Serialize;
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

/// 导出文件树节点（`GET /modpack/export/files/{instanceId}` 返回）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTreeNode {
    /// 文件名（不含路径）。
    pub name: String,
    /// 相对路径（`/` 分隔）；根级条目为其自身名。
    pub path: String,
    /// 节点类型：dir / file。
    #[serde(rename = "type")]
    pub kind: NodeKind,
    /// 文件大小；目录为子树累计大小。
    pub size: u64,
    /// 子树文件总数（目录含全部后代文件；文件恒为 1）。
    pub file_count: u64,
    /// 子节点（仅目录）。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ExportTreeNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Dir,
    File,
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
///
/// `include_files`：可选包含白名单（相对路径）。`Some` 时由白名单唯一决定
/// 包含内容（saves/screenshots 是否包含也看白名单）；`None` 时保持旧语义，
/// 由 `include_saves` / `include_screenshots` 控制这两类。
///
/// `name_override` / `version_override` / `author_override`：导出元数据覆盖
/// （trim 非空时生效，覆盖实例 modpackName/modpackVersion/modpackAuthor；
/// 作者仅 CF 写入，mrpack 无此字段）。
pub async fn build_export_zip(
    core: &Arc<GameCore>,
    cf_api_key: &str,
    instance: &GameInstance,
    format: ExportFormat,
    include_saves: bool,
    include_screenshots: bool,
    include_files: Option<&HashSet<String>>,
    name_override: Option<&str>,
    version_override: Option<&str>,
    author_override: Option<&str>,
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
    collect_content(
        &source_dir,
        &instance.name,
        include_saves,
        include_screenshots,
        include_files,
        &mut content,
    )?;

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
            write_cf_manifest(&mut zip, &opts, instance, &resolved, name_override, version_override, author_override)?;
            write_overrides(&mut zip, &opts, &source_dir, &content, &HashSet::new())?;
        }
        ExportFormat::Modrinth => {
            // 反查命中的 mods 走 files[]，不再进 overrides（避免重复）。
            let resolved_rel: HashSet<&str> = resolved.keys().map(|s| s.as_str()).collect();
            write_mr_index(&mut zip, &opts, instance, &resolved, name_override, version_override)?;
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

/// 列出实例可导出的完整文件树（供前端勾选展示）。
///
/// 与导出共用同一收集逻辑：排除版本 json/jar、`EXCLUDED_DIRS`、
/// 账户缓存。saves/screenshots 保留（是否导出由前端勾选/白名单决定）。
pub fn list_export_tree(instance: &GameInstance) -> Result<Vec<ExportTreeNode>, String> {
    let source_dir = instance_source_dir(instance);
    if !source_dir.is_dir() {
        return Err(format!(
            "实例目录不存在：{}",
            source_dir.to_string_lossy()
        ));
    }
    collect_export_tree(&source_dir, &instance.name)
}

/// 递归收集文件树。目录节点累计 `size`/`file_count`，排除项不进入树。
fn collect_export_tree(
    root: &Path,
    version_dir_name: &str,
) -> Result<Vec<ExportTreeNode>, String> {
    let version_json = format!("{version_dir_name}.json");
    let version_jar = format!("{version_dir_name}.jar");

    fn walk(
        dir: &Path,
        rel_dir: &str,
        root: &Path,
        version_json: &str,
        version_jar: &str,
    ) -> Result<Vec<ExportTreeNode>, String> {
        let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败 {dir:?}: {e}"))?;
        let mut nodes = Vec::new();
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
                let children = walk(&path, &rel, root, version_json, version_jar)?;
                let size: u64 = children.iter().map(|c| c.size).sum();
                let file_count: u64 = children.iter().map(|c| c.file_count).sum();
                nodes.push(ExportTreeNode {
                    name,
                    path: rel,
                    kind: NodeKind::Dir,
                    size,
                    file_count,
                    children,
                });
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
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                nodes.push(ExportTreeNode {
                    name,
                    path: rel,
                    kind: NodeKind::File,
                    size,
                    file_count: 1,
                    children: Vec::new(),
                });
            }
        }
        Ok(nodes)
    }

    walk(root, "", root, &version_json, &version_jar)
}

/// 树先序展平为内容条目（目录在前，文件在后；父目录先于子文件）。
fn flatten_tree(root: &Path, nodes: &[ExportTreeNode], out: &mut Vec<ContentEntry>) {
    for n in nodes {
        let abs = root.join(&n.path);
        if n.kind == NodeKind::Dir {
            out.push(ContentEntry { rel: n.path.clone(), abs: abs.clone(), is_dir: true });
            flatten_tree(root, &n.children, out);
        } else {
            out.push(ContentEntry { rel: n.path.clone(), abs, is_dir: false });
        }
    }
}

/// 按包含白名单过滤内容条目：文件必须命中白名单；目录仅当其子树
/// 存在命中文件时保留（保证 zip 路径完整）。
fn filter_by_include(content: Vec<ContentEntry>, include: &HashSet<String>) -> Vec<ContentEntry> {
    content.into_iter().filter(|e| {
        if e.is_dir {
            let prefix = format!("{}/", e.rel);
            include.iter().any(|p| p.starts_with(&prefix))
        } else {
            include.contains(&e.rel)
        }
    }).collect()
}

fn collect_content(
    root: &Path,
    version_dir_name: &str,
    include_saves: bool,
    include_screenshots: bool,
    include_files: Option<&HashSet<String>>,
    out: &mut Vec<ContentEntry>,
) -> Result<(), String> {
    let tree = collect_export_tree(root, version_dir_name)?;
    flatten_tree(root, &tree, out);

    if let Some(include) = include_files {
        // 白名单模式：包含内容由白名单唯一决定
        let filtered = filter_by_include(std::mem::take(out), include);
        *out = filtered;
        return Ok(());
    }

    // 旧语义（无白名单）：saves/screenshots 由独立开关控制（默认排除）
    out.retain(|e| {
        let top = e.rel.split('/').next().unwrap_or("");
        if top.eq_ignore_ascii_case("saves") {
            return include_saves;
        }
        if top.eq_ignore_ascii_case("screenshots") {
            return include_screenshots;
        }
        true
    });
    Ok(())
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

/// 元数据覆盖解析：请求值 trim 非空时优先，否则回退实例值。
fn meta_override(value: Option<&str>, fallback: &str) -> String {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => v.to_string(),
        None => fallback.to_string(),
    }
}

fn write_cf_manifest<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    opts: &SimpleFileOptions,
    instance: &GameInstance,
    resolved: &HashMap<String, ResolvedMod>,
    name_override: Option<&str>,
    version_override: Option<&str>,
    author_override: Option<&str>,
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

    let default_name = instance
        .modpack_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&instance.name);
    let default_version = instance
        .modpack_version
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("1.0.0");
    let default_author = instance.modpack_author.as_deref().unwrap_or("");

    let manifest = serde_json::json!({
        "minecraft": {
            "version": instance.game_version,
            "modLoaders": [mod_loaders],
        },
        "manifestType": "minecraftModpack",
        "manifestVersion": 1,
        "name": meta_override(name_override, default_name),
        "version": meta_override(version_override, default_version),
        "author": meta_override(author_override, default_author),
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
    name_override: Option<&str>,
    version_override: Option<&str>,
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

    let default_name = instance
        .modpack_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&instance.name);
    let default_version = instance
        .modpack_version
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("1.0.0");

    let index = serde_json::json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": meta_override(version_override, default_version),
        "name": meta_override(name_override, default_name),
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
    use std::path::PathBuf;

    use super::{cf_fingerprint, collect_export_tree, filter_by_include, flatten_tree, meta_override, ExportTreeNode};

    /// 测试用临时根目录（按进程 id 隔离，避免并行测试冲突）。
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-export-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &std::path::Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn find<'a>(nodes: &'a [ExportTreeNode], path: &str) -> Option<&'a ExportTreeNode> {
        for n in nodes {
            if n.path == path {
                return Some(n);
            }
            if let Some(found) = find(&n.children, path) {
                return Some(found);
            }
        }
        None
    }

    /// 构造典型实例目录并验证：排除项不出现、size/file_count 累计正确。
    #[test]
    fn collect_tree_excludes_and_aggregates() {
        let root = temp_root("tree");
        write(&root.join("1.20.1-Forge-47.1.0.json"), b"{}");
        write(&root.join("1.20.1-Forge-47.1.0.jar"), b"jar");
        write(&root.join("usercache.json"), b"[]");
        write(&root.join("mods/jei.jar"), &[0u8; 100]);
        write(&root.join("mods/sub/another.jar"), &[0u8; 50]);
        write(&root.join("resourcepacks/rp.zip"), &[0u8; 10]);
        write(&root.join("config/toml.toml"), b"x");
        write(&root.join("saves/world1/level.dat"), &[0u8; 7]);
        write(&root.join("screenshots/s.png"), &[0u8; 3]);
        write(&root.join("libraries/lib.jar"), &[0u8; 999]);

        let tree = collect_export_tree(&root, "1.20.1-Forge-47.1.0").unwrap();

        // 排除项不进入树
        assert!(find(&tree, "libraries").is_none(), "libraries 应被排除");
        assert!(find(&tree, "1.20.1-Forge-47.1.0.json").is_none());
        assert!(find(&tree, "1.20.1-Forge-47.1.0.jar").is_none());
        assert!(find(&tree, "usercache.json").is_none());

        // saves/screenshots 保留（由前端勾选决定）
        let saves = find(&tree, "saves").expect("saves 应保留");
        assert_eq!(saves.file_count, 1);
        assert_eq!(saves.size, 7);
        assert!(find(&tree, "screenshots").is_some());

        // 目录累计 size/file_count 含子目录
        let mods = find(&tree, "mods").expect("mods 应存在");
        assert_eq!(mods.file_count, 2);
        assert_eq!(mods.size, 150);
        assert!(find(&tree, "mods/sub").is_some());
    }

    /// 白名单过滤：只保留命中的文件及其父目录链。
    #[test]
    fn filter_by_include_keeps_selected_and_ancestors() {
        let root = temp_root("filter");
        write(&root.join("mods/jei.jar"), &[0u8; 10]);
        write(&root.join("mods/sub/another.jar"), &[0u8; 20]);
        write(&root.join("config/x.toml"), b"x");
        write(&root.join("saves/world1/level.dat"), &[0u8; 5]);

        let tree = collect_export_tree(&root, "v").unwrap();
        let mut content = Vec::new();
        flatten_tree(&root, &tree, &mut content);

        let mut include = std::collections::HashSet::new();
        include.insert("mods/jei.jar".to_string());
        include.insert("saves/world1/level.dat".to_string());
        let filtered = filter_by_include(content, &include);

        let rels: Vec<&str> = filtered.iter().map(|e| e.rel.as_str()).collect();
        // 命中的文件 + 父目录链存在
        assert!(rels.contains(&"mods/jei.jar"));
        assert!(rels.contains(&"mods"));
        assert!(rels.contains(&"saves/world1/level.dat"));
        assert!(rels.contains(&"saves/world1"));
        assert!(rels.contains(&"saves"));
        // 未命中的子树不出现
        assert!(!rels.contains(&"mods/sub/another.jar"));
        assert!(!rels.contains(&"mods/sub"));
        assert!(!rels.contains(&"config/x.toml"));

        // 文件条目都带绝对路径
        for e in &filtered {
            if !e.is_dir {
                assert!(e.abs.is_file(), "{} 应为真实文件", e.rel);
            }
        }
    }

    /// 元数据覆盖：请求值 trim 非空优先，否则回退实例默认。
    #[test]
    fn meta_override_prefers_non_blank_request_value() {
        assert_eq!(meta_override(Some("  My Pack  "), "Fallback"), "My Pack");
        assert_eq!(meta_override(Some(""), "Fallback"), "Fallback");
        assert_eq!(meta_override(Some("   "), "Fallback"), "Fallback");
        assert_eq!(meta_override(None, "Fallback"), "Fallback");
        assert_eq!(meta_override(Some("1.2.3"), "1.0.0"), "1.2.3");
    }

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
