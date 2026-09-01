//! MultiMC 实例/整合包通用导入（对齐 HMCL `MultiMCModpackInstallTask` /
//! `MultiMCInstancePatch` 的 MultiMC scheme → 官方 Version scheme 转换）。
//!
//! 职责：
//! - 解析 `instance.cfg`（INI）+ `mmc-pack.json`（components）→ 实例元数据
//! - 已知加载器 uid → 候选 `ModLoaderType`（策略 A：复用现有安装管线）
//! - 通用 json-patch 转换引擎（策略 B）：以 Mojang 官方版本 JSON 为 base，
//!   逐组件应用 patch（本地 `patches/{uid}.json` / 根 `{uid}.json`，否则
//!   `meta.multimc.org/v1/{uid}/{version}.json`），递归解析 `requires` 闭包，
//!   合并语义对齐 HMCL `resolveArtifact`：`libraries` 拼接去重、标量字段
//!   后定义者胜出、`tweakers`/`jvmArgs` 拼接、`compatibleJavaMajors` → `javaVersion`、
//!   物化 maven-only 库的 `downloads.artifact`（含 `MMC-hint: local` 内嵌库）
//! - 内容落盘：`.minecraft/` 用户内容 → `versions/{name}/`；实例 `libraries/`
//!   与内嵌库 → 共享 `libraries/`（maven 路径）
//! - 图标解析（`{iconKey}.png` / `.minecraft/icon.png` / `mmc-pack.json` 内嵌）

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use qomicex_core::models::installer::ModLoaderType;
use serde_json::{json, Value};

/// 单个 mmc-pack.json 组件。
#[derive(Debug, Clone)]
pub struct MmcpComponent {
    pub uid: String,
    pub version: String,
    pub dependency_only: bool,
}

/// 解析出的 MultiMC 实例元数据（策略 A/B 共用）。
#[derive(Debug, Clone)]
pub struct MultiMcMetadata {
    pub name: String,
    pub game_version: String,
    /// 主加载器组件 uid（无则空串 = 原版实例）。
    pub loader_uid: String,
    /// 主加载器组件 version。
    pub loader_version: String,
    /// 候选加载器（策略 A）：(ModLoaderType, 安装管线 loader 名)。
    pub loader_candidates: Vec<(ModLoaderType, String)>,
    /// 全部组件（含 dependency-only，策略 B 合并用）。
    pub components: Vec<MmcpComponent>,
    pub icon_data: Option<String>,
    /// `instance.cfg` OverrideJavaLocation=true 时的 Java 路径。
    pub java_path: Option<String>,
    /// `instance.cfg` OverrideMemory=true 时的 MaxMemAlloc。
    pub max_memory: Option<i32>,
}

/// 在给定起始目录（zip 解压根或用户选的文件夹）定位实例根目录：
/// 自身含 `instance.cfg`/`mmc-pack.json` → 自身；否则向下搜 2 层，
/// 返回含任意一个标记文件的目录（均含则优先）。
pub fn locate_instance_root(start: &Path) -> Option<PathBuf> {
    fn is_instance_dir(d: &Path) -> bool {
        d.join("instance.cfg").is_file() || d.join("mmc-pack.json").is_file()
    }
    if is_instance_dir(start) {
        return Some(start.to_path_buf());
    }
    let mut both: Option<PathBuf> = None;
    let mut either: Option<PathBuf> = None;
    let entries: Vec<_> = std::fs::read_dir(start)
        .map(|d| d.flatten().collect())
        .unwrap_or_default();
    for e in &entries {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        if is_instance_dir(&p) {
            if p.join("instance.cfg").is_file() && p.join("mmc-pack.json").is_file() {
                both = Some(p.clone());
            } else if either.is_none() {
                either = Some(p.clone());
            }
        }
    }
    // 深度 2（zip 常多包一层目录，如 `GT New Horizons 2.7.3/`）。
    for e in &entries {
        if !e.path().is_dir() {
            continue;
        }
        if let Ok(sub) = std::fs::read_dir(e.path()) {
            for s in sub.flatten() {
                if !s.path().is_dir() {
                    continue;
                }
                let p = s.path();
                if is_instance_dir(&p) {
                    if p.join("instance.cfg").is_file() && p.join("mmc-pack.json").is_file() {
                        both = Some(p.clone());
                    } else if either.is_none() {
                        either = Some(p.clone());
                    }
                }
            }
        }
    }
    both.or(either)
}

/// 解析 `instance.cfg`（INI 风格 `key=value`，支持 `#`/`;` 注释）。
pub fn parse_instance_cfg(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    map
}

