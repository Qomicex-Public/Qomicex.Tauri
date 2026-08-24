//! Plugin domain services (source: Services/PluginStore.cs, PluginPackageService.cs,
//! FileAuthService.cs, PluginVersion.cs, PluginGatewayClient.cs + Models/PluginManifest.cs).
//!
//! Data layout (BaseDir = settings::resolve_base_dir()):
//!   BaseDir/plugins/{pluginId}/manifest.json + dist/... (one dir per plugin)
//!   BaseDir/plugin-states.json            { pluginId: state }
//!   BaseDir/plugin-fs-auth.json           { pluginId: [ granted path prefix, ... ] }
//!   BaseDir/plugins/.gateway_port         Rust WASM gateway listening port

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::settings;

// =====================================================================
// Models (camelCase; mirror of Models/PluginManifest.cs)
// =====================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub min_launcher_version: String,
    #[serde(default)]
    pub layers: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<PluginDependency>,
    #[serde(default)]
    pub entry: PluginEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<PluginContributes>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDependency {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_sources: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_pages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu_items: Option<Vec<PluginMenuItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay: Option<PluginOverlayConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMenuItem {
    pub path: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOverlayConfig {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimizable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resizable: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub dir: String,
    pub state: String,
    pub installed_at: String,
}

// =====================================================================
// SemVer-ish comparison (source: Services/PluginVersion.cs)
// =====================================================================

pub fn version_satisfies(installed: &str, range: Option<&str>) -> bool {
    let range = match range {
        Some(r) => r,
        None => return true,
    };
    if range.trim().is_empty() {
        return true;
    }
    range
        .split(' ')
        .filter(|p| !p.trim().is_empty())
        .all(|part| version_satisfies_single(installed, part.trim()))
}

fn version_satisfies_single(installed: &str, constraint: &str) -> bool {
    if let Some(rest) = constraint.strip_prefix(">=") {
        return version_compare(installed, rest.trim()) >= 0;
    }
    if let Some(rest) = constraint.strip_prefix("<=") {
        return version_compare(installed, rest.trim()) <= 0;
    }
    if let Some(rest) = constraint.strip_prefix('>') {
        return version_compare(installed, rest.trim()) > 0;
    }
    if let Some(rest) = constraint.strip_prefix('<') {
        return version_compare(installed, rest.trim()) < 0;
    }
    if let Some(rest) = constraint.strip_prefix('=') {
        return version_compare(installed, rest.trim()) == 0;
    }
    version_compare(installed, constraint) == 0
}

fn version_compare(a: &str, b: &str) -> i32 {
    let pa = version_parse(a);
    let pb = version_parse(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va != vb {
            return if va < vb { -1 } else { 1 };
        }
    }
    0
}

/// Parse `1.20.1-beta+2` into numeric segments (stop at the first non-numeric
/// segment; empty result falls back to [0], matching the C# parser).
fn version_parse(version: &str) -> Vec<i32> {
    let cleaned = version
        .trim()
        .split('-')
        .next()
        .unwrap_or("")
        .split('+')
        .next()
        .unwrap_or("");
    let mut nums = Vec::new();
    for seg in cleaned.split('.') {
        match seg.parse::<i32>() {
            Ok(n) => nums.push(n),
            Err(_) => break,
        }
    }
    if nums.is_empty() {
        nums.push(0);
    }
    nums
}

// =====================================================================
// PluginStore
// =====================================================================

pub struct PluginStore {
    plugins_dir: PathBuf,
    states_file: PathBuf,
    cache: Mutex<Option<Vec<PluginInfo>>>,
    states_cache: Mutex<Option<HashMap<String, String>>>,
}

impl PluginStore {
    pub fn new() -> Self {
        let plugins_dir = settings::plugins_dir();
        let states_file = settings::resolve_base_dir().join("plugin-states.json");
        let _ = std::fs::create_dir_all(&plugins_dir);
        Self {
            plugins_dir,
            states_file,
            cache: Mutex::new(None),
            states_cache: Mutex::new(None),
        }
    }

    pub fn list_plugins(&self) -> Vec<PluginInfo> {
        let mut guard = match self.cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(cached) = &*guard {
            return cached.clone();
        }
        let scanned = self.scan_plugins();
        *guard = Some(scanned.clone());
        scanned
    }

    pub fn get_plugin(&self, id: &str) -> Option<PluginInfo> {
        self.list_plugins()
            .into_iter()
            .find(|p| p.manifest.id == id)
    }

    pub fn invalidate_cache(&self) {
        if let Ok(mut g) = self.cache.lock() {
            *g = None;
        }
    }

    /// Install from an already-extracted source directory (`POST /install`).
    /// Returns `Ok(None)` when the source has no manifest.json (=> invalid
    /// package). Missing mandatory dependencies raise PLUGIN_MISSING_DEPENDENCY.
    pub fn install_from_dir(&self, source_dir: &Path) -> Result<Option<PluginInfo>, ApiError> {
        let manifest_path = source_dir.join("manifest.json");
        if !manifest_path.is_file() {
            return Ok(None);
        }
        let json = std::fs::read_to_string(&manifest_path)?;
        let manifest: PluginManifest = serde_json::from_str(&json)
            .map_err(|e| ApiError::bad_request("INVALID_PLUGIN_MANIFEST", e.to_string()))?;

        let missing = self.resolve_missing_dependencies(&manifest);
        if !missing.is_empty() {
            let names = missing
                .iter()
                .map(|d| {
                    format!(
                        "{}({})",
                        d.id,
                        d.version.clone().unwrap_or_else(|| "任意".into())
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(ApiError::bad_request(
                "PLUGIN_MISSING_DEPENDENCY",
                format!("缺少必装前置插件: {names}"),
            ));
        }

        let target = self.plugins_dir.join(&manifest.id);
        if target.is_dir() {
            let _ = std::fs::remove_dir_all(&target);
        }
        copy_dir_recursive(source_dir, &target)?;

        self.invalidate_cache();
        Ok(Some(PluginInfo {
            manifest,
            dir: target.to_string_lossy().into_owned(),
            state: "installed".to_string(),
            installed_at: now_o(),
        }))
    }

    /// The dependencies that are missing / version-unsatisfied (optional skipped).
    pub fn resolve_missing_dependencies(&self, manifest: &PluginManifest) -> Vec<PluginDependency> {
        let installed = self.list_plugins();
        let mut missing = Vec::new();
        for dep in &manifest.dependencies {
            if dep.optional {
                continue;
            }
            let existing = installed.iter().find(|p| p.manifest.id == dep.id);
            let ok = existing
                .map(|p| version_satisfies(&p.manifest.version, dep.version.as_deref()))
                .unwrap_or(false);
            if !ok {
                missing.push(dep.clone());
            }
        }
        missing
    }

    pub fn set_state(&self, id: &str, state: &str) {
        let mut states = {
            let mut g = match self.states_cache.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if g.is_none() {
                *g = Some(load_string_map(&self.states_file));
            }
            g.clone().unwrap_or_default()
        };
        states.insert(id.to_string(), state.to_string());
        if let Ok(f) = std::fs::File::create(&self.states_file) {
            let _ = serde_json::to_writer(std::io::BufWriter::new(f), &states);
        }
        if let Ok(mut g) = self.states_cache.lock() {
            *g = Some(states);
        }
        self.invalidate_cache();
    }

    pub fn uninstall(&self, id: &str) {
        let dir = self.plugins_dir.join(id);
        if dir.is_dir() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        let mut states = {
            let mut g = match self.states_cache.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if g.is_none() {
                *g = Some(load_string_map(&self.states_file));
            }
            g.clone().unwrap_or_default()
        };
        states.remove(id);
        if let Ok(f) = std::fs::File::create(&self.states_file) {
            let _ = serde_json::to_writer(std::io::BufWriter::new(f), &states);
        }
        if let Ok(mut g) = self.states_cache.lock() {
            *g = Some(states);
        }
        self.invalidate_cache();
    }

    fn scan_plugins(&self) -> Vec<PluginInfo> {
        let mut result = Vec::new();
        if !self.plugins_dir.is_dir() {
            return result;
        }
        let states = load_string_map(&self.states_file);
        let entries = match std::fs::read_dir(&self.plugins_dir) {
            Ok(e) => e,
            Err(_) => return result,
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let manifest_path = dir.join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            let json = match std::fs::read_to_string(&manifest_path) {
                Ok(j) => j,
                Err(_) => continue,
            };
            let manifest: PluginManifest = match serde_json::from_str(&json) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let state = states
                .get(&manifest.id)
                .cloned()
                .unwrap_or_else(|| "installed".to_string());
            let installed_at = std::fs::metadata(&dir)
                .ok()
                .and_then(|m| m.created().ok())
                .map(created_time_o)
                .unwrap_or_else(|| now_o());
            result.push(PluginInfo {
                manifest,
                dir: dir.to_string_lossy().into_owned(),
                state,
                installed_at,
            });
        }
        let mut g = match self.states_cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        *g = Some(states);
        result
    }
}

/// Install a .qplugin/.zip package from raw bytes (`POST /upload`). The package
/// is extracted into a same-volume temp dir then atomically moved over the
/// target plugin dir. Returns `Ok(None)` for an invalid package.
pub fn install_from_package(package_bytes: &[u8]) -> Result<Option<PluginInfo>, ApiError> {
    let plugins_dir = settings::plugins_dir();
    let _ = std::fs::create_dir_all(&plugins_dir);

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package_bytes))
        .map_err(|_| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "Invalid plugin package"))?;

    let mut manifest: PluginManifest = {
        let mut reader = match archive.by_name("manifest.json") {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        let mut json = String::new();
        std::io::Read::read_to_string(&mut reader, &mut json)
            .map_err(|e| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", e.to_string()))?;
        serde_json::from_str(&json)
            .map_err(|e| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", e.to_string()))?
    };
    manifest.id = manifest.id.trim().to_string();

    // manifest.id 会被用作文件系统路径（安装目录名），必须先做格式校验，
    // 拒绝路径穿越（../、绝对路径、盘符、隐藏分隔）等恶意 ID。
    {
        let id = &manifest.id;
        let safe = !id.is_empty()
            && id.len() <= 128
            && !id.contains("..")
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
        if !safe {
            return Err(ApiError::bad_request(
                "INVALID_PLUGIN_PACKAGE",
                format!("非法的插件 ID: \"{id}\""),
            ));
        }
    }

    let target_dir = plugins_dir.join(&manifest.id);
    let temp_dir = plugins_dir.join(format!(
        ".{}.tmp-{}",
        manifest.id,
        uuid::Uuid::new_v4().simple()
    ));
    let mut moved = false;
    let result = (|| -> Result<(), ApiError> {
        let _ = std::fs::create_dir_all(&temp_dir);
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", e.to_string()))?;
            if entry.is_dir() {
                continue;
            }
            // Guard against zip-slip: reject entries escaping the temp root.
            let rel: PathBuf = PathBuf::from(entry.name());
            if !rel.is_relative()
                || rel
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                continue;
            }
            let out_path = temp_dir.join(&rel);
            if let Some(parent) = out_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let mut out = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
        }
        delete_recursively_with_retry(&target_dir)?;
        std::fs::rename(&temp_dir, &target_dir)?;
        moved = true;
        Ok(())
    })();

    if result.is_err() && !moved {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    result?;

    Ok(Some(PluginInfo {
        manifest,
        dir: target_dir.to_string_lossy().into_owned(),
        state: "installed".to_string(),
        installed_at: now_o(),
    }))
}

fn delete_recursively_with_retry(dir: &Path) -> Result<(), ApiError> {
    if !dir.exists() {
        return Ok(());
    }
    let mut attempt = 0;
    loop {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 4 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(200 * attempt as u64));
            }
            Err(e) => return Err(ApiError::internal(e.to_string())),
        }
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), ApiError> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            let _ = std::fs::create_dir_all(to.parent().unwrap_or(target));
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn load_string_map(path: &Path) -> HashMap<String, String> {
    if path.is_file() {
        if let Ok(json) = std::fs::read_to_string(path) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&json) {
                return map;
            }
        }
    }
    HashMap::new()
}

