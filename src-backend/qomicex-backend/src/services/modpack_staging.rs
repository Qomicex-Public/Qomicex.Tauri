// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 整合包安装失败的暂存区。
//!
//! 安装失败时把已下载的版本隔离目录整体挪到 `{gameDir}/.qml-install-staging/{key}/`，
//! 而不是连同实例记录一起删除：用户点重试时把目录搬回去，`download_batch` 跳过其中
//! 已校验完整的文件，避免整包重下。直接移除任务则由 [`drop_entry`] 删除。
//!
//! 放在 gameDir 下而不是启动器数据目录：两处通常不在同一个卷，`rename` 跨卷会失败，
//! 而复制一个几百 MB 的整合包没有意义。这个目录名以 `.` 开头且不在 `versions/` 下，
//! 不会被实例扫描识别。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 暂存条目保留时长：超过后由 [`cleanup_expired`] 删除。
pub const DEFAULT_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

const ROOT_DIR: &str = ".qml-install-staging";
const PAYLOAD_DIR: &str = "payload";
const META_FILE: &str = "meta.json";

/// `stash` / `take` / [`drop_entry`] 串行化：同一批次的并发安装、以及「移除任务」与
/// 「重试」同时发生时，不能让一个操作删掉另一个正在使用的目录。
static OP_LOCK: Mutex<()> = Mutex::new(());

/// 暂存时记录的文件清单（相对版本目录）。恢复时只认**大小一致**的文件：宁可重下，
/// 也不复用截断或过期的内容。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StagingFile {
    pub rel: String,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StagingMeta {
    /// 实例在版本列表里的显示名（恢复后即可用于提示）。
    pub name: String,
    pub source: String,
    pub project_id: String,
    pub version_id: String,
    /// 暂存时间（Unix 秒），TTL 以此为准。
    pub created_at: u64,
    /// 暂存时已完整的文件。缺失（旧版本写入的条目）时一律重下。
    #[serde(default)]
    pub files: Vec<StagingFile>,
}

impl StagingMeta {
    /// 恢复后的绝对路径 → 期望大小，供 `download_batch` 判定能否跳过。
    pub fn size_map(&self, target_dir: &Path) -> HashMap<PathBuf, u64> {
        self.files
            .iter()
            .map(|f| (target_dir.join(&f.rel), f.size))
            .collect()
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 由整合包坐标生成稳定的暂存键；缺少 project/version 时返回 `None`
/// （这类安装无法在重试时还原成同一份包，保持原有的删除回滚行为）。
///
/// `source` 统一转小写：安装入口传的是规范化后的值，删除入口传的是前端原值，
/// 不归一化会让同一份包算出两个键。
pub fn key_for(source: &str, project_id: Option<&str>, version_id: Option<&str>) -> Option<String> {
    let source = source.trim().to_ascii_lowercase();
    let project = project_id?.trim();
    let version = version_id?.trim();
    if source.is_empty() || project.is_empty() || version.is_empty() {
        return None;
    }
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    hasher.update([0u8]);
    hasher.update(project.as_bytes());
    hasher.update([0u8]);
    hasher.update(version.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("{}-{hex}", sanitize(&source, 16)))
}

fn sanitize(input: &str, max: usize) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(max)
        .collect();
    if cleaned.is_empty() {
        "pack".to_string()
    } else {
        cleaned
    }
}

pub fn root(game_dir: &Path) -> PathBuf {
    game_dir.join(ROOT_DIR)
}

fn entry_dir(game_dir: &Path, key: &str) -> PathBuf {
    root(game_dir).join(key)
}

/// 递归记录 payload 中的文件（相对路径 + 大小）。
fn collect_files(root: &Path) -> Vec<StagingFile> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(StagingFile {
                        rel: rel.to_string_lossy().replace('\\', "/"),
                        size: meta.len(),
                    });
                }
            }
        }
    }
    out
}