/// 组件 uid 白名单清洗（安全）：只保留 `[A-Za-z0-9._-]`，其余替换为 `_`。
/// uid 来自整合包内容，用于拼接本地 patch 路径与 meta URL，防止路径遍历 / URL 注入。
fn sanitize_component_id(uid: &str) -> String {
    uid.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 读取并解析 `mmc-pack.json` 的 components。
fn parse_mmc_components(root: &Path) -> Result<Vec<MmcpComponent>, String> {
    let content = std::fs::read_to_string(root.join("mmc-pack.json"))
        .map_err(|e| format!("读取 mmc-pack.json 失败: {e}"))?;
    parse_mmc_components_from_str(&content)
}

/// 从 `mmc-pack.json` 内容解析 components（文件夹 / zip 条目通用）。
fn parse_mmc_components_from_str(content: &str) -> Result<Vec<MmcpComponent>, String> {
    let v: Value =
        serde_json::from_str(content).map_err(|e| format!("解析 mmc-pack.json 失败: {e}"))?;
    let arr = v
        .get("components")
        .and_then(Value::as_array)
        .ok_or("mmc-pack.json 缺少 components")?;
    let mut comps = Vec::new();
    for c in arr {
        let uid = c.get("uid").and_then(Value::as_str).unwrap_or("");
        let version = c.get("version").and_then(Value::as_str).unwrap_or("");
        if uid.is_empty() {
            continue;
        }
        // 清洗后不得引入路径遍历（`..`）或含目录分隔符。
        let uid_clean = sanitize_component_id(uid);
        if uid_clean.is_empty()
            || uid_clean.contains("..")
            || uid_clean.contains('/')
            || uid_clean.contains('\\')
        {
            continue;
        }
        comps.push(MmcpComponent {
            uid: uid_clean,
            version: version.to_string(),
            dependency_only: c
                .get("dependencyOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    if comps.is_empty() {
        return Err("mmc-pack.json 无有效组件".to_string());
    }
    Ok(comps)
}

/// 版本号 ≤ 比较（点分数字；非数字部分按 ASCII 比较兜底）。用于 legacy 判定。
fn is_version_below_or_equal(a: &str, b: &str) -> bool {
    let pa: Vec<&str> = a.split('.').collect();
    let pb: Vec<&str> = b.split('.').collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or("0");
        let y = pb.get(i).copied().unwrap_or("0");
        match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(xn), Ok(yn)) => {
                if xn != yn {
                    return xn < yn;
                }
            }
            _ => match x.cmp(y) {
                std::cmp::Ordering::Equal => {}
                ord => return ord == std::cmp::Ordering::Less,
            },
        }
    }
    true
}

/// MultiMC 组件 uid → 候选加载器（策略 A）。
/// `net.minecraftforge` 版本形如 `0.x-alpha/beta` 时 Cleanroom（Forge fork），
/// 否则 Forge；两者都试（在 provider 列表命中者胜）。
pub fn loader_candidates(uid: &str, game_version: &str) -> Vec<(ModLoaderType, String)> {
    use ModLoaderType as T;
    match uid {
        "net.minecraftforge" => vec![
            (T::Forge, "forge".to_string()),
            (T::Cleanroom, "cleanroom".to_string()),
        ],
        "net.neoforged" => vec![(T::NeoForge, "neoforge".to_string())],
        "net.fabricmc.fabric-loader" => {
            if is_version_below_or_equal(game_version, "1.12.2") {
                vec![
                    (T::LegacyFabric, "legacyfabric".to_string()),
                    (T::Fabric, "fabric".to_string()),
                ]
            } else {
                vec![(T::Fabric, "fabric".to_string())]
            }
        }
        "net.legacyfabric.fabric-loader" => vec![(T::LegacyFabric, "legacyfabric".to_string())],
        "org.quiltmc.quilt-loader" => vec![(T::Quilt, "quilt".to_string())],
        "net.minecraft.liteloader" => vec![(T::LiteLoader, "liteloader".to_string())],
        "net.optifine" => vec![(T::OptiFine, "optifine".to_string())],
        "net.babric" => vec![(T::Babric, "babric".to_string())],
        _ => Vec::new(),
    }
}

/// 解析实例根目录元数据。
pub fn parse_metadata(root: &Path) -> Result<MultiMcMetadata, String> {
    let cfg = if root.join("instance.cfg").is_file() {
        parse_instance_cfg(
            &std::fs::read_to_string(root.join("instance.cfg"))
                .map_err(|e| format!("读取 instance.cfg 失败: {e}"))?,
        )
    } else {
        HashMap::new()
    };
    let components = parse_mmc_components(root)?;
    let fallback_name = root.file_name().map(|n| n.to_string_lossy().into_owned());
    let icon_data = resolve_icon(root, cfg.get("iconKey").map(|s| s.as_str()));
    build_metadata(cfg, components, fallback_name, icon_data)
}

/// 从 zip 整合包直接解析元数据（不落盘，类似 C# ZipArchive 只读条目）。
/// 定位实例根前缀（含 mmc-pack.json / instance.cfg 的目录），只读这三个条目：
/// `mmc-pack.json`（components）、`instance.cfg`（name/Java/内存/iconKey）、图标 PNG。
pub fn parse_metadata_from_zip(zip_path: &Path) -> Result<MultiMcMetadata, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开整合包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;

    // 1. 定位实例根前缀：收集所有含 mmc-pack.json 的目录（zip 常多包一层目录），
    //    优先选同时含 instance.cfg 的统一前缀，避免 mmc-pack.json 与 instance.cfg
    //    来自不同目录（如包内含多个实例或嵌套条目）导致名称/组件错配。
    let mut mc_prefixes: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            continue;
        };
        let name = entry.name();
        if name.ends_with("mmc-pack.json") {
            let dir = name
                .rsplit_once('/')
                .map(|(d, _)| d)
                .unwrap_or("")
                .to_string();
            if !mc_prefixes.iter().any(|p| *p == dir) {
                mc_prefixes.push(dir);
            }
        }
    }
    let prefix = mc_prefixes
        .iter()
        .find(|p| {
            let cand = if p.is_empty() {
                "instance.cfg".to_string()
            } else {
                format!("{p}/instance.cfg")
            };
            archive
                .by_name(&cand)
                .map(|mut e| {
                    let mut s = String::new();
                    std::io::Read::read_to_string(&mut e, &mut s).is_ok()
                })
                .unwrap_or(false)
        })
        .or_else(|| mc_prefixes.first())
        .cloned()
        .ok_or("未找到 MultiMC 实例（缺少 mmc-pack.json）")?;
    let prefix = prefix.as_str();

    // 2. 读取 mmc-pack.json + instance.cfg（只在前缀下查找，不回退裸路径跨目录匹配）。
    let read_zip_str =
        |archive: &mut zip::ZipArchive<std::fs::File>, rel: &str| -> Result<String, String> {
            let cand = if prefix.is_empty() {
                rel.to_string()
            } else {
                format!("{prefix}/{rel}")
            };
            let mut entry = archive
                .by_name(&cand)
                .map_err(|_| format!("zip 内缺少 {cand}"))?;
            let mut content = String::new();
            std::io::Read::read_to_string(&mut entry, &mut content)
                .map_err(|e| format!("读取 {cand} 失败: {e}"))?;
            Ok(content)
        };
    let components = parse_mmc_components_from_str(&read_zip_str(&mut archive, "mmc-pack.json")?)?;
    let cfg = read_zip_str(&mut archive, "instance.cfg")
        .map(|c| parse_instance_cfg(&c))
        .unwrap_or_default();

    // 3. 图标：`{root}/{iconKey}.png` → `.minecraft/icon.png`（zip 内相对根前缀）。
    let icon_data =
        resolve_icon_from_zip(&mut archive, prefix, cfg.get("iconKey").map(|s| s.as_str()));

    // 4. 名称兜底：实例根目录名（zip 前导目录名）。
    let fallback_name = prefix
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    build_metadata(cfg, components, fallback_name, icon_data)
}

/// 共享元数据构建：cfg + components + 名称兜底 + 图标 → MultiMcMetadata。
#[allow(clippy::too_many_arguments)]
fn build_metadata(
    cfg: HashMap<String, String>,
    components: Vec<MmcpComponent>,
    fallback_name: Option<String>,
    icon_data: Option<String>,
) -> Result<MultiMcMetadata, String> {
    // 游戏版本：net.minecraft 组件。
    let mc = components
        .iter()
        .find(|c| c.uid == "net.minecraft")
        .ok_or("mmc-pack.json 缺少 net.minecraft 组件")?;
    let game_version = mc.version.clone();
    if game_version.is_empty() {
        return Err("net.minecraft 组件版本为空".to_string());
    }

    // 主加载器：优先选择 uid 能映射到已知加载器的组件（特殊兼容包常混入
    // forgepatches/launchargs 等辅助组件，如 GTNH 的 me.eigenraven.lwjgl3ify.*，
    // 真正的加载器是 net.minecraftforge）；找不到已知加载器再回退首个
    // 非 dependency-only 且非 minecraft 的组件（自定义加载器 → 走 json-patch 兜底）。
    let loader = components
        .iter()
        .find(|c| {
            !c.dependency_only
                && c.uid != "net.minecraft"
                && !loader_candidates_for(&c.uid, &game_version).is_empty()
        })
        .or_else(|| {
            components
                .iter()
                .find(|c| !c.dependency_only && c.uid != "net.minecraft")
        });
    let loader_uid = loader.map(|c| c.uid.clone()).unwrap_or_default();
    let loader_version = loader.map(|c| c.version.clone()).unwrap_or_default();
    let loader_candidates = if loader_uid.is_empty() {
        Vec::new()
    } else {
        loader_candidates_for(&loader_uid, &game_version)
    };

    let name = cfg
        .get("name")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| fallback_name)
        .unwrap_or_else(|| "MultiMC 实例".to_string());

    // 仅当 Override 时导入启动设置。
    let java_path = if cfg
        .get("OverrideJavaLocation")
        .map(|s| s.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        cfg.get("JavaPath")
            .map(|s| s.trim().to_string())
            .filter(|s| {
                !s.is_empty() && !s.eq_ignore_ascii_case("replace this with your java path")
            })
    } else {
        None
    };
    let max_memory = if cfg
        .get("OverrideMemory")
        .map(|s| s.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        cfg.get("MaxMemAlloc")
            .and_then(|s| s.trim().parse::<i32>().ok())
    } else {
        None
    };

    Ok(MultiMcMetadata {
        name,
        game_version,
        loader_uid,
        loader_version,
        loader_candidates,
        components,
        icon_data,
        java_path,
        max_memory,
    })
}