fn now_o() -> String {
    use chrono::SecondsFormat;
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true)
}

/// Format a `SystemTime` in ISO-8601 UTC (the C# "O" round-trip format).
fn created_time_o(t: std::time::SystemTime) -> String {
    use chrono::SecondsFormat;
    let dur = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let dt =
        chrono::DateTime::<chrono::Utc>::from_timestamp(dur.as_secs() as i64, dur.subsec_nanos())
            .unwrap_or_default();
    dt.to_rfc3339_opts(SecondsFormat::Micros, true)
}

// =====================================================================
// FileAuthService
// =====================================================================

/// Per-plugin filesystem authorization. Persisted to
/// `{BaseDir}/plugin-fs-auth.json` as `{ pluginId: [ granted path, ... ] }`.
/// A grant covers the exact path plus everything beneath it (prefix match).
pub struct FileAuthService {
    auth_file: PathBuf,
    cache: Mutex<Option<HashMap<String, Vec<String>>>>,
}

impl FileAuthService {
    pub fn new() -> Self {
        let auth_file = settings::resolve_base_dir().join("plugin-fs-auth.json");
        Self {
            auth_file,
            cache: Mutex::new(None),
        }
    }

    /// Normalize to an absolute path (expand relative paths, drop `.`/`..`).
    /// Returns None for blank or unnormalizable input.
    pub fn normalize_path(path: &str) -> Option<PathBuf> {
        if path.trim().is_empty() {
            return None;
        }
        let abs = std::path::absolute(path).ok()?;
        let mut out = PathBuf::new();
        for comp in abs.components() {
            match comp {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                c => out.push(c.as_os_str()),
            }
        }
        if out.as_os_str().is_empty() {
            None
        } else {
            Some(out)
        }
    }

