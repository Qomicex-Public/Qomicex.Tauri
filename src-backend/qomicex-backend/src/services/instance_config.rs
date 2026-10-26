// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 实例独立配置：`{gameDir}/versions/{name}/qomicex.json`。
//!
//! 读取按**键**合并：独立文件中的键优先，缺失/null/空串逐项回退到
//! `data/instances.json`。写入同样按键进行——修改/重置一个设置只改对应键，
//! 不得整对象覆盖，否则重置内存会把 JVM 参数等无关设置一起带走。
//!
//! 账号令牌、图标 base64、派生路径不落独立文件：前者是秘密，后者可重建/会膨胀。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::{Map, Value};

use crate::services::instance::GameInstance;
use crate::settings;

pub const CONFIG_FILE: &str = "qomicex.json";

/// 串行化独立配置的「读-改-写」，避免 read/heal 与按键增量写入交错，
/// 把刚重置的值又被另一线程的旧快照盖回去。
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn config_guard() -> MutexGuard<'static, ()> {
    CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// 允许进入独立文件的键（camelCase）。不含 `accessToken` / `account*` /
/// `iconData` / `gameDir` / `resolvedGameDir` / `isDefault`。
const ALLOWED_KEYS: &[&str] = &[
    "id",
    "name",
    "gameVersion",
    "loader",
    "loaderVersion",
    "javaPath",
    "maxMemory",
    "jvmArgs",
    "isHidden",
    "versionIsolation",
    "modpackName",
    "modpackVersion",
    "modpackAuthor",
    "modpackSummary",
    "modpackSource",
    "modpackProjectId",
    "modpackVersionId",
    "modpackOrigin",
    "modpackVersionPublishedAt",
    "skipIntegrityCheck",
    "customGroupIds",
    "remark",
];

/// 身份键：即使等于结构体默认值也要写入，用于从独立文件重建实例。
const IDENTITY_KEYS: &[&str] = &["id", "name", "gameVersion"];

/// 随 Qomicex 整合包导出的设置子集。绝对路径（javaPath）、组 id、游玩统计
/// 属于本机环境，不进包；`jvmArgs` 是整合包能正常启动的关键，保留。
const EXPORT_KEYS: &[&str] = &[
    "maxMemory",
    "jvmArgs",
    "versionIsolation",
    "skipIntegrityCheck",
];

/// 导入包只采纳导出格式里的这些键。`javaPath` 等本机字段绝不能由包决定，
/// 否则恶意整合包可以让启动器执行任意可执行文件。
pub const IMPORT_KEYS: &[&str] = EXPORT_KEYS;

/// 独立配置是启动器元数据，正常只有几 KB。上限用于阻断恶意压缩包/损坏文件
/// 在导入或读取时把启动器内存打满。
pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

fn is_allowed(key: &str) -> bool {
    ALLOWED_KEYS.contains(&key)
}

/// 实例名同时是版本目录名（单一路径组件）。拒绝空名、分隔符、`.`/`..`、
/// Windows 盘符/ADS 冒号、尾随空格/点与保留设备名，避免配置路径逃逸
/// `versions/` 目录。
pub fn is_safe_instance_name(name: &str) -> bool {
    if name.is_empty() || name.trim() != name || name == "." || name == ".." {
        return false;
    }
    if name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0'))
        || name.ends_with(' ')
        || name.ends_with('.')
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return false;
    }
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

/// `gameDir` 可为相对路径；与 `rename_version_dir` 一致，以 `QOMICEX_HOME`
/// / 启动器数据目录为基座解析。
pub fn resolve_game_root(game_dir: &str) -> PathBuf {
    let root = Path::new(game_dir);
    if root.is_absolute() {
        root.to_path_buf()
    } else {
        settings::resolve_base_dir().join(root)
    }
}

/// 「空」= null / 空白字符串 / 空数组。空值不参与覆盖，按项回退。
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// 实例版本目录（`gameDir` 可为相对路径，与 `rename_version_dir` 同口径解析）。
/// 名称非法时返回 `None`，调用方不得退化成未校验的路径拼接。
pub fn version_dir(game_dir: &str, name: &str) -> Option<PathBuf> {
    if !is_safe_instance_name(name) {
        return None;
    }
    Some(resolve_game_root(game_dir).join("versions").join(name))
}