fn loader_candidates_for(uid: &str, game_version: &str) -> Vec<(ModLoaderType, String)> {
    loader_candidates(uid, game_version)
}

/// 图标解析：`{root}/{iconKey}.png` → `.minecraft/icon.png` → None。
pub fn resolve_icon(root: &Path, icon_key: Option<&str>) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(key) = icon_key {
        let k = key.trim();
        if !k.is_empty() {
            candidates.push(root.join(format!("{k}.png")));
        }
    }
    candidates.push(root.join(".minecraft/icon.png"));
    for p in candidates {
        if p.is_file() {
            if let Ok(bytes) = std::fs::read(&p) {
                return Some(format!("data:image/png;base64,{}", base64_encode(&bytes)));
            }
        }
    }
    None
}

/// 从 zip 直接读图标：`{prefix}/{iconKey}.png` → `{prefix}/.minecraft/icon.png` → None。
/// 前缀即实例根在 zip 内的相对目录（可能为空 = 根）。
fn resolve_icon_from_zip(
    archive: &mut zip::ZipArchive<std::fs::File>,
    prefix: &str,
    icon_key: Option<&str>,
) -> Option<String> {
    let join = |rel: &str| {
        if prefix.is_empty() {
            rel.to_string()
        } else {
            format!("{prefix}/{rel}")
        }
    };
    let mut candidates: Vec<String> = Vec::new();
    if let Some(key) = icon_key {
        let k = key.trim();
        if !k.is_empty() {
            candidates.push(join(&format!("{k}.png")));
        }
    }
    candidates.push(join(".minecraft/icon.png"));
    for name in candidates {
        let Ok(mut entry) = archive.by_name(&name) else {
            continue;
        };
        let mut bytes = Vec::new();
        if std::io::Read::read_to_end(&mut entry, &mut bytes).is_ok() {
            return Some(format!("data:image/png;base64,{}", base64_encode(&bytes)));
        }
    }
    None
}

/// 标准 base64（无外部 crate 依赖；与 modpack.rs 内实现一致）。
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push(TABLE[n as usize & 63] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push('=');
    }
    out
}

/// 顶层目录/文件跳过清单（运行时垃圾 / 重建目录）。
const SKIP_CONTENT_DIRS: &[&str] = &[
    ".cache",
    "logs",
    "downloads",
    "logconfigs",
    "crash-reports",
    "cache",
    "versions", // 游戏本体由安装管线/合并引擎重建
    "assets",   // 由完整性检查重建
];
const SKIP_CONTENT_FILES: &[&str] = &["icon.png", ".packignore"];

/// 拷贝实例用户内容与内嵌库到目标 game_root：
/// - `.minecraft/` 用户内容（mods/config/saves/options.txt…）→ `{game_root}/versions/{name}/`
/// - `.minecraft/libraries/` 与实例根 `libraries/` → `{game_root}/libraries/`
/// 返回拷贝文件数。
pub fn copy_instance_content(src_root: &Path, game_root: &Path, name: &str) -> Result<u64, String> {
    let dest = game_root.join("versions").join(name);
    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("创建实例目录失败 {}: {e}", dest.display()))?;
    let mut files = 0u64;

    let src_mc = src_root.join(".minecraft");
    if src_mc.is_dir() {
        files += copy_dir_children(&src_mc, &dest, &game_root.join("libraries"))?;
    }
    // 旧格式实例（如 Cleanroom）：libraries/ 在实例根。
    let root_libs = src_root.join("libraries");
    if root_libs.is_dir() {
        files += copy_tree(&root_libs, &game_root.join("libraries"))?;
    }
    Ok(files)
}

/// 拷贝 `.minecraft/` 的直接子项：顶层按跳过清单过滤，libraries 落共享目录。
fn copy_dir_children(src: &Path, dest: &Path, shared_libs: &Path) -> Result<u64, String> {
    let mut files = 0u64;
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if SKIP_CONTENT_FILES.contains(&name.as_str()) {
            continue;
        }
        if p.is_dir() {
            if SKIP_CONTENT_DIRS.contains(&name.as_str()) {
                continue;
            }
            let target = if name == "libraries" {
                shared_libs.to_path_buf()
            } else {
                dest.join(&name)
            };
            files += copy_tree(&p, &target)?;
        } else {
            copy_file(&p, &dest.join(&name))?;
            files += 1;
        }
    }
    Ok(files)
}

/// 递归拷贝目录树（目录内不跳过）。
fn copy_tree(src: &Path, dest: &Path) -> Result<u64, String> {
    let mut files = 0u64;
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            files += copy_tree(&p, &dest.join(&name))?;
        } else {
            copy_file(&p, &dest.join(&name))?;
            files += 1;
        }
    }
    Ok(files)
}

fn copy_file(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    std::fs::copy(src, dest)
        .map_err(|e| format!("拷贝失败 {} → {}: {e}", src.display(), dest.display()))?;
    Ok(())
}