    /// Return the granted prefix covering `path`, or None when unauthorized.
    pub fn find_grant(&self, plugin_id: &str, path: &str) -> Option<String> {
        let normalized = Self::normalize_path(path)?;
        let grants = {
            let mut g = match self.cache.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if g.is_none() {
                *g = Some(load_auth_map(&self.auth_file));
            }
            g.clone().unwrap_or_default()
        };
        for granted in grants.get(plugin_id).unwrap_or(&Vec::new()) {
            if let Some(gn) = Self::normalize_path(granted) {
                if covers(&normalized, &gn) {
                    return Some(granted.clone());
                }
            }
        }
        None
    }

    pub fn grant(&self, plugin_id: &str, path: &str) {
        let Some(normalized) = Self::normalize_path(path) else {
            return;
        };
        let normalized = normalized.to_string_lossy().into_owned();
        let mut g = match self.cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let map = g.get_or_insert_with(|| load_auth_map(&self.auth_file));
        let grants = map.entry(plugin_id.to_string()).or_default();
        let exists = grants.iter().any(|existing| {
            Self::normalize_path(existing)
                .map(|e| e.to_string_lossy() == normalized)
                .unwrap_or(false)
        });
        if !exists {
            grants.push(normalized);
            save_auth_map(&self.auth_file, map);
        }
    }

