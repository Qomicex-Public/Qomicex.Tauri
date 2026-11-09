// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 资源收藏导入导出（本地 JSON 文件，issue #293）。
//!
//! 导出格式是自描述的 `{format, version, exportedAt, folders, favorites}`：
//! - `folders` 只包含被导出收藏引用到的收藏夹；
//! - `favorites` 是 `resource_favorites.json` 的条目快照。
//!
//! 导入分两种模式：
//! - `merge`：收藏夹按 id → 名称（大小写不敏感）复用，缺失的新建；收藏按
//!   `source+id+category` 去重，**已存在的保留本地版本**（不覆盖用户改过的
//!   备注/标签/夹子归属）。
//! - `overwrite`：整体替换，调用方负责先备份现有 JSON。
//!
//! 这里集中放纯逻辑（构建/解析/计划），端点只负责读写文件与调用服务。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use crate::services::resource_favorite::favorite_key;
use crate::services::resource_favorite::ResourceFavorite;
use crate::services::resource_favorite_folder::{FavoriteFolder, MAX_FOLDER_NAME_CHARS};

/// 导出文件的格式标识（导入时精确匹配，避免误吃别的 JSON）。
pub const EXPORT_FORMAT: &str = "qomicex-resource-favorites";
/// 当前导出格式版本；导入只接受 `1..=EXPORT_VERSION`。
pub const EXPORT_VERSION: u32 = 1;

/// 导入文件体积上限（16 MiB）：2 万条收藏的 JSON 远小于此值。
const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;
/// 单次导入的收藏条数上限。
const MAX_IMPORT_FAVORITES: usize = 20_000;
/// 单次导入的收藏夹数量上限。
const MAX_IMPORT_FOLDERS: usize = 1_000;

/// 导出文件内容（全部 camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteExport {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub exported_at: String,
    pub folders: Vec<FavoriteFolder>,
    pub favorites: Vec<ResourceFavorite>,
}

/// 导出请求里可选的收藏键（对应「当前筛选结果」）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteKey {
    pub source: String,
    pub id: String,
    pub category: String,
}

/// 导入模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Merge,
    Overwrite,
}

/// 导入/导出失败：参数或文件内容不合法 → 400；读写失败 → 500。
#[derive(Debug)]
pub enum TransferError {
    Invalid(String),
    Io(String),
}

impl TransferError {
    /// 是否是调用方输入造成的错误（端点映射 400）。
    pub fn is_client_error(&self) -> bool {
        matches!(self, TransferError::Invalid(_))
    }

    /// 面向用户的错误文案。
    pub fn message(&self) -> &str {
        match self {
            TransferError::Invalid(m) | TransferError::Io(m) => m,
        }
    }
}

/// 构建导出包。`keys = None` 表示全部收藏；给定 keys 时只导出命中的条目，
/// 且只带被引用到的收藏夹。
pub fn build_export(
    favorites: Vec<ResourceFavorite>,
    folders: Vec<FavoriteFolder>,
    keys: Option<&[FavoriteKey]>,
) -> FavoriteExport {
    let favorites: Vec<ResourceFavorite> = match keys {
        Some(keys) => {
            let wanted: HashSet<String> = keys
                .iter()
                .map(|k| favorite_key(&k.source, &k.id, &k.category))
                .collect();
            favorites
                .into_iter()
                .filter(|f| wanted.contains(&f.unique_key()))
                .collect()
        }
        None => favorites,
    };
    let referenced: HashSet<&str> = favorites
        .iter()
        .flat_map(|f| f.folder_ids.iter().map(String::as_str))
        .collect();
    let folders = folders
        .into_iter()
        .filter(|f| referenced.contains(f.id.as_str()))
        .collect();
    FavoriteExport {
        format: EXPORT_FORMAT.to_string(),
        version: EXPORT_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        folders,
        favorites,
    }
}