/// 相对路径安全判定：非空、非绝对、不含 `..` 组件（用于 maven 相对路径拼接到
/// `libraries/` 下，防路径遍历逃逸出库目录）。
fn is_safe_rel_path(p: &str) -> bool {
    if p.trim().is_empty() {
        return false;
    }
    let path = Path::new(p);
    if path.is_absolute() {
        return false;
    }
    !path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// 拷贝合并 JSON 中 `MMC-hint: local` 的内嵌库：`{instance}/libraries/{basename}` → `{game_root}/libraries/{maven_path}`。
pub fn copy_embedded_libraries(
    src_root: &Path,
    game_root: &Path,
    merged_json: &str,
) -> Result<u64, String> {
    let mut copied = 0u64;
    let Ok(v) = serde_json::from_str::<Value>(merged_json) else {
        return Ok(0);
    };
    let Some(libs) = v.get("libraries").and_then(Value::as_array) else {
        return Ok(0);
    };
    for lib in libs {
        let is_local = lib
            .get("MMC-hint")
            .or_else(|| lib.get("hint"))
            .and_then(Value::as_str)
            .map(|s| s.eq_ignore_ascii_case("local"))
            .unwrap_or(false);
        if !is_local {
            continue;
        }
        let Some(name) = lib.get("name").and_then(Value::as_str) else {
            continue;
        };
        let maven_path = qomicex_core::util::lib_helper::maven_to_path(name);
        if maven_path.is_empty() || !is_safe_rel_path(&maven_path) {
            continue;
        }
        // 内嵌文件 = maven 路径末段（如 cleanroom-0.3.4-alpha-universal.jar）。
        let basename = maven_path.rsplit('/').next().unwrap_or("");
        if basename.is_empty() {
            continue;
        }
        let embedded = src_root.join("libraries").join(basename);
        if !embedded.is_file() {
            continue;
        }
        let dest = game_root.join("libraries").join(&maven_path);
        if dest.is_file() {
            continue;
        }
        copy_file(&embedded, &dest)?;
        copied += 1;
    }
    Ok(copied)
}

// ---------------------------------------------------------------------------
// 策略 B：通用 json-patch 转换引擎
// ---------------------------------------------------------------------------

/// 组件 patch 的 meta URL（version 为空时按 MultiMC 默认补全）。
/// uid/version 均经 URL 编码，防止 URL 注入（uid 已在 parse_mmc_components 清洗）。
pub fn meta_url(uid: &str, version: &str, game_version: &str) -> String {
    let ver = if version.trim().is_empty() {
        match uid {
            "org.lwjgl" => "2.9.1",
            "org.lwjgl3" => "3.1.2",
            "net.fabricmc.intermediary" | "org.quiltmc.hashed" => game_version,
            _ => "",
        }
    } else {
        version
    };
    let uid = urlencoding::encode(uid);
    let ver = urlencoding::encode(ver);
    format!("https://meta.multimc.org/v1/{uid}/{ver}.json")
}

/// 读取组件 patch：本地 `patches/{uid}.json` → 根 `{uid}.json` → meta.multimc.org。
async fn load_patch(
    http_client: &reqwest::Client,
    root: &Path,
    uid: &str,
    version: &str,
    game_version: &str,
) -> Result<Value, String> {
    for p in [
        root.join("patches").join(format!("{uid}.json")),
        root.join(format!("{uid}.json")),
    ] {
        if p.is_file() {
            let content = std::fs::read_to_string(&p)
                .map_err(|e| format!("读取本地 patch {uid} 失败: {e}"))?;
            return serde_json::from_str(&content)
                .map_err(|e| format!("解析本地 patch {uid} 失败: {e}"));
        }
    }
    let url = meta_url(uid, version, game_version);
    let resp = http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("拉取组件 patch {uid} 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "拉取组件 patch {uid} 失败（{}），且包内无 patches/{uid}.json",
            resp.status()
        ));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取组件 patch {uid} 失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析组件 patch {uid} 失败: {e}"))
}

