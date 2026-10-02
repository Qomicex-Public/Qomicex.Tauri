//! 资源收藏夹服务（独立 `resource_favorite_folders.json` 持久化）。
//!
//! 收藏项通过 `ResourceFavorite.folder_ids` 关联到本文件里的夹子，条目本身仍存
//! `resource_favorites.json`（P1 的扁平数组格式**保持不变**，因此零格式迁移）。
//! 与 `instance_group.rs` 同构：`Mutex<Vec<_>>` + 独立 JSON + 原子写 + 错误上报。
//!
//! P3 起一条收藏可归属**多个**夹子。删除收藏夹由调用方（端点）编排，顺序是
//! **先 `ResourceFavoriteService::detach_from_folder` 再 `delete` 本服务**：
//! 若第二步失败，最坏是「收藏已解关联、夹子空着」这种无害残留；反序会留下指向已删夹子的
//! 悬空 `folderId`。注意这里**不再删除收藏条目** —— 多归属下删除会连带毁掉别的夹子的成员。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::settings;

/// 收藏夹名长度上限（字符数，非字节）。本地 JSON 也做防御性上限，避免无界增长。
const MAX_FOLDER_NAME_CHARS: usize = 64;

/// 收藏夹（全部 camelCase）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteFolder {
    pub id: String,
    pub name: String,
    /// 服务端生成（RFC3339 UTC）；同时决定 `get_all()` 的返回顺序（插入序）。
    #[serde(default)]
    pub created_at: String,
}

/// 收藏夹操作的失败原因，端点据此映射 400 / 404 / 500。
#[derive(Debug, PartialEq, Eq)]
pub enum FolderError {
    /// 名称 trim 后为空。
    EmptyName,
    /// 名称超过 `MAX_FOLDER_NAME_CHARS`。
    NameTooLong,
    /// 与其他夹子重名（大小写不敏感）。
    NameTaken,
    /// 指定的 id 不存在。
    NotFound,
    /// 落盘失败（含原始错误信息，供日志/上报）。
    Save(String),
}

impl FolderError {
    /// 端点的错误码（与实例分组 `GROUP_*` 同风格）。
    pub fn code(&self) -> &'static str {
        match self {
            FolderError::EmptyName => "FAVORITE_FOLDER_NAME_EMPTY",
            FolderError::NameTooLong => "FAVORITE_FOLDER_NAME_TOO_LONG",
            FolderError::NameTaken => "FAVORITE_FOLDER_NAME_EXISTS",
            FolderError::NotFound => "FAVORITE_FOLDER_NOT_FOUND",
            FolderError::Save(_) => "FAVORITE_FOLDER_SAVE_FAILED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            FolderError::EmptyName => "收藏夹名称不能为空".to_string(),
            FolderError::NameTooLong => {
                format!("收藏夹名称不能超过 {MAX_FOLDER_NAME_CHARS} 个字符")
            }
            FolderError::NameTaken => "已存在同名收藏夹".to_string(),
            FolderError::NotFound => "收藏夹不存在".to_string(),
            FolderError::Save(e) => format!("保存收藏夹失败: {e}"),
        }
    }

    /// 是否属于「无法落盘」这一类（端点映射 500，其余映射 400/404）。
    pub fn is_save_failure(&self) -> bool {
        matches!(self, FolderError::Save(_))
    }
}

/// 资源收藏夹服务（独立 `resource_favorite_folders.json`）。
pub struct ResourceFavoriteFolderService {
    file_path: PathBuf,
    folders: Mutex<Vec<FavoriteFolder>>,
}