fn config_path(game_dir: &str, name: &str) -> Option<PathBuf> {
    Some(version_dir(game_dir, name)?.join(CONFIG_FILE))
}

/// 实例当前可落盘的完整快照（过滤不允许键与空值）。
fn snapshot(inst: &GameInstance) -> Map<String, Value> {
    match serde_json::to_value(inst) {
        Ok(Value::Object(obj)) => obj
            .into_iter()
            .filter(|(k, v)| is_allowed(k) && !is_blank(v))
            .collect(),
        _ => Map::new(),
    }
}

/// 只接受导出格式里的安全键；`javaPath`/账号/身份字段即使出现在包里也丢弃。
/// 调用方在写导入配置前必须经过这里。
pub fn sanitize_import_map(value: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = value.as_object() else {
        return out;
    };
    for key in IMPORT_KEYS {
        let Some(value) = obj.get(*key) else {
            continue;
        };
        if is_blank(value) {
            continue;
        }
        let valid = match *key {
            "maxMemory" => value
                .as_i64()
                .is_some_and(|n| n > 0 && i32::try_from(n).is_ok()),
            "jvmArgs" => value.is_string(),
            "versionIsolation" | "skipIntegrityCheck" => value.is_boolean(),
            _ => false,
        };
        if valid {
            out.insert((*key).to_string(), value.clone());
        }
    }
    out
}