/// 解析并规范化导入文件：格式/版本/上限校验，收藏夹名 trim + 去重，收藏键
/// 规范化 + 去重（同键后者覆盖前者），无效条目直接丢弃。
pub fn parse_export(raw: &str) -> Result<FavoriteExport, TransferError> {
    let mut export: FavoriteExport = serde_json::from_str(raw)
        .map_err(|e| TransferError::Invalid(format!("不是有效的收藏导出文件: {e}")))?;
    if export.format != EXPORT_FORMAT {
        return Err(TransferError::Invalid(
            "文件格式标识不匹配（不是 Qomicex 收藏导出文件）".to_string(),
        ));
    }
    if export.version == 0 || export.version > EXPORT_VERSION {
        return Err(TransferError::Invalid(format!(
            "不支持的导出格式版本 {}（当前支持 {}）",
            export.version, EXPORT_VERSION
        )));
    }
    if export.favorites.len() > MAX_IMPORT_FAVORITES {
        return Err(TransferError::Invalid(format!(
            "收藏条目过多（{}，上限 {MAX_IMPORT_FAVORITES}）",
            export.favorites.len()
        )));
    }
    if export.folders.len() > MAX_IMPORT_FOLDERS {
        return Err(TransferError::Invalid(format!(
            "收藏夹过多（{}，上限 {MAX_IMPORT_FOLDERS}）",
            export.folders.len()
        )));
    }

    let mut folders: Vec<FavoriteFolder> = Vec::with_capacity(export.folders.len());
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    for mut folder in export.folders {
        folder.id = folder.id.trim().to_string();
        folder.name = folder.name.trim().to_string();
        if folder.id.is_empty()
            || folder.name.is_empty()
            || folder.name.chars().count() > MAX_FOLDER_NAME_CHARS
            || !seen_ids.insert(folder.id.clone())
            || !seen_names.insert(folder.name.to_ascii_lowercase())
        {
            continue;
        }
        if folder.created_at.trim().is_empty() {
            folder.created_at = chrono::Utc::now().to_rfc3339();
        }
        folders.push(folder);
    }
    export.folders = folders;

    let mut favorites: Vec<ResourceFavorite> = Vec::with_capacity(export.favorites.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    for mut item in export.favorites {
        item.normalize_key();
        item.normalize_meta();
        if item.source.is_empty() || item.id.is_empty() || item.category.is_empty() {
            continue;
        }
        let key = favorite_key(&item.source, &item.id, &item.category);
        if let Some(&position) = index.get(&key) {
            favorites[position] = item;
        } else {
            index.insert(key, favorites.len());
            favorites.push(item);
        }
    }
    export.favorites = favorites;
    Ok(export)
}

/// 单个导入收藏夹的处理方式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderPlan {
    /// 导入文件里的收藏夹 id。
    pub imported_id: String,
    pub name: String,
    /// 本地已有同 id 或同名（大小写不敏感）的夹子 → 复用其 id；None 表示新建。
    pub existing_id: Option<String>,
}

/// 计算每个导入收藏夹与本地夹子的对应关系：同 id 优先，其次精确同名，最后
/// ASCII 大小写不敏感同名（`Foo`/`foo` 视为同名；多个变体时取第一个命中，
/// `Ä`/`ä` 不折叠）；都没有则 `existing_id = None`（调用方新建）。
pub fn plan_folders(local: &[FavoriteFolder], imported: &[FavoriteFolder]) -> Vec<FolderPlan> {
    imported
        .iter()
        .map(|folder| {
            let existing = local
                .iter()
                .find(|l| l.id == folder.id)
                .or_else(|| local.iter().find(|l| l.name == folder.name))
                .or_else(|| {
                    local
                        .iter()
                        .find(|l| l.name.eq_ignore_ascii_case(&folder.name))
                })
                .map(|l| l.id.clone());
            FolderPlan {
                imported_id: folder.id.clone(),
                name: folder.name.clone(),
                existing_id: existing,
            }
        })
        .collect()
}

