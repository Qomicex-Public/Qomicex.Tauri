// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 游戏实例模型与实例服务（对应源 Models/GameInstance.cs + Services/InstanceService.cs）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::services::instance_config;
use crate::settings;

/// 游戏实例（对应 C# GameInstance，全部 camelCase）。
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct GameInstance {
    pub id: String,
    pub name: String,
    pub game_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_path: Option<String>,
    pub max_memory: i32,
    pub game_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jvm_args: Option<String>,
    // 源为 DateTime；此处以 RFC3339 字符串等价表示（chrono 未启用 serde 特性，不动 Cargo.toml）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_played: Option<String>,
    pub play_time: i64,
    pub is_hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_isolation: Option<bool>,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_summary: Option<String>,
    // --- 整合包来源（issue #118 原地更新的判定依据）---
    // 仅「资源中心在线安装」写入；本地导入/拖入/MultiMC 导入不写，故这些实例
    // `modpack_origin` 为 None → 判定为不可更新（符合 issue「不应为手动导入提供」）。
    /// 平台来源："modrinth" / "curseforge"。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_source: Option<String>,
    /// 平台项目 id。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_project_id: Option<String>,
    /// 平台版本 id（更新的身份标识，绝不用版本名比较）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_version_id: Option<String>,
    /// 安装来源标记：仅 "resource-center" 表示可更新。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_origin: Option<String>,
    /// 当前版本发布时间（RFC3339）。用于当前版本已被平台删除时的排序回退。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpack_version_published_at: Option<String>,
    pub skip_integrity_check: bool,
    // 对应 C# [JsonIgnore(WhenWritingNull)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_game_dir: Option<String>,
    /// 所属自定义分组 id 列表（多对多，引用 groups.json）。
    #[serde(default)]
    pub custom_group_ids: Vec<String>,
    /// 用户自定义备注名（ENH-01）；为空时实例列表显示原版本名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    /// 记录创建时间（RFC3339）。仅服务端写入，供 sync_from_disk 的
    /// 「安装中宽限期」判定（整合包管线先建记录后建版本目录）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// 用户显式清空/重置过的设置键（camelCase）。搬迁接管时据此区分
    /// 「用户重置」与「记录里从未有过值」，避免把旧目录的值补回。
    /// 不写入 qomicex.json（不属于实例设置），只随 instances.json 镜像持久化。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cleared_settings: Vec<String>,
}

/// 新实例的默认最大内存（MiB）。
const DEFAULT_MAX_MEMORY: i32 = 4096;

impl Default for GameInstance {
    fn default() -> Self {
        Self {
            id: new_short_id(),
            name: String::new(),
            game_version: String::new(),
            loader: None,
            loader_version: None,
            java_path: None,
            max_memory: DEFAULT_MAX_MEMORY,
            game_dir: ".minecraft".to_string(),
            account_name: None,
            account_uuid: None,
            access_token: None,
            jvm_args: None,
            last_played: None,
            play_time: 0,
            is_hidden: false,
            version_isolation: None,
            is_default: false,
            icon: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
            modpack_source: None,
            modpack_project_id: None,
            modpack_version_id: None,
            modpack_origin: None,
            modpack_version_published_at: None,
            skip_integrity_check: false,
            resolved_game_dir: None,
            custom_group_ids: Vec::new(),
            remark: None,
            // 记录创建时间（RFC3339）；sync_from_disk 的安装中宽限期判定用。
            created_at: None,
            cleared_settings: Vec::new(),
        }
    }
}

/// 生成 12 位十六进制短 id（对应 C# `Guid.NewGuid().ToString("N")[..12]`）。
fn new_short_id() -> String {
    let full = format!("{:x}", uuid::Uuid::new_v4());
    full[..12].to_string()
}

/// 归一化游戏根目录，用于身份键比较：相对路径先按启动器基座解析，
/// 存在时再 canonicalize，避免 `E:\\.minecraft` / `E:\\foo\\..\\.minecraft`
/// / 尾随分隔符被当成不同目录而留下重复记录。
fn normalized_game_root(game_dir: &str) -> PathBuf {
    let root = instance_config::resolve_game_root(game_dir);
    std::fs::canonicalize(&root).unwrap_or(root)
}

fn same_game_root(a: &str, b: &str) -> bool {
    normalized_game_root(a) == normalized_game_root(b)
}

/// 目录存在性三态：`Unknown` 表示无法可靠判断（如卷暂时不可用、权限不足）。
/// 搬迁接管只接受「确认不存在」，避免把不可访问的旧目录误判为已删除。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathPresence {
    Present,
    Absent,
    Unknown,
}

fn path_presence(path: &Path) -> PathPresence {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => PathPresence::Present,
        Ok(_) => PathPresence::Absent,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 目标不存在时，只有确认某个祖先目录可访问，才能断定它是「被删除」
            // 而不是「所在卷暂时不可用」。例如 `E:\mc` 在 E: 盘离线时也报
            // NotFound，此时不能接管；`C:\mc` 被删但 `C:\` 可访问则已确认。
            for ancestor in path.ancestors().skip(1) {
                match std::fs::metadata(ancestor) {
                    Ok(meta) if meta.is_dir() => return PathPresence::Absent,
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return PathPresence::Unknown,
                }
            }
            PathPresence::Unknown
        }
        Err(_) => PathPresence::Unknown,
    }
}

fn non_blank(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.trim().is_empty())
}

/// 选择较晚的 RFC3339 时间戳；无法解析时保留 target 的已有值。
fn later_timestamp(target: &Option<String>, source: &Option<String>) -> Option<String> {
    match (target, source) {
        (Some(a), Some(b)) => {
            match (
                chrono::DateTime::parse_from_rfc3339(a),
                chrono::DateTime::parse_from_rfc3339(b),
            ) {
                (Ok(ta), Ok(tb)) if tb > ta => Some(b.clone()),
                _ => Some(a.clone()),
            }
        }
        (Some(a), None) => Some(a.clone()),
        (None, Some(b)) => Some(b.clone()),
        (None, None) => None,
    }
}

/// 磁盘扫描结果条目（用于 sync_from_disk）。
#[derive(Debug, Clone)]
pub struct ScannedVersionInfo {
    pub name: String,
    /// 版本**目录名**（= `VersionDirName`）——实例记录的身份键。
    ///
    /// `name` 取自版本 JSON 的 `id`（扫描用它对前端显示），与目录名可以不同
    /// （issue #244 的 GTNH：目录名 `GTNH 2.8.4`，JSON id `GT New Horizons`）。
    /// 而实例记录的 `name` 恒为目录名（见 `rename_version_dir`），故匹配必须用
    /// 目录名，否则键漂移会让记录被判为残留、再用 `Default` 重建，JVM 设置丢失。
    /// 旧前端不传时为 `None`，回退用 `name`（旧行为）。
    pub dir_name: Option<String>,
    pub game_version: String,
    pub game_dir: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    pub icon_data: Option<String>,
    pub modpack_name: Option<String>,
    pub modpack_version: Option<String>,
    pub modpack_author: Option<String>,
    pub modpack_summary: Option<String>,
}

/// 改名失败原因：目标目录已存在（用户可修复，前端应提示）vs IO 错误。
#[derive(Debug)]
pub enum RenameFailure {
    TargetExists(String),
    InvalidName(String),
    Io(String),
}

/// 安装中宽限期：sync_from_disk 对「已创建、版本目录未落」的隔离记录的保留窗口。
/// 整合包管线先 create 记录、后台任务才建版本目录；常量模块级共享（第 1 步
/// retain、第 5 步 scanned_dirs 兜底、测试三处同源，防漂移）。
const MODULE_INSTALLING_GRACE: chrono::Duration = chrono::Duration::minutes(10);

/// 实例服务（对应 C# InstanceService）。
pub struct InstanceService {
    file_path: PathBuf,
    instances: Mutex<Vec<GameInstance>>,
    default_id: Mutex<Option<String>>,
    scan_cache: Mutex<HashMap<String, Vec<ScannedVersionInfo>>>,
}

impl InstanceService {
    pub fn new() -> Self {
        let data_dir = settings::resolve_base_dir().join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("instances.json");
        let instances = load_from_file(&file_path);
        Self {
            file_path,
            instances: Mutex::new(instances),
            default_id: Mutex::new(None),
            scan_cache: Mutex::new(HashMap::new()),
        }
    }

    /// 测试专用：实例文件落在指定目录，避免读写用户真实数据。
    #[doc(hidden)]
    pub fn new_for_test(base_dir: &std::path::Path) -> Self {
        let data_dir = base_dir.join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("instances.json");
        Self {
            instances: Mutex::new(load_from_file(&file_path)),
            default_id: Mutex::new(None),
            scan_cache: Mutex::new(HashMap::new()),
            file_path,
        }
    }

