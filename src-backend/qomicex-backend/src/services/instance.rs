// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 游戏实例模型与实例服务（对应源 Models/GameInstance.cs + Services/InstanceService.cs）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::settings;

/// 游戏实例（对应 C# GameInstance，全部 camelCase）。
#[derive(Debug, Clone, Deserialize, Serialize)]
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
}

impl Default for GameInstance {
    fn default() -> Self {
        Self {
            id: new_short_id(),
            name: String::new(),
            game_version: String::new(),
            loader: None,
            loader_version: None,
            java_path: None,
            max_memory: 4096,
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
        }
    }
}

/// 生成 12 位十六进制短 id（对应 C# `Guid.NewGuid().ToString("N")[..12]`）。
fn new_short_id() -> String {
    let full = format!("{:x}", uuid::Uuid::new_v4());
    full[..12].to_string()
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

    fn save_to_file(&self) {
        let guard = match self.instances.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // 紧凑序列化（非 pretty）：`icon_data` 是 base64 data URI，73 个集成包图标
        // 就能把 instances.json 撑到 10MB+，pretty 的缩进/换行在这个体量下会让每次
        // 同步的写盘时间和文件体积都翻倍（实测慢 2-3 倍、大 30%+）。
        if let Ok(json) = serde_json::to_string(&*guard) {
            // 原子替换：直接 write 会在进程被杀时截断文件，而 load_from_file 解析
            // 失败一律返回空表 —— 那意味着全部实例记录丢失。先写同目录 tmp 再 rename。
            let tmp = self
                .file_path
                .with_extension(format!("json.{}.tmp", std::process::id()));
            let ok = std::fs::write(&tmp, &json).is_ok()
                && std::fs::rename(&tmp, &self.file_path).is_ok();
            if ok {
                return;
            }
            // tmp 写/换失败（权限、磁盘满、跨设备）：退回直写，至少别丢数据。
            let _ = std::fs::write(&self.file_path, &json);
        }
    }

    pub fn get_all(&self) -> Vec<GameInstance> {
        match self.instances.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
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
                std::path::Path::new(&inst.game_dir)
                    .join("versions")
                    .join(&inst.name)
                    .is_dir()
            })
            .collect()
    }

    pub fn get_by_id(&self, id: &str) -> Option<GameInstance> {
        match self.instances.lock() {
            Ok(g) => g.iter().find(|i| i.id == id).cloned(),
            Err(p) => p.into_inner().iter().find(|i| i.id == id).cloned(),
        }
    }

    pub fn create(&self, mut instance: GameInstance) -> GameInstance {
        let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
        if instance.id.is_empty() {
            instance.id = new_short_id();
        }
        // 创建时间戳：sync_from_disk 据此给「记录已建、版本目录未落」的整合包
        // 安装留宽限期（宽限期内的隔离记录不当残留清除）。
        if instance.created_at.is_none() {
            instance.created_at =
                Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
        guard.push(instance.clone());
        drop(guard);
        self.save_to_file();
        // 使该 game_dir 的扫描缓存失效
        self.invalidate_scan_cache(&instance.game_dir);
        instance
    }

    pub fn update(&self, id: &str, mut instance: GameInstance) -> Option<GameInstance> {
        let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
        let index = guard.iter().position(|i| i.id == id);
        let index = index?;
        instance.id = id.to_string();
        guard[index] = instance.clone();
        drop(guard);
        self.save_to_file();
        // 使该 game_dir 的扫描缓存失效
        self.invalidate_scan_cache(&instance.game_dir);
        Some(instance)
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
            self.save_to_file();
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
            self.create(instance.clone());
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
            let dir_exists = std::path::Path::new(&inst.game_dir)
                .join("versions")
                .join(&inst.name)
                .is_dir();
            if dir_exists {
                return true;
            }
            match inst
                .created_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            {
                Some(t) if now.signed_duration_since(t) < INSTALLING_GRACE => true,
                _ => false,
            }
        });

        // 2. 跟踪已扫描的游戏目录
        let scanned_dirs: std::collections::HashSet<String> =
            scanned.iter().map(|s| s.game_dir.clone()).collect();

        // 3. 按 (game_dir, name) 索引 JSON 实例
        let mut json_index: HashMap<(String, String), usize> = HashMap::new();
        for (idx, inst) in json_instances.iter().enumerate() {
            json_index.insert((inst.game_dir.clone(), inst.name.clone()), idx);
        }

        // 4. 遍历磁盘扫描结果，合并或创建实例
        let mut result: Vec<GameInstance> = Vec::new();
        let mut seen_keys: HashMap<(String, String), usize> = HashMap::new();

        for scanned in scanned {
            // 身份键用**目录名**：记录的 name 恒为目录名，而 scanned.name 是版本 JSON
            // 的 id，二者漂移时用 name 会导致匹配失败（记录被判残留 → Default 重建 →
            // JVM 设置丢失，issue #244）。
            //
            // `dir_name` 缺失（旧前端）时不能直接回退 `name`：那会在 JSON id 这个键下
            // 新建一条默认记录，同时保留原有的目录名记录，同一版本出现两条（其中一条
            // 设置已被重置）。故先把 `name` 当作 id 反查真实目录名。
            let dir_name = match scanned.dir_name.clone() {
                Some(d) => d,
                None => Self::resolve_dir_name_for_id(&scanned.game_dir, &scanned.name)
                    .unwrap_or_else(|| scanned.name.clone()),
            };
            let key = (scanned.game_dir.clone(), dir_name.clone());

            if let Some(&json_idx) = json_index.get(&key) {
                // JSON 中已有记录，合并（磁盘信息 + JSON 元数据）
                let mut inst = json_instances[json_idx].clone();

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

                // 去重：同 key 只保留一个
                if !seen_keys.contains_key(&key) {
                    seen_keys.insert(key, result.len());
                    result.push(inst);
                }
            } else {
                // JSON 中无记录，从磁盘信息创建新实例
                if !seen_keys.contains_key(&key) {
                    let inst = GameInstance {
                        // name 是版本隔离目录名（路径基座），必须用目录名而非 JSON id；
                        // 用 id 会让记录指向不存在的目录（重装/改名后错位，issue #244）。
                        name: key.1.clone(),
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
                    };
                    seen_keys.insert(key, result.len());
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
            let key = (inst.game_dir.clone(), inst.name.clone());
            // 已在合并段处理过的 key 不再追加（否则宽限期兜底会把同 key 记录
            // 重复写入结果并回存，且每次同步都会累加）。
            if seen_keys.contains_key(&key) {
                continue;
            }
            let dir_exists = std::path::Path::new(&inst.game_dir)
                .join("versions")
                .join(&inst.name)
                .is_dir();
            if scanned_dirs.contains(&inst.game_dir) && !dir_exists {
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
            Self::merge_concurrent_writeback(
                &json_instances,
                &known_ids,
                &names_before_migration,
                &guard,
                &mut result,
            );
            *guard = result.clone();
            drop(guard);
            self.save_to_file();
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
    }

    /// 去重：按 (game_dir, name) 去重，保留字段更完整的记录。
    pub fn dedup_instances(instances: &mut Vec<GameInstance>) {
        let mut seen: HashMap<(String, String), usize> = HashMap::new();
        let mut to_remove = Vec::new();

        for (idx, inst) in instances.iter().enumerate() {
            let key = (inst.game_dir.clone(), inst.name.clone());
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
        service.create(make_instance(
            "Existing",
            game_dir.to_str().unwrap(),
            Some(true),
        ));
        service.create(make_instance(
            "Missing",
            game_dir.to_str().unwrap(),
            Some(true),
        ));
        service.create(make_instance(
            "Shared",
            game_dir.to_str().unwrap(),
            Some(false),
        ));

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
        let inst = service.create(make_instance(
            "1.20.1-Forge-47.1.0",
            game_dir.to_str().unwrap(),
            Some(true),
        ));

        // 模拟 PUT /instance/{id} 改名全流程：重命名目录 → 更新记录
        let mut renamed = service.get_by_id(&inst.id).unwrap();
        service.rename_version_dir(&renamed, "我的服务器").unwrap();
        renamed.name = "我的服务器".to_string();
        service.update(&inst.id, renamed);

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
        let created = service.create(inst);

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
        let created = service.create(inst);
        // 复刻存量记录：没有 createdAt（宽限期豁免不生效）
        {
            let mut cur = service.get_by_id(&created.id).unwrap();
            cur.created_at = None;
            service.update(&created.id, cur);
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
        let created = service.create(inst);
        {
            let mut cur = service.get_by_id(&created.id).unwrap();
            cur.created_at = None;
            service.update(&created.id, cur);
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
        let created = service.create(inst);

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
        let installing = service.create(make_instance(
            "GT New Horizons",
            game_dir.to_str().unwrap(),
            Some(true),
        ));
        assert!(installing.created_at.is_some(), "create 应写入 created_at");

        // 超过宽限期的记录（目录不存在）→ 仍按残留清理
        let mut stale = make_instance("Stale", game_dir.to_str().unwrap(), Some(true));
        stale.created_at = Some(
            (chrono::Utc::now() - MODULE_INSTALLING_GRACE - chrono::Duration::minutes(1))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
        service.create(stale);

        // 同 game_dir 下另一个实例已被扫描命中（目录存在）→ 第 5 步的
        // scanned_dirs 排除不得绕过宽限期（CodeRabbit 评审发现）
        let scanned_dir = game_dir.join("versions").join("Existing");
        std::fs::create_dir_all(&scanned_dir).unwrap();
        service.create(make_instance(
            "Existing",
            game_dir.to_str().unwrap(),
            Some(true),
        ));
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
        let inst = service.create(make_instance(
            "Ghost",
            game_dir.to_str().unwrap(),
            Some(true),
        ));

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

        let inst2 = service.create(make_instance(
            "Ghost",
            game_dir.to_str().unwrap(),
            Some(true),
        ));
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
}
