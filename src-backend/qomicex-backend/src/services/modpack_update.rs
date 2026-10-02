//! 整合包原地更新的**执行引擎**（issue #118，方案 C）。
//!
//! ## 与「新建实例」的根本区别
//!
//! 安装失败会调 `try_delete`（连实例记录一起删）——那对**新建**是合理的
//! （不残留不可用实例），但对**原地更新**是灾难：用户的实例与存档会消失。
//! 因此本引擎绝不触碰 `try_delete`，失败一律走自己的 journal 回滚。
//!
//! ## 执行流程
//!
//! ```text
//! ① 下载新包体到暂存区（不改实例）
//! ② 备份将被覆盖/删除的文件 → .qomicex/update-backup/<ts>/
//! ③ 写 journal.json（状态 prepared → applying）
//! ④ 逐文件应用（同卷 rename 落位；删除 removed 类）
//! ⑤ 成功 → journal 标 done，重建清单，清理暂存
//! ⑥ 任一步失败 → 按 journal 逆序恢复 → 状态记 rolledBack
//! ```
//!
//! ## 崩溃恢复
//!
//! 进程在 `applying` 中途崩溃会留下半更新实例。启动时扫描各实例的 journal，
//! 状态仍为 `applying` 的自动回滚（见 [`rollback_pending_updates`]）。
//!
//! ## 边界（与 issue #118 决策一致）
//!
//! - `saves/` 下的文件**永不写入、永不删除**；
//! - 不在清单中的文件（用户自加）**一律不动**；
//! - 用户改过的文件在被覆盖前**先备份**；
//! - 新包已移除但用户改过的文件**保留**。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::services::modpack_manifest::{self, HostedFile, HostedFileKind, ModpackManifest};

/// journal 状态机。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalState {
    /// 已写好计划、备份完成，尚未开始改动实例。
    Prepared,
    /// 正在应用（**崩溃时此状态表示需要回滚**）。
    Applying,
    /// 全部应用完成。
    Done,
    /// 已回滚回原状。
    RolledBack,
}

/// 单个文件操作记录（回滚的依据）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOp {
    /// 相对实例根目录的路径（`/` 分隔）。
    pub path: String,
    pub action: JournalAction,
    /// 备份文件在该备份目录内的相对位置（`overwrite` / `remove` 有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<String>,
    /// 该操作是否已执行（回滚只撤销已执行的操作）。
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalAction {
    /// 文件将被新版本覆盖（旧内容已备份）。
    Overwrite,
    /// 文件将被删除（旧内容已备份）。
    Remove,
    /// 文件是新版本新增（回滚时删除）。
    Create,
}

/// 更新日志：记录计划执行的操作与状态，是崩溃恢复与回滚的唯一依据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateJournal {
    pub schema_version: u32,
    pub state: JournalState,
    /// 本次更新的备份目录名（`update-backup/<stamp>`）。
    /// 记进 journal 而非回滚时「猜最新目录」—— 崩溃恢复必须自包含且可重复。
    pub backup_stamp: String,
    /// 更新目标版本 id（成功收尾时写回实例记录）。
    pub target_version_id: String,
    /// 目标版本的 MC/加载器（用于收尾时更新记录）。
    pub target_game_version: String,
    pub target_loader: Option<String>,
    pub target_loader_version: Option<String>,
    /// 启动本次更新时的实例记录快照（回滚时恢复）。
    pub instance_snapshot: serde_json::Value,
    /// 版本目录下那些非托管文件（版本 json/jar）的备份相对路径。
    #[serde(default)]
    pub version_files_backup: Vec<String>,
    pub ops: Vec<JournalOp>,
}

pub const JOURNAL_SCHEMA_VERSION: u32 = 1;
const JOURNAL_FILE: &str = "update-journal.json";
const BACKUP_DIR: &str = "update-backup";
const STAGING_DIR: &str = "update-staging";

/// 实例内 `.qomicex/` 目录。
pub fn qomicex_dir(instance_dir: &Path) -> PathBuf {
    instance_dir.join(modpack_manifest::QOMICEX_DIR)
}

/// journal 文件路径（实例内）。
pub fn journal_path(instance_dir: &Path) -> PathBuf {
    qomicex_dir(instance_dir).join(JOURNAL_FILE)
}