fn read_raw(path: &Path) -> Option<Map<String, Value>> {
    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_CONFIG_BYTES {
        tracing::warn!(
            path = %path.display(),
            len,
            "实例独立配置超过大小上限，按损坏文件处理"
        );
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.as_object().cloned()
}

/// 把独立文件逐键叠加到 `base` 上。任一值类型非法 → 整份视为损坏，
/// 由调用方按 base 重写（逐键的缺失/空值仍然照常回退）。
fn merge_raw(base: &GameInstance, raw: &Map<String, Value>) -> Option<GameInstance> {
    // 从**完整** base 开始（含 gameDir 等不落独立文件的字段），只把文件里的
    // 允许键叠上去；否则 deserialize 会让被过滤掉的身份字段回落成默认空串。
    let mut obj = match serde_json::to_value(base) {
        Ok(Value::Object(obj)) => obj,
        _ => return None,
    };
    for (key, value) in raw {
        if is_allowed(key) && !is_blank(value) {
            obj.insert(key.clone(), value.clone());
        }
    }
    match serde_json::from_value::<GameInstance>(Value::Object(obj)) {
        Ok(inst) => Some(inst),
        Err(e) => {
            tracing::warn!(error = %e, "qomicex.json 含非法字段，按 instances.json 回退并重写");
            None
        }
    }
}

/// 计算写回内容：保留独立文件里已有的非空键，缺失/空值只补「非默认」的回退值。
fn heal_map(raw: &Map<String, Value>, merged: &GameInstance) -> Map<String, Value> {
    let default = snapshot(&GameInstance::default());
    let merged_map = snapshot(merged);
    let mut out: Map<String, Value> = raw
        .iter()
        .filter(|(k, v)| is_allowed(k) && !is_blank(v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // 身份键以合并结果为准：配置文件可能带着别的启动器/复制目录的旧 id，
    // 必须修正，否则 instances.json 丢失后会恢复出重复 id。
    for key in IDENTITY_KEYS {
        match merged_map.get(*key) {
            Some(value) if !is_blank(value) => {
                out.insert((*key).to_string(), value.clone());
            }
            _ => {
                out.remove(*key);
            }
        }
    }
    for (key, value) in merged_map {
        if out.contains_key(&key) {
            continue;
        }
        let identity = IDENTITY_KEYS.contains(&key.as_str());
        if identity || default.get(&key) != Some(&value) {
            out.insert(key, value);
        }
    }
    out
}

/// 写入独立配置。`Ok(false)` 表示版本目录不存在（只保留镜像），
/// `Err` 表示路径存在但写入失败——调用方必须让本次更新失败，不能假装成功。
fn write_map(path: &Path, map: &Map<String, Value>) -> Result<bool, String> {
    if !path.parent().is_some_and(Path::is_dir) {
        return Ok(false);
    }
    let json = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|e| format!("序列化实例独立配置失败: {e}"))?;
    if std::fs::read_to_string(path)
        .ok()
        .is_some_and(|existing| existing == json)
    {
        return Ok(true);
    }
    let tmp = path.with_file_name(format!("{CONFIG_FILE}.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, &json).is_ok() && std::fs::rename(&tmp, path).is_ok() {
        return Ok(true);
    }
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(path, &json)
        .map_err(|e| format!("写入实例独立配置失败 {}: {e}", path.display()))?;
    Ok(true)
}

/// 读取 + 按项回退 + 把回退到的非默认值写回独立文件。
///
/// 读路径调用（列表/启动/详情），因此损坏文件也会在这里被修复。
pub fn load(inst: &GameInstance) -> GameInstance {
    let _guard = config_guard();
    let Some(path) = config_path(&inst.game_dir, &inst.name) else {
        return inst.clone();
    };
    let raw = read_raw(&path);
    let (mut merged, valid_raw) = match raw.as_ref() {
        Some(r) => match merge_raw(inst, r) {
            Some(m) => (m, Some(r)),
            // 文件损坏：整份按统一记录回退并重写，坏键不能留在文件里。
            None => (inst.clone(), None),
        },
        None => (inst.clone(), None),
    };
    // 身份字段始终以记录为准：配置文件可能来自整合包或另一个启动器，
    // 不能让它改掉实例 id（default/running 引用会错位）或指向别的目录。
    merged.id = inst.id.clone();
    merged.name = inst.name.clone();
    merged.game_dir = inst.game_dir.clone();
    if path.parent().is_some_and(Path::is_dir) {
        let healed = heal_map(valid_raw.unwrap_or(&Map::new()), &merged);
        if let Err(e) = write_map(&path, &healed) {
            tracing::warn!(error = %e, "回写实例独立配置失败");
        }
    }
    merged
}

/// 从独立文件重建实例（`instances.json` 丢失/扫描新建记录时）。
/// 返回 `None` 表示没有可读配置；文件存在但为空对象也会返回默认实例 + 随机 id。
pub fn load_for_dir(game_dir: &str, name: &str) -> Option<GameInstance> {
    if !is_safe_instance_name(name) {
        return None;
    }
    let _guard = config_guard();
    let raw = read_raw(&config_path(game_dir, name)?)?;
    let base = GameInstance {
        name: name.to_string(),
        game_dir: game_dir.to_string(),
        ..Default::default()
    };
    let mut inst = merge_raw(&base, &raw)?;
    // 目录名是身份键，文件里的 name 可能是改名前的旧值。
    inst.name = name.to_string();
    inst.game_dir = game_dir.to_string();
    Some(inst)
}

/// 新建实例时采纳已存在的独立配置（配置优先），但保留本次创建的 id/name/gameDir。
pub fn adopt(inst: &GameInstance) -> Option<GameInstance> {
    if !is_safe_instance_name(&inst.name) {
        return None;
    }
    let _guard = config_guard();
    let raw = read_raw(&config_path(&inst.game_dir, &inst.name)?)?;
    let mut merged = merge_raw(inst, &raw)?;
    merged.id = inst.id.clone();
    merged.name = inst.name.clone();
    merged.game_dir = inst.game_dir.clone();
    Some(merged)
}

/// 写完整快照（新建实例 / 独立文件缺失时的一次性迁移）。
pub fn write_full(inst: &GameInstance) -> Result<bool, String> {
    let _guard = config_guard();
    let Some(dir) = version_dir(&inst.game_dir, &inst.name) else {
        return Ok(false);
    };
    if !dir.is_dir() {
        return Ok(false);
    }
    write_map(&dir.join(CONFIG_FILE), &snapshot(inst))
}

/// 仅当独立文件不存在时写完整快照。
pub fn ensure_full(inst: &GameInstance) {
    let _guard = config_guard();
    let Some(dir) = version_dir(&inst.game_dir, &inst.name) else {
        return;
    };
    if dir.is_dir() && !dir.join(CONFIG_FILE).is_file() {
        if let Err(e) = write_map(&dir.join(CONFIG_FILE), &snapshot(inst)) {
            tracing::warn!(error = %e, "补写实例独立配置失败");
        }
    }
}

/// 保存设置时的**按键增量**写入：只写 `old` → `new` 真正变化的键。
///
/// 这是「重置不穿越」的底层保证：重置内存时 `jvmArgs` 未变化，就完全不会
/// 被读取/重写，哪怕内存里的值来自回退或并发读取。
pub fn update_delta(old: &GameInstance, new: &GameInstance) -> Result<bool, String> {
    let _guard = config_guard();
    let Some(dir) = version_dir(&new.game_dir, &new.name) else {
        return Ok(false);
    };
    if !dir.is_dir() {
        return Ok(false);
    }
    let path = dir.join(CONFIG_FILE);
    let raw = read_raw(&path);
    // 文件不存在/损坏 → 用完整快照重建，避免只有增量键的半份配置。
    let Some(raw) = raw else {
        return write_map(&path, &snapshot(new));
    };
    if merge_raw(new, &raw).is_none() {
        return write_map(&path, &snapshot(new));
    }
    let old_map = snapshot(old);
    let new_map = snapshot(new);
    let mut out: Map<String, Value> = raw
        .into_iter()
        .filter(|(k, v)| is_allowed(k) && !is_blank(v))
        .collect();
    for key in ALLOWED_KEYS {
        let before = old_map.get(*key);
        let after = new_map.get(*key);
        if before == after {
            continue;
        }
        match after {
            Some(value) if !is_blank(value) => {
                out.insert((*key).to_string(), value.clone());
            }
            _ => {
                out.remove(*key);
            }
        }
    }
    // 身份键以记录为准，避免历史文件里的旧 id/name 在增量写入后继续留存。
    for key in IDENTITY_KEYS {
        match new_map.get(*key) {
            Some(value) if !is_blank(value) => {
                out.insert((*key).to_string(), value.clone());
            }
            _ => {
                out.remove(*key);
            }
        }
    }
    write_map(&path, &out)
}

/// Qomicex 整合包导出用的脱敏配置（不回写本地文件）。
pub fn export_map(inst: &GameInstance) -> Map<String, Value> {
    let full = snapshot(inst);
    EXPORT_KEYS
        .iter()
        .filter_map(|key| full.get(*key).map(|v| ((*key).to_string(), v.clone())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::services::error_report::tests::ENV_LOCK;

    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("qomicex-cfg-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn with_home<T>(home: &Path, f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", home);
        let out = f();
        match old {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        out
    }

    fn inst(game_dir: &str, name: &str) -> GameInstance {
        let mut i = GameInstance::default();
        i.name = name.to_string();
        i.game_dir = game_dir.to_string();
        i
    }

    fn write_json(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn missing_keys_fall_back_per_key_and_heal_non_defaults() {
        let home = temp_home("fallback");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("GTNH 2.8.4");
        std::fs::create_dir_all(&version_dir).unwrap();
        write_json(&version_dir.join(CONFIG_FILE), r#"{"maxMemory":8192}"#);

        let mut unified = inst(game_dir.to_str().unwrap(), "GTNH 2.8.4");
        unified.max_memory = 8192;
        unified.jvm_args = Some("-XX:+UseG1GC".into());
        unified.remark = Some("整合包".into());

        with_home(&home, || {
            let merged = load(&unified);
            assert_eq!(merged.max_memory, 8192);
            assert_eq!(
                merged.jvm_args.as_deref(),
                Some("-XX:+UseG1GC"),
                "独立文件缺失的键必须按项回退"
            );
            assert_eq!(merged.remark.as_deref(), Some("整合包"));

            let healed = read_raw(&version_dir.join(CONFIG_FILE)).unwrap();
            assert_eq!(healed["jvmArgs"], "-XX:+UseG1GC", "回退到的非默认值应写回");
            assert_eq!(healed["remark"], "整合包");
            assert_eq!(healed["maxMemory"], 8192, "原有键保持不变");
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn empty_values_fall_back_and_are_replaced() {
        let home = temp_home("blank");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();
        write_json(
            &version_dir.join(CONFIG_FILE),
            r#"{"jvmArgs":"","javaPath":"  ","customGroupIds":[]}"#,
        );

        let mut unified = inst(game_dir.to_str().unwrap(), "1.20.1");
        unified.jvm_args = Some("-Xmx8G".into());
        unified.java_path = Some("C:/Java/bin/javaw.exe".into());
        unified.custom_group_ids = vec!["g1".into()];

        with_home(&home, || {
            let merged = load(&unified);
            assert_eq!(merged.jvm_args.as_deref(), Some("-Xmx8G"));
            assert_eq!(merged.java_path.as_deref(), Some("C:/Java/bin/javaw.exe"));
            assert_eq!(merged.custom_group_ids, vec!["g1".to_string()]);
            let healed = read_raw(&version_dir.join(CONFIG_FILE)).unwrap();
            assert_eq!(healed["jvmArgs"], "-Xmx8G");
            assert_eq!(healed["customGroupIds"][0], "g1");
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn independent_file_wins_over_unified() {
        let home = temp_home("precedence");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();
        write_json(&version_dir.join(CONFIG_FILE), r#"{"maxMemory":16384}"#);

        let mut unified = inst(game_dir.to_str().unwrap(), "1.20.1");
        unified.max_memory = 4096;

        with_home(&home, || {
            assert_eq!(load(&unified).max_memory, 16384);
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn delta_write_only_touches_changed_key() {
        let home = temp_home("delta");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();

        let mut old = inst(game_dir.to_str().unwrap(), "1.20.1");
        old.max_memory = 4096;
        old.jvm_args = Some("-XX:+UseG1GC -Dfile.encoding=UTF-8".into());
        old.java_path = Some("C:/Java/bin/javaw.exe".into());

        with_home(&home, || {
            write_full(&old).unwrap();
            // 模拟“磁盘上的值比内存快照新”：整份快照重写会覆盖它，增量写入必须保留。
            let path = version_dir.join(CONFIG_FILE);
            let mut persisted = read_raw(&path).unwrap();
            persisted.insert("jvmArgs".into(), "-Xpersisted".into());
            write_json(
                &path,
                &serde_json::to_string(&Value::Object(persisted)).unwrap(),
            );

            // 只改内存并重置回默认：JVM/Java 键必须原样保留
            let mut new = old.clone();
            new.max_memory = 4096;
            update_delta(&old, &new).unwrap();
            let after = read_raw(&path).unwrap();
            assert_eq!(
                after["jvmArgs"], "-Xpersisted",
                "未变化键不得被整份快照覆盖"
            );
            assert_eq!(after["javaPath"], "C:/Java/bin/javaw.exe");

            // 清空 JVM 只删 jvmArgs，不碰 javaPath/内存
            let mut cleared = new.clone();
            cleared.jvm_args = None;
            update_delta(&new, &cleared).unwrap();
            let after = read_raw(&path).unwrap();
            assert!(!after.contains_key("jvmArgs"), "清空 JVM 应只删对应键");
            assert_eq!(after["javaPath"], "C:/Java/bin/javaw.exe");
            assert_eq!(after["maxMemory"], 4096);
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn snapshot_excludes_secrets_and_icons() {
        let home = temp_home("secrets");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();

        let mut i = inst(game_dir.to_str().unwrap(), "1.20.1");
        i.access_token = Some("secret-token".into());
        i.account_uuid = Some("uuid".into());
        i.account_name = Some("name".into());
        i.icon_data = Some("data:image/png;base64,xxx".into());
        i.jvm_args = Some("-Xmx8G".into());

        with_home(&home, || {
            write_full(&i).unwrap();
            let raw = std::fs::read_to_string(version_dir.join(CONFIG_FILE)).unwrap();
            for forbidden in [
                "secret-token",
                "accessToken",
                "iconData",
                "accountName",
                "accountUuid",
                "\"name\": \"name\"",
                "\"uuid\"",
            ] {
                assert!(!raw.contains(forbidden), "快照不得包含 {forbidden}");
            }
            assert!(raw.contains("jvmArgs"));
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn export_map_drops_local_absolute_paths() {
        let mut i = GameInstance::default();
        i.name = "pack".into();
        i.java_path = Some("C:/Users/me/Java/bin/javaw.exe".into());
        i.jvm_args = Some("-XX:+UseG1GC".into());
        i.max_memory = 8192;
        i.custom_group_ids = vec!["local".into()];
        let map = export_map(&i);
        assert!(map.get("javaPath").is_none(), "本地 Java 路径不得随包导出");
        assert!(
            map.get("customGroupIds").is_none(),
            "本地分组 id 不得随包导出"
        );
        assert_eq!(map["jvmArgs"], "-XX:+UseG1GC");
        assert_eq!(map["maxMemory"], 8192);
    }

    #[test]
    fn unsafe_instance_names_are_rejected() {
        for name in [
            "", ".", "..", "../evil", "a/b", "a\\b", "C:evil", "CON", "name.",
        ] {
            assert!(!is_safe_instance_name(name), "应拒绝非法实例名: {name:?}");
        }
        for name in ["1.20.1", "GTNH 2.8.4", "整合包", "foo (2)"] {
            assert!(is_safe_instance_name(name), "应允许正常实例名: {name:?}");
        }
    }

    #[test]
    fn import_sanitizer_only_keeps_exported_safe_keys() {
        let value: Value = serde_json::from_str(
            r#"{
                "maxMemory": 8192,
                "jvmArgs": "-Xmx8G",
                "versionIsolation": false,
                "skipIntegrityCheck": true,
                "javaPath": "C:/Windows/System32/calc.exe",
                "id": "foreign",
                "name": "../escape",
                "accountName": "leak",
                "customGroupIds": ["local"]
            }"#,
        )
        .unwrap();
        let map = sanitize_import_map(&value);
        assert_eq!(map["maxMemory"], 8192);
        assert_eq!(map["jvmArgs"], "-Xmx8G");
        assert_eq!(map["versionIsolation"], false);
        assert_eq!(map["skipIntegrityCheck"], true);
        for key in ["javaPath", "id", "name", "accountName", "customGroupIds"] {
            assert!(!map.contains_key(key), "导入配置不得采纳 {key}");
        }
    }

    #[test]
    fn oversized_config_is_treated_as_corrupt() {
        let home = temp_home("oversized");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();
        let path = version_dir.join(CONFIG_FILE);
        std::fs::write(&path, vec![b' '; MAX_CONFIG_BYTES as usize + 1]).unwrap();

        let mut unified = inst(game_dir.to_str().unwrap(), "1.20.1");
        unified.max_memory = 6144;
        let merged = load(&unified);
        assert_eq!(merged.max_memory, 6144);
        let healed_len = std::fs::metadata(&path).unwrap().len();
        assert!(
            healed_len <= MAX_CONFIG_BYTES,
            "超限配置应被小快照替换，实际 {healed_len} 字节"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn corrupt_config_is_rebuilt_from_unified() {
        let home = temp_home("corrupt");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("1.20.1");
        std::fs::create_dir_all(&version_dir).unwrap();
        write_json(
            &version_dir.join(CONFIG_FILE),
            r#"{"maxMemory":"not-a-number"}"#,
        );

        let mut unified = inst(game_dir.to_str().unwrap(), "1.20.1");
        unified.max_memory = 6144;
        unified.jvm_args = Some("-Xmx6G".into());

        with_home(&home, || {
            let merged = load(&unified);
            assert_eq!(merged.max_memory, 6144);
            let healed = read_raw(&version_dir.join(CONFIG_FILE)).unwrap();
            assert_eq!(healed["maxMemory"], 6144);
            assert_eq!(healed["jvmArgs"], "-Xmx6G");
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 配置文件里的 id/name 不得覆盖已有记录（整合包可能来自别的启动器/复制目录），
    /// 读取后还应把文件里的旧 id 修正为本地 id，避免 instances.json 丢失后恢复出重复 id。
    #[test]
    fn local_identity_wins_over_config() {
        let home = temp_home("identity");
        let game_dir = home.join("mc");
        let version_dir = game_dir.join("versions").join("Local");
        std::fs::create_dir_all(&version_dir).unwrap();
        write_json(
            &version_dir.join(CONFIG_FILE),
            r#"{"id":"foreign-id","name":"OldName","maxMemory":8192}"#,
        );

        let local = inst(game_dir.to_str().unwrap(), "Local");
        with_home(&home, || {
            let merged = load(&local);
            assert_eq!(merged.id, local.id, "记录的 id 不得被文件覆盖");
            assert_eq!(merged.name, "Local", "记录的目录名不得被文件覆盖");
            assert_eq!(merged.max_memory, 8192, "设置仍应按独立文件采纳");

            let healed = read_raw(&version_dir.join(CONFIG_FILE)).unwrap();
            assert_eq!(healed["id"], local.id, "文件里的旧 id 应被修正");
            assert_eq!(healed["name"], "Local");
        });
        let _ = std::fs::remove_dir_all(&home);
    }
}