    pub fn revoke(&self, plugin_id: &str, path: &str) {
        let Some(normalized) = Self::normalize_path(path) else {
            return;
        };
        let normalized = normalized.to_string_lossy().into_owned();
        let mut g = match self.cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let map = g.get_or_insert_with(|| load_auth_map(&self.auth_file));
        if let Some(grants) = map.get_mut(plugin_id) {
            grants.retain(|existing| {
                Self::normalize_path(existing)
                    .map(|e| e.to_string_lossy() != normalized)
                    .unwrap_or(true)
            });
            if grants.is_empty() {
                map.remove(plugin_id);
            }
            save_auth_map(&self.auth_file, map);
        }
    }
}

fn load_auth_map(path: &Path) -> HashMap<String, Vec<String>> {
    if path.is_file() {
        if let Ok(json) = std::fs::read_to_string(path) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, Vec<String>>>(&json) {
                return map;
            }
        }
    }
    HashMap::new()
}

fn save_auth_map(path: &Path, map: &HashMap<String, Vec<String>>) {
    if let Ok(f) = std::fs::File::create(path) {
        let _ = serde_json::to_writer(std::io::BufWriter::new(f), map);
    }
}

/// Directory-prefix coverage. `target` is covered when it equals `granted` or
/// sits under it. Component-based so `C:\a\b.txt` is covered by `C:\a`.
fn covers(target: &Path, granted: &Path) -> bool {
    target == granted || target.starts_with(granted)
}