/// 本次更新的暂存目录（新文件先落这里，避免污染实例）。
pub fn staging_dir(instance_dir: &Path) -> PathBuf {
    qomicex_dir(instance_dir).join(STAGING_DIR)
}

/// 备份根目录。
pub fn backup_root(instance_dir: &Path) -> PathBuf {
    qomicex_dir(instance_dir).join(BACKUP_DIR)
}

/// 本次更新的备份目录（带时间戳，便于用户手工找回）。
pub fn new_backup_dir(instance_dir: &Path) -> PathBuf {
    let ts = new_backup_stamp();
    backup_root(instance_dir).join(ts)
}

/// 生成备份目录名（时间戳）。目录名即 journal 里的 `backupStamp`。
pub fn new_backup_stamp() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 读取 journal；缺失/损坏 → None。
pub fn load_journal(instance_dir: &Path) -> Option<UpdateJournal> {
    let content = std::fs::read_to_string(journal_path(instance_dir)).ok()?;
    serde_json::from_str::<UpdateJournal>(&content).ok()
}

/// 写入 journal（原子替换：临时文件 + rename）。
pub fn save_journal(instance_dir: &Path, journal: &UpdateJournal) -> Result<(), String> {
    let path = journal_path(instance_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 .qomicex 目录失败 {}: {e}", parent.display()))?;
    }
    let json =
        serde_json::to_string_pretty(journal).map_err(|e| format!("序列化更新日志失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入更新日志失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换更新日志失败: {e}")
    })
}

/// 备份一个文件到备份目录，返回备份内的相对路径。
fn backup_file(
    instance_dir: &Path,
    backup_dir: &Path,
    rel: &str,
) -> Result<Option<String>, String> {
    let src = instance_dir.join(modpack_manifest::normalize_rel_path(rel));
    if !src.is_file() {
        return Ok(None);
    }
    // 备份路径沿用原相对结构（`<backup>/files/<rel>`），便于用户直接翻找。
    let backup_rel = format!("files/{}", modpack_manifest::normalize_rel_path(rel));
    let dst = backup_dir.join(&backup_rel);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建备份目录失败 {}: {e}", parent.display()))?;
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("备份文件失败 {}: {e}", src.display()))?;
    Ok(Some(backup_rel))
}

/// 备份版本目录下的版本 json / jar（回滚时恢复；也用于加载器变更场景）。
fn backup_version_files(
    instance_dir: &Path,
    backup_dir: &Path,
    version_dir_name: &str,
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for ext in ["json", "jar"] {
        let name = format!("{version_dir_name}.{ext}");
        let src = instance_dir.join(&name);
        if !src.is_file() {
            continue;
        }
        let backup_rel = format!("version/{name}");
        let dst = backup_dir.join(&backup_rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建备份目录失败 {}: {e}", parent.display()))?;
        }
        std::fs::copy(&src, &dst)
            .map_err(|e| format!("备份版本文件失败 {}: {e}", src.display()))?;
        out.push(backup_rel);
    }
    Ok(out)
}

/// 构造并落盘本次更新的操作计划 + 完整备份。
///
/// 返回 journal（状态 `Prepared`）。此时**尚未改动实例任何文件** ——
/// 若此处失败，实例保持原状（调用方只需清理暂存目录）。
pub fn prepare_journal(
    instance_dir: &Path,
    instance_snapshot: serde_json::Value,
    version_dir_name: &str,
    target: &UpdateTarget,
    plan: &UpdatePlan,
) -> Result<UpdateJournal, String> {
    let backup_stamp = new_backup_stamp();
    let backup_dir = backup_root(instance_dir).join(&backup_stamp);
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("创建备份目录失败 {}: {e}", backup_dir.display()))?;

    let mut ops: Vec<JournalOp> = Vec::new();

    // 覆盖类与删除类必须先备份（Create 无需备份）。
    for rel in plan.overwrites.iter().chain(plan.removes.iter()) {
        let backup = backup_file(instance_dir, &backup_dir, rel)?;
        let action = if plan.removes.contains(rel) {
            JournalAction::Remove
        } else {
            JournalAction::Overwrite
        };
        ops.push(JournalOp {
            path: modpack_manifest::normalize_rel_path(rel),
            action,
            // 文件可能已不存在（用户删过）：仍记录操作但无备份。
            backup,
            done: false,
        });
    }
    for rel in &plan.creates {
        ops.push(JournalOp {
            path: modpack_manifest::normalize_rel_path(rel),
            action: JournalAction::Create,
            backup: None,
            done: false,
        });
    }

    let version_files_backup = backup_version_files(instance_dir, &backup_dir, version_dir_name)?;

    let journal = UpdateJournal {
        schema_version: JOURNAL_SCHEMA_VERSION,
        state: JournalState::Prepared,
        backup_stamp,
        target_version_id: target.version_id.clone(),
        target_game_version: target.game_version.clone(),
        target_loader: target.loader.clone(),
        target_loader_version: target.loader_version.clone(),
        instance_snapshot,
        version_files_backup,
        ops,
    };
    save_journal(instance_dir, &journal)?;
    Ok(journal)
}

