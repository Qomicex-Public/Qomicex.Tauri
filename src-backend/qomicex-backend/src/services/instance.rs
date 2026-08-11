//! 游戏实例模型与实例服务（对应源 Models/GameInstance.cs + Services/InstanceService.cs）。

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
        }
    }
}

/// 生成 12 位十六进制短 id（对应 C# `Guid.NewGuid().ToString("N")[..12]`）。
fn new_short_id() -> String {
    let full = format!("{:x}", uuid::Uuid::new_v4());
    full[..12].to_string()
}

/// 实例服务（对应 C# InstanceService）。
pub struct InstanceService {
    file_path: PathBuf,
    instances: Mutex<Vec<GameInstance>>,
    default_id: Mutex<Option<String>>,
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