    /// 把给定实例列表写成 `instances.json`。持锁调用方传 `&guard`，
    /// 避免为了镜像写入再抢一次同一把锁。
    fn save_instances_json(instances: &[GameInstance], file_path: &Path) -> Result<(), String> {
        // 紧凑序列化（非 pretty）：`icon_data` 是 base64 data URI，73 个集成包图标
        // 就能把 instances.json 撑到 10MB+，pretty 的缩进/换行在这个体量下会让每次
        // 同步的写盘时间和文件体积都翻倍（实测慢 2-3 倍、大 30%+）。
        let json =
            serde_json::to_string(instances).map_err(|e| format!("序列化实例列表失败: {e}"))?;
        // 原子替换：直接 write 会在进程被杀时截断文件，而 load_from_file 解析
        // 失败一律返回空表 —— 那意味着全部实例记录丢失。先写同目录 tmp 再 rename。
        let tmp = file_path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, &json).is_ok() && std::fs::rename(&tmp, file_path).is_ok() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
        // tmp 写/换失败（权限、磁盘满、跨设备）：退回直写，至少别丢数据。
        std::fs::write(file_path, &json)
            .map_err(|e| format!("写入实例镜像失败 {}: {e}", file_path.display()))
    }

    fn save_to_file(&self) -> Result<(), String> {
        let guard = match self.instances.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        Self::save_instances_json(&guard, &self.file_path)
    }

    pub fn get_all(&self) -> Vec<GameInstance> {
        let (snapshot, changed) = {
            let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
            // 独立配置优先：每次读取都按键合并并回写（只有缺失/空值项才会补）。
            // 写回内存后，sync 的并发合并基准与读到的值一致，不会把刚读到的
            // 独立配置当成「并发修改」再拿旧内存值覆盖回去。
            let mut changed = false;
            for inst in guard.iter_mut() {
                let merged = instance_config::load(inst);
                if merged != *inst {
                    *inst = merged;
                    changed = true;
                }
            }
            (guard.clone(), changed)
        };
        // 独立文件可能比镜像新（上次镜像写失败/手动替换）。采纳后同步镜像，
        // 否则重启会回退到旧值。
        if changed {
            if let Err(e) = self.save_to_file() {
                tracing::warn!(error = %e, "同步独立配置到 instances.json 失败");
            }
        }
        snapshot
    }

    /// 更新指定 game_dir 的扫描结果缓存。
    pub fn update_scan_cache(&self, game_dir: &str, scanned: Vec<ScannedVersionInfo>) {
        let mut cache = match self.scan_cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        cache.insert(game_dir.to_string(), scanned);
    }

    /// 使指定 game_dir 的扫描缓存失效。
    pub fn invalidate_scan_cache(&self, game_dir: &str) {
        let mut cache = match self.scan_cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        cache.remove(game_dir);
    }

    /// 以磁盘实际目录为主过滤实例列表：version_isolation 开启（含全局默认）的实例，
    /// 其 `{game_dir}/versions/{name}` 目录不存在时视为残留（安装下载失败、已手动
    /// 删除文件或删除流程未落盘），从返回列表中剔除。隔离关闭（共享 game_dir）的
    /// 实例无法用独立目录判断，一律保留。仅过滤显示、不改写磁盘 JSON，避免误删
    /// 刚创建、版本目录尚未建立的实例。
    ///
    /// 如果有扫描缓存，会先同步磁盘数据再返回。
    pub fn list_existing(&self) -> Vec<GameInstance> {
        // 如果有扫描缓存，先同步
        let cache = match self.scan_cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };

        if !cache.is_empty() {
            // 收集所有扫描结果
            let all_scanned: Vec<ScannedVersionInfo> =
                cache.values().flat_map(|v| v.iter().cloned()).collect();
            drop(cache);

            // 同步并返回
            return self.sync_from_disk(&all_scanned);
        }

        drop(cache);

        // 无扫描缓存，使用原有的过滤逻辑
        let global_isolation = crate::settings::get_global_version_isolation();
        self.get_all()
            .into_iter()
            .filter(|inst| {
                let isolation = inst.version_isolation.unwrap_or(global_isolation);
                if !isolation {
                    return true;
                }
                path_presence(
                    &std::path::Path::new(&inst.game_dir)
                        .join("versions")
                        .join(&inst.name),
                ) != PathPresence::Absent
            })
            .collect()
    }

    pub fn get_by_id(&self, id: &str) -> Option<GameInstance> {
        let (found, changed) = {
            let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
            let slot = guard.iter_mut().find(|i| i.id == id)?;
            let merged = instance_config::load(slot);
            let changed = merged != *slot;
            if changed {
                *slot = merged;
            }
            (slot.clone(), changed)
        };
        // 独立配置与统一文件不一致时把结果镜像回 instances.json，避免重启后
        // 又读回旧值（例如刚导入的整合包配置被采纳）。
        if changed {
            if let Err(e) = self.save_to_file() {
                tracing::warn!(error = %e, "同步独立配置到 instances.json 失败");
            }
        }
        Some(found)
    }

    pub fn create(&self, mut instance: GameInstance) -> Result<GameInstance, String> {
        if !instance_config::is_safe_instance_name(&instance.name) {
            return Err(format!("非法实例名: {}", instance.name));
        }
        let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
        // 一个版本目录只允许一条记录：否则两条记录会共用同一份 qomicex.json，
        // 互相把身份/设置修复成自己的值。
        if guard
            .iter()
            .any(|i| i.name == instance.name && same_game_root(&i.game_dir, &instance.game_dir))
        {
            return Err(format!("实例目录已被占用: {}", instance.name));
        }
        if instance.id.is_empty() {
            instance.id = new_short_id();
        }
        // 创建时间戳：sync_from_disk 据此给「记录已建、版本目录未落」的整合包
        // 安装留宽限期（宽限期内的隔离记录不当残留清除）。
        if instance.created_at.is_none() {
            instance.created_at =
                Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
        // 目录里已有独立配置（重建实例/指向已有版本目录）：按项采纳，但身份
        // 仍用本次创建的记录，避免复用旧 id 造成重复。
        if let Some(adopted) = instance_config::adopt(&instance) {
            instance = adopted;
        }
        // 先确认镜像和独立配置都写成功，再改内存；失败时不留下半条记录。
        let mut candidate = guard.clone();
        candidate.push(instance.clone());
        Self::save_instances_json(&candidate, &self.file_path)?;
        if let Err(e) = instance_config::write_full(&instance) {
            if let Err(rollback) = Self::save_instances_json(&guard, &self.file_path) {
                tracing::error!(error = %rollback, "回滚 instances.json 失败");
            }
            return Err(e);
        }
        guard.push(instance.clone());
        drop(guard);
        // 使该 game_dir 的扫描缓存失效
        self.invalidate_scan_cache(&instance.game_dir);
        Ok(instance)
    }

    /// 在实例锁内把补丁应用到**最新**记录，避免两个并发 PUT 各自持有旧快照导致
    /// 后到的请求把前一个请求改的其它字段回退。
    pub fn update_with<F>(&self, id: &str, apply: F) -> Result<Option<GameInstance>, String>
    where
        F: FnOnce(&mut GameInstance),
    {
        let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
        let index = guard.iter().position(|i| i.id == id);
        let Some(index) = index else {
            return Ok(None);
        };
        let old = guard[index].clone();
        let mut next = old.clone();
        next.id = id.to_string();
        apply(&mut next);
        Self::track_cleared_settings(&old, &mut next);
        if next.name != old.name && !instance_config::is_safe_instance_name(&next.name) {
            return Err(format!("非法实例名: {}", next.name));
        }
        // 改名/改目录后不得与已有记录共用版本目录（会共用同一份 qomicex.json）。
        if (next.name != old.name || !same_game_root(&next.game_dir, &old.game_dir))
            && guard.iter().enumerate().any(|(i, inst)| {
                i != index
                    && inst.name == next.name
                    && same_game_root(&inst.game_dir, &next.game_dir)
            })
        {
            return Err(format!("实例目录已被占用: {}", next.name));
        }
        // 镜像先写：清空可空字段时，独立文件删键后仍能回退到刚写的 null/空值。
        // 全程持有实例锁，读路径不会在两次写之间看到半新半旧的状态。
        let mut mirror = guard.clone();
        mirror[index] = next.clone();
        Self::save_instances_json(&mirror, &self.file_path)?;
        if let Err(e) = instance_config::update_delta(&old, &next) {
            // 独立配置写失败 → 回滚镜像，保持失败前的可见状态一致。
            if let Err(rollback) = Self::save_instances_json(&guard, &self.file_path) {
                tracing::error!(error = %rollback, "回滚 instances.json 失败");
            }
            return Err(e);
        }
        guard[index] = next.clone();
        drop(guard);
        // 使该 game_dir 的扫描缓存失效
        self.invalidate_scan_cache(&next.game_dir);
        Ok(Some(next))
    }

    pub fn update(&self, id: &str, instance: GameInstance) -> Result<Option<GameInstance>, String> {
        self.update_with(id, |current| *current = instance.clone())
    }

    /// 记录用户显式清空/重置的设置键。只比较用户可编辑字段：
    /// 字段从「有值」变成空/默认值 → 标记为已清空；重新设置有值 → 取消标记。
    /// 搬迁接管用这个集合区分「用户重置」与「记录里从未有过值」。
    ///
    /// 账号相关字段也记录标记，但搬迁接管不搬运凭据；标记用于避免以后把旧账号
    /// 从更老的记录补回来。
    fn track_cleared_settings(old: &GameInstance, next: &mut GameInstance) {
        use std::collections::BTreeSet;

        let mut cleared: BTreeSet<String> = next.cleared_settings.iter().cloned().collect();
        fn track(cleared: &mut BTreeSet<String>, key: &str, was_set: bool, now_set: bool) {
            if now_set {
                cleared.remove(key);
            } else if was_set {
                cleared.insert(key.to_string());
            }
        }

        track(
            &mut cleared,
            "jvmArgs",
            non_blank(&old.jvm_args),
            non_blank(&next.jvm_args),
        );
        track(
            &mut cleared,
            "javaPath",
            non_blank(&old.java_path),
            non_blank(&next.java_path),
        );
        track(
            &mut cleared,
            "remark",
            non_blank(&old.remark),
            non_blank(&next.remark),
        );
        track(
            &mut cleared,
            "accountName",
            non_blank(&old.account_name),
            non_blank(&next.account_name),
        );
        track(
            &mut cleared,
            "accountUuid",
            non_blank(&old.account_uuid),
            non_blank(&next.account_uuid),
        );
        track(
            &mut cleared,
            "accessToken",
            non_blank(&old.access_token),
            non_blank(&next.access_token),
        );
        track(
            &mut cleared,
            "icon",
            non_blank(&old.icon),
            non_blank(&next.icon),
        );

        track(
            &mut cleared,
            "maxMemory",
            old.max_memory != DEFAULT_MAX_MEMORY,
            next.max_memory != DEFAULT_MAX_MEMORY,
        );
        track(
            &mut cleared,
            "versionIsolation",
            old.version_isolation.is_some(),
            next.version_isolation.is_some(),
        );
        track(&mut cleared, "isHidden", old.is_hidden, next.is_hidden);
        track(
            &mut cleared,
            "skipIntegrityCheck",
            old.skip_integrity_check,
            next.skip_integrity_check,
        );
        track(
            &mut cleared,
            "customGroupIds",
            !old.custom_group_ids.is_empty(),
            !next.custom_group_ids.is_empty(),
        );

        next.cleared_settings = cleared.into_iter().collect();
    }

    /// 改名时同步重命名版本目录 + 目录内 {name}.json/.jar + 修补版本 JSON 内的 id。
    /// name 同时是版本隔离目录名（VersionDirName），只改记录会被 sync_from_disk
    /// 按磁盘目录名打回。目录不存在（未安装/共享残留）→ 直接 Ok；
    /// 重命名失败（游戏运行中目录被占用/目标已存在）→ Err，调用方不得改记录。
    pub fn rename_version_dir(
        &self,
        inst: &GameInstance,
        new_name: &str,
    ) -> Result<(), RenameFailure> {
        let old_name = inst.name.as_str();
        if old_name.is_empty() || old_name == new_name {
            return Ok(());
        }
        if !instance_config::is_safe_instance_name(new_name) {
            return Err(RenameFailure::InvalidName(new_name.to_string()));
        }
        let game_root = if std::path::Path::new(&inst.game_dir).is_absolute() {
            PathBuf::from(&inst.game_dir)
        } else {
            settings::resolve_base_dir().join(&inst.game_dir)
        };
        let old_dir = game_root.join("versions").join(old_name);
        let new_dir = game_root.join("versions").join(new_name);
        if !old_dir.is_dir() {
            return Ok(());
        }
        if new_dir.exists() {
            return Err(RenameFailure::TargetExists(new_dir.display().to_string()));
        }
        std::fs::rename(&old_dir, &new_dir).map_err(|e| {
            RenameFailure::Io(format!(
                "版本目录重命名失败（可能游戏正在运行或目录被占用）: {e}"
            ))
        })?;
        for ext in ["json", "jar"] {
            let old_file = new_dir.join(format!("{old_name}.{ext}"));
            let new_file = new_dir.join(format!("{new_name}.{ext}"));
            if old_file.is_file() {
                let _ = std::fs::rename(&old_file, &new_file);
            }
        }
        let json_path = new_dir.join(format!("{new_name}.json"));
        if json_path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&json_path) {
                if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(obj) = val.as_object_mut() {
                        obj.insert(
                            "id".to_string(),
                            serde_json::Value::String(new_name.to_string()),
                        );
                    }
                    if let Ok(out) = serde_json::to_string_pretty(&val) {
                        let _ = std::fs::write(&json_path, out);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Option<GameInstance> {
        // 旧语义保留（调用方只关心记录是否存在）；目录删除失败静默的缺口由
        // try_delete 承接（安装回滚/手动删除端点应改用 try_delete）。
        self.try_delete(id).ok().flatten()
    }

    /// 删除实例记录 + 版本隔离目录（目录删除失败 → Err，记录已回滚保留）。
    ///
    /// 顺序：先删记录（防删除期间被扫描/启动引用），再删目录；目录删除失败时
    /// **恢复记录**并返回 Err——否则残留目录会被 sync_from_disk 反推成幽灵实例
    /// （新 id 复活）。Windows 下目录被占用（游戏进程/杀软扫描）多为瞬态，先短重试。
    pub fn try_delete(&self, id: &str) -> Result<Option<GameInstance>, String> {
        let mut default_guard = self.default_id.lock().unwrap_or_else(|p| p.into_inner());
        if default_guard.as_deref() == Some(id) {
            *default_guard = None;
        }
        drop(default_guard);

        let instance = {
            let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
            let instance = guard.iter().find(|i| i.id == id).cloned();
            let instance = match instance {
                Some(i) => i,
                None => return Ok(None),
            };
            guard.retain(|i| i.id != id);
            drop(guard);
            if let Err(e) = self.save_to_file() {
                tracing::warn!(error = %e, "删除实例后写 instances.json 失败");
            }
            instance
        };

        // 删除版本隔离目录 {gameDir}/versions/{name}（重试 3 次，间隔 200ms）
        let version_dir = std::path::Path::new(&instance.game_dir)
            .join("versions")
            .join(&instance.name);
        let mut removed = !version_dir.is_dir();
        // Windows 上刚取消/刚下载完的目录常被下载线程、杀软或索引服务短暂占用；
        // 600ms 的重试窗口不够（issue #224 的「取消后残留 jar 实例」），放宽到约 3s。
        for _ in 0..10 {
            if std::fs::remove_dir_all(&version_dir).is_ok() {
                removed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        if !removed {
            // 目录删不掉 → 恢复记录，避免残留目录被扫描反推成幽灵实例
            if let Err(e) = self.create(instance.clone()) {
                tracing::error!(error = %e, "恢复实例记录失败");
            }
            return Err(format!(
                "版本目录删除失败（可能被占用）：{}",
                version_dir.display()
            ));
        }

        // 使该 game_dir 的扫描缓存失效
        self.invalidate_scan_cache(&instance.game_dir);

        Ok(Some(instance))
    }

    pub fn get_default_id(&self) -> Option<String> {
        let mut guard = self.default_id.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_some() {
            return guard.clone();
        }
        let path = self.default_file_path();
        let id = read_default_id(&path);
        *guard = id.clone();
        id
    }

    pub fn set_default_id(&self, id: &str) {
        let mut guard = self.default_id.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(id.to_string());
        drop(guard);
        let path = self.default_file_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, format!("\"{}\"", id));
    }

    pub fn clear_default_id(&self) {
        let mut guard = self.default_id.lock().unwrap_or_else(|p| p.into_inner());
        *guard = None;
        drop(guard);
        let path = self.default_file_path();
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }

    fn default_file_path(&self) -> PathBuf {
        settings::resolve_base_dir()
            .join("data")
            .join("default_instance.json")
    }

    /// 以磁盘扫描结果为主，合并 JSON 元数据，清理残留，去重。
    /// 这是实例列表的核心同步方法，所有需要获取实例列表的地方都应通过此方法。
    pub fn sync_from_disk(&self, scanned: &[ScannedVersionInfo]) -> Vec<GameInstance> {
        let global_isolation = crate::settings::get_global_version_isolation();
        let mut json_instances = self.get_all();
        // 扫描目录名只解析一次：`dir_name` 缺失时要读版本 JSON 反查，不应在
        // 持锁写回阶段重复读盘（CodeRabbit 评审）。
        let scanned_dir_names: Vec<String> = scanned.iter().map(Self::scanned_dir_name).collect();
        // 本次同步开始时的已知 id：用于区分「被判定为残留 / 被并发删除」与「并发新建」。
        let known_ids: std::collections::HashSet<String> =
            json_instances.iter().map(|i| i.id.clone()).collect();
        // 迁移前的名字快照：并发改名的判定基准。
        // ⚠️ 不能用迁移后的 `json_instances` 当基准 —— 身份迁移只改这份本地副本，没改
        // 共享列表，此时「迁移后的新名」与「实际仍是的旧名」必然不等，会把自己的迁移
        // 当成并发改名给撤销掉。
        let names_before_migration: HashMap<String, String> = json_instances
            .iter()
            .map(|i| (i.id.clone(), i.name.clone()))
            .collect();

        // 1a. 身份迁移：存量记录的 `name` 可能是版本 JSON 的 `id`（旧前端按扫描结果补建
        // 记录时写入的就是 `ScannedVersion.name`）。若扫描结果给出了该 id 对应的**版本
        // 目录名**且目录真实存在，先把记录迁移成目录名身份 —— 否则第 1 步会拿 id 去拼
        // `versions/{id}` 判定「目录不存在」，把设置完好的记录当残留删掉（issue #244 评审）。
        // 目标目录不存在时不迁移：宁可按原逻辑走宽限期，也不把记录名改成不存在的目录。
        let alias: HashMap<(String, String), String> = scanned
            .iter()
            .filter_map(|s| {
                s.dir_name
                    .as_ref()
                    .map(|d| ((s.game_dir.clone(), s.name.clone()), d.clone()))
            })
            .collect();
        for inst in json_instances.iter_mut() {
            let Some(dir) = alias.get(&(inst.game_dir.clone(), inst.name.clone())) else {
                continue;
            };
            if dir == &inst.name {
                continue;
            }
            if std::path::Path::new(&inst.game_dir)
                .join("versions")
                .join(dir)
                .is_dir()
            {
                tracing::info!(
                    from = %inst.name,
                    to = %dir,
                    "scan: migrating instance name to version dir name"
                );
                inst.name = dir.clone();
            }
        }
        // 1a.5 旧目录不在本次扫描结果里时，按记录自身 `game_dir` 反查 JSON id
        // 别名：记录名可能是版本 JSON 的 `id`，而实际版本目录用第三个名字。
        // 不先修复的话，第 1 步会因 `versions/{记录名}` 不存在把它当残留删除，
        // 或搬迁接管误以为旧目录已消失（Sourcery 评审）。
        for inst in json_instances.iter_mut() {
            if !instance_config::is_safe_instance_name(&inst.name)
                || inst.game_dir.trim().is_empty()
            {
                continue;
            }
            let versions = normalized_game_root(&inst.game_dir).join("versions");
            if path_presence(&versions) != PathPresence::Present
                || path_presence(&versions.join(&inst.name)) == PathPresence::Present
            {
                continue;
            }
            if let Some(alias) = Self::resolve_dir_name_for_id(&inst.game_dir, &inst.name) {
                if alias != inst.name
                    && path_presence(&versions.join(&alias)) == PathPresence::Present
                {
                    tracing::info!(
                        from = %inst.name,
                        to = %alias,
                        "scan: repairing legacy instance name from version JSON id"
                    );
                    inst.name = alias;
                }
            }
        }
        // 清理/接管前先去重：同一 (归一化 game_dir, name) 只保留字段最完整的一条，
        // 避免接管时在多个重复记录里随便挑一个。
        Self::dedup_instances(&mut json_instances);

        // 1b. 游戏目录搬迁接管：用户把 `.minecraft` 移到别的盘/路径后，记录仍挂在
        // 旧 `game_dir` 下；旧版本目录已被删除时，第 1 步会删除记录，第 4 步再按
        // `(新目录, name)` 建一条默认记录 —— JVM 参数、内存、Java 路径、备注与统计
        // 全部丢失（GTNH 实测：从 C: 搬到 E: 后 JVM 参数归零，游戏无法启动）。
        // 必须在清理残留前把这类孤立记录接管到新目录。
        //
        // 接管会写目标 `qomicex.json`；写失败时必须放弃本次同步并保留旧记录，
        // 否则旧记录被清理而目标配置仍是旧值，下一次读取会把刚恢复的设置再次
        // 覆盖掉（Sourcery 评审）。
        if let Err(e) = Self::adopt_moved_game_dir_instances(
            &mut json_instances,
            scanned,
            &scanned_dir_names,
            global_isolation,
        ) {
            tracing::warn!(error = %e, "搬迁实例设置回写失败，放弃本次扫描写回");
            return self.get_all();
        }
        // 迁移后可能出现同 (game_dir, name) 的重复记录：保留字段更完整的一条。
        Self::dedup_instances(&mut json_instances);

        // 1. 清理残留：版本隔离开启 + 版本目录不存在 → 删除记录
        //
        // （常量提为模块级：第 5 步的兜底与测试共用同一值，防两处漂移。）
        const INSTALLING_GRACE: chrono::Duration = MODULE_INSTALLING_GRACE;
        let now = chrono::Utc::now();
        json_instances.retain(|inst| {
            let isolation = inst.version_isolation.unwrap_or(global_isolation);
            if !isolation {
                return true;
            }
            let version_dir = std::path::Path::new(&inst.game_dir)
                .join("versions")
                .join(&inst.name);
            match path_presence(&version_dir) {
                // 卷不可用/权限不足时无法确认目录已删，保留记录，避免设置被误清。
                PathPresence::Present | PathPresence::Unknown => true,
                PathPresence::Absent => matches!(
                    inst.created_at
                        .as_deref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
                    Some(t) if now.signed_duration_since(t) < INSTALLING_GRACE
                ),
            }
        });

        // 2. 跟踪已扫描的游戏目录（归一化根目录，避免同一目录不同写法被当成两个）
        let scanned_dirs: std::collections::HashSet<String> = scanned
            .iter()
            .map(|s| {
                normalized_game_root(&s.game_dir)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();

        // 3. 按归一化 (game_dir, name) 索引 JSON 实例
        let mut json_index: HashMap<(String, String), usize> = HashMap::new();
        for (idx, inst) in json_instances.iter().enumerate() {
            json_index.insert(
                (
                    normalized_game_root(&inst.game_dir)
                        .to_string_lossy()
                        .into_owned(),
                    inst.name.clone(),
                ),
                idx,
            );
        }

        // 4. 遍历磁盘扫描结果，合并或创建实例
        let mut result: Vec<GameInstance> = Vec::new();
        let mut seen_keys: HashMap<(String, String), usize> = HashMap::new();
        // 独立配置里带 id：instances.json 丢失后据此恢复原实例。已被占用的 id
        // （目录被复制/备份过）必须换新，否则两条记录共享 id，PUT/DELETE 会错位。
        let mut used_ids: std::collections::HashSet<String> =
            json_instances.iter().map(|i| i.id.clone()).collect();

        for (scanned, dir_name) in scanned.iter().zip(&scanned_dir_names) {
            // 身份键用**目录名**：记录的 name 恒为目录名，而 scanned.name 是版本 JSON
            // 的 id，二者漂移时用 name 会导致匹配失败（记录被判残留 → Default 重建 →
            // JVM 设置丢失，issue #244）。
            //
            // `dir_name` 缺失（旧前端）时不能直接回退 `name`：那会在 JSON id 这个键下
            // 新建一条默认记录，同时保留原有的目录名记录，同一版本出现两条（其中一条
            // 设置已被重置）。故先把 `name` 当作 id 反查真实目录名（已在函数入口缓存）。
            let key = (
                normalized_game_root(&scanned.game_dir)
                    .to_string_lossy()
                    .into_owned(),
                dir_name.clone(),
            );

            if let Some(&json_idx) = json_index.get(&key) {
                // JSON 中已有记录，合并（磁盘信息 + JSON 元数据）
                let mut inst = json_instances[json_idx].clone();
                let before_scan = inst.clone();

                // 修复 game_version（以磁盘为准）
                if !scanned.game_version.is_empty() && inst.game_version != scanned.game_version {
                    inst.game_version = scanned.game_version.clone();
                }

                // 修复 loader（以磁盘为准）
                if let Some(ref loader) = scanned.loader {
                    if inst.loader.as_ref() != Some(loader) {
                        inst.loader = Some(loader.clone());
                    }
                }
                if let Some(ref loader_version) = scanned.loader_version {
                    if inst.loader_version.as_ref() != Some(loader_version) {
                        inst.loader_version = Some(loader_version.clone());
                    }
                }

                // 补全 icon_data
                if inst.icon_data.is_none() && scanned.icon_data.is_some() {
                    inst.icon_data = scanned.icon_data.clone();
                }

                // 补全整合包元数据（如果 JSON 中没有但扫描结果有）
                if inst.modpack_name.is_none() && scanned.modpack_name.is_some() {
                    inst.modpack_name = scanned.modpack_name.clone();
                }
                if inst.modpack_version.is_none() && scanned.modpack_version.is_some() {
                    inst.modpack_version = scanned.modpack_version.clone();
                }
                if inst.modpack_author.is_none() && scanned.modpack_author.is_some() {
                    inst.modpack_author = scanned.modpack_author.clone();
                }
                if inst.modpack_summary.is_none() && scanned.modpack_summary.is_some() {
                    inst.modpack_summary = scanned.modpack_summary.clone();
                }

                // 扫描修正的 gameVersion/loader 必须同步落盘：load 优先读独立配置，
                // 否则下一次读取会把这里刚修正的磁盘事实又覆盖回旧值。
                if inst != before_scan {
                    if let Err(e) = instance_config::update_delta(&before_scan, &inst) {
                        tracing::warn!(error = %e, "同步扫描元数据到实例独立配置失败");
                    }
                }

                // 去重：同 key 只保留一个
                if let std::collections::hash_map::Entry::Vacant(e) = seen_keys.entry(key) {
                    e.insert(result.len());
                    result.push(inst);
                }
            } else {
                // JSON 中无记录：版本目录里有独立配置（instances.json 丢失/重建）时
                // 用它恢复 id、JVM、内存等设置，否则才从磁盘信息建默认记录。
                let dir_name_for_row = key.1.clone();
                if let std::collections::hash_map::Entry::Vacant(e) = seen_keys.entry(key) {
                    let inst =
                        match instance_config::load_for_dir(&scanned.game_dir, &dir_name_for_row) {
                            Some(mut cfg) => {
                                // 目录被复制/备份时文件里的 id 会重复；冲突时换新 id，
                                // 否则两条记录共享 id，PUT/DELETE 会错位。
                                if cfg.id.trim().is_empty() || used_ids.contains(&cfg.id) {
                                    cfg.id = new_short_id();
                                }
                                // 身份键以磁盘目录为准（配置里的 name 可能是改名前的旧值）。
                                cfg.name = dir_name_for_row;
                                cfg.game_dir = scanned.game_dir.clone();
                                // 磁盘事实优先，其余设置保留配置文件里的值。
                                if !scanned.game_version.is_empty() {
                                    cfg.game_version = scanned.game_version.clone();
                                }
                                if let Some(loader) = scanned.loader.clone() {
                                    cfg.loader = Some(loader);
                                }
                                if let Some(loader_version) = scanned.loader_version.clone() {
                                    cfg.loader_version = Some(loader_version);
                                }
                                if cfg.icon_data.is_none() && scanned.icon_data.is_some() {
                                    cfg.icon_data = scanned.icon_data.clone();
                                }
                                if cfg.modpack_name.is_none() {
                                    cfg.modpack_name = scanned.modpack_name.clone();
                                }
                                if cfg.modpack_version.is_none() {
                                    cfg.modpack_version = scanned.modpack_version.clone();
                                }
                                if cfg.modpack_author.is_none() {
                                    cfg.modpack_author = scanned.modpack_author.clone();
                                }
                                if cfg.modpack_summary.is_none() {
                                    cfg.modpack_summary = scanned.modpack_summary.clone();
                                }
                                // 把恢复后确定的 id / 磁盘事实写回配置文件，避免
                                // 下一次同步又生成一个不同的随机 id。
                                if let Err(e) = instance_config::write_full(&cfg) {
                                    tracing::warn!(error = %e, "恢复实例独立配置失败");
                                }
                                cfg
                            }
                            None => GameInstance {
                                // name 是版本隔离目录名（路径基座），必须用目录名而非 JSON id；
                                // 用 id 会让记录指向不存在的目录（重装/改名后错位，issue #244）。
                                name: dir_name_for_row,
                                game_version: scanned.game_version.clone(),
                                game_dir: scanned.game_dir.clone(),
                                loader: scanned.loader.clone(),
                                loader_version: scanned.loader_version.clone(),
                                icon_data: scanned.icon_data.clone(),
                                modpack_name: scanned.modpack_name.clone(),
                                modpack_version: scanned.modpack_version.clone(),
                                modpack_author: scanned.modpack_author.clone(),
                                modpack_summary: scanned.modpack_summary.clone(),
                                ..Default::default()
                            },
                        };
                    used_ids.insert(inst.id.clone());
                    e.insert(result.len());
                    result.push(inst);
                }
            }
        }

        // 5. 将未被扫描的游戏目录的 JSON 实例追加到结果中
        //    （只保留未被扫描的目录的实例，已扫描目录中不存在的 JSON 条目视为残留，不保留）
        //
        // ⚠️ 例外一：宽限期内的安装中实例必须在**同目录已有其他版本被扫描**时也保留
        // ——此时第 5 步的 `!scanned_dirs.contains(game_dir)` 会把它排除（目录被
        // 其它实例扫描命中），等于绕过第 1 步的宽限期（GTNH 评审发现）。
        //
        // ⚠️ 例外二（issue #244，防御网）：版本目录**真实存在**的记录绝不在此丢弃。
        // 扫描键来自版本 JSON 的 `id`，与记录名（目录名）可以不同；键漂移时第 4 步
        // 匹配不上，若此处再按「键没命中 = 残留」丢弃，JVM/内存等设置就被扫没了。
        // 判「是不是残留」的可靠依据是目录本身在不在，而不是名字对不对得上。
        const RETAIN_GRACE: chrono::Duration = INSTALLING_GRACE;
        for inst in &json_instances {
            let root_key = normalized_game_root(&inst.game_dir)
                .to_string_lossy()
                .into_owned();
            let key = (root_key.clone(), inst.name.clone());
            // 已在合并段处理过的 key 不再追加（否则宽限期兜底会把同 key 记录
            // 重复写入结果并回存，且每次同步都会累加）。
            if seen_keys.contains_key(&key) {
                continue;
            }
            let version_dir = std::path::Path::new(&inst.game_dir)
                .join("versions")
                .join(&inst.name);
            // Unknown（卷离线/权限不足）按存在处理，宁可保留也不误删。
            let dir_missing = path_presence(&version_dir) == PathPresence::Absent;
            if scanned_dirs.contains(&root_key) && dir_missing {
                // 同目录已被扫描且该记录的版本目录确实不存在：正常实例已在合并段
                // 处理；宽限期记录在此兜底（目录尚未落盘的安装中实例）。
                let in_grace = matches!(
                    inst.created_at
                        .as_deref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
                    Some(t) if now.signed_duration_since(t) < RETAIN_GRACE
                );
                if !in_grace {
                    continue;
                }
            }
            seen_keys.insert(key, result.len());
            result.push(inst.clone());
        }

        // 6. 写回 JSON
        //
        // ⚠️ 不能直接 `*guard = result`：`result` 基于第 0 步的 `get_all()` 快照算出，
        // 扫描期间用户可能正在实例设置里改 JVM/内存（PUT /instance/{id}），整体覆盖会把
        // 这些并发修改回退掉（issue #244 评审）。故写回前做一次合并（见
        // `merge_concurrent_writeback`）。
        {
            let mut guard = match self.instances.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            // 搬迁接管同样要应用到持有锁的最新列表：否则 `result` 里刚补回的
            // JVM/内存相对 `guard` 是「新增差异」，会被并发合并误判成用户改动
            // 而用默认记录覆盖掉。应用到 guard 后，两边一致；同步期间用户真正
            // 改过的字段仍会以 guard 为准被带到 result。
            //
            // 在克隆上执行：写入 `qomicex.json` 失败时直接放弃本次写回，不能
            // 把 guard 改到一半就返回。
            let mut current = guard.clone();
            let remaps = match Self::adopt_moved_game_dir_instances(
                &mut current,
                scanned,
                &scanned_dir_names,
                global_isolation,
            ) {
                Ok(remaps) => remaps,
                Err(e) => {
                    tracing::warn!(error = %e, "搬迁实例设置回写失败，放弃本次扫描写回");
                    drop(guard);
                    return self.get_all();
                }
            };
            Self::merge_concurrent_writeback(
                &json_instances,
                &known_ids,
                &names_before_migration,
                &current,
                &mut result,
            );
            // 合并保留了目标记录的 id、删除了来源记录：默认实例若指向来源，
            // 需要同步改指目标，否则 get_default_id 会返回已删除的 id。
            if let Some(default_id) = self.get_default_id() {
                if let Some((_, new_id)) = remaps.iter().find(|(old, _)| old == &default_id) {
                    self.set_default_id(new_id);
                }
            }
            *guard = result.clone();
            drop(guard);
            if let Err(e) = self.save_to_file() {
                tracing::warn!(error = %e, "扫描回写 instances.json 失败");
            }
        }

        // 6.1 给缺失独立配置的实例补一份完整快照（升级迁移/新建目录）。已存在的
        // 文件不动，避免把整合包导入的设置用内存默认值覆盖掉。
        for inst in &result {
            instance_config::ensure_full(inst);
        }

        result
    }

    /// 反查「版本 JSON id → 版本目录名」。
    ///
    /// 仅用于 `dir_name` 缺失的旧客户端兼容：旧前端按扫描结果补建记录时把
    /// `ScannedVersion.name`（= JSON id）写进了记录的 `name`，无法据此拼目录路径。
    /// 做法是列出 `{gameDir}/versions/` 下的目录，读出各自 `{dir}/{dir}.json` 的 `id`，
    /// 找到 `id == 传入 id` 的那个目录名。查不到返回 `None`，调用方回退原行为。
    ///
    /// 只在 `dir_name` 缺失时调用（旧客户端），常规路径不付这个代价。
    fn resolve_dir_name_for_id(game_dir: &str, id: &str) -> Option<String> {
        let versions_dir = std::path::Path::new(game_dir).join("versions");
        // 目录名恰好等于 id 是最常见情形，先直接命中，避免读盘。
        if versions_dir.join(id).is_dir() {
            return Some(id.to_string());
        }
        let entries = std::fs::read_dir(&versions_dir).ok()?;
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().into_owned();
            let json_path = dir.join(format!("{dir_name}.json"));
            let Ok(bytes) = std::fs::read(&json_path) else {
                continue;
            };
            let Ok(root) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                continue;
            };
            if root.get("id").and_then(|v| v.as_str()) == Some(id) {
                return Some(dir_name);
            }
        }
        None
    }

    /// 扫描条目的版本目录名。`dir_name` 缺失时按版本 JSON `id` 反查目录名。
    fn scanned_dir_name(scanned: &ScannedVersionInfo) -> String {
        match scanned.dir_name.clone() {
            Some(dir) => dir,
            None => Self::resolve_dir_name_for_id(&scanned.game_dir, &scanned.name)
                .unwrap_or_else(|| scanned.name.clone()),
        }
    }

    /// 把旧 `game_dir` 下已失效的实例记录接管到新 `game_dir`。
    ///
    /// 触发条件（同时满足，避免把两个并存的游戏目录误合并）：
    /// - 旧记录的版本隔离开启（共享目录无法用版本目录是否存在判断搬迁）；
    /// - 旧根目录**存在且可访问**，但 `versions/{name}` / `versions/{dirName}` /
    ///   JSON id 别名目录都确认不存在；
    /// - 游戏版本/加载器一致（缺失元数据不算匹配）。
    ///
    /// 两种落地方式：
    /// - 新目录还没有记录：直接接管旧记录（保留原 `id` 与全部设置）。
    /// - 新目录已有记录：把旧记录里**用户没有显式清空**的设置补进新记录，
    ///   保留新记录的 `id` 与统计，再删除旧记录。
    ///
    /// 所有 `qomicex.json` 写入都在修改 `instances` 之前完成；写失败返回 `Err`，
    /// 调用方放弃本次扫描写回，绝不出现「旧记录已删、目标配置仍是旧值」。
    fn adopt_moved_game_dir_instances(
        instances: &mut Vec<GameInstance>,
        scanned: &[ScannedVersionInfo],
        scanned_dir_names: &[String],
        global_isolation: bool,
    ) -> Result<Vec<(String, String)>, String> {
        if scanned.is_empty() || instances.is_empty() {
            return Ok(Vec::new());
        }
        let mut claimed_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut remaps = Vec::new();

        for (item, dir_name) in scanned.iter().zip(scanned_dir_names) {
            let Some(source_idx) = Self::find_moved_game_dir_source(
                instances,
                item,
                dir_name,
                global_isolation,
                &claimed_ids,
            ) else {
                continue;
            };
            let old = instances[source_idx].clone();
            let target_idx = instances
                .iter()
                .position(|i| i.name == *dir_name && same_game_root(&i.game_dir, &item.game_dir));

            if let Some(target_idx) = target_idx {
                // 正常情况下 find 已排除同根目录，source_idx != target_idx；
                // 但 canonicalize 在扫描期间失败/路径被并发替换时可能出现相等，
                // 此时来源即目标，直接跳过，避免删除唯一记录后越界。
                if source_idx == target_idx {
                    // 这条记录已经是新根目录下的目标，只是 canonicalize 在两次
                    // 调用间不稳定，导致它同时被当成旧根来源。这里只修正内存路径/
                    // 目录名，让第 5 步按新根保留；设置本身没有变化，不能再用内存
                    // 快照覆盖磁盘上的 qomicex.json，否则会回滚并发写入。
                    tracing::warn!(
                        name = %dir_name,
                        "scan: 来源与目标为同一记录，按目标记录保留"
                    );
                    let mut fixed = instances[source_idx].clone();
                    fixed.game_dir = item.game_dir.clone();
                    // `dir_name` 可能是版本 JSON id 反查的回退值；只要
                    // `versions/{dir_name}` 真实存在就是可用的目录名。
                    let real_dir = path_presence(
                        &normalized_game_root(&item.game_dir)
                            .join("versions")
                            .join(dir_name),
                    ) == PathPresence::Present;
                    if real_dir {
                        fixed.name = dir_name.clone();
                    }
                    claimed_ids.insert(fixed.id.clone());
                    instances[source_idx] = fixed;
                    continue;
                }
                let mut target = instances[target_idx].clone();
                Self::carry_orphan_settings(&mut target, &old);
                // 新目录里可能已有一份 qomicex.json；必须在删除来源/写回镜像前
                // 成功刷新，否则下一次读取会用它把刚补进来的设置覆盖回去。
                match instance_config::write_full(&target) {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(format!(
                            "目标实例目录不存在，无法写入 qomicex.json: {}",
                            target.game_dir
                        ));
                    }
                    Err(e) => return Err(e),
                }
                let new_id = target.id.clone();
                // 先删来源再写目标：remove 会让后续下标整体前移，若来源在目标
                // 之前，写回下标必须同步减一，避免把设置写进相邻实例。
                instances.remove(source_idx);
                let target_idx = if source_idx < target_idx {
                    target_idx - 1
                } else {
                    target_idx
                };
                instances[target_idx] = target;
                if old.id != new_id {
                    remaps.push((old.id.clone(), new_id));
                }
                claimed_ids.insert(old.id.clone());
                tracing::info!(
                    name = %dir_name,
                    from = %old.game_dir,
                    to = %item.game_dir,
                    "scan: merging orphaned instance settings into existing record"
                );
                continue;
            }

            let old_game_dir = old.game_dir.clone();
            let mut adopted = old.clone();
            adopted.game_dir = item.game_dir.clone();
            adopted.name = dir_name.clone();
            // 整目录搬迁时 qomicex.json 也跟着过来：以新目录里的最新配置为准，
            // 同时保留记录里的 id/统计等本地字段。
            adopted = instance_config::load(&adopted);
            match instance_config::write_full(&adopted) {
                Ok(true) => {}
                Ok(false) => {
                    return Err(format!(
                        "目标实例目录不存在，无法写入 qomicex.json: {}",
                        adopted.game_dir
                    ));
                }
                Err(e) => return Err(e),
            }
            claimed_ids.insert(adopted.id.clone());
            instances[source_idx] = adopted;
            tracing::info!(
                name = %dir_name,
                from = %old_game_dir,
                to = %item.game_dir,
                "scan: adopting instance from moved game dir"
            );
        }
        Ok(remaps)
    }

    /// 找一个「旧版本目录已确认不存在」的搬迁来源记录。目录名或版本 JSON id
    /// 任一命中都算同一实例（旧前端曾把 JSON id 当记录名）。
    ///
    /// 只有**唯一**候选才接管：多个已删除目录里有同名同版本记录时，任意选
    /// 「信息最完整」的一条可能把无关安装的账号/令牌/设置带过来。
    fn find_moved_game_dir_source(
        instances: &[GameInstance],
        item: &ScannedVersionInfo,
        dir_name: &str,
        global_isolation: bool,
        claimed_ids: &std::collections::HashSet<String>,
    ) -> Option<usize> {
        if !instance_config::is_safe_instance_name(dir_name) || item.game_dir.trim().is_empty() {
            return None;
        }
        let new_root = normalized_game_root(&item.game_dir);
        let mut candidates = Vec::new();

        for (idx, inst) in instances.iter().enumerate() {
            if claimed_ids.contains(&inst.id)
                || inst.game_dir.trim().is_empty()
                || !instance_config::is_safe_instance_name(&inst.name)
                || !(inst.name == dir_name || inst.name == item.name)
                || !inst.version_isolation.unwrap_or(global_isolation)
                || !Self::same_instance_meta(inst, item)
            {
                continue;
            }
            let old_root = normalized_game_root(&inst.game_dir);
            if old_root == new_root {
                continue;
            }
            // 旧根目录状态未知（卷暂时不可用/权限不足）时无法确认「已搬走」，
            // 宁可本次不接管，等卷恢复后再处理。确认不存在（祖先目录可访问）
            // 或确认存在才继续。
            if path_presence(&old_root) == PathPresence::Unknown {
                continue;
            }
            let old_versions = old_root.join("versions");
            let mut names = vec![inst.name.clone(), dir_name.to_string()];
            // 旧记录名可能是 JSON id，而实际旧目录用第三个名字；把别名也纳入
            // 存在性检查。无法读取 versions 时按「未知」处理，不接管。
            if inst.name != dir_name {
                match Self::resolve_dir_name_for_id(&inst.game_dir, &inst.name) {
                    Some(alias) if alias != inst.name && alias != *dir_name => names.push(alias),
                    None if path_presence(&old_versions) == PathPresence::Present
                        && std::fs::read_dir(&old_versions).is_err() =>
                    {
                        continue;
                    }
                    _ => {}
                }
            }
            let confirmed_absent = names.iter().all(|name| {
                matches!(
                    path_presence(&old_versions.join(name)),
                    PathPresence::Absent
                )
            });
            if confirmed_absent {
                candidates.push(idx);
            }
        }

        match candidates.as_slice() {
            [idx] => Some(*idx),
            [] => None,
            _ => {
                tracing::warn!(
                    name = %dir_name,
                    candidates = candidates.len(),
                    "scan: 多个已删除目录都匹配当前实例，跳过搬迁接管"
                );
                None
            }
        }
    }

    /// 把孤儿记录里新记录缺失的设置补过去。新记录已有的值一律不覆盖；
    /// `cleared_settings` 里记录的用户显式清空项也不补，避免「重置穿越」。
    fn carry_orphan_settings(target: &mut GameInstance, source: &GameInstance) {
        fn fill_text(target: &mut Option<String>, source: &Option<String>, cleared: bool) {
            if cleared {
                return;
            }
            if target.as_deref().is_none_or(|v| v.trim().is_empty()) {
                if let Some(value) = source.as_deref().filter(|v| !v.trim().is_empty()) {
                    *target = Some(value.to_string());
                }
            }
        }

        let cleared: std::collections::HashSet<String> =
            target.cleared_settings.iter().cloned().collect();
        fill_text(
            &mut target.jvm_args,
            &source.jvm_args,
            cleared.contains("jvmArgs"),
        );
        fill_text(
            &mut target.java_path,
            &source.java_path,
            cleared.contains("javaPath"),
        );
        fill_text(
            &mut target.remark,
            &source.remark,
            cleared.contains("remark"),
        );
        if !cleared.contains("maxMemory")
            && target.max_memory == DEFAULT_MAX_MEMORY
            && source.max_memory != DEFAULT_MAX_MEMORY
        {
            target.max_memory = source.max_memory;
        }
        if target.version_isolation.is_none() && !cleared.contains("versionIsolation") {
            target.version_isolation = source.version_isolation;
        }
        if !target.skip_integrity_check
            && source.skip_integrity_check
            && !cleared.contains("skipIntegrityCheck")
        {
            target.skip_integrity_check = true;
        }
        if target.custom_group_ids.is_empty() && !cleared.contains("customGroupIds") {
            target.custom_group_ids = source.custom_group_ids.clone();
        }
        if !target.is_hidden && source.is_hidden && !cleared.contains("isHidden") {
            target.is_hidden = true;
        }
        if target.loader_version.is_none() {
            target.loader_version = source.loader_version.clone();
        }

        for (target_field, source_field, key) in [
            (
                &mut target.modpack_name,
                &source.modpack_name,
                "modpackName",
            ),
            (
                &mut target.modpack_version,
                &source.modpack_version,
                "modpackVersion",
            ),
            (
                &mut target.modpack_author,
                &source.modpack_author,
                "modpackAuthor",
            ),
            (
                &mut target.modpack_summary,
                &source.modpack_summary,
                "modpackSummary",
            ),
            (
                &mut target.modpack_source,
                &source.modpack_source,
                "modpackSource",
            ),
            (
                &mut target.modpack_project_id,
                &source.modpack_project_id,
                "modpackProjectId",
            ),
            (
                &mut target.modpack_version_id,
                &source.modpack_version_id,
                "modpackVersionId",
            ),
            (
                &mut target.modpack_origin,
                &source.modpack_origin,
                "modpackOrigin",
            ),
            (
                &mut target.modpack_version_published_at,
                &source.modpack_version_published_at,
                "modpackVersionPublishedAt",
            ),
            // 账号/令牌不跨记录搬运：搬迁接管是启发式匹配，唯一来源也仍可能
            // 选错；凭据泄漏的代价高于少恢复一次登录态。目标没有账号时会走
            // 全局账号选择。
            (&mut target.icon_data, &source.icon_data, "iconData"),
            (&mut target.icon, &source.icon, "icon"),
        ] {
            if !cleared.contains(key) && target_field.is_none() {
                *target_field = source_field.clone();
            }
        }

        target.last_played = later_timestamp(&target.last_played, &source.last_played);
        if target.created_at.is_none() {
            target.created_at = source.created_at.clone();
        }
        target.play_time = target.play_time.max(source.play_time);
        target.is_default |= source.is_default;

        // 旧记录显式清空过的键也一并继承：以后再搬迁时不要从更老的记录复活。
        let mut merged_cleared: std::collections::BTreeSet<String> = cleared.into_iter().collect();
        merged_cleared.extend(source.cleared_settings.iter().cloned());
        target.cleared_settings = merged_cleared.into_iter().collect();
    }

    fn canonical_loader(loader: &str) -> String {
        match loader.trim().to_ascii_lowercase().as_str() {
            "forge" | "net.minecraftforge" => "forge".to_string(),
            "neoforge" | "net.neoforged" => "neoforge".to_string(),
            other => other.to_string(),
        }
    }

    /// 搬迁接管只在游戏版本/加载器**可确认一致**时进行，避免把同名但无关的
    /// 实例设置带到新目录（例如用户删掉旧 1.20.1 实例后又装了同名 1.7.10 实例）。
    /// 缺失版本或 loader 元数据时无法确认兼容性，宁可保留旧记录也不接管。
    fn same_instance_meta(inst: &GameInstance, scanned: &ScannedVersionInfo) -> bool {
        if inst.game_version.trim().is_empty()
            || scanned.game_version.trim().is_empty()
            || inst.game_version.trim() != scanned.game_version.trim()
        {
            return false;
        }
        match (inst.loader.as_deref(), scanned.loader.as_deref()) {
            (Some(a), Some(b)) => Self::canonical_loader(a) == Self::canonical_loader(b),
            (None, None) => true,
            _ => false,
        }
    }

    /// 写回前的并发合并：把同步期间发生的用户改动、并发改名与并发新建搬到 `result` 上，
    /// 并剔除同步期间被并发删除的记录。
    ///
    /// `result` 由第 0 步的 `snapshot` 算出；`current` 是加锁后的实际列表。两者差异
    /// 即同步期间的并发写入：
    /// - `current` 有而 `snapshot` 无，且不在 `known_ids`（本次同步开始前已知的 id）
    ///   → 并发新建，保留（不因整表替换而丢；被判残留清掉的 id 在 `known_ids` 内，不会救回）。
    /// - `known_ids` 里有、`current` 里没有 → 同步期间被并发删除，从 `result` 剔除；
    ///   否则 `*guard = result` 会把已删记录写回（隔离关闭时第 1 步不会清理它，实例永久复活）。
    /// - 两边都有但**用户可编辑字段**或**名字**不同 → 把当前值搬到 `result` 对应记录。
    ///
    /// `names_before_migration` 是第 1a 步身份迁移**之前**的 id→name 快照，作为并发改名的
    /// 判定基准：迁移只改本地副本，用迁移后的值当基准会把自己的迁移误判为并发改名而撤销。
    fn merge_concurrent_writeback(
        snapshot: &[GameInstance],
        known_ids: &std::collections::HashSet<String>,
        names_before_migration: &HashMap<String, String>,
        current: &[GameInstance],
        result: &mut Vec<GameInstance>,
    ) {
        let current_ids: std::collections::HashSet<&str> =
            current.iter().map(|c| c.id.as_str()).collect();
        // 并发删除：本次同步开始前存在、现在已不在 → 不得写回。
        result.retain(|r| !known_ids.contains(&r.id) || current_ids.contains(r.id.as_str()));

        let snapshot_by_id: HashMap<String, &GameInstance> =
            snapshot.iter().map(|i| (i.id.clone(), i)).collect();
        let mut concurrent_new: Vec<GameInstance> = Vec::new();
        for cur in current {
            match snapshot_by_id.get(&cur.id) {
                None => {
                    if !known_ids.contains(&cur.id) && !result.iter().any(|r| r.id == cur.id) {
                        concurrent_new.push(cur.clone());
                    }
                }
                Some(orig) => {
                    // 并发改名基准用「迁移前」的名字，避免误判：用户改名后 cur 是新名、
                    // 迁移前快照仍是旧名 → 判定为并发改名；反之若只是第 1a 步迁移，
                    // 迁移前快照与 cur 相同 → 不判定，迁移得以保留。
                    let base_name = names_before_migration.get(&cur.id);
                    if let Some(slot) = result.iter_mut().find(|r| r.id == cur.id) {
                        if base_name.map(|b| b != &cur.name).unwrap_or(false) {
                            slot.name = cur.name.clone();
                        }
                        Self::carry_user_edits(orig, cur, slot);
                    }
                }
            }
        }
        result.extend(concurrent_new);
    }

    /// 把并发写入的用户可编辑字段从 `cur`（当前实际值）搬到 `slot`（本次同步算出的值）。
    /// 只处理用户能改的字段；`name`/`game_version`/`loader`/整合包元数据由同步与业务
    /// 路径管理，不在此覆盖（否则会撤销身份迁移或磁盘校正）。
    fn carry_user_edits(orig: &GameInstance, cur: &GameInstance, slot: &mut GameInstance) {
        // 用户显式清空/重置的键以 `cur` 为准，即使 `orig` 本来就是空值。
        // 否则会出现：guard 接管先把旧 JVM 补进来（orig 为空），随后用户清空
        // （cur 仍为空，仅多出 cleared 标记），逐字段 diff 看不到变化，slot 里
        // 被补进来的旧值反而留了下来。
        let cleared = |key: &str| cur.cleared_settings.iter().any(|k| k == key);
        if cleared("jvmArgs") {
            slot.jvm_args = cur.jvm_args.clone();
        }
        if cleared("javaPath") {
            slot.java_path = cur.java_path.clone();
        }
        if cleared("remark") {
            slot.remark = cur.remark.clone();
        }
        if cleared("maxMemory") {
            slot.max_memory = cur.max_memory;
        }
        if cleared("versionIsolation") {
            slot.version_isolation = cur.version_isolation;
        }
        if cleared("isHidden") {
            slot.is_hidden = cur.is_hidden;
        }
        if cleared("skipIntegrityCheck") {
            slot.skip_integrity_check = cur.skip_integrity_check;
        }
        if cleared("customGroupIds") {
            slot.custom_group_ids = cur.custom_group_ids.clone();
        }
        if cleared("accountName") {
            slot.account_name = cur.account_name.clone();
        }
        if cleared("accountUuid") {
            slot.account_uuid = cur.account_uuid.clone();
        }
        if cleared("accessToken") {
            slot.access_token = cur.access_token.clone();
        }
        if cleared("icon") {
            slot.icon = cur.icon.clone();
        }

        // 仅当相对快照有变化时才搬，避免无谓的字段重写。
        if cur.jvm_args != orig.jvm_args {
            slot.jvm_args = cur.jvm_args.clone();
        }
        if cur.max_memory != orig.max_memory {
            slot.max_memory = cur.max_memory;
        }
        if cur.java_path != orig.java_path {
            slot.java_path = cur.java_path.clone();
        }
        if cur.remark != orig.remark {
            slot.remark = cur.remark.clone();
        }
        if cur.custom_group_ids != orig.custom_group_ids {
            slot.custom_group_ids = cur.custom_group_ids.clone();
        }
        if cur.is_hidden != orig.is_hidden {
            slot.is_hidden = cur.is_hidden;
        }
        if cur.version_isolation != orig.version_isolation {
            slot.version_isolation = cur.version_isolation;
        }
        if cur.skip_integrity_check != orig.skip_integrity_check {
            slot.skip_integrity_check = cur.skip_integrity_check;
        }
        if cur.account_name != orig.account_name {
            slot.account_name = cur.account_name.clone();
        }
        if cur.account_uuid != orig.account_uuid {
            slot.account_uuid = cur.account_uuid.clone();
        }
        if cur.access_token != orig.access_token {
            slot.access_token = cur.access_token.clone();
        }
        if cur.icon != orig.icon {
            slot.icon = cur.icon.clone();
        }
        if cur.icon_data != orig.icon_data {
            slot.icon_data = cur.icon_data.clone();
        }
        if cur.last_played != orig.last_played {
            slot.last_played = cur.last_played.clone();
        }
        if cur.play_time != orig.play_time {
            slot.play_time = cur.play_time;
        }
        if cur.cleared_settings != orig.cleared_settings {
            slot.cleared_settings = cur.cleared_settings.clone();
        }
    }

    /// 去重：按归一化 (game_dir, name) 去重，保留字段更完整的记录。
    pub fn dedup_instances(instances: &mut Vec<GameInstance>) {
        let mut seen: HashMap<(String, String), usize> = HashMap::new();
        let mut to_remove = Vec::new();

        for (idx, inst) in instances.iter().enumerate() {
            let key = (
                normalized_game_root(&inst.game_dir)
                    .to_string_lossy()
                    .into_owned(),
                inst.name.clone(),
            );
            if let Some(&existing_idx) = seen.get(&key) {
                // 比较哪个记录更完整
                let existing = &instances[existing_idx];
                let current_score = Self::instance_completeness_score(inst);
                let existing_score = Self::instance_completeness_score(existing);

                if current_score > existing_score {
                    // 当前记录更完整，移除旧记录
                    to_remove.push(existing_idx);
                    seen.insert(key, idx);
                } else {
                    // 保留旧记录，标记当前记录待移除
                    to_remove.push(idx);
                }
            } else {
                seen.insert(key, idx);
            }
        }

        // 从后往前移除，避免索引失效
        to_remove.sort_unstable_by(|a, b| b.cmp(a));
        for idx in to_remove {
            instances.remove(idx);
        }
    }

    /// 计算实例信息完整度分数（用于去重时选择保留哪个记录）。
    fn instance_completeness_score(inst: &GameInstance) -> i32 {
        let mut score = 0;
        if inst.icon_data.is_some() {
            score += 10;
        }
        if inst.modpack_name.is_some() {
            score += 8;
        }
        if non_blank(&inst.jvm_args) {
            score += 7;
        }
        if non_blank(&inst.java_path) {
            score += 5;
        }
        if inst.max_memory != DEFAULT_MAX_MEMORY {
            score += 3;
        }
        if non_blank(&inst.remark) {
            score += 2;
        }
        if inst.last_played.is_some() {
            score += 5;
        }
        if inst.account_uuid.is_some() {
            score += 3;
        }
        if !inst.custom_group_ids.is_empty() {
            score += 2;
        }
        if inst.play_time > 0 {
            score += 1;
        }
        score
    }
}

/// 加载 instances 列表（文件不存在/解析失败 → 空列表，对应 C# LoadFromFile）。
fn load_from_file(file_path: &PathBuf) -> Vec<GameInstance> {
    if file_path.exists() {
        if let Ok(content) = std::fs::read_to_string(file_path) {
            if let Ok(list) = serde_json::from_str::<Vec<GameInstance>>(&content) {
                return list;
            }
        }
    }
    Vec::new()
}

/// 读取默认实例 id（对应 C# GetDefaultId：trim 后去引号）。
fn read_default_id(path: &PathBuf) -> Option<String> {
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(path) {
            let trimmed = content.trim().trim_matches('"');
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::error_report::tests::ENV_LOCK;

    fn make_instance(name: &str, game_dir: &str, isolation: Option<bool>) -> GameInstance {
        let mut inst = GameInstance::default();
        inst.name = name.to_string();
        inst.game_dir = game_dir.to_string();
        inst.version_isolation = isolation;
        inst
    }

    #[test]
    fn list_existing_filters_missing_version_dirs() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-instance-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc1");
        // 只有 Existing 有真实版本目录；Missing 是残留（下载失败/已删除）；Shared 隔离关闭
        std::fs::create_dir_all(game_dir.join("versions").join("Existing")).unwrap();

        let service = InstanceService::new();
        service
            .create(make_instance(
                "Existing",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        service
            .create(make_instance(
                "Missing",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        service
            .create(make_instance(
                "Shared",
                game_dir.to_str().unwrap(),
                Some(false),
            ))
            .unwrap();

        let existing = service.list_existing();
        let names: Vec<&str> = existing.iter().map(|i| i.name.as_str()).collect();
        assert!(names.contains(&"Existing"), "有目录的实例应保留: {names:?}");
        assert!(
            !names.contains(&"Missing"),
            "目录不存在的残留实例应被过滤: {names:?}"
        );
        assert!(names.contains(&"Shared"), "隔离关闭的实例应保留: {names:?}");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
    }

    /// 回归：改名必须同步重命名版本目录（name 即 VersionDirName），
    /// 否则 sync_from_disk 会按磁盘旧目录名把记录当残留清掉、旧名复活。
    #[test]
    fn rename_version_dir_renames_dir_and_files() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-rename-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let old_dir = game_dir.join("versions").join("1.20.1-Forge-47.1.0");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(
            old_dir.join("1.20.1-Forge-47.1.0.json"),
            r#"{"id":"1.20.1-Forge-47.1.0","inheritsFrom":"1.20.1"}"#,
        )
        .unwrap();
        std::fs::write(old_dir.join("1.20.1-Forge-47.1.0.jar"), b"jar").unwrap();

        let service = InstanceService::new();
        let inst = service
            .create(make_instance(
                "1.20.1-Forge-47.1.0",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();

        // 模拟 PUT /instance/{id} 改名全流程：重命名目录 → 更新记录
        let mut renamed = service.get_by_id(&inst.id).unwrap();
        service.rename_version_dir(&renamed, "我的服务器").unwrap();
        renamed.name = "我的服务器".to_string();
        service.update(&inst.id, renamed).unwrap();

        // 目录/json/jar 已重命名，JSON 内 id 已修补
        let new_dir = game_dir.join("versions").join("我的服务器");
        assert!(new_dir.is_dir(), "版本目录应已重命名");
        assert!(!old_dir.is_dir(), "旧目录不应残留");
        assert!(
            new_dir.join("我的服务器.json").is_file(),
            "版本 JSON 应已重命名"
        );
        assert!(
            new_dir.join("我的服务器.jar").is_file(),
            "版本 jar 应已重命名"
        );
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(new_dir.join("我的服务器.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(json["id"], "我的服务器", "版本 JSON 内 id 应已修补");

        // sync_from_disk 后新名仍在（修复点：不再被打回）
        let scanned = vec![ScannedVersionInfo {
            name: "我的服务器".to_string(),
            dir_name: Some("我的服务器".to_string()),
            game_version: "1.20.1".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: Some("forge".to_string()),
            loader_version: Some("47.1.0".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);
        let names: Vec<&str> = result.iter().map(|i| i.name.as_str()).collect();
        assert!(
            names.contains(&"我的服务器"),
            "改名后实例不应被磁盘同步打回: {names:?}"
        );

        // 目录被占用（目标已存在）→ TargetExists 且记录不变
        let ghost = game_dir.join("versions").join("Ghost");
        std::fs::create_dir_all(&ghost).unwrap();
        let occupied = service.rename_version_dir(&service.get_by_id(&inst.id).unwrap(), "Ghost");
        assert!(
            matches!(occupied, Err(RenameFailure::TargetExists(_))),
            "目标目录已存在时应报 TargetExists: {occupied:?}"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 回归（Issue #244）：扫描产出的 `name` 是版本 JSON 的 `id`，与实例记录的
    /// `name`（版本目录名）可以不同。此时 sync_from_disk 必须按**目录名**匹配，
    /// 否则带 JVM 设置的记录被判为残留 → 用 Default 重建 → jvm_args/maxMemory
    /// 归零，用户的 GTNH 实例再也起不来。
    #[test]
    fn sync_from_disk_keeps_settings_when_json_id_differs_from_dir_name() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = std::env::temp_dir().join(format!("qomicex-issue244-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        // 目录名 GTNH 2.8.4 与版本 JSON id（GT New Horizons）不一致 —— 用户实测形态。
        std::fs::create_dir_all(game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("GTNH 2.8.4", game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.7.10".to_string();
        inst.max_memory = 8192;
        inst.jvm_args = Some("-XX:+UseG1GC -Dfml.ignoreInvalidMinecraftCertificates=true".into());
        inst.modpack_name = Some("GT New Horizons".into());
        inst.remark = Some("我的整合包".into());
        let created = service.create(inst).unwrap();

        let scanned = vec![ScannedVersionInfo {
            name: "GT New Horizons".to_string(),      // 版本 JSON id
            dir_name: Some("GTNH 2.8.4".to_string()), // 版本目录名
            game_version: "1.7.10".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: Some("1.7.10-10.13.4.1614-1.7.10".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        // 记录必须存活且是**同一条**（id 不变），设置不得丢失
        let kept = result
            .iter()
            .find(|i| i.name == "GTNH 2.8.4")
            .unwrap_or_else(|| panic!("目录名对应的实例记录被扫描清掉了: {result:?}"));
        assert_eq!(kept.id, created.id, "实例 id 不得被重建换掉");
        assert_eq!(kept.jvm_args, created.jvm_args, "JVM 参数不得丢失");
        assert_eq!(kept.max_memory, 8192, "内存设置不得被重置为默认值");
        assert_eq!(kept.modpack_name.as_deref(), Some("GT New Horizons"));
        assert_eq!(kept.remark.as_deref(), Some("我的整合包"));
        // 不得因 id/目录名漂移而额外造出一条名字来自 JSON id 的重复实例
        assert_eq!(
            result
                .iter()
                .filter(|i| i.game_dir == game_dir.to_str().unwrap())
                .count(),
            1,
            "同目录不得出现重复实例: {result:?}"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 回归（Issue #244 决定性防线）：扫描可能**整个漏掉**某个版本目录 ——
    /// `scan_one_version` 在 `{name}.json` 解析失败时返回 `None`、只留一条 warn，
    /// 该版本就不出现在扫描结果里。此时旧逻辑「game_dir 被扫过 + 名字没命中 = 残留」
    /// 会把**目录真实存在**的记录丢掉，随后被重建成 `Default`（jvmArgs/maxMemory 归零）。
    /// 存量记录常无 `createdAt`（该字段后加），宽限期豁免也不生效。
    #[test]
    fn sync_from_disk_keeps_settings_when_version_omitted_from_scan() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-issue244-omit-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        std::fs::create_dir_all(game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("GTNH 2.8.4", game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.7.10".to_string();
        inst.max_memory = 8192;
        inst.jvm_args =
            Some("-Dfile.encoding=UTF-8 --add-opens java.base/java.lang=ALL-UNNAMED".into());
        let created = service.create(inst).unwrap();
        // 复刻存量记录：没有 createdAt（宽限期豁免不生效）
        {
            let mut cur = service.get_by_id(&created.id).unwrap();
            cur.created_at = None;
            service.update(&created.id, cur).unwrap();
        }

        // 同 game_dir 下另一版本被扫到（scanned_dirs 含该 game_dir），但 GTNH 2.8.4
        // 因版本 JSON 解析失败被整条跳过。
        let scanned = vec![ScannedVersionInfo {
            name: "1.12.2".to_string(),
            dir_name: Some("1.12.2".to_string()),
            game_version: "1.12.2".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: None,
            loader_version: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let kept = result
            .iter()
            .find(|i| i.name == "GTNH 2.8.4")
            .unwrap_or_else(|| panic!("版本目录真实存在的实例被扫描清掉了: {result:?}"));
        assert_eq!(kept.id, created.id, "实例 id 不得被重建换掉");
        assert_eq!(kept.jvm_args, created.jvm_args, "JVM 参数不得丢失");
        assert_eq!(kept.max_memory, 8192, "内存设置不得被重置为默认值");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 回归（Issue #244 评审）：存量记录的 `name` 可能是版本 JSON 的 id（旧前端按扫描
    /// 结果补建时写入的就是 ScannedVersion.name）。此时记录的目录其实存在（真名是目录
    /// 名），若不做身份迁移，第 1 步会拿 id 去拼 `versions/{id}` 判「不存在」并把记录
    /// 当残留删掉，设置随之丢失。扫描给出 id→目录名映射时必须迁移。
    #[test]
    fn sync_from_disk_migrates_legacy_record_named_by_json_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-issue244-alias-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        std::fs::create_dir_all(game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        // 存量记录：name 是 JSON id，且没有 createdAt（宽限期豁免不生效）
        let mut inst = make_instance("GT New Horizons", game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.7.10".to_string();
        inst.max_memory = 8192;
        inst.jvm_args = Some("-XX:+UseG1GC".into());
        let created = service.create(inst).unwrap();
        {
            let mut cur = service.get_by_id(&created.id).unwrap();
            cur.created_at = None;
            service.update(&created.id, cur).unwrap();
        }

        // 扫描给出映射：id="GT New Horizons" → 目录名 "GTNH 2.8.4"（目录真实存在）
        let scanned = vec![ScannedVersionInfo {
            name: "GT New Horizons".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: Some("1.7.10-10.13.4.1614-1.7.10".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let kept = result
            .iter()
            .find(|i| i.id == created.id)
            .unwrap_or_else(|| panic!("存量记录（name 为 JSON id）被当残留清掉: {result:?}"));
        assert_eq!(kept.name, "GTNH 2.8.4", "记录名应迁移为版本目录名");
        assert_eq!(kept.jvm_args, created.jvm_args, "JVM 参数不得丢失");
        assert_eq!(kept.max_memory, 8192, "内存设置不得丢失");
        assert_eq!(
            result
                .iter()
                .filter(|i| i.game_dir == game_dir.to_str().unwrap())
                .count(),
            1,
            "迁移后不得出现重复实例: {result:?}"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 回归（Issue #244 评审）：旧前端不带 `dirName` 提交扫描结果，且版本 JSON 的
    /// `id` 与目录名不同。若直接回退用 `name`（JSON id）当身份键，会在该键下新建一条
    /// 默认记录、同时保留原有目录名记录 —— 同一版本出现两条，其中一条设置已重置。
    /// 应反查真实目录名后按目录名匹配。
    #[test]
    fn sync_from_disk_resolves_dir_name_when_dir_name_absent() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-issue244-nodir-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("GTNH 2.8.4");
        std::fs::create_dir_all(&version_dir).unwrap();
        // 目录名 GTNH 2.8.4，但其版本 JSON 的 id 是 GT New Horizons
        std::fs::write(
            version_dir.join("GTNH 2.8.4.json"),
            r#"{"id":"GT New Horizons","inheritsFrom":"1.7.10"}"#,
        )
        .unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("GTNH 2.8.4", game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.7.10".to_string();
        inst.max_memory = 8192;
        inst.jvm_args = Some("-XX:+UseG1GC".into());
        let created = service.create(inst).unwrap();

        // 旧前端：dir_name 缺失，只给 name（= JSON id）
        let scanned = vec![ScannedVersionInfo {
            name: "GT New Horizons".to_string(),
            dir_name: None,
            game_version: "1.7.10".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: Some("1.7.10-10.13.4.1614-1.7.10".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let same_dir: Vec<&GameInstance> = result
            .iter()
            .filter(|i| i.game_dir == game_dir.to_str().unwrap())
            .collect();
        assert_eq!(
            same_dir.len(),
            1,
            "同一版本不得出现两条记录（其中一条设置被重置）: {result:?}"
        );
        let kept = result
            .iter()
            .find(|i| i.id == created.id)
            .expect("原记录应保留");
        assert_eq!(kept.name, "GTNH 2.8.4");
        assert_eq!(kept.jvm_args, created.jvm_args, "JVM 参数不得丢失");
        assert_eq!(kept.max_memory, 8192, "内存设置不得丢失");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 回归：用户把 `.minecraft` 从 C: 搬到 E:（GTNH 实测路径）后，旧版本目录被
    /// 删除。`(game_dir, name)` 键不再匹配，旧逻辑会删掉旧记录并新建默认记录，
    /// JVM 参数/内存/Java 路径/统计全部归零。扫描必须把孤立记录接管到新目录，
    /// 保留原 id 与设置，并在新目录补写 qomicex.json。
    #[test]
    fn sync_from_disk_adopts_settings_when_game_dir_moves() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-gamedir-move-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        std::fs::create_dir_all(new_game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("GTNH 2.8.4", old_game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.7.10".to_string();
        inst.loader = Some("Forge".to_string());
        inst.loader_version = Some("1.7.10-10.13.4.1614-1.7.10".to_string());
        inst.max_memory = 8192;
        inst.jvm_args =
            Some("-Dfile.encoding=UTF-8 --add-opens java.base/java.lang=ALL-UNNAMED".into());
        inst.java_path = Some("C:/Java/jdk-21/bin/java.exe".into());
        inst.remark = Some("GTNH 专用".into());
        inst.play_time = 42;
        inst.last_played = Some("2026-10-23T07:48:18Z".into());
        let created = service.create(inst).unwrap();

        let scanned = vec![ScannedVersionInfo {
            name: "GTNH 2.8.4".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: Some("1.7.10-10.13.4.1614-1.7.10".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let moved = result
            .iter()
            .find(|i| i.id == created.id)
            .unwrap_or_else(|| panic!("搬迁后的实例记录被清掉: {result:?}"));
        assert_eq!(moved.game_dir, new_game_dir.to_str().unwrap());
        assert_eq!(moved.name, "GTNH 2.8.4");
        assert_eq!(moved.jvm_args, created.jvm_args, "JVM 参数不得丢失");
        assert_eq!(moved.max_memory, 8192, "内存设置不得被重置");
        assert_eq!(moved.java_path, created.java_path, "Java 路径不得丢失");
        assert_eq!(moved.remark.as_deref(), Some("GTNH 专用"));
        assert_eq!(moved.play_time, 42, "游玩统计不得丢失");
        assert_eq!(
            result.iter().filter(|i| i.name == "GTNH 2.8.4").count(),
            1,
            "搬迁后不得同时留下新旧两条记录: {result:?}"
        );

        // 模拟重启：镜像与独立配置都必须留得住。
        let reopened = InstanceService::new();
        let kept = reopened
            .get_by_id(&created.id)
            .unwrap_or_else(|| panic!("重启后实例记录丢失"));
        assert_eq!(kept.jvm_args, created.jvm_args);
        assert_eq!(kept.max_memory, 8192);
        let cfg_path = new_game_dir
            .join("versions")
            .join("GTNH 2.8.4")
            .join("qomicex.json");
        let cfg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert_eq!(cfg["jvmArgs"].as_str(), moved.jvm_args.as_deref());
        assert_eq!(cfg["maxMemory"], 8192);

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 用户先切到新目录、旧目录稍后才删除：第一次扫描会留下一条默认记录，
    /// 第二次扫描（旧版本目录已消失）必须把孤儿记录里的 JVM/内存/Java 路径补进
    /// 这条默认记录，而不是让用户重新配置（GTNH 实测顺序）。
    #[test]
    fn sync_from_disk_restores_settings_into_existing_default_record() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-gamedir-late-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        std::fs::create_dir_all(new_game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        let mut old = make_instance("GTNH 2.8.4", old_game_dir.to_str().unwrap(), Some(true));
        old.game_version = "1.7.10".to_string();
        old.loader = Some("Forge".to_string());
        old.max_memory = 8192;
        old.jvm_args =
            Some("-Dfile.encoding=UTF-8 --add-opens java.base/java.lang=ALL-UNNAMED".into());
        old.java_path = Some("C:/Java/jdk-21/bin/java.exe".into());
        old.play_time = 36;
        old.last_played = Some("2026-10-11T09:21:33Z".into());
        let old_created = service.create(old).unwrap();
        // 复刻存量记录：没有 createdAt，避免安装宽限期把旧记录保下来。
        {
            let mut cur = service.get_by_id(&old_created.id).unwrap();
            cur.created_at = None;
            service.update(&old_created.id, cur).unwrap();
        }

        // 第一次切目录后的默认记录：已有目录、已有游玩统计，但没有 JVM/内存设置。
        let mut fresh = make_instance("GTNH 2.8.4", new_game_dir.to_str().unwrap(), Some(true));
        fresh.game_version = "1.7.10".to_string();
        fresh.loader = Some("Forge".to_string());
        fresh.play_time = 1;
        fresh.last_played = Some("2026-10-23T07:48:18Z".into());
        let fresh_created = service.create(fresh).unwrap();
        // 旧记录是默认实例：合并后必须把默认 id 改指新记录，不能悬空。
        service.set_default_id(&old_created.id);

        let scanned = vec![ScannedVersionInfo {
            name: "GTNH 2.8.4".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: Some("1.7.10-10.13.4.1614-1.7.10".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let kept = result
            .iter()
            .find(|i| i.id == fresh_created.id)
            .unwrap_or_else(|| panic!("新目录记录应保留: {result:?}"));
        assert_eq!(kept.jvm_args, old_created.jvm_args, "JVM 参数应补回");
        assert_eq!(kept.max_memory, 8192, "内存应补回");
        assert_eq!(kept.java_path, old_created.java_path, "Java 路径应补回");
        assert_eq!(kept.play_time, 36, "游玩时长应保留较长的一份");
        assert_eq!(
            service.get_default_id().as_deref(),
            Some(fresh_created.id.as_str()),
            "默认实例应改指合并后的记录"
        );
        assert_eq!(
            result.iter().filter(|i| i.name == "GTNH 2.8.4").count(),
            1,
            "旧目录记录应被清理，不得重复: {result:?}"
        );
        assert!(
            result.iter().all(|i| i.id != old_created.id),
            "旧记录不应继续存在"
        );

        let reopened = InstanceService::new();
        let kept = reopened.get_by_id(&fresh_created.id).unwrap();
        assert_eq!(kept.jvm_args, old_created.jvm_args);
        assert_eq!(kept.max_memory, 8192);

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 用户在新目录里显式清空过 JVM/内存时，搬迁接管不得把旧目录的值补回来。
    /// `cleared_settings` 记录的是「用户重置」而不是「从未设置」。
    #[test]
    fn sync_from_disk_respects_user_cleared_settings() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-gamedir-cleared-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        std::fs::create_dir_all(new_game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        let mut old = make_instance("GTNH 2.8.4", old_game_dir.to_str().unwrap(), Some(true));
        old.game_version = "1.7.10".to_string();
        old.loader = Some("Forge".to_string());
        old.max_memory = 8192;
        old.jvm_args = Some("-Dfile.encoding=UTF-8".into());
        let old_created = service.create(old).unwrap();
        {
            let mut cur = service.get_by_id(&old_created.id).unwrap();
            cur.created_at = None;
            service.update(&old_created.id, cur).unwrap();
        }

        let mut fresh = make_instance("GTNH 2.8.4", new_game_dir.to_str().unwrap(), Some(true));
        fresh.game_version = "1.7.10".to_string();
        fresh.loader = Some("Forge".to_string());
        fresh.cleared_settings = vec!["jvmArgs".into(), "maxMemory".into()];
        let fresh_created = service.create(fresh).unwrap();

        let scanned = vec![ScannedVersionInfo {
            name: "GTNH 2.8.4".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: Some("1.7.10-10.13.4.1614-1.7.10".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let kept = result
            .iter()
            .find(|i| i.id == fresh_created.id)
            .unwrap_or_else(|| panic!("新目录记录应保留: {result:?}"));
        assert_eq!(kept.jvm_args, None, "用户显式清空的 JVM 不得被旧值覆盖");
        assert_eq!(
            kept.max_memory, DEFAULT_MAX_MEMORY,
            "用户显式重置的内存不得被旧值覆盖"
        );
        assert!(
            result.iter().all(|i| i.id != old_created.id),
            "旧记录应被清理"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 多个已删除的游戏目录都有同名同版本记录时，无法判断真正来源，必须放弃
    /// 接管，避免把无关安装的 JVM/账号令牌带进新目录。
    #[test]
    fn sync_from_disk_does_not_guess_between_multiple_orphan_sources() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = std::env::temp_dir().join(format!(
            "qomicex-gamedir-ambiguous-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_a = home.join("old-a");
        let old_b = home.join("old-b");
        let new_game_dir = home.join("new-mc");
        std::fs::create_dir_all(&old_a).unwrap();
        std::fs::create_dir_all(&old_b).unwrap();
        std::fs::create_dir_all(new_game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        let mut a = make_instance("GTNH 2.8.4", old_a.to_str().unwrap(), Some(true));
        a.game_version = "1.7.10".to_string();
        a.loader = Some("Forge".to_string());
        a.jvm_args = Some("-Da".into());
        let a_created = service.create(a).unwrap();
        let mut b = make_instance("GTNH 2.8.4", old_b.to_str().unwrap(), Some(true));
        b.game_version = "1.7.10".to_string();
        b.loader = Some("Forge".to_string());
        b.jvm_args = Some("-Db".into());
        let b_created = service.create(b).unwrap();
        for id in [&a_created.id, &b_created.id] {
            let mut cur = service.get_by_id(id).unwrap();
            cur.created_at = None;
            service.update(id, cur).unwrap();
        }

        let mut fresh = make_instance("GTNH 2.8.4", new_game_dir.to_str().unwrap(), Some(true));
        fresh.game_version = "1.7.10".to_string();
        fresh.loader = Some("Forge".to_string());
        let fresh_created = service.create(fresh).unwrap();

        let scanned = vec![ScannedVersionInfo {
            name: "GTNH 2.8.4".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let kept = result
            .iter()
            .find(|i| i.id == fresh_created.id)
            .unwrap_or_else(|| panic!("新目录记录应保留: {result:?}"));
        assert_eq!(kept.jvm_args, None, "来源不唯一时不得猜测并复制 JVM");
        assert!(result.iter().all(|i| i.id != a_created.id));
        assert!(result.iter().all(|i| i.id != b_created.id));

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// qomicex.json 写失败时不能删旧记录：否则目标配置仍是旧值，下一次读取
    /// 会把刚补回的 JVM/内存再次覆盖掉。
    #[test]
    fn sync_from_disk_aborts_writeback_when_qomicex_cannot_be_written() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = std::env::temp_dir().join(format!(
            "qomicex-gamedir-writefail-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        let version_dir = new_game_dir.join("versions").join("GTNH 2.8.4");
        std::fs::create_dir_all(&version_dir).unwrap();

        let service = InstanceService::new();
        let mut old = make_instance("GTNH 2.8.4", old_game_dir.to_str().unwrap(), Some(true));
        old.game_version = "1.7.10".to_string();
        old.loader = Some("Forge".to_string());
        old.jvm_args = Some("-Dfile.encoding=UTF-8".into());
        let old_created = service.create(old).unwrap();
        {
            let mut cur = service.get_by_id(&old_created.id).unwrap();
            cur.created_at = None;
            service.update(&old_created.id, cur).unwrap();
        }

        let mut fresh = make_instance("GTNH 2.8.4", new_game_dir.to_str().unwrap(), Some(true));
        fresh.game_version = "1.7.10".to_string();
        fresh.loader = Some("Forge".to_string());
        let fresh_created = service.create(fresh).unwrap();
        // 用同名目录占住 qomicex.json，让 write_map 的原子替换和回退写都失败。
        let cfg_path = version_dir.join(instance_config::CONFIG_FILE);
        let _ = std::fs::remove_file(&cfg_path);
        std::fs::create_dir(&cfg_path).unwrap();

        let scanned = vec![ScannedVersionInfo {
            name: "GTNH 2.8.4".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: Some("1.7.10-10.13.4.1614-1.7.10".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        assert!(
            result.iter().any(|i| i.id == old_created.id),
            "写失败时必须保留旧记录: {result:?}"
        );
        let kept = result.iter().find(|i| i.id == fresh_created.id).unwrap();
        assert_eq!(kept.jvm_args, None, "写失败时不得假装已恢复设置");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 旧记录名是版本 JSON id、实际旧目录用第三个名字且仍然存在时，不能接管；
    /// 同时要把记录名修复成真实目录名，避免第 1 步把它当残留删除。
    #[test]
    fn sync_from_disk_does_not_adopt_when_legacy_alias_dir_still_exists() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-gamedir-alias-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        let actual_dir = old_game_dir.join("versions").join("ActualDir");
        std::fs::create_dir_all(&actual_dir).unwrap();
        std::fs::write(
            actual_dir.join("ActualDir.json"),
            r#"{"id":"GT New Horizons"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(new_game_dir.join("versions").join("ActualDir")).unwrap();

        let service = InstanceService::new();
        let mut old = make_instance(
            "GT New Horizons",
            old_game_dir.to_str().unwrap(),
            Some(true),
        );
        old.game_version = "1.7.10".to_string();
        old.loader = Some("Forge".to_string());
        old.jvm_args = Some("-Dfile.encoding=UTF-8".into());
        let old_created = service.create(old).unwrap();
        {
            let mut cur = service.get_by_id(&old_created.id).unwrap();
            cur.created_at = None;
            service.update(&old_created.id, cur).unwrap();
        }

        let scanned = vec![ScannedVersionInfo {
            name: "GT New Horizons".to_string(),
            dir_name: Some("ActualDir".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let old = result
            .iter()
            .find(|i| i.id == old_created.id)
            .expect("旧目录仍存在时记录不得被删除");
        assert_eq!(old.name, "ActualDir", "记录名应修复为真实目录名");
        assert_eq!(old.game_dir, old_game_dir.to_str().unwrap());
        assert_eq!(old.jvm_args, old_created.jvm_args, "设置不得被搬走");
        let new = result
            .iter()
            .find(|i| i.game_dir == new_game_dir.to_str().unwrap())
            .expect("新目录应新建默认记录");
        assert_eq!(new.jvm_args, None);

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 旧目录仍存在时不能把它的设置「偷」给另一个目录里的同名实例：两个目录可能
    /// 是用户有意并存的独立安装目录。此时应保留旧记录，并在新目录新建默认记录。
    #[test]
    fn sync_from_disk_does_not_steal_settings_when_old_game_dir_still_exists() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-gamedir-coexist-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        std::fs::create_dir_all(old_game_dir.join("versions").join("GTNH 2.8.4")).unwrap();
        std::fs::create_dir_all(new_game_dir.join("versions").join("GTNH 2.8.4")).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("GTNH 2.8.4", old_game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.7.10".to_string();
        inst.loader = Some("Forge".to_string());
        inst.max_memory = 8192;
        inst.jvm_args = Some("-XX:+UseG1GC".into());
        let created = service.create(inst).unwrap();

        let scanned = vec![ScannedVersionInfo {
            name: "GTNH 2.8.4".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        let old = result
            .iter()
            .find(|i| i.id == created.id)
            .expect("旧目录记录应保留");
        assert_eq!(old.game_dir, old_game_dir.to_str().unwrap());
        assert_eq!(old.jvm_args, created.jvm_args);
        let new = result
            .iter()
            .find(|i| i.game_dir == new_game_dir.to_str().unwrap())
            .expect("新目录应新建记录");
        assert_ne!(new.id, created.id, "新目录不得复用旧记录 id");
        assert_eq!(new.jvm_args, None, "不得把旧目录的 JVM 参数带到新目录");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 同名但游戏版本不同时不得接管：用户可能删掉旧 1.20.1 实例后，又安装了
    /// 同名的 1.7.10 实例，旧 JVM 参数对后者可能直接导致启动失败。
    #[test]
    fn sync_from_disk_does_not_adopt_across_game_versions() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-gamedir-version-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        std::fs::create_dir_all(new_game_dir.join("versions").join("Same Name")).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("Same Name", old_game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.20.1".to_string();
        inst.max_memory = 8192;
        inst.jvm_args = Some("-XX:+UseG1GC".into());
        let created = service.create(inst).unwrap();
        // 复刻存量记录：没有 createdAt，避免安装宽限期把旧记录保下来。
        {
            let mut cur = service.get_by_id(&created.id).unwrap();
            cur.created_at = None;
            service.update(&created.id, cur).unwrap();
        }

        let scanned = vec![ScannedVersionInfo {
            name: "Same Name".to_string(),
            dir_name: Some("Same Name".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        assert!(
            result.iter().all(|i| i.id != created.id),
            "旧 1.20.1 记录不应被搬到 1.7.10 目录: {result:?}"
        );
        let new = result
            .iter()
            .find(|i| i.game_dir == new_game_dir.to_str().unwrap())
            .expect("新目录应新建记录");
        assert_eq!(new.jvm_args, None);

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 旧记录缺少游戏版本/加载器时不能视为「匹配」：无法确认兼容性时保留旧记录，
    /// 不把它的设置接管到同名的新目录（Sourcery 评审）。
    #[test]
    fn sync_from_disk_does_not_adopt_without_compatible_metadata() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-gamedir-meta-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let old_game_dir = home.join("old-mc");
        let new_game_dir = home.join("new-mc");
        std::fs::create_dir_all(new_game_dir.join("versions").join("Same Name")).unwrap();

        let service = InstanceService::new();
        let mut old = make_instance("Same Name", old_game_dir.to_str().unwrap(), Some(true));
        old.game_version = String::new();
        old.loader = None;
        old.jvm_args = Some("-Xmx8G".into());
        let old_created = service.create(old).unwrap();
        {
            let mut cur = service.get_by_id(&old_created.id).unwrap();
            cur.created_at = None;
            service.update(&old_created.id, cur).unwrap();
        }

        let scanned = vec![ScannedVersionInfo {
            name: "Same Name".to_string(),
            dir_name: Some("Same Name".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: new_game_dir.to_str().unwrap().to_string(),
            loader: Some("Forge".to_string()),
            loader_version: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);

        assert!(
            result.iter().all(|i| i.id != old_created.id),
            "元数据不兼容时旧记录不应被接管: {result:?}"
        );
        let new = result
            .iter()
            .find(|i| i.game_dir == new_game_dir.to_str().unwrap())
            .expect("新目录应新建默认记录");
        assert_eq!(new.jvm_args, None, "不得复制未确认兼容实例的 JVM");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 回归（Issue #244 评审）：扫描期间用户改了 JVM/内存（PUT /instance/{id}），
    /// 写回合并不得用旧快照把它覆盖回去；同时并发新建的记录不得被整表替换丢掉，
    /// 而被判定为残留清掉的记录也不能被「救回」。
    ///
    /// 直接测合并函数，才能构造真正的交错时序（`sync_from_disk` 内部先取快照再写回，
    /// 从外部无法在两者之间插入改动）。
    #[test]
    fn merge_concurrent_writeback_keeps_user_edits() {
        let snapshot = vec![
            make_instance("GTNH 2.8.4", "C:/mc", Some(true)), // 将被并发修改
            make_instance("Stale", "C:/mc", Some(true)),      // 被判残留清掉
        ];
        let known_ids: std::collections::HashSet<String> =
            snapshot.iter().map(|i| i.id.clone()).collect();
        let names_before: HashMap<String, String> = snapshot
            .iter()
            .map(|i| (i.id.clone(), i.name.clone()))
            .collect();

        // 同步期间的实际状态：第 1 条被改了内存/JVM；Stale 已不在（残留清理）；
        // 外加一条并发新建的记录。
        let mut edited = snapshot[0].clone();
        edited.max_memory = 12288;
        edited.jvm_args = Some("--add-opens java.base/java.lang=ALL-UNNAMED".into());
        let mut concurrent_new = make_instance("NewlyCreated", "C:/mc", Some(true));
        concurrent_new.max_memory = 2048;
        let current = vec![edited, concurrent_new];

        // result：同步算出的结果（第 1 条仍是旧值，Stale 已被清掉）
        let mut result = vec![snapshot[0].clone()];
        InstanceService::merge_concurrent_writeback(
            &snapshot,
            &known_ids,
            &names_before,
            &current,
            &mut result,
        );

        let kept = result.iter().find(|i| i.id == snapshot[0].id).unwrap();
        assert_eq!(kept.max_memory, 12288, "并发改的内存不得被同步回退");
        assert_eq!(
            kept.jvm_args.as_deref(),
            Some("--add-opens java.base/java.lang=ALL-UNNAMED"),
            "并发改的 JVM 参数不得被同步回退"
        );
        assert!(
            result.iter().any(|i| i.name == "NewlyCreated"),
            "并发新建的记录不得被整表替换丢掉: {result:?}"
        );
        assert!(
            !result.iter().any(|i| i.id == snapshot[1].id),
            "被判定为残留清掉的记录不得被合并救回: {result:?}"
        );
    }

    /// 回归（Issue #244 评审）：同步期间用户把实例**改名**（PUT 先 rename_version_dir
    /// 再更新 name）。若合并时不带上新名，`result` 会保留旧目录名；下次同步时旧目录已
    /// 不存在，记录被当残留删除、新目录被扫成 Default 记录 —— 正是 #244 的故障形态。
    /// 同步期间用户清空一个「接管前本来就是空」的字段时，逐字段 diff 看不到变化，
    /// 但 `clearedSettings` 必须让 `result` 回到用户清空后的值，不能被刚补进来的旧值
    /// 留下（Sourcery 评审）。
    #[test]
    fn merge_concurrent_writeback_respects_clear_after_adoption() {
        let snapshot = vec![make_instance("GTNH 2.8.4", "C:/mc", Some(true))];
        let known_ids: std::collections::HashSet<String> =
            snapshot.iter().map(|i| i.id.clone()).collect();
        let names_before: HashMap<String, String> = snapshot
            .iter()
            .map(|i| (i.id.clone(), i.name.clone()))
            .collect();

        // orig 中 JVM/内存本来就是空/默认；同步接管先把旧值补进 slot。
        let mut slot = snapshot[0].clone();
        slot.jvm_args = Some("-Dfile.encoding=UTF-8".into());
        slot.max_memory = 8192;
        // 用户在同步期间显式清空：cur 的值仍是空/默认，只多了 cleared 标记。
        let mut cleared = snapshot[0].clone();
        cleared.jvm_args = None;
        cleared.max_memory = DEFAULT_MAX_MEMORY;
        cleared.cleared_settings = vec!["jvmArgs".into(), "maxMemory".into()];
        let mut result = vec![slot];

        InstanceService::merge_concurrent_writeback(
            &snapshot,
            &known_ids,
            &names_before,
            &[cleared],
            &mut result,
        );

        let kept = result.iter().find(|i| i.id == snapshot[0].id).unwrap();
        assert_eq!(kept.jvm_args, None, "用户清空后不得留下接管补进来的 JVM");
        assert_eq!(
            kept.max_memory, DEFAULT_MAX_MEMORY,
            "用户重置后不得留下接管补进来的内存"
        );
        assert!(kept.cleared_settings.iter().any(|k| k == "jvmArgs"));
        assert!(kept.cleared_settings.iter().any(|k| k == "maxMemory"));
    }

    #[test]
    fn merge_concurrent_writeback_keeps_concurrent_rename() {
        let snapshot = vec![make_instance("OldName", "C:/mc", Some(true))];
        let known_ids: std::collections::HashSet<String> =
            snapshot.iter().map(|i| i.id.clone()).collect();
        let names_before: HashMap<String, String> = snapshot
            .iter()
            .map(|i| (i.id.clone(), i.name.clone()))
            .collect();

        // 并发改名后的实际状态
        let mut renamed = snapshot[0].clone();
        renamed.name = "NewName".to_string();
        let current = vec![renamed];

        // result 里仍是同步算出的旧名
        let mut result = vec![snapshot[0].clone()];
        InstanceService::merge_concurrent_writeback(
            &snapshot,
            &known_ids,
            &names_before,
            &current,
            &mut result,
        );

        let kept = result.iter().find(|i| i.id == snapshot[0].id).unwrap();
        assert_eq!(
            kept.name, "NewName",
            "并发改名不得被同步回退（否则下次同步丢设置）"
        );
    }

    /// 回归（Issue #244 评审）：同步期间用户**删除**了实例（try_delete 从共享列表移除）。
    /// `result` 是更早的快照算出的、仍含该 id；若直接写回，已删记录会复活
    /// （隔离关闭时第 1 步不会清理它，实例永久存在）。
    #[test]
    fn merge_concurrent_writeback_drops_concurrently_deleted() {
        let snapshot = vec![
            make_instance("Keep", "C:/mc", Some(true)),
            make_instance("Deleted", "C:/mc", Some(false)), // 隔离关闭 → 第 1 步不清它
        ];
        let known_ids: std::collections::HashSet<String> =
            snapshot.iter().map(|i| i.id.clone()).collect();
        let names_before: HashMap<String, String> = snapshot
            .iter()
            .map(|i| (i.id.clone(), i.name.clone()))
            .collect();

        // 并发删除：current 里只剩 Keep
        let current = vec![snapshot[0].clone()];
        // result 仍含两条（快照算出的）
        let mut result = snapshot.clone();
        InstanceService::merge_concurrent_writeback(
            &snapshot,
            &known_ids,
            &names_before,
            &current,
            &mut result,
        );

        assert!(
            !result.iter().any(|i| i.id == snapshot[1].id),
            "并发删除的记录不得被写回复活: {result:?}"
        );
        assert!(
            result.iter().any(|i| i.id == snapshot[0].id),
            "未删的记录应保留"
        );
    }

    /// 回归：身份迁移不得被并发合并撤销。迁移只改本地快照，共享列表里仍是旧名；
    /// 若以迁移后的名字当基准判定「并发改名」，就会把自己的迁移撤销掉。
    #[test]
    fn merge_concurrent_writeback_does_not_undo_identity_migration() {
        // 迁移前名字（names_before_migration）
        let mut pre = make_instance("GT New Horizons", "C:/mc", Some(true));
        pre.max_memory = 8192;
        let names_before: HashMap<String, String> =
            [(pre.id.clone(), pre.name.clone())].into_iter().collect();
        let known_ids: std::collections::HashSet<String> = [pre.id.clone()].into_iter().collect();

        // 迁移后（本地快照）与共享列表（仍是旧名）一致：用户没改名
        let mut migrated = pre.clone();
        migrated.name = "GTNH 2.8.4".to_string();
        let snapshot = vec![migrated.clone()];
        let current = vec![pre.clone()];

        let mut result = vec![migrated.clone()];
        InstanceService::merge_concurrent_writeback(
            &snapshot,
            &known_ids,
            &names_before,
            &current,
            &mut result,
        );

        let kept = result.iter().find(|i| i.id == pre.id).unwrap();
        assert_eq!(
            kept.name, "GTNH 2.8.4",
            "第 1a 步的身份迁移不得被并发合并撤销: {result:?}"
        );
        assert_eq!(kept.max_memory, 8192, "迁移记录的设置不得丢失");
    }

    /// 回归：幽灵实例防线。try_delete 正常删目录 → Ok；删除失败 → Err 且记录恢复
    /// （否则残留目录会被 sync_from_disk 反推成幽灵实例复活）。
    #[test]
    fn sync_from_disk_grace_period_keeps_installing_isolated_instance() {
        // GTNH 实测缺陷：整合包管线先 create 记录（版本目录未落盘），此期间
        // sync_from_disk 的 retain 把记录当残留清掉；任务完成后磁盘扫描反推出
        // 一条丢失 loader/隔离/整合包元数据的裸记录。宽限期内的「已创建、目录
        // 未落」隔离记录必须保留。
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-grace-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let service = InstanceService::new();

        // 刚创建（宽限期内）+ 目录不存在 → 必须保留
        let installing = service
            .create(make_instance(
                "GT New Horizons",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        assert!(installing.created_at.is_some(), "create 应写入 created_at");

        // 超过宽限期的记录（目录不存在）→ 仍按残留清理
        let mut stale = make_instance("Stale", game_dir.to_str().unwrap(), Some(true));
        stale.created_at = Some(
            (chrono::Utc::now() - MODULE_INSTALLING_GRACE - chrono::Duration::minutes(1))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
        service.create(stale).unwrap();

        // 同 game_dir 下另一个实例已被扫描命中（目录存在）→ 第 5 步的
        // scanned_dirs 排除不得绕过宽限期（CodeRabbit 评审发现）
        let scanned_dir = game_dir.join("versions").join("Existing");
        std::fs::create_dir_all(&scanned_dir).unwrap();
        service
            .create(make_instance(
                "Existing",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        let scanned = vec![ScannedVersionInfo {
            name: "Existing".to_string(),
            dir_name: Some("Existing".to_string()),
            game_version: "1.20.1".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: None,
            loader_version: None,
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];

        let result = service.sync_from_disk(&scanned);
        let names: Vec<&str> = result.iter().map(|i| i.name.as_str()).collect();
        assert!(
            names.contains(&"GT New Horizons"),
            "宽限期内的安装中实例不应被清掉（含同目录其它版本被扫描的场景）: {names:?}"
        );
        assert!(
            !names.contains(&"Stale"),
            "宽限期外的无目录记录仍应按残留清理: {names:?}"
        );
        assert!(
            names.contains(&"Existing"),
            "被扫描的正常实例应保留: {names:?}"
        );
        // 扫描命中的实例只允许出现一次（宽限期兜底不得把同 key 记录重复写入）。
        assert_eq!(
            names.iter().filter(|n| **n == "Existing").count(),
            1,
            "同 key 实例不得重复: {names:?}"
        );
        // 保留下来的记录应保持完整字段（loader/version_isolation 不丢）
        let kept = service
            .get_by_id(&installing.id)
            .expect("宽限期记录应写回 JSON");
        assert_eq!(kept.version_isolation, Some(true));

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn try_delete_recovers_record_when_dir_undeletable() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-trydelete-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("Ghost");
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(version_dir.join("Ghost.json"), "{}").unwrap();

        let service = InstanceService::new();
        let inst = service
            .create(make_instance(
                "Ghost",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();

        // 正常删除：目录可删 → Ok(Some)，记录与目录均消失
        let removed = service.try_delete(&inst.id);
        assert!(removed.is_ok(), "正常删除应成功: {removed:?}");
        assert!(!version_dir.is_dir(), "版本目录应被删除");

        // 制造「目录删不掉」：Windows 上进程 CWD 所在目录不可删除（目录被锁定）。
        // （实测：File::open 句柄锁无效——std 删除走 POSIX semantics；只读文件也
        // 无效——remove_dir_all 会自行清除只读属性。仅 CWD 锁可靠。）
        std::fs::create_dir_all(&version_dir).unwrap();
        let old_cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(&version_dir).unwrap();

        let inst2 = service
            .create(make_instance(
                "Ghost",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        let result = service.try_delete(&inst2.id);
        let record_restored = service.get_by_id(&inst2.id).is_some();

        if cfg!(windows) {
            assert!(
                matches!(result, Err(ref e) if e.contains("版本目录删除失败")),
                "Windows 上 CWD 锁应导致目录删除失败: {result:?}"
            );
            assert!(
                record_restored,
                "目录删除失败时实例记录必须恢复（防幽灵实例复活）"
            );
            assert!(version_dir.is_dir(), "残留目录应仍在（等待用户处理）");
        } else {
            // 非 Windows：CWD 锁不生效 → 行为退化为正常删除，同样可接受
            assert!(result.is_ok() || record_restored);
        }

        // 恢复 CWD 后清理
        std::env::set_current_dir(old_cwd).unwrap();
        let _ = std::fs::remove_dir_all(&version_dir);
        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
    }

    /// 并发补丁必须在实例锁内应用到最新记录：后一个请求只改 JVM，不能把前一个
    /// 请求写的内存设置回退成它读到的旧快照。
    #[test]
    fn update_with_applies_patches_to_latest_record() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-update-patch-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();

        let service = InstanceService::new();
        let created = service
            .create(make_instance(
                "1.20.1",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        service
            .update_with(&created.id, |cur| cur.max_memory = 8192)
            .unwrap()
            .expect("first patch");
        service
            .update_with(&created.id, |cur| cur.jvm_args = Some("-Xmx8G".to_string()))
            .unwrap()
            .expect("second patch");

        let final_inst = service.get_by_id(&created.id).unwrap();
        assert_eq!(final_inst.max_memory, 8192, "第二个补丁不得回退内存设置");
        assert_eq!(final_inst.jvm_args.as_deref(), Some("-Xmx8G"));
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(version_dir.join(instance_config::CONFIG_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["maxMemory"], 8192);
        assert_eq!(raw["jvmArgs"], "-Xmx8G");

        // 同一版本目录不得出现第二条记录（否则两条记录共用一份配置）。
        assert!(service
            .create(make_instance(
                "1.20.1",
                game_dir.to_str().unwrap(),
                Some(true)
            ))
            .is_err());
        service
            .create(make_instance(
                "Other",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        let err = service
            .update_with(&created.id, |cur| cur.name = "Other".to_string())
            .unwrap_err();
        assert!(err.contains("已被占用"), "改名也不得共用版本目录: {err}");
        assert_eq!(
            service.get_by_id(&created.id).unwrap().name,
            "1.20.1",
            "改名失败后记录不得变化"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 用户清空设置时记录 `cleared_settings`，重新设置有值时取消标记。
    #[test]
    fn update_with_tracks_user_cleared_settings() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-cleared-track-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        std::fs::create_dir_all(game_dir.join("versions").join("1.20.1")).unwrap();
        let service = InstanceService::new();
        let mut inst = make_instance("1.20.1", game_dir.to_str().unwrap(), Some(true));
        inst.jvm_args = Some("-Xmx8G".into());
        inst.max_memory = 8192;
        inst.remark = Some("备注".into());
        inst.skip_integrity_check = true;
        inst.is_hidden = true;
        inst.custom_group_ids = vec!["group".into()];
        let created = service.create(inst).unwrap();

        service
            .update_with(&created.id, |cur| {
                cur.jvm_args = None;
                cur.max_memory = DEFAULT_MAX_MEMORY;
                cur.remark = None;
                cur.skip_integrity_check = false;
                cur.is_hidden = false;
                cur.version_isolation = None;
                cur.custom_group_ids.clear();
            })
            .unwrap()
            .expect("clear patch");
        let cleared = service.get_by_id(&created.id).unwrap().cleared_settings;
        for key in [
            "jvmArgs",
            "maxMemory",
            "remark",
            "skipIntegrityCheck",
            "isHidden",
            "versionIsolation",
            "customGroupIds",
        ] {
            assert!(
                cleared.iter().any(|k| k == key),
                "{key} 应记录为用户已清空: {cleared:?}"
            );
        }

        service
            .update_with(&created.id, |cur| cur.jvm_args = Some("-Xmx4G".into()))
            .unwrap()
            .expect("set patch");
        let cleared = service.get_by_id(&created.id).unwrap().cleared_settings;
        assert!(
            !cleared.iter().any(|k| k == "jvmArgs"),
            "重新设置后不应再视为已清空: {cleared:?}"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 扫描修正的 gameVersion/loader 必须同步写回独立配置，否则下一次 load
    /// 会把旧配置盖回内存，用户看到版本信息反复跳变。
    #[test]
    fn sync_from_disk_updates_scanned_metadata_in_config() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = std::env::temp_dir().join(format!("qomicex-scan-meta-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("GTNH 2.8.4");
        std::fs::create_dir_all(&version_dir).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("GTNH 2.8.4", game_dir.to_str().unwrap(), Some(true));
        inst.game_version = "1.12.2".to_string();
        inst.max_memory = 8192;
        inst.jvm_args = Some("-XX:+UseG1GC".to_string());
        let created = service.create(inst).unwrap();

        let scanned = vec![ScannedVersionInfo {
            name: "GT New Horizons".to_string(),
            dir_name: Some("GTNH 2.8.4".to_string()),
            game_version: "1.7.10".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: Some("forge".to_string()),
            loader_version: Some("14.23.5.2860".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = service.sync_from_disk(&scanned);
        let kept = result.iter().find(|i| i.id == created.id).unwrap();
        assert_eq!(kept.game_version, "1.7.10");
        assert_eq!(kept.loader.as_deref(), Some("forge"));
        assert_eq!(kept.loader_version.as_deref(), Some("14.23.5.2860"));

        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(version_dir.join(instance_config::CONFIG_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["gameVersion"], "1.7.10");
        assert_eq!(raw["loader"], "forge");
        assert_eq!(raw["loaderVersion"], "14.23.5.2860");
        assert_eq!(raw["jvmArgs"], "-XX:+UseG1GC", "无关设置不得丢失");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 独立配置比镜像新时，`get_all` 采纳后必须回写镜像，否则重启会退回旧值。
    #[test]
    fn get_all_mirrors_newer_config_to_instances_json() {
        let home =
            std::env::temp_dir().join(format!("qomicex-getall-mirror-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);

        // game_dir 用绝对路径，独立配置不需要 QOMICEX_HOME；避免改动进程级环境变量
        // 和其他不持 ENV_LOCK 的测试（如 plugin）互相干扰。
        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();

        let service = InstanceService::new_for_test(&home);
        let created = service
            .create(make_instance(
                "1.20.1",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        let mut newer = created.clone();
        newer.max_memory = 8192;
        newer.jvm_args = Some("-Xmx8G".to_string());
        instance_config::write_full(&newer).unwrap();

        let all = service.get_all();
        let merged = all.iter().find(|i| i.id == created.id).unwrap();
        assert_eq!(merged.max_memory, 8192);
        assert_eq!(merged.jvm_args.as_deref(), Some("-Xmx8G"));

        let mirror: Vec<GameInstance> = serde_json::from_slice(
            &std::fs::read(home.join("data").join("instances.json")).unwrap(),
        )
        .unwrap();
        let mirrored = mirror.iter().find(|i| i.id == created.id).unwrap();
        assert_eq!(mirrored.max_memory, 8192, "get_all 应把新配置同步到镜像");
        assert_eq!(mirrored.jvm_args.as_deref(), Some("-Xmx8G"));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// 重置某一项设置时，独立配置只改对应键：重置内存不得连带清空 JVM/Java。
    #[test]
    fn update_resets_only_the_changed_config_key() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-reset-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("1.20.1", game_dir.to_str().unwrap(), Some(true));
        inst.max_memory = 8192;
        inst.jvm_args = Some("-XX:+UseG1GC".to_string());
        inst.java_path = Some("C:/Java/bin/javaw.exe".to_string());
        let created = service.create(inst).unwrap();
        let config_path = version_dir.join(instance_config::CONFIG_FILE);

        // 只重置内存 → JVM/Java 原样保留
        let mut reset = created.clone();
        reset.max_memory = 4096;
        service
            .update(&created.id, reset.clone())
            .unwrap()
            .expect("update");
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(raw["maxMemory"], 4096);
        assert_eq!(raw["jvmArgs"], "-XX:+UseG1GC");
        assert_eq!(raw["javaPath"], "C:/Java/bin/javaw.exe");

        // 清空 JVM → 只删 jvmArgs，内存/Java 路径不动
        let mut cleared = reset.clone();
        cleared.jvm_args = None;
        service
            .update(&created.id, cleared)
            .unwrap()
            .expect("update");
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert!(
            raw.get("jvmArgs").is_none(),
            "清空 JVM 只应删除对应键: {raw}"
        );
        assert_eq!(raw["maxMemory"], 4096);
        assert_eq!(raw["javaPath"], "C:/Java/bin/javaw.exe");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// instances.json 丢失后，sync_from_disk 应从独立配置恢复原 id 与全部设置。
    #[test]
    fn sync_recovers_settings_from_config_when_instances_json_lost() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-recover-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("GTNH");
        std::fs::create_dir_all(&version_dir).unwrap();

        let service = InstanceService::new();
        let mut inst = make_instance("GTNH", game_dir.to_str().unwrap(), Some(true));
        inst.max_memory = 8192;
        inst.jvm_args = Some("-Xmx8G".to_string());
        inst.java_path = Some("C:/Java/bin/javaw.exe".to_string());
        let created = service.create(inst).unwrap();

        // 模拟统一文件丢失
        let unified = home.join("data").join("instances.json");
        std::fs::remove_file(&unified).unwrap();

        let restarted = InstanceService::new();
        assert!(restarted.get_all().is_empty(), "统一文件丢失后应为空表");

        let scanned = vec![ScannedVersionInfo {
            name: "GTNH".to_string(),
            dir_name: Some("GTNH".to_string()),
            game_version: "1.20.1".to_string(),
            game_dir: game_dir.to_str().unwrap().to_string(),
            loader: Some("forge".to_string()),
            loader_version: Some("47.1.0".to_string()),
            icon_data: None,
            modpack_name: None,
            modpack_version: None,
            modpack_author: None,
            modpack_summary: None,
        }];
        let result = restarted.sync_from_disk(&scanned);
        let found = result
            .iter()
            .find(|i| i.name == "GTNH")
            .unwrap_or_else(|| panic!("应从 qomicex.json 恢复实例: {result:?}"));

        assert_eq!(found.id, created.id, "实例 id 应从独立配置恢复");
        assert_eq!(found.max_memory, 8192, "内存设置不得丢失");
        assert_eq!(found.jvm_args.as_deref(), Some("-Xmx8G"), "JVM 不得丢失");
        assert_eq!(
            found.java_path.as_deref(),
            Some("C:/Java/bin/javaw.exe"),
            "Java 路径不得丢失"
        );
        assert_eq!(found.version_isolation, Some(true));
        assert_eq!(found.loader.as_deref(), Some("forge"), "磁盘 loader 应覆盖");
        assert!(unified.is_file(), "同步后应重建 instances.json");
        assert!(
            restarted.get_by_id(&created.id).is_some(),
            "恢复的记录应写回内存/统一文件"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 创建指向已有版本目录时采纳其中的独立配置（整合包导入/重建），但不复用旧 id。
    #[test]
    fn create_adopts_existing_config_but_keeps_new_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home =
            std::env::temp_dir().join(format!("qomicex-adopt-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&home);
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = home.join("games").join("mc");
        let version_dir = game_dir.join("versions").join("Pack");
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(
            version_dir.join(instance_config::CONFIG_FILE),
            r#"{"id":"old-id","maxMemory":8192,"jvmArgs":"-Xmx8G","javaPath":"C:/local/javaw.exe"}"#,
        )
        .unwrap();

        let service = InstanceService::new();
        let created = service
            .create(make_instance(
                "Pack",
                game_dir.to_str().unwrap(),
                Some(true),
            ))
            .unwrap();
        assert_ne!(created.id, "old-id", "不得复用包里的旧 id");
        assert_eq!(created.max_memory, 8192, "应采纳包内内存设置");
        assert_eq!(created.jvm_args.as_deref(), Some("-Xmx8G"));

        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(version_dir.join(instance_config::CONFIG_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["id"], created.id, "配置文件 id 应更新为新记录 id");

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