/// 合并模式的候选：只返回本地不存在的键（导入内部同键也去重）。
/// 返回 `(待新增, 跳过数)`；已存在的保留本地版本。
pub fn merge_candidates(
    local_keys: &HashSet<String>,
    imported: &[ResourceFavorite],
) -> (Vec<ResourceFavorite>, usize) {
    let mut seen = local_keys.clone();
    let mut out: Vec<ResourceFavorite> = Vec::with_capacity(imported.len());
    let mut skipped = 0usize;
    for item in imported {
        let key = item.unique_key();
        if !seen.insert(key) {
            skipped += 1;
            continue;
        }
        out.push(item.clone());
    }
    (out, skipped)
}

/// 把导入收藏的 `folderIds` 换成目标环境的 id；引用了未声明收藏夹的 id 直接丢弃。
pub fn remap_folder_ids(items: &mut [ResourceFavorite], remap: &HashMap<String, String>) {
    for item in items.iter_mut() {
        item.folder_ids = item
            .folder_ids
            .iter()
            .filter_map(|id| remap.get(id).cloned())
            .collect();
        item.normalize_meta();
    }
}

/// 校验导出/导入路径：必须是绝对路径且以 `.json` 结尾。
pub fn validate_json_path(raw: &str) -> Result<PathBuf, TransferError> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err(TransferError::Invalid("路径必须是绝对路径".to_string()));
    }
    let is_json = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !is_json {
        return Err(TransferError::Invalid("文件扩展名必须是 .json".to_string()));
    }
    Ok(path)
}

/// 读取并解析导入文件（大小上限 + UTF-8）。
pub fn read_export_file(raw_path: &str) -> Result<FavoriteExport, TransferError> {
    let path = validate_json_path(raw_path)?;
    // 文件不存在属于用户选错路径（400）；权限不足/被占用是 IO 故障（500）。
    let meta = std::fs::metadata(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TransferError::Invalid(format!("无法读取文件: {e}"))
        } else {
            TransferError::Io(format!("无法读取文件: {e}"))
        }
    })?;
    if !meta.is_file() {
        return Err(TransferError::Invalid("不是文件".to_string()));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(TransferError::Invalid(format!(
            "文件过大（{} 字节，上限 {MAX_IMPORT_BYTES}）",
            meta.len()
        )));
    }
    // 非 UTF-8 是文件内容问题（400）；其余读失败（占用/权限）按 IO（500）。
    let content = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidData {
            TransferError::Invalid(format!("文件不是 UTF-8: {e}"))
        } else {
            TransferError::Io(format!("读取文件失败: {e}"))
        }
    })?;
    parse_export(&content)
}

/// 写出导出文件（覆盖同名文件；父目录不存在时报错）。
///
/// 导出结果必须能被自己的导入器吃下：条数上限与序列化后的体积都按导入侧
/// 的常量校验，超限直接报错，避免生成「看起来成功、导入却失败」的备份文件。
/// 同时拒绝指向收藏数据库本身，防止把用户数据覆盖成导出包。
pub fn write_export_file(raw_path: &str, export: &FavoriteExport) -> Result<(), TransferError> {
    let path = validate_json_path(raw_path)?;
    if is_protected_favorite_db(&path) {
        return Err(TransferError::Invalid(
            "不能把导出文件写到收藏数据库上".to_string(),
        ));
    }
    if export.favorites.len() > MAX_IMPORT_FAVORITES {
        return Err(TransferError::Invalid(format!(
            "收藏条目过多（{}，上限 {MAX_IMPORT_FAVORITES}），导入器无法读取",
            export.favorites.len()
        )));
    }
    if export.folders.len() > MAX_IMPORT_FOLDERS {
        return Err(TransferError::Invalid(format!(
            "收藏夹过多（{}，上限 {MAX_IMPORT_FOLDERS}），导入器无法读取",
            export.folders.len()
        )));
    }
    let json = serde_json::to_string_pretty(export)
        .map_err(|e| TransferError::Io(format!("序列化导出内容失败: {e}")))?;
    if json.len() as u64 > MAX_IMPORT_BYTES {
        return Err(TransferError::Invalid(format!(
            "导出内容过大（{} 字节，上限 {MAX_IMPORT_BYTES}），导入器无法读取",
            json.len()
        )));
    }
    std::fs::write(&path, json).map_err(|e| TransferError::Io(format!("写入导出文件失败: {e}")))?;
    Ok(())
}

