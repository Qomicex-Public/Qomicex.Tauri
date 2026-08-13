//! 游戏设置（options.txt）读写服务。
//!
//! 对应 C# 侧 `OptionsHelper`（InstanceController.CreateGameSettingsOptions）与
//! core 的 OptionsProvider（qomicex-core-rust services/options/options_txt.rs）：
//! - 嵌入 `Resources/GameSettings/options.json`（选项定义）与 `descriptions.json`（zh-CN/en-US 描述）；
//! - options.txt 格式：`key:value`（行内含 `=` 也接受），键值两侧 Trim，写回恒为 `key:value`；
//! - 版本可用性为离线版本号比较（不依赖 mojang manifest）：解析 introducedVersion（如 "1.13"）
//!   与实例 gameVersion（如 "1.20.1"）逐段比较，任一侧解析失败视为可用。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use qomicex_core::models::local::{MinecraftOption, OptionViewItem};

const OPTIONS_JSON: &str = include_str!("../../Resources/GameSettings/options.json");
const DESCRIPTIONS_JSON: &str = include_str!("../../Resources/GameSettings/descriptions.json");

const DEFAULT_DESCRIPTION: &str = "(无描述)";
const FALLBACK_LANGUAGE: &str = "en-US";

/// 选项定义（懒加载，嵌入资源仅解析一次）
fn definitions() -> &'static Vec<MinecraftOption> {
    static DEFINITIONS: OnceLock<Vec<MinecraftOption>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| {
        serde_json::from_str(OPTIONS_JSON).expect("解析 options.json 失败")
    })
}

/// 多语言描述（懒加载）：外层语言键 → 内层选项名键 → 描述
fn descriptions() -> &'static HashMap<String, HashMap<String, String>> {
    static DESCRIPTIONS: OnceLock<HashMap<String, HashMap<String, String>>> = OnceLock::new();
    DESCRIPTIONS.get_or_init(|| {
        serde_json::from_str(DESCRIPTIONS_JSON).expect("解析 descriptions.json 失败")
    })
}

/// options.txt 路径：版本隔离 → `{gameDir}/versions/{version}/options.txt`，否则 `{gameDir}/options.txt`
fn options_path(game_dir: &str, version: &str, isolated: bool) -> PathBuf {
    if isolated {
        Path::new(game_dir).join("versions").join(version).join("options.txt")
    } else {
        Path::new(game_dir).join("options.txt")
    }
}

/// 加载 options.txt 为有序键值对（源 Dictionary 插入序 → Vec 保序，已存在 key 原位替换）
fn load_config(path: &Path) -> Vec<(String, String)> {
    if !path.is_file() {
        return Vec::new();
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut config: Vec<(String, String)> = Vec::new();
    for line in content.strip_prefix('\u{FEFF}').unwrap_or(&content).lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let sep = if line.contains('=') { '=' } else { ':' };
        if let Some((key, value)) = line.split_once(sep) {
            upsert(&mut config, key.trim().to_string(), value.trim().to_string());
        }
    }
    config
}

fn upsert(config: &mut Vec<(String, String)>, key: String, value: String) {
    if let Some(entry) = config.iter_mut().find(|(k, _)| *k == key) {
        entry.1 = value;
    } else {
        config.push((key, value));
    }
}

/// 写回 options.txt（恒 `key:value` + `\n`，UTF-8 无 BOM）
fn save_config(path: &Path, config: &[(String, String)]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut content = String::new();
    for (key, value) in config {
        content.push_str(key);
        content.push(':');
        content.push_str(value);
        content.push('\n');
    }
    std::fs::write(path, content)
}

/// 推断值类型（顺序逐字对应 C# InferValueKind）：Boolean → Range → Enum → Text
fn infer_value_kind(valid_values: &str) -> String {
    if valid_values.eq_ignore_ascii_case("true,false")
        || valid_values.eq_ignore_ascii_case("false,true")
    {
        return "Boolean".to_string();
    }
    if looks_like_range(valid_values) {
        return "Range".to_string();
    }
    if valid_values.contains(',') {
        return "Enum".to_string();
    }
    "Text".to_string()
}

/// 区间形态（替代 C# RangePattern 正则：`digits [-–] digits`）
fn looks_like_range(value: &str) -> bool {
    for sep in ['–', '-'] {
        if let Some((a, b)) = value.trim().split_once(sep) {
            if a.trim().parse::<f64>().is_ok() && b.trim().parse::<f64>().is_ok() {
                return true;
            }
        }
    }
    false
}

/// 离线版本号比较：introduced 为空 → 可用；任一侧解析失败 → 可用；
/// 否则逐段比较（缺段补 0），当前版本 >= 引入版本 → 可用。
fn is_available_in_version(introduced: &str, game_version: &str) -> bool {
    if introduced.trim().is_empty() {
        return true;
    }
    let Some(introduced) = parse_version(introduced) else {
        return true;
    };
    let Some(current) = parse_version(game_version) else {
        return true;
    };
    current >= introduced
}

