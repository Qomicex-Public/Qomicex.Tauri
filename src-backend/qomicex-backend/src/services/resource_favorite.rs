//! 资源收藏服务（独立 resource_favorites.json 持久化）。
//!
//! 收藏条目唯一键为 `source + id + category`；同时保存卡片渲染所需的资源快照
//! （title / iconUrl / author / downloadCount / categories / …），使收藏视图无需
//! 再发起网络请求即可复用 `ResourceCard` 渲染与安装。
//!
//! 与 `instance_group.rs` 同款落地方式（`Mutex<Vec<_>>` + `{BaseDir}/data/*.json`），
//! 但改进两点：
//! - 修改与保存放在**同一个锁临界区**内，避免并发写入互相覆盖；
//! - 保存走**临时文件 + rename** 原子写，并返回 `Result` 而不是吞掉错误。
//!
//! P2 预留字段（`folderId` / `note` / `tags`）在此即已落盘，P2 只加 UI 与端点，
//! 不需要对既有 JSON 做数据迁移。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::settings;

/// 单条备注的字符上限（P2）。本地 JSON 也做防御性上限。
const MAX_NOTE_CHARS: usize = 2000;
/// 单条收藏的标签数上限（P2）。
const MAX_TAGS: usize = 20;
/// 单个标签的字符上限（P2）。
const MAX_TAG_CHARS: usize = 32;

/// 收藏条目（全部 camelCase）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFavorite {
    /// 资源来源（modrinth / curseforge / ftb）。
    pub source: String,
    /// 来源侧的资源 id。
    pub id: String,
    /// 资源分类（mod / modpack / shader / resourcepack / datapack / save）。
    pub category: String,
    // ---- 资源快照（收藏视图离线渲染用）----
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub icon_url: String,
    #[serde(default)]
    pub download_count: i64,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub project_url: String,
    #[serde(default)]
    pub slug: String,
    /// 与 `ResourceItem.latestVersion` 对齐；缺失时为空串，前端不做必填假设。
    #[serde(default)]
    pub latest_version: String,
    // ---- P2 预留（收藏夹 / 备注 / 自定义标签）----
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 服务端生成（RFC3339 UTC），客户端传入值被忽略。
    #[serde(default)]
    pub created_at: String,
}

impl ResourceFavorite {
    fn matches(&self, source: &str, id: &str, category: &str) -> bool {
        self.source == source && self.id == id && self.category == category
    }

    /// 裁剪三个键段的首尾空白。
    ///
    /// `DELETE` 的查询参数（`FavoriteKeyQuery::validated`）会裁剪后再做精确匹配，
    /// 所以写入侧必须用同一口径，否则 `" modrinth "` 这类键写进去就删不掉了。
    /// `pub`：端点校验也复用这一处实现，避免两侧裁剪逻辑漂移。
    pub fn normalize_key(&mut self) {
        self.source = self.source.trim().to_string();
        self.id = self.id.trim().to_string();
        self.category = self.category.trim().to_string();
    }

    /// 规范化 P2 元数据（`folderId` / `note` / `tags`），在落库边界统一执行。
    ///
    /// - `folderId`：裁剪；空串视为 `None`（前端清空选择时可能传来 `""`）。
    /// - `note`：裁剪；空串视为 `None`；超长按字符截断到 `MAX_NOTE_CHARS`。
    /// - `tags`：逐个裁剪、丢空、**大小写不敏感去重**（保留首次出现的写法）、
    ///   单标签截断到 `MAX_TAG_CHARS`、整体上限 `MAX_TAGS`（防本地 JSON 无界增长）。
    pub fn normalize_meta(&mut self) {
        self.folder_id = self
            .folder_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        self.note = self
            .note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(MAX_NOTE_CHARS).collect::<String>());

        let mut seen: Vec<String> = Vec::new();
        let mut tags: Vec<String> = Vec::new();
        for raw in std::mem::take(&mut self.tags) {
            let tag: String = raw.trim().chars().take(MAX_TAG_CHARS).collect();
            if tag.is_empty() {
                continue;
            }
            let lowered = tag.to_lowercase();
            if seen.contains(&lowered) {
                continue;
            }
            seen.push(lowered);
            tags.push(tag);
            if tags.len() >= MAX_TAGS {
                break;
            }
        }
        self.tags = tags;
    }
}