/// 更新计划：三分类的**相对路径**集合（执行引擎的输入）。
#[derive(Debug, Clone, Default)]
pub struct UpdatePlan {
    /// 需要从暂存区搬运落位的新文件（覆盖已有 + 新增）。
    pub overwrites: Vec<String>,
    pub creates: Vec<String>,
    /// 需要删除的旧文件。
    pub removes: Vec<String>,
}

/// 目标版本信息（收尾时写回实例记录）。
#[derive(Debug, Clone, Default)]
pub struct UpdateTarget {
    pub version_id: String,
    pub game_version: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagedOutcome {
    /// 落位成功（含已有文件被覆盖）。
    Applied,
    /// 暂存区没有该文件（下载被跳过）→ 跳过，不影响其它文件。
    MissingInStaging,
}

/// 把一个暂存文件搬运到实例内目标位置（同卷 rename，跨卷退化为 copy+remove）。
///
/// 先创建父目录；目标已存在时**直接覆盖**（旧内容已由 journal 备份）。
pub fn apply_staged_file(instance_dir: &Path, rel: &str) -> Result<StagedOutcome, String> {
    let rel_norm = modpack_manifest::normalize_rel_path(rel);
    // 安全边界：绝不越界写、绝不动存档。
    if !modpack_manifest::is_safe_rel_path(&rel_norm)
        || modpack_manifest::is_protected_path(&rel_norm)
    {
        return Err(format!("拒绝写入非法或受保护路径: {rel}"));
    }
    let src = staging_dir(instance_dir).join(&rel_norm);
    if !src.is_file() {
        return Ok(StagedOutcome::MissingInStaging);
    }
    let dst = instance_dir.join(&rel_norm);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目标目录失败 {}: {e}", parent.display()))?;
    }
    match std::fs::rename(&src, &dst) {
        Ok(()) => Ok(StagedOutcome::Applied),
        Err(_) => {
            // 跨卷 / 目标被占用：退化为复制后删除源。
            std::fs::copy(&src, &dst)
                .map_err(|e| format!("写入文件失败 {}: {e}", dst.display()))?;
            let _ = std::fs::remove_file(&src);
            Ok(StagedOutcome::Applied)
        }
    }
}

/// 删除一个实例内文件（仅限非受保护、非清单外的调用方保证）。
pub fn apply_remove(instance_dir: &Path, rel: &str) -> Result<(), String> {
    let rel_norm = modpack_manifest::normalize_rel_path(rel);
    // 双保险：即使调用方算错，也绝不删存档。
    if !modpack_manifest::is_safe_rel_path(&rel_norm)
        || modpack_manifest::is_protected_path(&rel_norm)
    {
        return Err(format!("拒绝删除非法或受保护路径: {rel}"));
    }
    let path = instance_dir.join(&rel_norm);
    if !path.is_file() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除文件失败 {}: {e}", path.display()))
}