/// 把版本隔离目录挪进暂存区。失败时返回错误，调用方应退回原来的删除逻辑。
///
/// 已有同键条目时**不覆盖**：并发失败的两个安装各自持有一份不完整内容，保留先生成的
/// 那份即可，覆盖只会让两份都不可用。
pub fn stash(
    game_dir: &Path,
    version_dir_name: &str,
    key: &str,
    mut meta: StagingMeta,
) -> Result<PathBuf, String> {
    let _guard = OP_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let source = game_dir.join("versions").join(version_dir_name);
    if !source.is_dir() {
        return Err(format!("版本目录不存在：{}", source.display()));
    }
    let dir = entry_dir(game_dir, key);
    if dir.exists() {
        return Err(format!("已有暂存条目，保留原有内容：{}", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建暂存目录失败：{e}"))?;
    let payload = dir.join(PAYLOAD_DIR);
    if let Err(e) = std::fs::rename(&source, &payload) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("移入暂存区失败：{e}"));
    }
    meta.files = collect_files(&payload);
    let meta_json = serde_json::to_vec(&meta).map_err(|e| format!("序列化暂存元数据失败：{e}"))?;
    std::fs::write(dir.join(META_FILE), meta_json)
        .map_err(|e| format!("写入暂存元数据失败：{e}"))?;
    Ok(dir)
}

/// 把暂存内容搬回 `{gameDir}/versions/{target_name}`。
///
/// 目标目录已存在时**不动它**，返回 `Ok(None)`：同名实例可能已由别的流程创建，
/// 递归删除会连带删掉不属于本次安装的文件。暂存条目保留到 TTL 或用户移除任务。
pub fn take(game_dir: &Path, key: &str, target_name: &str) -> Result<Option<StagingMeta>, String> {
    let _guard = OP_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = entry_dir(game_dir, key);
    let payload = dir.join(PAYLOAD_DIR);
    if !payload.is_dir() {
        return Ok(None);
    }
    let target = game_dir.join("versions").join(target_name);
    if target.exists() {
        return Ok(None);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建版本目录失败：{e}"))?;
    }
    let meta = std::fs::read(dir.join(META_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<StagingMeta>(&b).ok());
    std::fs::rename(&payload, &target).map_err(|e| format!("恢复暂存目录失败：{e}"))?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(Some(meta.unwrap_or_else(|| StagingMeta {
        name: target_name.to_string(),
        source: String::new(),
        project_id: String::new(),
        version_id: String::new(),
        created_at: now_secs(),
        files: Vec::new(),
    })))
}

/// 读取暂存条目的元数据（不改动目录）；条目不存在或元数据不可读时返回 `None`。
pub fn meta_of(game_dir: &Path, key: &str) -> Option<StagingMeta> {
    std::fs::read(entry_dir(game_dir, key).join(META_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// 删除指定暂存条目（用户移除任务时调用）。
pub fn drop_entry(game_dir: &Path, key: &str) -> Result<bool, String> {
    let _guard = OP_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = entry_dir(game_dir, key);
    if !dir.exists() {
        return Ok(false);
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除暂存目录失败：{e}"))?;
    Ok(true)
}

/// 删除超过 `ttl` 的暂存条目，返回删除数量。
pub fn cleanup_expired(game_dir: &Path, ttl: Duration) -> usize {
    let _guard = OP_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let root = root(game_dir);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return 0;
    };
    let cutoff = now_secs().saturating_sub(ttl.as_secs());
    let mut removed = 0;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let created = std::fs::read(dir.join(META_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice::<StagingMeta>(&b).ok())
            .map(|m| m.created_at)
            .or_else(|| {
                // 元数据缺失（写入中断）时退回目录 mtime，避免永久残留。
                std::fs::metadata(&dir)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
            });
        if created.is_some_and(|c| c < cutoff) && std::fs::remove_dir_all(&dir).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_game_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qomicex-staging-{tag}-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("versions")).unwrap();
        dir
    }

    fn meta() -> StagingMeta {
        StagingMeta {
            name: "ATM10".to_string(),
            source: "curseforge".to_string(),
            project_id: "1".to_string(),
            version_id: "2".to_string(),
            created_at: now_secs(),
            files: Vec::new(),
        }
    }

    #[test]
    fn key_is_stable_and_rejects_missing_coordinates() {
        let a = key_for("curseforge", Some("123"), Some("456")).unwrap();
        let b = key_for("curseforge", Some("123"), Some("456")).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, key_for("curseforge", Some("123"), Some("457")).unwrap());
        assert!(key_for("curseforge", None, Some("456")).is_none());
        assert!(key_for("curseforge", Some("123"), Some("")).is_none());
        assert!(!a.contains("..") && !a.contains('/') && !a.contains('\\'));
    }

    /// 安装入口传规范化后的 source，删除入口传前端原值：大小写不同必须落到同一个键。
    #[test]
    fn key_normalizes_source_case() {
        let lower = key_for("curseforge", Some("123"), Some("456")).unwrap();
        let upper = key_for("CurseForge", Some("123"), Some("456")).unwrap();
        assert_eq!(lower, upper);
    }

    #[test]
    fn stash_then_take_restores_files_with_sizes() {
        let game_dir = temp_game_dir("roundtrip");
        let version = game_dir.join("versions").join("ATM10");
        std::fs::create_dir_all(version.join("mods")).unwrap();
        std::fs::write(version.join("mods").join("a.jar"), b"payload").unwrap();

        let key = key_for("curseforge", Some("1"), Some("2")).unwrap();
        stash(&game_dir, "ATM10", &key, meta()).unwrap();
        assert!(!version.exists(), "暂存后版本目录应已移走");

        let restored = take(&game_dir, &key, "ATM10").unwrap().expect("应命中暂存");
        assert_eq!(restored.files.len(), 1);
        assert_eq!(restored.files[0].rel, "mods/a.jar");
        assert_eq!(restored.files[0].size, 7);
        let target = game_dir.join("versions").join("ATM10");
        let sizes = restored.size_map(&target);
        assert_eq!(sizes.get(&target.join("mods").join("a.jar")), Some(&7));

        assert_eq!(
            std::fs::read(target.join("mods").join("a.jar")).unwrap(),
            b"payload"
        );
        assert!(!game_dir.join(ROOT_DIR).join(&key).exists());
    }

    /// 重试时实例名可能变化（同名实例已存在会加后缀），恢复必须落到新名字下。
    #[test]
    fn take_restores_into_renamed_target() {
        let game_dir = temp_game_dir("renamed");
        let version = game_dir.join("versions").join("ATM10");
        std::fs::create_dir_all(version.join("mods")).unwrap();
        std::fs::write(version.join("mods").join("a.jar"), b"payload").unwrap();

        let key = key_for("curseforge", Some("1"), Some("2")).unwrap();
        stash(&game_dir, "ATM10", &key, meta()).unwrap();

        let restored = take(&game_dir, &key, "ATM10-retry")
            .unwrap()
            .expect("应命中暂存");
        assert_eq!(restored.name, "ATM10", "元数据保留原始展示名");
        assert!(!game_dir.join("versions").join("ATM10").exists());
        assert_eq!(
            std::fs::read(
                game_dir
                    .join("versions")
                    .join("ATM10-retry")
                    .join("mods")
                    .join("a.jar")
            )
            .unwrap(),
            b"payload"
        );
        let sizes = restored.size_map(&game_dir.join("versions").join("ATM10-retry"));
        assert!(
            sizes.contains_key(
                &game_dir
                    .join("versions")
                    .join("ATM10-retry")
                    .join("mods")
                    .join("a.jar")
            ),
            "size_map 必须按新目标目录生成"
        );
    }

    /// 恢复目标已存在时不得删除它（可能是同名实例），返回 None 并保留暂存。
    #[test]
    fn take_keeps_existing_target_untouched() {
        let game_dir = temp_game_dir("exists");
        let version = game_dir.join("versions").join("ATM10");
        std::fs::create_dir_all(&version).unwrap();
        std::fs::write(version.join("x.jar"), b"x").unwrap();
        let key = key_for("curseforge", Some("1"), Some("2")).unwrap();
        stash(&game_dir, "ATM10", &key, meta()).unwrap();

        // 目标目录被别的流程重新创建
        std::fs::create_dir_all(&version).unwrap();
        std::fs::write(version.join("user-config.txt"), b"keep").unwrap();

        assert!(take(&game_dir, &key, "ATM10").unwrap().is_none());
        assert_eq!(
            std::fs::read(version.join("user-config.txt")).unwrap(),
            b"keep",
            "已存在的目标目录不得被删除"
        );
        assert!(
            game_dir.join(ROOT_DIR).join(&key).exists(),
            "未消费的暂存条目应保留"
        );
    }

    /// 同键已有暂存条目时不得覆盖（并发失败的两个安装）。
    #[test]
    fn second_stash_does_not_clobber_first() {
        let game_dir = temp_game_dir("clobber");
        let key = key_for("curseforge", Some("1"), Some("2")).unwrap();
        for (name, body) in [("A", b"first".as_slice()), ("B", b"second".as_slice())] {
            let version = game_dir.join("versions").join(name);
            std::fs::create_dir_all(&version).unwrap();
            std::fs::write(version.join("f.jar"), body).unwrap();
            let result = stash(&game_dir, name, &key, meta());
            if name == "A" {
                assert!(result.is_ok());
            } else {
                assert!(result.is_err(), "第二个 stash 应被拒绝");
            }
        }
        let payload = game_dir.join(ROOT_DIR).join(&key).join(PAYLOAD_DIR);
        assert_eq!(std::fs::read(payload.join("f.jar")).unwrap(), b"first");
        assert!(
            game_dir.join("versions").join("B").exists(),
            "被拒绝的安装目录留给调用方按原逻辑处理"
        );
    }

    #[test]
    fn take_without_entry_is_noop() {
        let game_dir = temp_game_dir("miss");
        let key = key_for("curseforge", Some("1"), Some("2")).unwrap();
        assert!(take(&game_dir, &key, "ATM10").unwrap().is_none());
    }

    #[test]
    fn drop_entry_removes_payload() {
        let game_dir = temp_game_dir("drop");
        let version = game_dir.join("versions").join("ATM10");
        std::fs::create_dir_all(&version).unwrap();
        std::fs::write(version.join("x.jar"), b"x").unwrap();
        let key = key_for("curseforge", Some("1"), Some("2")).unwrap();
        stash(&game_dir, "ATM10", &key, meta()).unwrap();
        assert!(drop_entry(&game_dir, &key).unwrap());
        assert!(!game_dir.join(ROOT_DIR).join(&key).exists());
        assert!(
            !drop_entry(&game_dir, &key).unwrap(),
            "重复删除应返回 false"
        );
    }

    #[test]
    fn cleanup_removes_only_expired_entries() {
        let game_dir = temp_game_dir("ttl");
        let fresh_key = key_for("curseforge", Some("1"), Some("2")).unwrap();
        let stale_key = key_for("curseforge", Some("1"), Some("3")).unwrap();
        for key in [&fresh_key, &stale_key] {
            let version = game_dir.join("versions").join(format!("v-{key}"));
            std::fs::create_dir_all(&version).unwrap();
            std::fs::write(version.join("a.jar"), b"a").unwrap();
            stash(&game_dir, &format!("v-{key}"), key, meta()).unwrap();
        }
        // 把 stale 条目的创建时间改到 8 天前
        let stale_meta_path = game_dir.join(ROOT_DIR).join(&stale_key).join(META_FILE);
        let mut stale: StagingMeta =
            serde_json::from_slice(&std::fs::read(&stale_meta_path).unwrap()).unwrap();
        stale.created_at = now_secs() - 8 * 24 * 60 * 60;
        std::fs::write(&stale_meta_path, serde_json::to_vec(&stale).unwrap()).unwrap();

        assert_eq!(cleanup_expired(&game_dir, DEFAULT_TTL), 1);
        assert!(game_dir.join(ROOT_DIR).join(&fresh_key).exists());
        assert!(!game_dir.join(ROOT_DIR).join(&stale_key).exists());
    }
}