/// 目标是否就是收藏/收藏夹数据库文件（含经目录别名/软链接的等价路径）。
fn is_protected_favorite_db(path: &Path) -> bool {
    is_protected_db_in(&crate::settings::resolve_base_dir().join("data"), path)
}

/// `is_protected_favorite_db` 的目录可注入版本（测试用）。
fn is_protected_db_in(data_dir: &Path, path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !(name.eq_ignore_ascii_case("resource_favorites.json")
        || name.eq_ignore_ascii_case("resource_favorite_folders.json"))
    {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    // canonicalize 失败（data 目录尚未创建）时退回绝对路径比较：不能因为
    // 目录不存在就判定「不受保护」，否则首次运行可能把数据库覆盖成导出包。
    absolutize(parent) == absolutize(data_dir)
}

/// 尽量解析真实路径；路径不存在时退回到绝对化结果。
fn absolutize(path: &Path) -> PathBuf {
    path.canonicalize()
        .or_else(|_| std::path::absolute(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// 覆盖导入前把现有收藏/收藏夹 JSON 备份为带时间戳的 `.bak`。
///
/// 时间戳后缀保证重试不会覆盖上一次（可能是唯一一份）的原始备份；返回实际
/// 备份的文件数（文件不存在时跳过）。
pub fn backup_favorite_files() -> Result<usize, TransferError> {
    backup_files_in(&crate::settings::resolve_base_dir().join("data"))
}

fn backup_files_in(dir: &Path) -> Result<usize, TransferError> {
    // 时间戳只有毫秒精度：连续两次导入（含测试）可能落在同一毫秒，必须再加
    // 随机后缀，否则第二次会把第一次的备份覆盖掉。
    let stamp = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f"),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let mut backed_up = 0usize;
    for name in ["resource_favorites.json", "resource_favorite_folders.json"] {
        let src = dir.join(name);
        if !src.is_file() {
            continue;
        }
        let dst = dir.join(format!("{name}.bak.{stamp}"));
        std::fs::copy(&src, &dst)
            .map_err(|e| TransferError::Io(format!("备份 {} 失败: {e}", src.display())))?;
        backed_up += 1;
    }
    Ok(backed_up)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn favorite(id: &str, folder_ids: &[&str]) -> ResourceFavorite {
        ResourceFavorite {
            source: "modrinth".into(),
            id: id.into(),
            category: "mod".into(),
            title: format!("资源 {id}"),
            folder_ids: folder_ids.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn folder(id: &str, name: &str) -> FavoriteFolder {
        FavoriteFolder {
            id: id.into(),
            name: name.into(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
        }
    }

    #[test]
    fn build_export_filters_by_keys_and_referenced_folders() {
        let favorites = vec![favorite("a", &["f1"]), favorite("b", &["f2"])];
        let folders = vec![folder("f1", "常用"), folder("f2", "测试")];
        let keys = vec![FavoriteKey {
            source: "modrinth".into(),
            id: "a".into(),
            category: "mod".into(),
        }];

        let export = build_export(favorites.clone(), folders.clone(), Some(&keys));
        assert_eq!(export.format, EXPORT_FORMAT);
        assert_eq!(export.version, EXPORT_VERSION);
        assert_eq!(export.favorites.len(), 1);
        assert_eq!(export.favorites[0].id, "a");
        assert_eq!(export.folders.len(), 1, "只导出被引用到的收藏夹");
        assert_eq!(export.folders[0].id, "f1");

        let all = build_export(favorites, folders, None);
        assert_eq!(all.favorites.len(), 2);
        assert_eq!(all.folders.len(), 2);
    }

    #[test]
    fn parse_rejects_wrong_format_version_and_oversize() {
        let wrong_format = r#"{"format":"other","version":1,"folders":[],"favorites":[]}"#;
        assert!(parse_export(wrong_format).is_err());

        let wrong_version =
            r#"{"format":"qomicex-resource-favorites","version":99,"folders":[],"favorites":[]}"#;
        assert!(parse_export(wrong_version).is_err());

        assert!(parse_export("{ not json").is_err());
    }

    /// 导入文件必须显式带 `folders` 与 `favorites`（空数组合法）。
    #[test]
    fn parse_requires_both_arrays() {
        assert!(parse_export(
            r#"{"format":"qomicex-resource-favorites","version":1,"favorites":[]}"#
        )
        .is_err());
        assert!(parse_export(
            r#"{"format":"qomicex-resource-favorites","version":1,"folders":[]}"#
        )
        .is_err());
        assert!(parse_export(
            r#"{"format":"qomicex-resource-favorites","version":1,"folders":[],"favorites":[]}"#
        )
        .is_ok());
    }

    #[test]
    fn parse_normalizes_and_dedups() {
        let raw = r#"{
            "format":"qomicex-resource-favorites",
            "version":1,
            "folders":[
                {"id":" f1 ","name":" 常用 "},
                {"id":"f1","name":"重复 id"},
                {"id":"f2","name":"常用"},
                {"id":"f3","name":""}
            ],
            "favorites":[
                {"source":" modrinth ","id":"a","category":"mod"},
                {"source":"modrinth","id":"a","category":"mod","title":"后者覆盖"},
                {"source":"","id":"x","category":"mod"}
            ]
        }"#;
        let export = parse_export(raw).unwrap();
        assert_eq!(export.folders.len(), 1);
        assert_eq!(export.folders[0].id, "f1");
        assert_eq!(export.folders[0].name, "常用");
        assert_eq!(export.favorites.len(), 1);
        assert_eq!(export.favorites[0].title, "后者覆盖");
        assert_eq!(export.favorites[0].source, "modrinth");
    }

    #[test]
    fn plan_folders_prefers_id_then_name() {
        let local = vec![folder("l1", "常用"), folder("l2", "测试")];
        let imported = vec![
            folder("i1", "常用"),       // 同名 → 复用 l1
            folder("l2", "另一个名字"), // 同 id → 复用 l2
            folder("i3", "新夹子"),     // 新建
        ];
        let plans = plan_folders(&local, &imported);
        assert_eq!(plans[0].existing_id.as_deref(), Some("l1"));
        assert_eq!(plans[1].existing_id.as_deref(), Some("l2"));
        assert_eq!(plans[2].existing_id, None);

        // 本地同时存在大小写变体时，精确同名优先于「第一个 ASCII 匹配」。
        let ambiguous = vec![folder("a", "Foo"), folder("b", "foo")];
        let plans = plan_folders(&ambiguous, &[folder("i", "foo")]);
        assert_eq!(plans[0].existing_id.as_deref(), Some("b"));
    }

    #[test]
    fn merge_candidates_keeps_local_and_skips_duplicates() {
        let local: HashSet<String> = [favorite_key("modrinth", "a", "mod")].into_iter().collect();
        let imported = vec![
            favorite("a", &[]), // 本地已有 → 跳过
            favorite("b", &[]),
            favorite("b", &[]), // 导入内部重复 → 跳过
            favorite("c", &[]),
        ];
        let (added, skipped) = merge_candidates(&local, &imported);
        assert_eq!(added.len(), 2);
        assert_eq!(added[0].id, "b");
        assert_eq!(added[1].id, "c");
        assert_eq!(skipped, 2);
    }

    #[test]
    fn remap_drops_unknown_folders() {
        let mut items = vec![favorite("a", &["i1", "missing"])];
        let mut remap = HashMap::new();
        remap.insert("i1".to_string(), "local-1".to_string());
        remap_folder_ids(&mut items, &remap);
        assert_eq!(items[0].folder_ids, vec!["local-1".to_string()]);
    }

    #[test]
    fn validate_json_path_requires_absolute_json() {
        assert!(validate_json_path("favorites.json").is_err());
        let abs = std::env::temp_dir().join("favorites.JSON");
        assert!(validate_json_path(&abs.to_string_lossy()).is_ok());
        let txt = std::env::temp_dir().join("favorites.txt");
        assert!(validate_json_path(&txt.to_string_lossy()).is_err());
    }

    #[test]
    fn backup_files_copies_existing_json_only() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("resource_favorites.json"), "[]").unwrap();

        assert_eq!(backup_files_in(&dir).unwrap(), 1);
        let first: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("resource_favorites.json.bak.")
            })
            .collect();
        assert_eq!(first.len(), 1);
        assert_eq!(std::fs::read_to_string(first[0].path()).unwrap(), "[]");

        // 第二次备份必须生成新文件，不能覆盖上一次的原始备份。
        std::fs::write(dir.join("resource_favorites.json"), "[{\"a\":1}]").unwrap();
        assert_eq!(backup_files_in(&dir).unwrap(), 1);
        let all: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("resource_favorites.json.bak.")
            })
            .collect();
        assert_eq!(all.len(), 2, "重试备份不得覆盖原始备份");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn export_with_counts(favorites: usize, folders: usize) -> FavoriteExport {
        FavoriteExport {
            format: EXPORT_FORMAT.to_string(),
            version: EXPORT_VERSION,
            exported_at: String::new(),
            folders: (0..folders)
                .map(|i| FavoriteFolder {
                    id: format!("f{i}"),
                    name: format!("分组{i}"),
                    created_at: String::new(),
                })
                .collect(),
            favorites: (0..favorites)
                .map(|i| ResourceFavorite {
                    source: "modrinth".into(),
                    id: format!("id{i}"),
                    category: "mod".into(),
                    ..Default::default()
                })
                .collect(),
        }
    }

    /// 导入条数上限的边界：正好达到上限可通过，超出返回限制错误。
    #[test]
    fn parse_enforces_count_limits_at_boundary() {
        let at_limit = serde_json::to_string(&export_with_counts(
            MAX_IMPORT_FAVORITES,
            MAX_IMPORT_FOLDERS,
        ))
        .unwrap();
        assert!(parse_export(&at_limit).is_ok());

        let too_many_favorites =
            serde_json::to_string(&export_with_counts(MAX_IMPORT_FAVORITES + 1, 0)).unwrap();
        assert!(parse_export(&too_many_favorites).is_err());

        let too_many_folders =
            serde_json::to_string(&export_with_counts(0, MAX_IMPORT_FOLDERS + 1)).unwrap();
        assert!(parse_export(&too_many_folders).is_err());
    }

    /// 读取侧文件体积上限：超过上限时不读内容直接报错。
    #[test]
    fn read_rejects_file_larger_than_limit() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-size-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("too-big.json");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_IMPORT_BYTES + 1).unwrap();
        drop(file);

        let err = read_export_file(&path.to_string_lossy()).unwrap_err();
        assert!(
            err.message().contains("文件过大"),
            "实际: {}",
            err.message()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 导出结果必须满足导入侧上限，避免生成无法恢复的备份文件。
    #[test]
    fn write_export_rejects_results_import_cannot_read() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.json");
        let export = export_with_counts(MAX_IMPORT_FAVORITES + 1, 0);
        let err = write_export_file(&path.to_string_lossy(), &export).unwrap_err();
        assert!(
            err.message().contains("收藏条目过多"),
            "实际: {}",
            err.message()
        );
        assert!(!path.exists(), "超限时不得写出文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 导出目标不得指向收藏数据库本身（含经 `..` 的等价路径）。
    #[test]
    fn protected_db_path_is_rejected() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-protect-{}", uuid::Uuid::new_v4()));
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();

        assert!(is_protected_db_in(
            &data,
            &data.join("resource_favorites.json")
        ));
        assert!(is_protected_db_in(
            &data,
            &data.join("resource_favorite_folders.json")
        ));
        assert!(!is_protected_db_in(&data, &data.join("export.json")));
        // 目录别名/`..` 经 canonicalize 后仍是同一个文件。
        assert!(is_protected_db_in(
            &data,
            &data.join("..").join("data").join("resource_favorites.json")
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