/// 应用阶段：按 journal 逐条执行，每条完成后立即落盘 journal（崩溃可恢复）。
///
/// 顺序：先写新文件（`Create` + `Overwrite`），再删旧文件（`Remove`）。
/// 这样即使中途崩溃，实例也处于「新文件已就位 + 少量旧文件未清理」的可恢复状态，
/// 而不是「旧文件已删 + 新文件未写」的不可用状态。
pub fn apply_journal(instance_dir: &Path, journal: &mut UpdateJournal) -> Result<(), String> {
    journal.state = JournalState::Applying;
    save_journal(instance_dir, journal)?;

    // 先写后删：索引顺序里 Remove 在 Overwrite 之后，这里重排以保证语义明确。
    let order: Vec<usize> = (0..journal.ops.len())
        .filter(|i| journal.ops[*i].action != JournalAction::Remove)
        .chain((0..journal.ops.len()).filter(|i| journal.ops[*i].action == JournalAction::Remove))
        .collect();

    for idx in order {
        if journal.ops[idx].done {
            continue;
        }
        let (action, path) = {
            let op = &journal.ops[idx];
            (op.action, op.path.clone())
        };
        match action {
            JournalAction::Remove => apply_remove(instance_dir, &path)?,
            JournalAction::Overwrite | JournalAction::Create => {
                apply_staged_file(instance_dir, &path)?;
            }
        }
        journal.ops[idx].done = true;
        // 每步落盘：崩溃时能精确知道做到哪一条。
        save_journal(instance_dir, journal)?;
    }
    Ok(())
}

/// 回滚：按 journal **逆序**撤销已执行的操作。
///
/// - `Create`：删除新增的文件；
/// - `Overwrite` / `Remove`：从备份复制回原位。
///
/// 备份目录名取自 journal 自身（`backup_stamp`），因此崩溃恢复时不需要「猜」
/// 是哪个备份 —— 自包含、可重复调用。
/// 返回 `Err` 表示回滚本身失败（备份目录路径会写进错误信息，供用户手工恢复）。
pub fn rollback(instance_dir: &Path, journal: &mut UpdateJournal) -> Result<(), String> {
    let backup_dir = backup_root(instance_dir).join(&journal.backup_stamp);
    let backup_dir_str = backup_dir.to_string_lossy().to_string();
    let mut errors: Vec<String> = Vec::new();

    for op in journal.ops.iter().rev() {
        if !op.done {
            continue;
        }
        match op.action {
            JournalAction::Create => {
                if let Err(e) = apply_remove(instance_dir, &op.path) {
                    errors.push(e);
                }
            }
            JournalAction::Overwrite | JournalAction::Remove => {
                let Some(backup) = op.backup.as_deref() else {
                    // 无备份（原本就不存在）→ 删除即可。
                    if let Err(e) = apply_remove(instance_dir, &op.path) {
                        errors.push(e);
                    }
                    continue;
                };
                let src = backup_dir.join(backup);
                let dst = instance_dir.join(modpack_manifest::normalize_rel_path(&op.path));
                if let Some(parent) = dst.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::copy(&src, &dst) {
                    errors.push(format!("恢复 {} 失败: {e}", op.path));
                }
            }
        }
    }

    // 恢复版本 json / jar（加载器变更、或版本文件被更新过程重写的场景）。
    for rel in &journal.version_files_backup {
        let src = backup_dir.join(rel);
        let name = rel.strip_prefix("version/").unwrap_or(rel);
        let dst = instance_dir.join(name);
        if src.is_file() {
            if let Err(e) = std::fs::copy(&src, &dst) {
                errors.push(format!("恢复版本文件 {name} 失败: {e}"));
            }
        }
    }

    journal.state = JournalState::RolledBack;
    if let Err(e) = save_journal(instance_dir, journal) {
        errors.push(e);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "MODPACK_UPDATE_ROLLBACK_FAILED: {}；备份目录: {backup_dir_str}",
            errors.join("; ")
        ))
    }
}

/// 回滚（带显式备份时间戳）。
/// 重建托管文件清单（更新成功后调用）。
///
/// 以实例当前磁盘状态为准重扫，得到新的基线。
pub fn rebuild_manifest(
    game_dir: &str,
    instance_name: &str,
    instance_dir: &Path,
    game_version: &str,
    loader: Option<&str>,
    loader_version: Option<&str>,
    origin: modpack_manifest::ManifestOrigin,
    content_rels: &[String],
) -> Result<(), String> {
    let content: std::collections::HashSet<String> = content_rels
        .iter()
        .map(|r| modpack_manifest::normalize_rel_path(r))
        .collect();
    let files: Vec<HostedFile> =
        modpack_manifest::sweep_hosted_files(instance_dir, instance_name, &content);
    let manifest = ModpackManifest {
        schema_version: modpack_manifest::MANIFEST_SCHEMA_VERSION,
        game_version: game_version.to_string(),
        loader: loader.map(String::from).filter(|s| !s.is_empty()),
        loader_version: loader_version.map(String::from).filter(|s| !s.is_empty()),
        origin,
        files,
    };
    modpack_manifest::save_manifest(game_dir, instance_name, &manifest)
}