/// 资源收藏服务（独立 resource_favorites.json）。
pub struct ResourceFavoriteService {
    file_path: PathBuf,
    items: Mutex<Vec<ResourceFavorite>>,
}

impl ResourceFavoriteService {
    pub fn new() -> Self {
        let data_dir = settings::resolve_base_dir().join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("resource_favorites.json");
        let items = load_from_file(&file_path);
        Self {
            file_path,
            items: Mutex::new(items),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<ResourceFavorite>> {
        // 中毒锁恢复：单条记录损坏不应让整个收藏功能不可用。
        self.items.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 原子写：先写同目录临时文件，再 rename 覆盖目标（避免半截 JSON 落盘）。
    fn save_locked(&self, items: &[ResourceFavorite]) -> Result<(), String> {
        let json =
            serde_json::to_string_pretty(items).map_err(|e| format!("序列化收藏列表失败: {e}"))?;
        let tmp = self.file_path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {e}"))?;
        std::fs::rename(&tmp, &self.file_path).map_err(|e| format!("替换收藏文件失败: {e}"))?;
        Ok(())
    }

    /// 全部收藏，按 `createdAt` 降序（RFC3339 UTC → 字典序即时间序）。
    pub fn get_all(&self) -> Vec<ResourceFavorite> {
        let mut items = self.lock().clone();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    /// 新增或更新（按唯一键 `source + id + category`）。
    ///
    /// 已存在时只刷新资源快照与 P2 字段，**保留原 `createdAt`**（收藏时间不因
    /// 重复收藏被刷新）；`createdAt` 一律由服务端生成。
    ///
    /// 语义要点：
    /// - 键段先 `trim` 再匹配/存储。`DELETE` 侧会对查询参数做同样裁剪，若这里存
    ///   原值，形如 `" modrinth "` 的键写入后将**永远无法删除**。
    /// - 先在**副本**上改、落盘成功后才提交到内存。否则保存失败（磁盘满/权限）
    ///   会让内存保留一条未持久化的改动：前端已回滚、`GET` 却仍能读到它，
    ///   重启后又消失，三处状态互相矛盾。
    pub fn upsert(&self, mut item: ResourceFavorite) -> Result<ResourceFavorite, String> {
        item.normalize_key();
        item.normalize_meta();
        let mut guard = self.lock();
        let mut next = guard.clone();
        match next
            .iter_mut()
            .find(|x| x.matches(&item.source, &item.id, &item.category))
        {
            Some(existing) => {
                item.created_at = existing.created_at.clone();
                *existing = item.clone();
            }
            None => {
                item.created_at = chrono::Utc::now().to_rfc3339();
                next.push(item.clone());
            }
        }
        self.save_locked(&next)?;
        *guard = next;
        Ok(item)
    }

    /// 按唯一键删除；命中返回 `true`。
    ///
    /// 与 `upsert` 同样是「先落盘、后提交内存」，且未命中时不触碰磁盘。
    pub fn remove(&self, source: &str, id: &str, category: &str) -> Result<bool, String> {
        let (source, id, category) = (source.trim(), id.trim(), category.trim());
        let mut guard = self.lock();
        if !guard.iter().any(|x| x.matches(source, id, category)) {
            return Ok(false);
        }
        let mut next = guard.clone();
        next.retain(|x| !x.matches(source, id, category));
        self.save_locked(&next)?;
        *guard = next;
        Ok(true)
    }

    /// 删除指定收藏夹内的**全部**收藏，返回删除条数（P2 删夹子的级联步骤）。
    ///
    /// 与 `remove` 同一口径：先在副本上改、落盘成功才提交内存；空夹子不触碰磁盘。
    /// 端点负责先调本方法、再删收藏夹实体 —— 顺序理由见
    /// `resource_favorite_folder.rs` 的模块注释（避免悬空 `folderId`）。
    pub fn remove_by_folder(&self, folder_id: &str) -> Result<usize, String> {
        let folder_id = folder_id.trim();
        let mut guard = self.lock();
        let hits = guard
            .iter()
            .filter(|x| x.folder_id.as_deref() == Some(folder_id))
            .count();
        if hits == 0 {
            return Ok(0);
        }
        let mut next = guard.clone();
        next.retain(|x| x.folder_id.as_deref() != Some(folder_id));
        self.save_locked(&next)?;
        *guard = next;
        Ok(hits)
    }
}

fn load_from_file(file_path: &PathBuf) -> Vec<ResourceFavorite> {
    if file_path.exists() {
        if let Ok(content) = std::fs::read_to_string(file_path) {
            if let Ok(list) = serde_json::from_str::<Vec<ResourceFavorite>>(&content) {
                return list;
            }
            // 文件损坏时按空列表启动（不覆盖原文件，等下一次写入才重建）。
            eprintln!(
                "[resource_favorite] 收藏文件解析失败，按空列表启动: {}",
                file_path.display()
            );
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, category: &str, title: &str) -> ResourceFavorite {
        ResourceFavorite {
            source: "modrinth".to_string(),
            id: id.to_string(),
            category: category.to_string(),
            title: title.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn upsert_dedups_by_unique_key_and_preserves_created_at() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let svc = ResourceFavoriteService {
            file_path: dir.join("resource_favorites.json"),
            items: Mutex::new(Vec::new()),
        };

        let first = svc.upsert(item("AANobbMI", "mod", "Sodium")).unwrap();
        assert!(!first.created_at.is_empty());
        // 同键再次 upsert：只换快照，不新增、不刷新 createdAt。
        let second = svc.upsert(item("AANobbMI", "mod", "Sodium 改名")).unwrap();
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(svc.get_all().len(), 1);
        assert_eq!(svc.get_all()[0].title, "Sodium 改名");
        // 同 id 不同 category 视为另一条。
        svc.upsert(item("AANobbMI", "modpack", "Sodium")).unwrap();
        assert_eq!(svc.get_all().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_matches_full_unique_key_only() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let svc = ResourceFavoriteService {
            file_path: dir.join("resource_favorites.json"),
            items: Mutex::new(Vec::new()),
        };
        svc.upsert(item("P", "mod", "P")).unwrap();

        assert!(!svc.remove("modrinth", "P", "modpack").unwrap());
        assert_eq!(svc.get_all().len(), 1);
        assert!(svc.remove("modrinth", "P", "mod").unwrap());
        assert!(svc.get_all().is_empty());
        // 重复删除不再触发保存，且仍返回 false。
        assert!(!svc.remove("modrinth", "P", "mod").unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_tolerates_missing_and_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("resource_favorites.json");

        assert!(load_from_file(&path).is_empty());
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_from_file(&path).is_empty());
        std::fs::write(&path, "[]").unwrap();
        assert!(load_from_file(&path).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 前后端契约：落盘/返回的键名必须是 camelCase，且与 `src/types/index.ts`
    /// 的 `ResourceFavorite` 逐字段对齐——键名写错会静默丢数据（前端读到
    /// `undefined`），这类 bug 类型检查抓不到。
    #[test]
    fn json_contract_is_camel_case_and_field_complete() {
        let full = ResourceFavorite {
            source: "modrinth".into(),
            id: "AANobbMI".into(),
            category: "mod".into(),
            title: "Sodium".into(),
            description: "d".into(),
            author: "jellysquid".into(),
            icon_url: "http://x/i.png".into(),
            download_count: 7,
            categories: vec!["optimization".into()],
            project_url: "http://x/p".into(),
            slug: "sodium".into(),
            latest_version: "mc1.21.4-0.6.0".into(),
            folder_id: None,
            note: None,
            tags: vec![],
            created_at: "2026-10-01T00:00:00+00:00".into(),
        };
        let v = serde_json::to_value(&full).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "source",
            "id",
            "category",
            "title",
            "description",
            "author",
            "iconUrl",
            "downloadCount",
            "categories",
            "projectUrl",
            "slug",
            "latestVersion",
            "folderId",
            "note",
            "tags",
            "createdAt",
        ] {
            assert!(obj.contains_key(key), "缺少契约字段 {key}");
        }
        assert!(
            !obj.contains_key("icon_url"),
            "键名必须 camelCase，不能是 snake_case"
        );
        assert_eq!(obj.len(), 16, "字段数变化说明契约已漂移");

        // 反序列化：前端最简请求（仅必填键）必须走 Default 而不是报错。
        let minimal: ResourceFavorite = serde_json::from_str(
            r#"{"source":"curseforge","id":"238222","category":"mod","createdAt":""}"#,
        )
        .unwrap();
        assert_eq!(minimal.title, "");
        assert_eq!(minimal.latest_version, "");
        assert_eq!(minimal.download_count, 0);
        assert!(minimal.categories.is_empty());
        assert!(minimal.folder_id.is_none());
        assert!(minimal.tags.is_empty());
    }

    /// P2 预留字段（`folderId` / `note` / `tags`）在 P1 也必须原样落盘往返，
    /// 否则 P2 接 UI 时会丢数据。
    #[test]
    fn reserved_p2_fields_round_trip() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("resource_favorites.json");
        let svc = ResourceFavoriteService {
            file_path: path.clone(),
            items: Mutex::new(Vec::new()),
        };
        let mut with_p2 = item("AANobbMI", "mod", "Sodium");
        with_p2.folder_id = Some("fav-1".into());
        with_p2.note = Some("常用".into());
        with_p2.tags = vec!["优化".into()];
        svc.upsert(with_p2).unwrap();

        // 重新构造服务（走 load_from_file）验证字段真的落了盘。
        let reloaded = ResourceFavoriteService {
            file_path: path.clone(),
            items: Mutex::new(load_from_file(&path)),
        };
        let got = reloaded.get_all();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].folder_id.as_deref(), Some("fav-1"));
        assert_eq!(got[0].note.as_deref(), Some("常用"));
        assert_eq!(got[0].tags, vec!["优化".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 键段在写入侧裁剪：`DELETE` 的查询参数会 trim 后精确匹配，因此写入也必须
    /// 用同一口径，否则 `" modrinth "` 这类键存进去就再也删不掉。
    #[test]
    fn keys_are_trimmed_on_write_and_match_on_delete() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let svc = ResourceFavoriteService {
            file_path: dir.join("resource_favorites.json"),
            items: Mutex::new(Vec::new()),
        };

        let mut padded = item("AANobbMI", "mod", "Sodium");
        padded.source = "  modrinth \t".into();
        padded.id = " AANobbMI\n".into();
        padded.category = "mod ".into();
        let saved = svc.upsert(padded).unwrap();
        assert_eq!(saved.source, "modrinth");
        assert_eq!(saved.id, "AANobbMI");
        assert_eq!(saved.category, "mod");

        // 落盘内容也必须是裁剪后的键。
        let on_disk = load_from_file(&dir.join("resource_favorites.json"));
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].source, "modrinth");

        // DELETE 侧（此处模拟其已裁剪的入参）必须能命中；带空白的入参同样命中。
        assert!(svc.remove("modrinth", "AANobbMI", "mod").unwrap());
        svc.upsert(item("AANobbMI", "mod", "Sodium")).unwrap();
        assert!(svc.remove(" modrinth ", " AANobbMI ", " mod ").unwrap());
        assert!(svc.get_all().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 落盘失败时**不得**改动内存：否则前端已回滚、`GET` 却仍能读到未持久化的
    /// 条目，重启后又消失（UI / 内存 / 磁盘三处状态互相矛盾）。
    #[test]
    fn save_failure_leaves_memory_untouched() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 父目录不存在 → 临时文件写入必然失败（模拟磁盘满/权限不足）。
        let broken_path = dir.join("missing-subdir").join("resource_favorites.json");

        let svc = ResourceFavoriteService {
            file_path: broken_path.clone(),
            items: Mutex::new(Vec::new()),
        };
        let err = svc
            .upsert(item("AANobbMI", "mod", "Sodium"))
            .expect_err("落盘失败必须返回 Err");
        assert!(err.contains("写入临时文件失败"), "实际错误: {err}");
        assert!(
            svc.get_all().is_empty(),
            "upsert 落盘失败后内存必须保持为空"
        );

        // remove：内存里有条目、落盘失败 → 同样不能把条目从内存里删掉。
        let svc2 = ResourceFavoriteService {
            file_path: broken_path,
            items: Mutex::new(vec![item("JEI", "mod", "JEI")]),
        };
        assert!(svc2
            .remove("modrinth", "JEI", "mod")
            .expect_err("落盘失败必须返回 Err")
            .contains("写入临时文件失败"));
        assert_eq!(
            svc2.get_all().len(),
            1,
            "remove 落盘失败后内存必须保留原条目"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P2 元数据在落库边界统一规范化：夹子 id 与备注裁剪、空串转 `None`、
    /// 标签去空 + 大小写不敏感去重（保留首次写法）+ 上限。
    #[test]
    fn p2_meta_is_normalized_on_write() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let svc = ResourceFavoriteService {
            file_path: dir.join("resource_favorites.json"),
            items: Mutex::new(Vec::new()),
        };

        let mut with_meta = item("AANobbMI", "mod", "Sodium");
        with_meta.folder_id = Some("  f-1  ".into());
        with_meta.note = Some("  常用性能模组  ".into());
        with_meta.tags = vec![
            " 优化 ".into(),
            "".into(),
            "   ".into(),
            "优化".into(), // 与第一条重复（去空白后同名）→ 丢弃
            "Performance".into(),
            "performance".into(),           // 大小写不敏感去重 → 丢弃
            "字".repeat(MAX_TAG_CHARS + 5), // 超长 → 截断
        ];
        let saved = svc.upsert(with_meta).unwrap();
        assert_eq!(saved.folder_id.as_deref(), Some("f-1"));
        assert_eq!(saved.note.as_deref(), Some("常用性能模组"));
        assert_eq!(
            saved.tags,
            vec![
                "优化".to_string(),
                "Performance".to_string(),
                "字".repeat(MAX_TAG_CHARS),
            ]
        );

        // 空串一律转 None（前端清空选择/清空备注时可能传 ""）。
        let mut cleared = item("238222", "mod", "JEI");
        cleared.folder_id = Some("   ".into());
        cleared.note = Some("".into());
        let saved2 = svc.upsert(cleared).unwrap();
        assert!(saved2.folder_id.is_none());
        assert!(saved2.note.is_none());

        // 标签数量上限。
        let mut many = item("X", "mod", "X");
        many.tags = (0..(MAX_TAGS + 8)).map(|i| format!("t{i}")).collect();
        let saved3 = svc.upsert(many).unwrap();
        assert_eq!(saved3.tags.len(), MAX_TAGS);

        // 备注长度按字符截断。
        let mut long_note = item("Y", "mod", "Y");
        long_note.note = Some("字".repeat(MAX_NOTE_CHARS + 50));
        let saved4 = svc.upsert(long_note).unwrap();
        assert_eq!(
            saved4.note.as_deref().map(|n| n.chars().count()),
            Some(MAX_NOTE_CHARS)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 删夹子的级联步骤：按 `folderId` 删除全部条目；空夹子不触碰磁盘。
    #[test]
    fn remove_by_folder_cascades_and_is_noop_when_empty() {
        let dir = std::env::temp_dir().join(format!("qmx-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("resource_favorites.json");
        let svc = ResourceFavoriteService {
            file_path: path.clone(),
            items: Mutex::new(Vec::new()),
        };

        let mut in_f1_a = item("A", "mod", "A");
        in_f1_a.folder_id = Some("f1".into());
        let mut in_f1_b = item("B", "mod", "B");
        in_f1_b.folder_id = Some("f1".into());
        let mut in_f2 = item("C", "mod", "C");
        in_f2.folder_id = Some("f2".into());
        let unfiled = item("D", "mod", "D");
        for it in [in_f1_a, in_f1_b, in_f2, unfiled] {
            svc.upsert(it).unwrap();
        }
        assert_eq!(svc.get_all().len(), 4);

        assert_eq!(svc.remove_by_folder("f1").unwrap(), 2);
        let left: Vec<_> = svc.get_all().into_iter().map(|f| f.id).collect();
        assert_eq!(left.len(), 2);
        assert!(left.contains(&"C".to_string()) && left.contains(&"D".to_string()));

        // 落盘内容也应同步（重新加载验证）。
        let reloaded = ResourceFavoriteService {
            file_path: path,
            items: Mutex::new(load_from_file(&dir.join("resource_favorites.json"))),
        };
        assert_eq!(reloaded.get_all().len(), 2);

        // 再删同一个空夹子：0 条，且不触碰磁盘。
        assert_eq!(svc.remove_by_folder("f1").unwrap(), 0);
        assert_eq!(svc.remove_by_folder("nope").unwrap(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