// =====================================================================
// PluginGatewayClient (WASM gateway bridge, source: PluginGatewayClient.cs)
// =====================================================================

/// Bridges the Tauri WASM gateway (`src-tauri/src/plugin_gateway`). The
/// gateway writes its listening port to `plugins/.gateway_port` as plain text.
pub struct PluginGatewayClient {
    http: reqwest::Client,
    port_file: PathBuf,
}

impl PluginGatewayClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            port_file: settings::plugins_dir().join(".gateway_port"),
        }
    }

    fn gateway_url(&self) -> Option<String> {
        let port = std::fs::read_to_string(&self.port_file).ok()?;
        let port = port.trim();
        if port.is_empty() {
            return None;
        }
        Some(format!("http://127.0.0.1:{port}"))
    }

    pub async fn loaded_plugins(&self) -> Vec<String> {
        let Some(base) = self.gateway_url() else {
            return Vec::new();
        };
        let Ok(resp) = self.http.get(format!("{base}/plugins")).send().await else {
            return Vec::new();
        };
        let Ok(json) = resp.json::<serde_json::Value>().await else {
            return Vec::new();
        };
        json.get("plugins")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn plugin_info(&self, id: &str) -> Option<serde_json::Value> {
        let base = self.gateway_url()?;
        let encoded = urlencoding::encode(id);
        let resp = self
            .http
            .get(format!("{base}/plugins/{encoded}/info"))
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<serde_json::Value>().await.ok()
    }

    pub async fn invoke(&self, id: &str, export: &str) -> Option<serde_json::Value> {
        let base = self.gateway_url()?;
        let encoded = urlencoding::encode(id);
        let body = serde_json::json!({ "export": export });
        let resp = self
            .http
            .post(format!("{base}/plugins/{encoded}/invoke"))
            .json(&body)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<serde_json::Value>().await.ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造内存中的最小 .qplugin 包（仅根级 manifest.json）。
    fn minimal_package(manifest_json: &str) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::SimpleFileOptions = Default::default();
            zip.start_file("manifest.json", opts).unwrap();
            std::io::Write::write_all(&mut zip, manifest_json.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn install_rejects_path_traversal_id() {
        let pkg = minimal_package(r#"{"id":"../../evil","name":"x","version":"1.0.0"}"#);
        let err = install_from_package(&pkg).unwrap_err();
        assert_eq!(err.code, "INVALID_PLUGIN_PACKAGE");
        assert!(err.message.contains("非法的插件 ID"));
    }

    #[test]
    fn install_rejects_empty_and_absolute_ids() {
        for id in ["", "C:\\Windows\\Temp", "/etc/passwd", "a..b"] {
            let manifest = format!(r#"{{"id":"{id}","name":"x","version":"1.0.0"}}"#);
            let pkg = minimal_package(&manifest);
            let err = install_from_package(&pkg).unwrap_err();
            assert_eq!(err.code, "INVALID_PLUGIN_PACKAGE", "id={id}");
        }
    }

    #[test]
    fn install_accepts_safe_id() {
        let pkg = minimal_package(
            r#"{"id":"com.qomicex.demo","name":"x","version":"1.0.0","entry":{},"layers":["l2"],"permissions":[]}"#,
        );
        // 依赖预检：无依赖 → 应安装成功
        let info = install_from_package(&pkg).unwrap().unwrap();
        assert_eq!(info.manifest.id, "com.qomicex.demo");
        // 清理安装产物
        crate::services::plugin::PluginStore::new().uninstall("com.qomicex.demo");
    }
}