/// 清理暂存目录（成功收尾或失败回滚后调用）。
pub fn cleanup_staging(instance_dir: &Path) {
    let dir = staging_dir(instance_dir);
    if dir.is_dir() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(dir = %dir.display(), error = %e, "清理更新暂存目录失败");
        }
    }
}

/// 只保留最近一次备份，删除更早的（避免磁盘无限增长）。
pub fn prune_old_backups(instance_dir: &Path) {
    let root = backup_root(instance_dir);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    // 目录名是 `%Y%m%d-%H%M%S`，字典序即时间序。
    dirs.sort();
    if dirs.len() <= 1 {
        return;
    }
    for old in &dirs[..dirs.len() - 1] {
        if let Err(e) = std::fs::remove_dir_all(old) {
            tracing::warn!(dir = %old.display(), error = %e, "清理旧备份失败");
        }
    }
}

/// 启动时扫描所有实例的 journal，把状态停留在 `applying` 的实例回滚。
///
/// 进程在应用阶段中途崩溃会留下半更新实例；这里保证下次启动即恢复。
/// 返回成功回滚的实例数。
pub fn rollback_pending_updates(
    instance_service: &crate::services::instance::InstanceService,
) -> usize {
    let mut count = 0usize;
    for inst in instance_service.get_all() {
        let instance_dir = modpack_manifest::instance_version_dir(&inst.game_dir, &inst.name);
        let Some(mut journal) = load_journal(&instance_dir) else {
            continue;
        };
        if journal.state != JournalState::Applying {
            continue;
        }
        // 备份目录名取自 journal 自身（自包含），不依赖「猜最新目录」：
        // 若用户手动删了备份目录，回滚会如实报错而不是去恢复错误的目录。
        if !backup_root(&instance_dir)
            .join(&journal.backup_stamp)
            .is_dir()
        {
            tracing::error!(
                instance = %inst.name,
                stamp = %journal.backup_stamp,
                "更新日志处于 applying 但备份目录不存在，无法自动回滚（需人工处理）"
            );
            continue;
        }
        tracing::warn!(
            instance = %inst.name,
            "检测到未完成的整合包更新（进程崩溃），正在自动回滚"
        );
        match rollback(&instance_dir, &mut journal) {
            Ok(()) => count += 1,
            Err(e) => tracing::error!(instance = %inst.name, error = %e, "自动回滚失败"),
        }
    }
    count
}

