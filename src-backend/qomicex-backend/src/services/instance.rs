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
    pub skip_integrity_check: bool,
    // 对应 C# [JsonIgnore(WhenWritingNull)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_game_dir: Option<String>,
    /// 所属自定义分组 id 列表（多对多，引用 groups.json）。
    #[serde(default)]
    pub custom_group_ids: Vec<String>,
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
            skip_integrity_check: false,
            resolved_game_dir: None,
            custom_group_ids: Vec::new(),
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

    fn save_to_file(&self) {
        let guard = match self.instances.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&*guard) {
            let _ = std::fs::write(&self.file_path, json);
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

    pub fn delete(&self, id: &str) -> Option<GameInstance> {
        let mut default_guard = self.default_id.lock().unwrap_or_else(|p| p.into_inner());
        if default_guard.as_deref() == Some(id) {
            *default_guard = None;
        }
        drop(default_guard);

        let mut guard = self.instances.lock().unwrap_or_else(|p| p.into_inner());
        let instance = guard.iter().find(|i| i.id == id).cloned();
        let instance = instance?;
        guard.retain(|i| i.id != id);
        drop(guard);
        self.save_to_file();

        // 删除版本隔离目录 {gameDir}/versions/{name}
        let version_dir = std::path::Path::new(&instance.game_dir)
            .join("versions")
            .join(&instance.name);
        if version_dir.is_dir() {
            let _ = std::fs::remove_dir_all(&version_dir);
        }

        // 使该 game_dir 的扫描缓存失效
        self.invalidate_scan_cache(&instance.game_dir);

        Some(instance)
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

        // 1. 清理残留：版本隔离开启 + 版本目录不存在 → 删除记录
        json_instances.retain(|inst| {
            let isolation = inst.version_isolation.unwrap_or(global_isolation);
            if !isolation {
                return true;
            }
            std::path::Path::new(&inst.game_dir)
                .join("versions")
                .join(&inst.name)
                .is_dir()
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
            let key = (scanned.game_dir.clone(), scanned.name.clone());

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
                        name: scanned.name.clone(),
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
        for inst in &json_instances {
            let key = (inst.game_dir.clone(), inst.name.clone());
            if !seen_keys.contains_key(&key) && !scanned_dirs.contains(&inst.game_dir) {
                seen_keys.insert(key, result.len());
                result.push(inst.clone());
            }
        }

        // 6. 写回 JSON
        {
            let mut guard = match self.instances.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            *guard = result.clone();
            drop(guard);
            self.save_to_file();
        }

        result
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
}