/// 构建合并后的版本 JSON（策略 B）：Mojang base + 组件 patch 依依赖序合并。
/// 返回 `(合并 JSON, 组件收集的 +jvmArgs)` —— jvmArgs 由调用方写入实例 jvm_args 字段
/// （MultiMC 的 +jvmArgs 非标准字段；旧格式 json 注入 arguments.jvm 会因缺
/// arguments.game 导致启动报错，实例字段两种格式均保证生效）。
pub async fn build_merged_version_json(
    http_client: &reqwest::Client,
    root: &Path,
    metadata: &MultiMcMetadata,
    version_dir_name: &str,
) -> Result<(String, Vec<String>), String> {
    // 1. Mojang base（Qomicex 原生字段：downloads.client / assetIndex / libraries）。
    let base = fetch_mojang_version_json(http_client, &metadata.game_version).await?;
    let mut merged = base;
    merged["id"] = Value::String(version_dir_name.to_string());

    // 2. 加载全部组件 patch（本地优先，否则 meta）。
    let mut patches: HashMap<String, Value> = HashMap::new();
    for c in &metadata.components {
        let p = load_patch(
            http_client,
            root,
            &c.uid,
            &c.version,
            &metadata.game_version,
        )
        .await?;
        patches.insert(c.uid.clone(), p);
    }

    // 3. 递归解析 requires 闭包。
    loop {
        let mut missing: Vec<(String, String)> = Vec::new();
        for (_uid, patch) in &patches {
            if let Some(reqs) = patch.get("requires").and_then(Value::as_array) {
                for r in reqs {
                    let Some(rid) = r.get("uid").and_then(Value::as_str) else {
                        continue;
                    };
                    // requires 的 uid 亦来自补丁内容，清洗后须安全（无遍历/分隔符）。
                    let rid = sanitize_component_id(rid);
                    if rid.is_empty()
                        || rid.contains("..")
                        || rid.contains('/')
                        || rid.contains('\\')
                    {
                        continue;
                    }
                    if rid == "net.minecraft" || patches.contains_key(&rid) {
                        continue;
                    }
                    let ver = r
                        .get("equalsVersion")
                        .or_else(|| r.get("suggests"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    missing.push((rid.to_string(), ver.to_string()));
                }
            }
        }
        if missing.is_empty() {
            break;
        }
        for (rid, ver) in missing {
            let p = load_patch(http_client, root, &rid, &ver, &metadata.game_version).await?;
            patches.insert(rid, p);
        }
    }

    // 3.5. HMCL 语义对齐：net.minecraft patch 自带 libraries 时，以其替换 Mojang base 的
    // libraries 作为基础库表。MultiMC 的 net.minecraft.json 是修正后的完整库表
    // （如 gson 2.10.1、log4j -fixed、剔除 LWJGL2），直接 merge 会残留 Mojang base 旧库
    // （gson 2.2.4 / LWJGL2 2.9.1）导致 classpath 冲突、启动 VerifyError。
    if let Some(mc_patch) = patches.get("net.minecraft") {
        if let Some(libs) = mc_patch.get("libraries").and_then(Value::as_array) {
            merged["libraries"] = Value::Array(libs.clone());
        }
    }

    // 4. 依序合并（dependency-only 优先，保持 mmc-pack 相对序；标量字段后定义者胜出）。
    let mut order: Vec<String> = Vec::new();
    let mut deps: Vec<String> = Vec::new();
    for c in &metadata.components {
        if c.dependency_only {
            deps.push(c.uid.clone());
        } else if patches.contains_key(&c.uid) {
            order.push(c.uid.clone());
        }
    }
    for uid in &deps {
        if let Some(p) = patches.get(uid) {
            apply_patch(&mut merged, p)?;
        }
    }
    for uid in &order {
        if let Some(p) = patches.get(uid) {
            apply_patch(&mut merged, p)?;
        }
    }

    // 5. 收尾：补 downloads.client（base 缺失时）、物化库、注入 tweakers、整理 javaVersion。
    ensure_downloads_client(http_client, &mut merged, &metadata.game_version).await?;
    materialize_library_downloads(&mut merged);
    let tweakers = merged
        .get("__tweakers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    inject_tweakers(&mut merged, &tweakers);
    let jvm_args = merged
        .get("__jvm_args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let jvm_args: Vec<String> = jvm_args
        .iter()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect();
    // 特殊兼容包推断 Java 大版本：为 RFB 引导或含 --add-opens/--add-modules/
    // --enable-preview 等 Java 9+ 参数（GTNH Java 17-25 等）时，把 javaVersion 提升到
    // 17（若缺失或低于 17），避免启动器误选 Java 8 导致无法启动。
    let current_java = merged
        .get("javaVersion")
        .and_then(|j| j.get("majorVersion"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let main_class = merged
        .get("mainClass")
        .and_then(Value::as_str)
        .unwrap_or("");
    let needs_modern_java = main_class.contains("retrofuturabootstrap")
        || jvm_args
            .iter()
            .any(|a| a == "--add-opens" || a == "--add-modules" || a == "--enable-preview");
    if needs_modern_java && current_java < 17 {
        merged["javaVersion"] = json!({
            "component": "java-runtime-gamma",
            "majorVersion": 17
        });
    }
    merged.as_object_mut().map(|m| m.remove("__tweakers"));
    merged.as_object_mut().map(|m| m.remove("__jvm_args"));
    merged.as_object_mut().map(|m| m.remove("__main_jar"));

    let json =
        serde_json::to_string(&merged).map_err(|e| format!("序列化合并版本 JSON 失败: {e}"))?;
    Ok((json, jvm_args))
}

/// 拉取 Mojang 官方版本 JSON（版本清单 → 版本 URL → JSON）。
async fn fetch_mojang_version_json(
    http_client: &reqwest::Client,
    game_version: &str,
) -> Result<Value, String> {
    let manifest_url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
    let manifest: Value = http_client
        .get(manifest_url)
        .send()
        .await
        .map_err(|e| format!("获取 Mojang 版本清单失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("获取 Mojang 版本清单失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析 Mojang 版本清单失败: {e}"))?;
    let url = manifest
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find(|v| v.get("id").and_then(Value::as_str) == Some(game_version))
        })
        .and_then(|v| v.get("url").and_then(Value::as_str))
        .ok_or_else(|| format!("Mojang 版本清单中未找到游戏版本 {game_version}"))?;
    let v: Value = http_client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("获取版本 {game_version} JSON 失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("获取版本 {game_version} JSON 失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析版本 {game_version} JSON 失败: {e}"))?;
    Ok(v)
}

/// 应用单个组件 patch 到 base（对齐 HMCL 合并语义）。
fn apply_patch(base: &mut Value, patch: &Value) -> Result<(), String> {
    let Some(obj) = patch.as_object() else {
        return Err("组件 patch 不是 JSON 对象".to_string());
    };
    for (key, val) in obj {
        let (op, name) = if let Some(rest) = key.strip_prefix('-') {
            ("remove", rest)
        } else if let Some(rest) = key.strip_prefix('+') {
            ("add", rest)
        } else {
            ("set", key.as_str())
        };
        match op {
            "remove" => {
                base.as_object_mut().map(|m| m.remove(name));
            }
            _ => match name {
                "libraries" => merge_libraries(base, val),
                "arguments" => merge_arguments(base, val),
                "tweakers" => {
                    append_to_arr(base, "__tweakers", val);
                }
                "jvmArgs" => {
                    append_to_arr(base, "__jvm_args", val);
                }
                "mainJar" => {
                    // 主 jar 以 base 的 downloads.client 为准；patch 的 mainJar 仅记录（备查）。
                    base.as_object_mut()
                        .map(|m| m.insert("__main_jar".to_string(), val.clone()));
                }
                "compatibleJavaMajors" => apply_java_majors(base, val),
                "mainClass"
                | "appletClass"
                | "jar"
                | "minecraftArguments"
                | "assetIndex"
                | "downloads"
                | "javaVersion"
                | "minimumLauncherVersion"
                | "releaseTime"
                | "time"
                | "id"
                | "type" => {
                    if !val.is_null() {
                        base.as_object_mut()
                            .map(|m| m.insert(name.to_string(), val.clone()));
                    }
                }
                "compatibleJavaName" | "order" | "requires" | "conflicts" | "suggests"
                | "equals" | "uid" | "version" | "cachedName" | "cachedVersion"
                | "cachedVolatile" | "volatile" | "formatVersion" | "name" | "dependsOn"
                | "mavenFiles" | "mods" | "traits" => {
                    // MultiMC 元键 / 不适用字段：忽略。
                }
                _ => {
                    // 未知键：替换（保守，避免关键字段丢失）。
                    base.as_object_mut()
                        .map(|m| m.insert(name.to_string(), val.clone()));
                }
            },
        }
    }
    Ok(())
}

/// libraries 拼接（按 name 去重，后定义者覆盖同名字段、保留原位置）。
fn merge_libraries(base: &mut Value, val: &Value) {
    let Some(new_libs) = val.as_array() else {
        return;
    };
    let Some(base_arr) = base.get_mut("libraries").and_then(Value::as_array_mut) else {
        base.as_object_mut()
            .map(|m| m.insert("libraries".to_string(), val.clone()));
        return;
    };
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (i, lib) in base_arr.iter().enumerate() {
        if let Some(n) = lib.get("name").and_then(Value::as_str) {
            seen.insert(n.to_string(), i);
        }
    }
    for lib in new_libs {
        let name = lib.get("name").and_then(Value::as_str).unwrap_or("");
        if let Some(&idx) = seen.get(name) {
            base_arr[idx] = lib.clone();
        } else if !name.is_empty() {
            seen.insert(name.to_string(), base_arr.len());
            base_arr.push(lib.clone());
        } else {
            base_arr.push(lib.clone());
        }
    }
}

/// arguments（新格式对象 {game, jvm}）合并：数组拼接去重；旧格式字符串直接替换。
fn merge_arguments(base: &mut Value, val: &Value) {
    match val {
        Value::Object(o) => {
            let base_obj = base
                .get_mut("arguments")
                .and_then(Value::as_object_mut)
                .cloned()
                .unwrap_or_default();
            let mut merged = base_obj;
            for k in ["game", "jvm"] {
                if let Some(arr) = o.get(k).and_then(Value::as_array) {
                    let entry = merged.entry(k.to_string()).or_insert_with(|| json!([]));
                    let mut out: Vec<Value> = Vec::new();
                    let mut seen = std::collections::HashSet::new();
                    if let Some(existing) = entry.as_array() {
                        for it in existing {
                            let s = serde_json::to_string(it).unwrap_or_default();
                            if seen.insert(s) {
                                out.push(it.clone());
                            }
                        }
                    }
                    for it in arr {
                        let s = serde_json::to_string(it).unwrap_or_default();
                        if seen.insert(s) {
                            out.push(it.clone());
                        }
                    }
                    *entry = Value::Array(out);
                }
            }
            base.as_object_mut()
                .map(|m| m.insert("arguments".to_string(), Value::Object(merged)));
        }
        Value::String(s) => {
            base.as_object_mut()
                .map(|m| m.insert("arguments".to_string(), json!(s)));
        }
        _ => {}
    }
}

fn append_to_arr(base: &mut Value, key: &str, val: &Value) {
    let Some(items) = val.as_array() else {
        if !val.is_null() {
            base.as_object_mut().map(|m| {
                let arr = m.entry(key.to_string()).or_insert_with(|| json!([]));
                if let Some(a) = arr.as_array_mut() {
                    a.push(val.clone());
                }
            });
        }
        return;
    };
    base.as_object_mut().map(|m| {
        let arr = m.entry(key.to_string()).or_insert_with(|| json!([]));
        if let Some(a) = arr.as_array_mut() {
            for it in items {
                a.push(it.clone());
            }
        }
    });
}

/// compatibleJavaMajors → javaVersion.majorVersion（取 {8,11,16,17,21} 中最大者）。
fn apply_java_majors(base: &mut Value, val: &Value) {
    let Some(majors) = val.as_array() else { return };
    let mut best: Option<i32> = None;
    for m in majors {
        if let Some(n) = m.as_i64() {
            if matches!(n, 8 | 11 | 16 | 17 | 21) {
                best = Some(best.map_or(n as i32, |b: i32| (n as i32).max(b)));
            }
        }
    }
    if let Some(n) = best {
        let component = match n {
            17 | 21 => "java-runtime-gamma",
            16 => "java-runtime-alpha",
            11 => "java-runtime-beta",
            _ => "jre-legacy",
        };
        base.as_object_mut().map(|m| {
            m.insert(
                "javaVersion".to_string(),
                json!({ "component": component, "majorVersion": n }),
            )
        });
    }
}

/// 合并 JSON 无 downloads.client 时，从 Mojang 版本 JSON 补全（旧版本 base 用 mainJar）。
async fn ensure_downloads_client(
    http_client: &reqwest::Client,
    merged: &mut Value,
    game_version: &str,
) -> Result<(), String> {
    let has_client = merged
        .get("downloads")
        .and_then(|d| d.get("client"))
        .map(|c| !c.is_null())
        .unwrap_or(false);
    if has_client {
        return Ok(());
    }
    let mojang = fetch_mojang_version_json(http_client, game_version).await?;
    if let Some(client) = mojang
        .get("downloads")
        .and_then(|d| d.get("client"))
        .cloned()
    {
        merged.as_object_mut().map(|m| {
            let d = m.entry("downloads").or_insert_with(|| json!({}));
            if let Some(dobj) = d.as_object_mut() {
                dobj.insert("client".to_string(), client);
            }
        });
    }
    Ok(())
}

/// 物化 maven-only 库的 `downloads.artifact`（core 只认 downloads.artifact / librariesSource）：
/// - 已有 downloads.artifact：补 path（maven_to_path）。
/// - 库级 `url`+`path`：直接作 artifact（url 已是完整文件 URL）。
/// - 仅 name：`{url 或 libraries.minecraft.net/}{maven_path}`。
/// - `MMC-hint: local`：path = maven 路径，url 留空（文件由内嵌库拷贝提供）。
fn materialize_library_downloads(base: &mut Value) {
    let Some(libs) = base.get_mut("libraries").and_then(Value::as_array_mut) else {
        return;
    };
    for lib in libs.iter_mut() {
        let Some(name) = lib.get("name").and_then(Value::as_str) else {
            continue;
        };
        let maven_path = qomicex_core::util::lib_helper::maven_to_path(name);
        if !maven_path.is_empty() && !is_safe_rel_path(&maven_path) {
            continue;
        }
        let is_local = lib
            .get("MMC-hint")
            .or_else(|| lib.get("hint"))
            .and_then(Value::as_str)
            .map(|s| s.eq_ignore_ascii_case("local"))
            .unwrap_or(false);
        let has_downloads = lib.get("downloads").is_some();
        if has_downloads {
            if let Some(art) = lib.get_mut("downloads").and_then(|d| d.get_mut("artifact")) {
                if art
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty()
                    && !maven_path.is_empty()
                {
                    art.as_object_mut()
                        .map(|a| a.insert("path".to_string(), json!(maven_path)));
                }
            }
            continue;
        }
        // 无 downloads：构造 artifact。
        let path = if !maven_path.is_empty() {
            maven_path
        } else {
            continue;
        };
        let (artifact_path, url) = if is_local {
            // 内嵌库：文件由 copy_embedded_libraries 从实例 libraries/ 提供，url 留空。
            (path.clone(), String::new())
        } else {
            let repo = lib.get("url").and_then(Value::as_str).unwrap_or("");
            let rel = lib.get("path").and_then(Value::as_str).unwrap_or("");
            if !repo.is_empty() && !rel.is_empty() && is_safe_rel_path(rel) {
                // MultiMC 格式：url = 完整文件 URL（repo + path）。
                (rel.to_string(), repo.to_string())
            } else if !repo.is_empty() && is_safe_rel_path(&path) {
                let base = if repo.ends_with('/') {
                    repo.to_string()
                } else {
                    format!("{repo}/")
                };
                (path.clone(), format!("{base}{path}"))
            } else {
                (
                    path.clone(),
                    format!("https://libraries.minecraft.net/{path}"),
                )
            }
        };
        lib.as_object_mut().map(|l| {
            l.insert(
                "downloads".to_string(),
                json!({ "artifact": { "path": artifact_path, "url": url, "size": 0, "sha1": "" } }),
            );
        });
    }
}

/// 注入 tweakers 到启动参数：旧格式 → minecraftArguments 追加 `--tweakClass <t>`；
/// 新格式 → arguments.game 追加 `{"rules":[],"value":["--tweakClass","<t>"]}`。
fn inject_tweakers(base: &mut Value, tweakers: &[Value]) {
    if tweakers.is_empty() {
        return;
    }
    let tweakers: Vec<&str> = tweakers.iter().filter_map(Value::as_str).collect();
    if tweakers.is_empty() {
        return;
    }
    // 旧格式：minecraftArguments 字符串。
    if let Some(mc) = base.get("minecraftArguments").and_then(Value::as_str) {
        let mut s = mc.to_string();
        for t in &tweakers {
            s.push_str(&format!(" --tweakClass {t}"));
        }
        base.as_object_mut()
            .map(|m| m.insert("minecraftArguments".to_string(), json!(s)));
        return;
    }
    // 新格式：arguments.game。
    if let Some(game) = base
        .get_mut("arguments")
        .and_then(|a| a.get_mut("game"))
        .and_then(Value::as_array_mut)
    {
        for t in &tweakers {
            game.push(json!({ "rules": [], "value": ["--tweakClass", t] }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("qomicex-multimc-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, content).unwrap();
    }

    const PACK_JSON: &str = r#"{
      "components": [
        {"uid": "org.lwjgl", "version": "2.9.4-nightly-20150209", "dependencyOnly": true},
        {"uid": "net.minecraft", "version": "1.12.2", "important": true},
        {"uid": "net.minecraftforge", "version": "10.13.4.1614"}
      ]
    }"#;
    const CFG: &str =
        "InstanceType=OneSix\nname=TestPack\niconKey=test\nOverrideMemory=true\nMaxMemAlloc=2048\n";

    #[test]
    fn parse_metadata_extracts_fields() {
        let root = temp_dir("parse");
        write(&root, "instance.cfg", CFG);
        write(&root, "mmc-pack.json", PACK_JSON);
        let meta = parse_metadata(&root).unwrap();
        assert_eq!(meta.name, "TestPack");
        assert_eq!(meta.game_version, "1.12.2");
        assert_eq!(meta.loader_uid, "net.minecraftforge");
        assert_eq!(meta.loader_version, "10.13.4.1614");
        assert_eq!(meta.max_memory, Some(2048));
        assert!(meta.java_path.is_none());
        assert_eq!(meta.loader_candidates[0].1, "forge");
    }

    #[test]
    fn loader_candidates_legacy_detection() {
        let fabric_legacy = loader_candidates("net.fabricmc.fabric-loader", "1.12.2");
        assert_eq!(fabric_legacy[0].1, "legacyfabric");
        let fabric_modern = loader_candidates("net.fabricmc.fabric-loader", "1.20.1");
        assert_eq!(fabric_modern[0].1, "fabric");
        assert!(loader_candidates("com.unknown.loader", "1.20.1").is_empty());
    }

    #[test]
    fn locate_root_finds_nested_dir() {
        let root = temp_dir("locate");
        write(&root, "inner/instance.cfg", CFG);
        write(&root, "inner/mmc-pack.json", PACK_JSON);
        let found = locate_instance_root(&root).unwrap();
        assert_eq!(found.file_name().unwrap().to_str().unwrap(), "inner");
    }

    #[test]
    fn copy_instance_content_maps_dirs() {
        let root = temp_dir("copy");
        write(&root, ".minecraft/mods/a.jar", "jar");
        write(&root, ".minecraft/saves/world/level.dat", "dat");
        write(&root, ".minecraft/options.txt", "lang:en_US");
        write(&root, ".minecraft/logs/latest.log", "junk");
        write(&root, ".minecraft/.cache/x", "junk");
        write(
            &root,
            "libraries/cleanroom-0.3.4-alpha-universal.jar",
            "jarbytes",
        );
        let game = root.join("game");
        let files = copy_instance_content(&root, &game, "TestPack").unwrap();
        assert_eq!(files, 4);
        assert_eq!(
            std::fs::read_to_string(game.join("versions/TestPack/mods/a.jar")).unwrap(),
            "jar"
        );
        assert_eq!(
            std::fs::read_to_string(game.join("versions/TestPack/saves/world/level.dat")).unwrap(),
            "dat"
        );
        assert_eq!(
            std::fs::read_to_string(game.join("versions/TestPack/options.txt")).unwrap(),
            "lang:en_US"
        );
        // 跳过 logs / .cache。
        assert!(!game.join("versions/TestPack/logs").exists());
        assert!(!game.join("versions/TestPack/.cache").exists());
        // 实例根 libraries → 共享 libraries。
        assert_eq!(
            std::fs::read_to_string(game.join("libraries/cleanroom-0.3.4-alpha-universal.jar"))
                .unwrap(),
            "jarbytes"
        );
    }

    #[test]
    fn merge_joins_libraries_and_overrides_scalars() {
        let mut base = json!({
            "id": "base",
            "mainClass": "net.minecraft.client.main.Main",
            "libraries": [{"name": "a:a:1", "url": "https://old.repo/"}],
            "minecraftArguments": "-D a"
        });
        let patch = json!({
            "libraries": [{"name": "b:b:1"}, {"name": "a:a:1", "url": "https://new.repo/"}],
            "mainClass": "net.minecraft.launchwrapper.Launch",
            "+tweakers": ["t.A", "t.B"],
            "formatVersion": 1,
            "uid": "x",
            "version": "1"
        });
        apply_patch(&mut base, &patch).unwrap();
        // 同名（完整 maven 名）覆盖、其余追加。
        let libs: Vec<&Value> = base["libraries"].as_array().unwrap().iter().collect();
        assert_eq!(libs.len(), 2);
        assert_eq!(libs[0]["name"], "a:a:1");
        assert_eq!(libs[0]["url"], "https://new.repo/"); // 同名内容被 patch 覆盖
        assert_eq!(libs[1]["name"], "b:b:1");
        assert_eq!(base["mainClass"], "net.minecraft.launchwrapper.Launch");
        assert_eq!(base["minecraftArguments"], "-D a");
        assert!(base.get("uid").is_none()); // 元键剥离
        let tweakers: Vec<&str> = base["__tweakers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap())
            .collect();
        assert_eq!(tweakers, vec!["t.A", "t.B"]);
    }

    #[test]
    fn materialize_and_inject() {
        let mut v = json!({
            "minecraftArguments": "--username ${auth_player_name}",
            "libraries": [
                {"name": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10:universal", "url": "https://maven.minecraftforge.net/"},
                {"name": "com.cleanroommc:cleanroom:0.3.4-alpha-universal", "MMC-hint": "local"},
                {"name": "com.mojang:patchy:1.3.9", "downloads": {"artifact": {"url": "https://libraries.minecraft.net/x.jar"}}}
            ]
        });
        materialize_library_downloads(&mut v);
        inject_tweakers(&mut v, &[json!("cpw.mods.fml.common.launcher.FMLTweaker")]);
        let libs = v["libraries"].as_array().unwrap();
        assert_eq!(
            libs[0]["downloads"]["artifact"]["url"],
            "https://maven.minecraftforge.net/net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-universal.jar"
        );
        assert_eq!(libs[0]["downloads"]["artifact"]["path"], "net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-universal.jar");
        assert_eq!(
            libs[1]["downloads"]["artifact"]["path"],
            "com/cleanroommc/cleanroom/0.3.4-alpha-universal/cleanroom-0.3.4-alpha-universal.jar"
        );
        assert_eq!(libs[1]["downloads"]["artifact"]["url"], ""); // local：文件由内嵌库提供
        assert_eq!(
            libs[2]["downloads"]["artifact"]["path"],
            "com/mojang/patchy/1.3.9/patchy-1.3.9.jar"
        ); // 补 path
        assert!(v["minecraftArguments"]
            .as_str()
            .unwrap()
            .contains("--tweakClass cpw.mods.fml.common.launcher.FMLTweaker"));
    }

    #[test]
    fn meta_url_defaults() {
        assert_eq!(
            meta_url("org.lwjgl3", "", "1.12.2"),
            "https://meta.multimc.org/v1/org.lwjgl3/3.1.2.json"
        );
        assert_eq!(
            meta_url("net.fabricmc.intermediary", "", "1.12.2"),
            "https://meta.multimc.org/v1/net.fabricmc.intermediary/1.12.2.json"
        );
        assert_eq!(
            meta_url("net.neoforged", "26.2.0.75", "26.2"),
            "https://meta.multimc.org/v1/net.neoforged/26.2.0.75.json"
        );
    }

    #[test]
    fn copy_embedded_libraries_places_maven_path() {
        let root = temp_dir("embedded");
        write(
            &root,
            "libraries/cleanroom-0.3.4-alpha-universal.jar",
            "bytes",
        );
        let merged = r#"{"libraries": [
            {"name": "com.cleanroommc:cleanroom:0.3.4-alpha-universal", "MMC-hint": "local"}
        ]}"#;
        let game = root.join("game");
        let copied = copy_embedded_libraries(&root, &game, merged).unwrap();
        assert_eq!(copied, 1);
        assert_eq!(
            std::fs::read_to_string(
                game.join("libraries/com/cleanroommc/cleanroom/0.3.4-alpha-universal/cleanroom-0.3.4-alpha-universal.jar")
            )
            .unwrap(),
            "bytes"
        );
    }

    #[test]
    fn is_version_below_or_equal_works() {
        assert!(is_version_below_or_equal("1.7.10", "1.12.2"));
        assert!(!is_version_below_or_equal("1.20.1", "1.12.2"));
        assert!(is_version_below_or_equal("1.12.2", "1.12.2"));
    }

    /// 手动验证：对真实 MultiMC 包跑通用合并引擎（需网络）。
    /// 用法：`QOMICEX_MMC_TEST_PACK=<实例目录> cargo test -- --ignored multimc_real_pack_merge`
    #[tokio::test]
    #[ignore]
    async fn multimc_real_pack_merge() {
        let Some(dir) = std::env::var_os("QOMICEX_MMC_TEST_PACK") else {
            eprintln!("skip: QOMICEX_MMC_TEST_PACK 未设置");
            return;
        };
        let root = locate_instance_root(Path::new(&dir)).expect("实例根");
        let meta = parse_metadata(&root).expect("元数据");
        // 特殊兼容包：主加载器应识别为已知加载器（forge），而非辅助组件（lwjgl3ify）。
        if meta.name.contains("GTNH") || meta.components.iter().any(|c| c.uid.contains("lwjgl3ify"))
        {
            assert_eq!(
                meta.loader_uid, "net.minecraftforge",
                "GTNH 主加载器应为 forge"
            );
        }
        let client = reqwest::Client::new();
        let (merged, jvm_args) = build_merged_version_json(&client, &root, &meta, "MergeProbe")
            .await
            .expect("合并失败");
        let v: Value = serde_json::from_str(&merged).expect("JSON");
        let libs = v
            .get("libraries")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        let has_client = v
            .get("downloads")
            .and_then(|d| d.get("client"))
            .map(|c| c.is_object())
            .unwrap_or(false);
        eprintln!(
            "name={} mc={} mainClass={} libs={} client={} assetIndex={} jvmArgs={}",
            meta.name,
            meta.game_version,
            v.get("mainClass").and_then(Value::as_str).unwrap_or(""),
            libs,
            has_client,
            v.get("assetIndex")
                .and_then(|a| a.get("id"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            jvm_args.len()
        );
        assert!(v
            .get("mainClass")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty()));
        assert!(libs > 0);
        assert!(has_client, "旧版本应补齐 downloads.client");
        if meta.name.contains("GTNH") {
            assert_eq!(
                v.get("javaVersion")
                    .and_then(|j| j.get("majorVersion"))
                    .and_then(Value::as_i64),
                Some(17),
                "GTNH Java 17-25 应推断 Java 17"
            );
            assert!(
                jvm_args.iter().any(|a| a == "--add-opens"),
                "应提取 --add-opens JVM 参数"
            );
        }
    }

    /// 手动验证：MMC-hint:local 内嵌库经 copy_embedded_libraries 复制到 maven 路径后，
    /// 缺失文件扫描不应再把它判为缺失（避免空 url 回退 libraries.minecraft.net 404）。
    /// 用法：`QOMICEX_MMC_TEST_PACK=<实例目录> cargo test -- --ignored multimc_local_lib_skips_download`
    #[tokio::test]
    #[ignore]
    async fn multimc_local_lib_skips_download() {
        let Some(dir) = std::env::var_os("QOMICEX_MMC_TEST_PACK") else {
            eprintln!("skip: QOMICEX_MMC_TEST_PACK 未设置");
            return;
        };
        let root = locate_instance_root(Path::new(&dir)).expect("实例根");
        let meta = parse_metadata(&root).expect("元数据");
        let client = reqwest::Client::new();
        let game_root =
            std::env::temp_dir().join(format!("qomicex-mmclocal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&game_root);
        std::fs::create_dir_all(&game_root).unwrap();

        let (merged, _jvm) = build_merged_version_json(&client, &root, &meta, "LocalProbe")
            .await
            .expect("合并失败");
        let copied = copy_embedded_libraries(&root, &game_root, &merged).expect("复制内嵌库失败");
        let v: Value = serde_json::from_str(&merged).unwrap();
        let local_lib = v
            .get("libraries")
            .and_then(Value::as_array)
            .and_then(|a| {
                a.iter()
                    .find(|l| l.get("MMC-hint").and_then(Value::as_str) == Some("local"))
            })
            .cloned();
        let Some(local_lib) = local_lib else {
            eprintln!("no local lib in merged json");
            return;
        };
        let name = local_lib.get("name").and_then(Value::as_str).unwrap_or("");
        let maven_path = qomicex_core::util::lib_helper::maven_to_path(name);
        let dest = game_root.join("libraries").join(&maven_path);
        eprintln!(
            "local lib {name} copied={copied} dest_exists={}",
            dest.is_file()
        );

        let repair = crate::services::install_service::build_repair_core(
            game_root.to_str().unwrap(),
            0,
            client,
        );
        let miss = repair
            .locator()
            .get_miss_files_from_json(&merged)
            .await
            .expect("扫描失败");
        let hit = miss.iter().find(|f| f.path.contains("lwjgl3ify"));
        eprintln!(
            "miss total={} lwjgl3ify_missing={}",
            miss.len(),
            hit.map(|h| h.url.clone()).unwrap_or_default()
        );
        assert!(
            hit.is_none(),
            "内嵌库不应被判为缺失（否则触发 libraries.minecraft.net 404）: {:?}",
            hit.map(|h| h.url.clone())
        );
        let _ = std::fs::remove_dir_all(&game_root);
    }

    fn write_zip(root: &Path, name: &str, entries: &[(&str, &str)]) -> PathBuf {
        let p = root.join(name);
        let file = std::fs::File::create(&p).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (path, content) in entries {
            zw.start_file(*path, opts).unwrap();
            use std::io::Write;
            zw.write_all(content.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
        p
    }

    #[test]
    fn parse_metadata_from_zip_nested_prefix() {
        let root = temp_dir("zip-nested");
        // zip 多包一层目录（模拟 GTNH `GT New Horizons 2.8.4/`）。
        let zip = write_zip(
            &root,
            "pack.zip",
            &[
                ("GT New Horizons 2.8.4/mmc-pack.json", PACK_JSON),
                ("GT New Horizons 2.8.4/instance.cfg", CFG),
                ("GT New Horizons 2.8.4/README.txt", "ignore"),
            ],
        );
        let meta = parse_metadata_from_zip(&zip).unwrap();
        assert_eq!(meta.name, "TestPack");
        assert_eq!(meta.game_version, "1.12.2");
        assert_eq!(meta.loader_uid, "net.minecraftforge");
        assert_eq!(meta.max_memory, Some(2048));
        // 名称兜底用 zip 前导目录名（无 instance.cfg name 时）。
    }

    #[test]
    fn parse_metadata_from_zip_root_level() {
        let root = temp_dir("zip-root");
        let zip = write_zip(
            &root,
            "pack.zip",
            &[("mmc-pack.json", PACK_JSON), ("instance.cfg", CFG)],
        );
        let meta = parse_metadata_from_zip(&zip).unwrap();
        assert_eq!(meta.name, "TestPack");
        assert_eq!(meta.game_version, "1.12.2");
    }

    #[test]
    fn parse_metadata_from_zip_prefers_dir_with_cfg() {
        let root = temp_dir("zip-pref");
        // 两个候选：一个只有 mmc-pack.json（无 cfg），一个两者都有 → 应选后者。
        let zip = write_zip(
            &root,
            "pack.zip",
            &[
                ("CandidateA/mmc-pack.json", PACK_JSON),
                ("CandidateB/mmc-pack.json", PACK_JSON),
                ("CandidateB/instance.cfg", CFG),
            ],
        );
        let meta = parse_metadata_from_zip(&zip).unwrap();
        assert_eq!(meta.name, "TestPack");
        assert_eq!(meta.max_memory, Some(2048)); // cfg 来自 CandidateB
    }

    #[test]
    fn parse_metadata_from_zip_real_gtnh() {
        // 用户提供的真实 GTNH 压缩包（仅存在时运行）。
        let zip = std::path::Path::new(
            r"C:\Project\tmp\modpacks\muilti-mc\GT_New_Horizons_2.8.4_Java_17-25.zip",
        );
        if !zip.is_file() {
            eprintln!("skip: GTNH zip not found");
            return;
        }
        let meta = parse_metadata_from_zip(zip).unwrap();
        assert_eq!(meta.game_version, "1.7.10");
        assert_eq!(meta.loader_uid, "net.minecraftforge");
        assert!(!meta.components.is_empty());
        eprintln!(
            "GTNH zip meta: name={} game={} loader={}",
            meta.name, meta.game_version, meta.loader_uid
        );
    }
}