/// 实例下最新的备份目录名（时间戳）。
pub fn latest_backup_stamp(instance_dir: &Path) -> Option<String> {
    let root = backup_root(instance_dir);
    let entries = std::fs::read_dir(&root).ok()?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names.pop()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qomicex-mp-update-{tag}-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn target() -> UpdateTarget {
        UpdateTarget {
            version_id: "999".to_string(),
            game_version: "1.21".to_string(),
            loader: Some("neoforge".to_string()),
            loader_version: Some("21.0".to_string()),
        }
    }

    fn journal_for(dir: &Path, plan: &UpdatePlan) -> UpdateJournal {
        prepare_journal(
            dir,
            serde_json::json!({"name":"Pack"}),
            "Pack",
            &target(),
            plan,
        )
        .unwrap()
    }

    /// 正常的「备份 → 应用 → 完成」：新文件落位、旧文件删除、用户改动被备份。
    #[test]
    fn apply_journal_writes_and_removes_and_backs_up() {
        let dir = temp_dir("apply");
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join("config/user.toml"), b"USER-ORIGINAL").unwrap();
        std::fs::write(dir.join("mods/old.jar"), b"old").unwrap();

        // 暂存新内容
        std::fs::create_dir_all(staging_dir(&dir).join("config")).unwrap();
        std::fs::write(staging_dir(&dir).join("config/user.toml"), b"NEW").unwrap();
        std::fs::create_dir_all(staging_dir(&dir).join("mods")).unwrap();
        std::fs::write(staging_dir(&dir).join("mods/new.jar"), b"new").unwrap();

        let plan = UpdatePlan {
            overwrites: vec!["config/user.toml".to_string()],
            creates: vec!["mods/new.jar".to_string()],
            removes: vec!["mods/old.jar".to_string()],
        };
        let mut journal = journal_for(&dir, &plan);

        // prepare 阶段不得改动实例（仍是用户原值）
        assert_eq!(
            std::fs::read(dir.join("config/user.toml")).unwrap(),
            b"USER-ORIGINAL"
        );

        apply_journal(&dir, &mut journal).unwrap();
        assert_eq!(std::fs::read(dir.join("config/user.toml")).unwrap(), b"NEW");
        assert!(dir.join("mods/new.jar").is_file());
        assert!(!dir.join("mods/old.jar").exists(), "removes 应被删除");
        assert_eq!(journal.state, JournalState::Applying);
        cleanup_staging(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回滚必须把用户改过的原内容恢复回来（这是「绝不损坏实例」的核心保证）。
    #[test]
    fn rollback_restores_original_content() {
        let dir = temp_dir("rollback");
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join("config/user.toml"), b"USER-ORIGINAL").unwrap();
        std::fs::create_dir_all(staging_dir(&dir).join("config")).unwrap();
        std::fs::write(staging_dir(&dir).join("config/user.toml"), b"NEW").unwrap();

        let plan = UpdatePlan {
            overwrites: vec!["config/user.toml".to_string()],
            creates: vec![],
            removes: vec![],
        };
        let mut journal = journal_for(&dir, &plan);

        apply_journal(&dir, &mut journal).unwrap();
        assert_eq!(std::fs::read(dir.join("config/user.toml")).unwrap(), b"NEW");

        rollback(&dir, &mut journal).unwrap();
        assert_eq!(
            std::fs::read(dir.join("config/user.toml")).unwrap(),
            b"USER-ORIGINAL",
            "回滚必须恢复用户原始内容"
        );
        assert_eq!(journal.state, JournalState::RolledBack);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回滚要删掉本次新增的文件（Create 逆操作）。
    #[test]
    fn rollback_deletes_created_files() {
        let dir = temp_dir("rollback-create");
        std::fs::create_dir_all(staging_dir(&dir).join("mods")).unwrap();
        std::fs::write(staging_dir(&dir).join("mods/new.jar"), b"new").unwrap();

        let plan = UpdatePlan {
            overwrites: vec![],
            creates: vec!["mods/new.jar".to_string()],
            removes: vec![],
        };
        let mut journal = journal_for(&dir, &plan);
        apply_journal(&dir, &mut journal).unwrap();
        assert!(dir.join("mods/new.jar").is_file());

        rollback(&dir, &mut journal).unwrap();
        assert!(!dir.join("mods/new.jar").exists(), "新增文件应被回滚删除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回滚要恢复被删除的旧文件。
    #[test]
    fn rollback_restores_removed_files() {
        let dir = temp_dir("rollback-remove");
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods/removed.jar"), b"OLD-CONTENT").unwrap();

        let plan = UpdatePlan {
            overwrites: vec![],
            creates: vec![],
            removes: vec!["mods/removed.jar".to_string()],
        };
        let mut journal = journal_for(&dir, &plan);
        apply_journal(&dir, &mut journal).unwrap();
        assert!(!dir.join("mods/removed.jar").exists());

        rollback(&dir, &mut journal).unwrap();
        assert_eq!(
            std::fs::read(dir.join("mods/removed.jar")).unwrap(),
            b"OLD-CONTENT",
            "被删除的旧文件应被恢复"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **安全底线**：saves/ 与越界路径在应用与删除阶段都必须被拒绝。
    #[test]
    fn apply_and_remove_refuse_saves_and_escapes() {
        let dir = temp_dir("guard");
        std::fs::create_dir_all(dir.join("saves/world")).unwrap();
        std::fs::write(dir.join("saves/world/level.dat"), b"PRECIOUS").unwrap();
        // 即使暂存区里放了存档，也不得写入
        std::fs::create_dir_all(staging_dir(&dir).join("saves/world")).unwrap();
        std::fs::write(
            staging_dir(&dir).join("saves/world/level.dat"),
            b"OVERWRITE-ATTEMPT",
        )
        .unwrap();

        assert!(
            apply_staged_file(&dir, "saves/world/level.dat").is_err(),
            "不得向 saves/ 写文件"
        );
        assert!(
            apply_remove(&dir, "saves/world/level.dat").is_err(),
            "不得删除 saves/ 下的文件"
        );
        assert!(apply_staged_file(&dir, "../escape.jar").is_err());
        assert!(apply_remove(&dir, "../../../etc/passwd").is_err());

        // 存档内容必须原封不动
        assert_eq!(
            std::fs::read(dir.join("saves/world/level.dat")).unwrap(),
            b"PRECIOUS"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 暂存区缺文件时应跳过（下载被跳过），不阻断其它文件。
    #[test]
    fn apply_skips_missing_staged_files() {
        let dir = temp_dir("missing");
        std::fs::create_dir_all(&dir).unwrap();
        let outcome = apply_staged_file(&dir, "mods/never-downloaded.jar").unwrap();
        assert_eq!(outcome, StagedOutcome::MissingInStaging);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// journal 往返 + 崩溃恢复：状态为 applying 的实例应被自动回滚。
    #[test]
    fn journal_roundtrip_and_state_check() {
        let dir = temp_dir("journal");
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods/a.jar"), b"A").unwrap();
        let plan = UpdatePlan {
            overwrites: vec!["mods/a.jar".to_string()],
            creates: vec![],
            removes: vec![],
        };
        let mut journal = journal_for(&dir, &plan);
        // prepare 后状态为 prepared
        assert_eq!(load_journal(&dir).unwrap().state, JournalState::Prepared);

        apply_journal(&dir, &mut journal).unwrap();
        // 应用后（未收尾）状态为 applying → 崩溃恢复会认领
        assert_eq!(load_journal(&dir).unwrap().state, JournalState::Applying);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只保留最近一次备份。
    #[test]
    fn prune_keeps_only_latest_backup() {
        let dir = temp_dir("prune");
        let root = backup_root(&dir);
        for stamp in ["20260101-000000", "20260102-000000", "20260103-000000"] {
            std::fs::create_dir_all(root.join(stamp)).unwrap();
        }
        prune_old_backups(&dir);
        let remaining: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(remaining, vec!["20260103-000000"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 更新成功后清单重建：内容分类正确、存档不入清单。
    #[test]
    fn rebuild_manifest_after_update() {
        let _guard = crate::services::error_report::tests::ENV_LOCK
            .lock()
            .unwrap();
        let home = temp_dir("rebuild-home");
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = "games/mc";
        let name = "Pack";
        let instance_dir = modpack_manifest::instance_version_dir(game_dir, name);
        std::fs::create_dir_all(instance_dir.join("mods")).unwrap();
        std::fs::create_dir_all(instance_dir.join("config")).unwrap();
        std::fs::create_dir_all(instance_dir.join("saves/world")).unwrap();
        std::fs::write(instance_dir.join("mods/a.jar"), b"a").unwrap();
        std::fs::write(instance_dir.join("config/c.toml"), b"c").unwrap();
        std::fs::write(instance_dir.join("saves/world/level.dat"), b"w").unwrap();

        rebuild_manifest(
            game_dir,
            name,
            &instance_dir,
            "1.21",
            Some("neoforge"),
            Some("21.0"),
            modpack_manifest::ManifestOrigin {
                source: Some("curseforge".to_string()),
                project_id: Some("1".to_string()),
                version_id: Some("999".to_string()),
                origin: Some("resource-center".to_string()),
                version_published_at: None,
            },
            &["mods/a.jar".to_string()],
        )
        .unwrap();

        let m = modpack_manifest::load_manifest(game_dir, name).unwrap();
        assert_eq!(m.origin.version_id.as_deref(), Some("999"));
        let paths: Vec<&str> = m.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["config/c.toml", "mods/a.jar"]);
        let a = m.files.iter().find(|f| f.path == "mods/a.jar").unwrap();
        assert_eq!(a.kind, HostedFileKind::Content);
        let c = m.files.iter().find(|f| f.path == "config/c.toml").unwrap();
        assert_eq!(c.kind, HostedFileKind::Override);

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