impl ResourceFavoriteFolderService {
    pub fn new() -> Self {
        let data_dir = settings::resolve_base_dir().join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("resource_favorite_folders.json");
        let folders = load_from_file(&file_path);
        Self {
            file_path,
            folders: Mutex::new(folders),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<FavoriteFolder>> {
        // 中毒锁恢复：一条坏记录不该让整个收藏夹功能不可用。
        self.folders.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 原子写：先写同目录临时文件，再 rename 覆盖（避免半截 JSON 落盘）。
    fn save_locked(&self, folders: &[FavoriteFolder]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(folders)
            .map_err(|e| format!("序列化收藏夹列表失败: {e}"))?;
        let tmp = self.file_path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {e}"))?;
        std::fs::rename(&tmp, &self.file_path).map_err(|e| format!("替换收藏夹文件失败: {e}"))?;
        Ok(())
    }

    /// 全部收藏夹，保持插入顺序（新建的排最后）。
    pub fn get_all(&self) -> Vec<FavoriteFolder> {
        self.lock().clone()
    }

    /// 是否存在该 id（端点删夹子前先确认，避免对不存在的 id 做破坏性级联）。
    pub fn exists(&self, id: &str) -> bool {
        self.lock().iter().any(|f| f.id == id)
    }

    /// 裁剪并校验名称（trim + 非空 + 长度上限）。
    fn normalize_name(name: &str) -> Result<String, FolderError> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(FolderError::EmptyName);
        }
        if name.chars().count() > MAX_FOLDER_NAME_CHARS {
            return Err(FolderError::NameTooLong);
        }
        Ok(name)
    }

    /// 新建收藏夹；重名（大小写不敏感）返回 `NameTaken`。
    ///
    /// 先在副本上改、落盘成功后才提交到内存（与收藏服务同一口径）。
    pub fn create(&self, name: &str) -> Result<FavoriteFolder, FolderError> {
        let name = Self::normalize_name(name)?;
        let mut guard = self.lock();
        if guard.iter().any(|f| f.name.eq_ignore_ascii_case(&name)) {
            return Err(FolderError::NameTaken);
        }
        let folder = FavoriteFolder {
            id: new_short_id(),
            name,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let mut next = guard.clone();
        next.push(folder.clone());
        self.save_locked(&next).map_err(FolderError::Save)?;
        *guard = next;
        Ok(folder)
    }

    /// 重命名；`NotFound` / `NameTaken` 分别映射 404 / 400。
    pub fn rename(&self, id: &str, name: &str) -> Result<FavoriteFolder, FolderError> {
        let name = Self::normalize_name(name)?;
        let mut guard = self.lock();
        let index = guard
            .iter()
            .position(|f| f.id == id)
            .ok_or(FolderError::NotFound)?;
        if guard
            .iter()
            .enumerate()
            .any(|(i, f)| i != index && f.name.eq_ignore_ascii_case(&name))
        {
            return Err(FolderError::NameTaken);
        }
        let mut next = guard.clone();
        next[index].name = name;
        let updated = next[index].clone();
        self.save_locked(&next).map_err(FolderError::Save)?;
        *guard = next;
        Ok(updated)
    }

    /// 删除收藏夹（**不含**夹内收藏；级联由端点编排，见模块注释）。
    pub fn delete(&self, id: &str) -> Result<FavoriteFolder, FolderError> {
        let mut guard = self.lock();
        let folder = guard
            .iter()
            .find(|f| f.id == id)
            .cloned()
            .ok_or(FolderError::NotFound)?;
        let mut next = guard.clone();
        next.retain(|f| f.id != id);
        self.save_locked(&next).map_err(FolderError::Save)?;
        *guard = next;
        Ok(folder)
    }
}

/// 生成 12 位十六进制短 id（与 `instance_group.rs` / `instance.rs` 一致）。
fn new_short_id() -> String {
    let full = format!("{:x}", uuid::Uuid::new_v4());
    full[..12].to_string()
}

fn load_from_file(file_path: &PathBuf) -> Vec<FavoriteFolder> {
    if file_path.exists() {
        if let Ok(content) = std::fs::read_to_string(file_path) {
            if let Ok(list) = serde_json::from_str::<Vec<FavoriteFolder>>(&content) {
                return list;
            }
            eprintln!(
                "[resource_favorite_folder] 收藏夹文件解析失败，按空列表启动: {}",
                file_path.display()
            );
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(dir: &std::path::Path) -> ResourceFavoriteFolderService {
        ResourceFavoriteFolderService {
            file_path: dir.join("resource_favorite_folders.json"),
            folders: Mutex::new(Vec::new()),
        }
    }

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qmx-folder-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_trims_names_and_rejects_duplicates_case_insensitively() {
        let dir = tmp_dir();
        let svc = service(&dir);

        let created = svc.create("  优化  ").unwrap();
        assert_eq!(created.name, "优化");
        assert!(!created.created_at.is_empty());

        assert_eq!(svc.create("优化").unwrap_err(), FolderError::NameTaken);
        assert_eq!(svc.create(" 优化 ").unwrap_err(), FolderError::NameTaken);
        // 大小写不敏感：Modrinth / modrinth 视为同名。
        svc.create("Modrinth").unwrap();
        assert_eq!(svc.create("modrinth").unwrap_err(), FolderError::NameTaken);
        // 允许把名字改成自己的原名（不与自身冲突）。
        assert_eq!(svc.rename(&created.id, "优化").unwrap().name, "优化");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_rejects_empty_and_overlong_names() {
        let dir = tmp_dir();
        let svc = service(&dir);

        assert_eq!(svc.create("   ").unwrap_err(), FolderError::EmptyName);
        assert_eq!(svc.create("").unwrap_err(), FolderError::EmptyName);
        let long = "字".repeat(MAX_FOLDER_NAME_CHARS + 1);
        assert_eq!(svc.create(&long).unwrap_err(), FolderError::NameTooLong);
        // 边界：正好等于上限应当通过（按字符数而非字节数计）。
        let at_limit = "字".repeat(MAX_FOLDER_NAME_CHARS);
        assert!(svc.create(&at_limit).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_and_delete_report_not_found() {
        let dir = tmp_dir();
        let svc = service(&dir);
        let a = svc.create("A").unwrap();
        let b = svc.create("B").unwrap();

        assert_eq!(svc.rename("nope", "C").unwrap_err(), FolderError::NotFound);
        assert_eq!(svc.rename(&b.id, "A").unwrap_err(), FolderError::NameTaken);
        assert_eq!(svc.rename(&b.id, "B2").unwrap().name, "B2");
        assert_eq!(svc.get_all().len(), 2);

        assert_eq!(svc.delete("nope").unwrap_err(), FolderError::NotFound);
        assert_eq!(svc.delete(&a.id).unwrap().name, "A");
        assert_eq!(svc.get_all().len(), 1);
        // 重复删除：NotFound（端点映射 404）。
        assert_eq!(svc.delete(&a.id).unwrap_err(), FolderError::NotFound);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folders_round_trip_and_survive_corrupt_file() {
        let dir = tmp_dir();
        let path = dir.join("resource_favorite_folders.json");
        let svc = service(&dir);
        svc.create("优化").unwrap();
        svc.create("整合包").unwrap();

        // 重新构造服务（走 load_from_file）验证落盘 + 插入序。
        let reloaded = ResourceFavoriteFolderService {
            file_path: path.clone(),
            folders: Mutex::new(load_from_file(&path)),
        };
        let names: Vec<_> = reloaded.get_all().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["优化".to_string(), "整合包".to_string()]);

        // 文件损坏 → 空列表启动（不覆盖原文件）。
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_from_file(&path).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_failure_leaves_memory_untouched() {
        let dir = tmp_dir();
        // 父目录不存在 → 临时文件写入必然失败。
        let broken = dir
            .join("missing-subdir")
            .join("resource_favorite_folders.json");
        let svc = ResourceFavoriteFolderService {
            file_path: broken,
            folders: Mutex::new(Vec::new()),
        };

        let err = svc.create("优化").unwrap_err();
        assert!(err.is_save_failure(), "实际错误: {err:?}");
        assert!(svc.get_all().is_empty(), "落盘失败后内存必须保持为空");

        // rename / delete 同样不得改动内存。
        let svc2 = ResourceFavoriteFolderService {
            file_path: dir
                .join("missing-subdir")
                .join("resource_favorite_folders.json"),
            folders: Mutex::new(vec![FavoriteFolder {
                id: "f1".into(),
                name: "优化".into(),
                created_at: "2026-10-01T00:00:00+00:00".into(),
            }]),
        };
        assert!(svc2.rename("f1", "改名").unwrap_err().is_save_failure());
        assert_eq!(svc2.get_all()[0].name, "优化");
        assert!(svc2.delete("f1").unwrap_err().is_save_failure());
        assert_eq!(svc2.get_all().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