/// 解析 `1.20.1` → [1, 20, 1]；非数字段（如快照名）→ None
fn parse_version(v: &str) -> Option<Vec<u32>> {
    let mut parts = Vec::new();
    for seg in v.trim().split('.') {
        parts.push(seg.trim().parse::<u32>().ok()?);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts)
}

/// 获取指定语言的选项描述（回退链：language → en-US → "(无描述)"）
fn get_description(name: &str, language: &str) -> String {
    for lang in [language, FALLBACK_LANGUAGE] {
        if let Some(desc) = descriptions()
            .get(lang)
            .and_then(|map| map.get(name))
            .filter(|d| !d.trim().is_empty())
        {
            return desc.clone();
        }
    }
    DEFAULT_DESCRIPTION.to_string()
}

/// 列出实例的游戏设置（合并定义 + 当前值 + 描述 + 版本可用性）
pub fn list_options(
    game_dir: &str,
    version: &str,
    isolated: bool,
    game_version: &str,
    language: &str,
) -> Vec<OptionViewItem> {
    let config: HashMap<String, String> =
        load_config(&options_path(game_dir, version, isolated)).into_iter().collect();
    definitions()
        .iter()
        .map(|opt| OptionViewItem {
            name: opt.name.clone(),
            default_value: opt.default_value.clone(),
            current_value: config
                .get(&opt.name)
                .cloned()
                .unwrap_or_else(|| opt.default_value.clone()),
            description: get_description(&opt.name, language),
            valid_values_raw: opt.valid_values.clone(),
            introduced_version: opt.introduced_version.clone(),
            is_available_in_current_version: is_available_in_version(
                &opt.introduced_version,
                game_version,
            ),
            value_kind: infer_value_kind(&opt.valid_values),
        })
        .collect()
}

/// 获取单个选项的定义
pub fn get_option(
    game_dir: &str,
    version: &str,
    isolated: bool,
    game_version: &str,
    language: &str,
    name: &str,
) -> Option<OptionViewItem> {
    list_options(game_dir, version, isolated, game_version, language)
        .into_iter()
        .find(|item| item.name == name)
}

/// 设置选项值（不存在的选项也会写入；options.txt 不存在则创建）
pub fn set_option(
    game_dir: &str,
    version: &str,
    isolated: bool,
    name: &str,
    value: &str,
) -> std::io::Result<()> {
    let path = options_path(game_dir, version, isolated);
    let mut config = load_config(&path);
    upsert(&mut config, name.to_string(), value.to_string());
    save_config(&path, &config)
}

/// 启动器界面语言 → Minecraft 语言代码（如 zh-CN → zh_cn、en → en_us）。
/// 未识别时按 小写 + `-`→`_` 兜底。
pub fn to_minecraft_lang(language: &str) -> String {
    match language {
        "zh-CN" => "zh_cn".to_string(),
        "zh-TW" => "zh_tw".to_string(),
        "en" => "en_us".to_string(),
        other => other.to_lowercase().replace('-', "_"),
    }
}

/// 仅当 options.txt 不存在或未含 `lang` 选项时写入语言（尊重游戏内已设语言）。
pub fn ensure_lang(game_dir: &str, version: &str, isolated: bool, language: &str) {
    let path = options_path(game_dir, version, isolated);
    let config = load_config(&path);
    if config.iter().any(|(k, _)| k == "lang") {
        return;
    }
    let mut config = config;
    upsert(&mut config, "lang".to_string(), to_minecraft_lang(language));
    let _ = save_config(&path, &config);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_kind_inference() {
        assert_eq!(infer_value_kind("true,false"), "Boolean");
        assert_eq!(infer_value_kind("FALSE,TRUE"), "Boolean");
        assert_eq!(infer_value_kind("0 - 7"), "Range");
        assert_eq!(infer_value_kind("0 – 2"), "Range");
        assert_eq!(infer_value_kind("-1 – 1"), "Range");
        assert_eq!(infer_value_kind("all,decreased,minimal"), "Enum");
        assert_eq!(infer_value_kind("字符串"), "Text");
        assert_eq!(infer_value_kind("键控代码"), "Text");
    }

    #[test]
    fn version_availability_offline() {
        assert!(is_available_in_version("", "1.20.1"));
        assert!(is_available_in_version("1.13", "1.20.1"));
        assert!(is_available_in_version("1.21.11", "1.21.11"));
        assert!(!is_available_in_version("1.21.11", "1.20.1"));
        assert!(is_available_in_version("1.20", "1.20.1"));
        assert!(is_available_in_version("snapshot-name", "1.20.1"));
    }

    #[test]
    fn lang_mapping() {
        assert_eq!(to_minecraft_lang("zh-CN"), "zh_cn");
        assert_eq!(to_minecraft_lang("zh-TW"), "zh_tw");
        assert_eq!(to_minecraft_lang("en"), "en_us");
        assert_eq!(to_minecraft_lang("ja-JP"), "ja_jp");
    }
}
