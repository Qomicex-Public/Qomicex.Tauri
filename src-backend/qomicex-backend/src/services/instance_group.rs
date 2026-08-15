//! 实例自定义分组服务（独立 groups.json 持久化）。
//!
//! 分组定义 `{id, name, color}` 存 `{BaseDir}/data/groups.json`；
//! 实例通过 `GameInstance.custom_group_ids`（string[]）多对多引用分组 id。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::settings;

/// 实例自定义分组（全部 camelCase）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceGroup {
    pub id: String,
    pub name: String,
    /// 徽章颜色（CSS 色值，如 `#22c55e`）。
    pub color: String,
}

/// 实例分组服务（独立 groups.json，与 InstanceService 解耦）。
pub struct InstanceGroupService {
    file_path: PathBuf,
    groups: Mutex<Vec<InstanceGroup>>,
}

impl InstanceGroupService {
    pub fn new() -> Self {
        let data_dir = settings::resolve_base_dir().join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("groups.json");
        let groups = load_from_file(&file_path);
        Self {
            file_path,
            groups: Mutex::new(groups),
        }
    }

    fn save_to_file(&self) {
        let guard = match self.groups.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&*guard) {
            let _ = std::fs::write(&self.file_path, json);
        }
    }

    pub fn get_all(&self) -> Vec<InstanceGroup> {
        match self.groups.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }

    pub fn get_by_id(&self, id: &str) -> Option<InstanceGroup> {
        match self.groups.lock() {
            Ok(g) => g.iter().find(|x| x.id == id).cloned(),
            Err(p) => p.into_inner().iter().find(|x| x.id == id).cloned(),
        }
    }

    /// 创建分组；name 重复时返回 `None`（前端提示）。
    pub fn create(&self, name: String, color: String) -> Option<InstanceGroup> {
        let mut guard = self.groups.lock().unwrap_or_else(|p| p.into_inner());
        if guard.iter().any(|g| g.name.eq_ignore_ascii_case(&name)) {
            return None;
        }
        let group = InstanceGroup {
            id: new_short_id(),
            name,
            color,
        };
        guard.push(group.clone());
        drop(guard);
        self.save_to_file();
        Some(group)
    }

    /// 重命名/改色；name 与其他分组冲突时返回 `None`。
    pub fn update(&self, id: &str, name: String, color: String) -> Option<InstanceGroup> {
        let mut guard = self.groups.lock().unwrap_or_else(|p| p.into_inner());
        let index = guard.iter().position(|g| g.id == id)?;
        if guard
            .iter()
            .enumerate()
            .any(|(i, g)| i != index && g.name.eq_ignore_ascii_case(&name))
        {
            return None;
        }
        guard[index].name = name;
        guard[index].color = color;
        let group = guard[index].clone();
        drop(guard);
        self.save_to_file();
        Some(group)
    }

    pub fn delete(&self, id: &str) -> Option<InstanceGroup> {
        let mut guard = self.groups.lock().unwrap_or_else(|p| p.into_inner());
        let group = guard.iter().find(|g| g.id == id).cloned()?;
        guard.retain(|g| g.id != id);
        drop(guard);
        self.save_to_file();
        Some(group)
    }
}

/// 生成 12 位十六进制短 id（与 InstanceService 一致）。
fn new_short_id() -> String {
    let full = format!("{:x}", uuid::Uuid::new_v4());
    full[..12].to_string()
}

fn load_from_file(file_path: &PathBuf) -> Vec<InstanceGroup> {
    if file_path.exists() {
        if let Ok(content) = std::fs::read_to_string(file_path) {
            if let Ok(list) = serde_json::from_str::<Vec<InstanceGroup>>(&content) {
                return list;
            }
        }
    }
    Vec::new()
}
