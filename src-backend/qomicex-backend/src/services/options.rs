//! 游戏设置（options.txt）读写服务。
//!
//! 对应 C# 侧 `OptionsHelper`（InstanceController.CreateGameSettingsOptions）与
//! core 的 OptionsProvider（qomicex-core-rust services/options/options_txt.rs）：
//! - 嵌入 `Resources/GameSettings/options.json`（选项定义）；多语言描述单一文案源在
//!   `qomicex-tauri-i18n` submodule 的 `src/{lang}/game-settings-descriptions.json`
//!   （编辑翻译必须改 submodule 内文件并在 i18n 仓库提交推送）；
//! - options.txt 格式：`key:value`（行内含 `=` 也接受），键值两侧 Trim，写回恒为 `key:value`；
//! - 版本可用性为离线版本号比较（不依赖 mojang manifest）：解析 introducedVersion（如 "1.13"）
//!   与实例 gameVersion（如 "1.20.1"）逐段比较，任一侧解析失败视为可用。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use qomicex_core::models::local::{MinecraftOption, OptionViewItem};

const OPTIONS_JSON: &str = include_str!("../../Resources/GameSettings/options.json");

// 游戏设置描述（单一文案源：qomicex-tauri-i18n submodule，每语言一个 JSON）。
// 路径从本文件（src/services/）上溯 4 级到仓库根，再进 submodule。
const DESCRIPTIONS_ZH_CN: &str =
    include_str!("../../../../qomicex-tauri-i18n/src/zh-CN/game-settings-descriptions.json");
const DESCRIPTIONS_ZH_TW: &str =
    include_str!("../../../../qomicex-tauri-i18n/src/zh-TW/game-settings-descriptions.json");
const DESCRIPTIONS_EN_US: &str =
    include_str!("../../../../qomicex-tauri-i18n/src/en-US/game-settings-descriptions.json");
const DESCRIPTIONS_EN_GB: &str =
    include_str!("../../../../qomicex-tauri-i18n/src/en-GB/game-settings-descriptions.json");

const DEFAULT_DESCRIPTION: &str = "(无描述)";
const FALLBACK_LANGUAGE: &str = "en-US";

/// 选项定义（懒加载，嵌入资源仅解析一次）
fn definitions() -> &'static Vec<MinecraftOption> {
    static DEFINITIONS: OnceLock<Vec<MinecraftOption>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| serde_json::from_str(OPTIONS_JSON).expect("解析 options.json 失败"))
}

/// 多语言描述（懒加载）：外层语言键 → 内层选项名键 → 描述。
/// 4 份 submodule JSON 合并为一张表（zh-TW/en-GB 复用 zh-CN/en-US 内容）。
fn descriptions() -> &'static HashMap<String, HashMap<String, String>> {
    static DESCRIPTIONS: OnceLock<HashMap<String, HashMap<String, String>>> = OnceLock::new();
    DESCRIPTIONS.get_or_init(|| {
        let mut map: HashMap<String, HashMap<String, String>> = HashMap::new();
        for (lang, json) in [
            ("zh-CN", DESCRIPTIONS_ZH_CN),
            ("zh-TW", DESCRIPTIONS_ZH_TW),
            ("en-US", DESCRIPTIONS_EN_US),
            ("en-GB", DESCRIPTIONS_EN_GB),
        ] {
            map.insert(
                lang.to_string(),
                serde_json::from_str(json)
                    .unwrap_or_else(|e| panic!("解析 {lang} 游戏设置描述失败: {e}")),
            );
        }
        map
    })
}

/// options.txt 路径：版本隔离 → `{gameDir}/versions/{version}/options.txt`，否则 `{gameDir}/options.txt`
fn options_path(game_dir: &str, version: &str, isolated: bool) -> PathBuf {
    if isolated {
        Path::new(game_dir)
            .join("versions")
            .join(version)
            .join("options.txt")
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
            upsert(
                &mut config,
                key.trim().to_string(),
                value.trim().to_string(),
            );
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

/// 当前值是否为 JSON 数组形态（如 options.txt 的
/// `resourcePacks:["vanilla","foo.zip"]`）→ 前端按列表（可增删 chips）展示。
fn looks_like_list(value: &str) -> bool {
    let trimmed = value.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return false;
    }
    matches!(serde_json::from_str::<serde_json::Value>(trimmed), Ok(serde_json::Value::Array(_)))
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
    let config: HashMap<String, String> = load_config(&options_path(game_dir, version, isolated))
        .into_iter()
        .collect();
    definitions()
        .iter()
        .map(|opt| {
            let current_value = config
                .get(&opt.name)
                .cloned()
                .unwrap_or_else(|| opt.default_value.clone());
            OptionViewItem {
                name: opt.name.clone(),
                default_value: opt.default_value.clone(),
                current_value: current_value.clone(),
                description: get_description(&opt.name, language),
                valid_values_raw: opt.valid_values.clone(),
                introduced_version: opt.introduced_version.clone(),
                is_available_in_current_version: is_available_in_version(
                    &opt.introduced_version,
                    game_version,
                ),
                // 当前值是 JSON 数组（resourcePacks/datapacks 等）→ List，覆盖定义推断
                // （这些 key 的 validValues 为空，原推断为 Text）。
                value_kind: if looks_like_list(&current_value) {
                    "List".to_string()
                } else {
                    infer_value_kind(&opt.valid_values)
                },
            }
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
        "en" | "en-US" => "en_us".to_string(),
        "en-GB" => "en_gb".to_string(),
        other => other.to_lowercase().replace('-', "_"),
    }
}

/// 仅当 options.txt 不存在或未含 `lang` 选项时写入语言（尊重游戏内已设语言）。
/// `system`（跟随系统）时跳过，避免写入错误的语言码。
pub fn ensure_lang(game_dir: &str, version: &str, isolated: bool, language: &str) {
    if language == "system" {
        return;
    }
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
    fn list_value_detection() {
        // options.txt 的数组值（resourcePacks/datapacks 等）
        assert!(looks_like_list(r#"["vanilla","foo.zip"]"#));
        assert!(looks_like_list(r#"[]"#));
        assert!(looks_like_list("[\"a\", \"b\"]"));
        // 非数组/非法 JSON
        assert!(!looks_like_list("vanilla"));
        assert!(!looks_like_list(""));
        assert!(!looks_like_list("[broken"));
        assert!(!looks_like_list("{\"a\":1}"));
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
    fn minecraft_lang_mapping() {
        assert_eq!(to_minecraft_lang("zh-CN"), "zh_cn");
        assert_eq!(to_minecraft_lang("zh-TW"), "zh_tw");
        assert_eq!(to_minecraft_lang("en"), "en_us");
        assert_eq!(to_minecraft_lang("en-US"), "en_us");
        assert_eq!(to_minecraft_lang("en-GB"), "en_gb");
    }

    #[test]
    fn lang_mapping() {
        assert_eq!(to_minecraft_lang("zh-CN"), "zh_cn");
        assert_eq!(to_minecraft_lang("zh-TW"), "zh_tw");
        assert_eq!(to_minecraft_lang("en"), "en_us");
        assert_eq!(to_minecraft_lang("ja-JP"), "ja_jp");
    }
}
