//! 整合包托管文件清单（issue #118 原地更新的基线）。
//!
//! ## 为什么需要这份清单
//!
//! 更新一个已安装的整合包，必须回答两个问题：
//! 1. **新包应该有什么** —— 由新包索引（CF `manifest.json` / MR
//!    `modrinth.index.json`）回答；
//! 2. **磁盘上实际是什么** —— 只有安装时落一份「谁装的、装在哪、装成什么样」
//!    的记录才能回答。这就是本模块。
//!
//! 有了它才能区分三种「同名文件」：包原样装的（可安全覆盖）、用户改过的
//! （覆盖前必须先备份）、用户自己加的（不在清单里，一律不动）。
//!
//! ## 双基线分工
//!
//! - 包索引（`.qomicex/` 内的 `pack/`）：Prism 的做法，用于 diff 出「新包新增/移除」
//! - 本清单：Prism 没有，用于 diff 出「用户改没改」
//!
//! 二者缺一都会退化：只有索引则分不清用户改动（Prism 一律覆盖、自己也在源码里
//! 留了 TODO 认账）；只有清单则推不出旧包被移除的文件。
//!
//! ## 落盘位置
//!
//! `{gameDir}/versions/{instanceName}/.qomicex/modpack-manifest.json`
//!
//! 放在实例版本目录**内部**而非 `{BaseDir}`：实例改名走
//! [`crate::services::instance::InstanceService::rename_version_dir`]，它是整目录
//! `std::fs::rename`，清单随目录一起搬走，不需要额外迁移逻辑。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::services::modpack_export::sha1_file_hex;

/// 实例内的 `.qomicex/` 隐藏目录名（清单、包索引、更新暂存/备份都在其下）。
pub const QOMICEX_DIR: &str = ".qomicex";

/// 清单文件名。
pub const MANIFEST_FILE: &str = "modpack-manifest.json";

/// 清单格式版本。将来若改结构，读侧按版本号决定是否迁移而非直接报错。
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// 托管文件的来源类别，决定更新时如何处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostedFileKind {
    /// 包索引里声明的内容文件（mods/、resourcepacks/ 等，按下载计划落盘）。
    Content,
    /// 包内 overrides（含 MR 的 `client-overrides`）释放出来的文件。
    Override,
}

/// 单个受管文件记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedFile {
    /// 相对实例根目录的路径，**统一 `/` 分隔**（跨平台可比）。
    pub path: String,
    /// 安装完成时磁盘上该文件的 SHA-1（小写十六进制）。
    /// 更新时与当前磁盘值比对，不等即「用户改过」。
    pub sha1: String,
    pub kind: HostedFileKind,
}

/// 安装来源快照（更新的资格判定与身份依据）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ManifestOrigin {
    /// "modrinth" / "curseforge"。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    /// 仅 `"resource-center"` 才允许更新。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 该版本的发布时间（RFC3339），当前版本被平台删除时的排序回退。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_published_at: Option<String>,
}

/// 托管文件清单。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackManifest {
    pub schema_version: u32,
    /// 生成该清单时的 Minecraft 版本。
    pub game_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    /// 来源快照。
    pub origin: ManifestOrigin,
    /// 文件清单（按 `path` 排序，保证序列化稳定、便于 diff 与测试）。
    pub files: Vec<HostedFile>,
}

/// 实例版本目录（`{gameDir}/versions/{name}`）。`game_dir` 为相对路径时按
/// `QOMICEX_HOME` 解析，与 [`crate::services::instance`] 的既有语义一致。
pub fn instance_version_dir(game_dir: &str, instance_name: &str) -> PathBuf {
    let root = if Path::new(game_dir).is_absolute() {
        PathBuf::from(game_dir)
    } else {
        crate::settings::resolve_base_dir().join(game_dir)
    };
    root.join("versions").join(instance_name)
}

/// 清单文件的绝对路径。
pub fn manifest_path(game_dir: &str, instance_name: &str) -> PathBuf {
    instance_version_dir(game_dir, instance_name)
        .join(QOMICEX_DIR)
        .join(MANIFEST_FILE)
}

/// 读取清单。文件缺失 / 解析失败 / schema 版本不认识 → `None`
/// （调用方据此判定「不可更新」，绝不因清单损坏而报错阻断其它功能）。
pub fn load_manifest(game_dir: &str, instance_name: &str) -> Option<ModpackManifest> {
    let path = manifest_path(game_dir, instance_name);
    let content = std::fs::read_to_string(&path).ok()?;
    let manifest: ModpackManifest = serde_json::from_str(&content).ok()?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        tracing::warn!(
            path = %path.display(),
            found = manifest.schema_version,
            expected = MANIFEST_SCHEMA_VERSION,
            "整合包清单 schema 版本不匹配，按不可更新处理"
        );
        return None;
    }
    Some(manifest)
}

/// 写入清单（原子替换：先写 `.tmp` 再 rename，避免半截 JSON）。
///
/// 写入失败只返回 `Err`，由调用方决定是否降级为告警 —— 安装已经完成，
/// 清单写不出来不该让一次成功的安装报失败。
pub fn save_manifest(
    game_dir: &str,
    instance_name: &str,
    manifest: &ModpackManifest,
) -> Result<(), String> {
    let path = manifest_path(game_dir, instance_name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建清单目录失败 {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("序列化整合包清单失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入清单临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        // 跨设备/被占用时 rename 可能失败：清理 tmp，避免残留误导下次读取。
        let _ = std::fs::remove_file(&tmp);
        format!("替换清单文件失败 {}: {e}", path.display())
    })
}

/// 归一化为清单内的相对路径形式：统一 `/` 分隔、去掉 `./` 前缀。
///
/// ⚠️ **本函数不是安全边界**：它会剥掉前导 `/`，即 `/etc/passwd` 会变成
/// `etc/passwd`。任何来自包索引/外部输入的路径必须先过 [`is_safe_rel_path`]，
/// 不能只靠本函数「净化」。当前唯一用途是把已通过校验的路径规范化以便存储比较。
pub fn normalize_rel_path(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

/// 路径安全校验：拒绝绝对路径、`..`、Windows 盘符与 UNC。
///
/// 所有来自包索引的路径在落到磁盘前都必须过这一关（zip-slip 防护，
/// 与 `multimc.rs` 的 `enclosed_name()` 思路一致）。
///
/// 绝对路径判定必须在归一化**之前**做：`normalize_rel_path` 会剥掉前导 `/`，
/// 若先归一化再判，`/etc/passwd` 会被当成合法的相对路径 `etc/passwd` 放行。
pub fn is_safe_rel_path(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    // POSIX 绝对路径：前导 `/`（含 `//` UNC 形态）直接拒绝。
    if rel.starts_with('/') || rel.starts_with('\\') {
        return false;
    }
    // Windows 盘符（`C:`）与 UNC（`\\server`）。
    let bytes = rel.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let normalized = normalize_rel_path(rel);
    if normalized.is_empty() {
        return false;
    }
    // 逐段检查：任何 `..` 段即拒绝（`a/../b` 也不放行，宁可保守）。
    normalized
        .split('/')
        .all(|seg| !seg.is_empty() && seg != ".." && seg != ".")
}

/// 该相对路径是否属于「永不触碰」的范围（存档）。
///
/// issue #118 明确要求更新不得影响存档；`saves/` 一律跳过，既不写也不删。
pub fn is_protected_path(rel: &str) -> bool {
    let n = normalize_rel_path(rel).to_ascii_lowercase();
    n == "saves" || n.starts_with("saves/")
}

/// 对实例根目录下的一组相对路径计算 SHA-1，产出清单文件条目。
///
/// 逐个读盘计算而非复用下载前的哈希：下载分支与 overrides 解压分支**并发**执行，
/// 同名文件可能互相覆盖，只有读取最终落盘结果才反映真实状态。
///
/// - 不存在的路径直接跳过（下载被跳过 / 用户删除）；
/// - 受保护路径（`saves/`）永不入清单；
/// - `kind` 由调用方按来源（下载计划 / overrides）给出。
pub fn collect_hosted_files(
    instance_dir: &Path,
    candidates: impl IntoIterator<Item = (String, HostedFileKind)>,
) -> Vec<HostedFile> {
    let mut out: Vec<HostedFile> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (raw, kind) in candidates {
        if !is_safe_rel_path(&raw) || is_protected_path(&raw) {
            continue;
        }
        let rel = normalize_rel_path(&raw);
        // 同路径可能同时来自下载计划与 overrides（并发写同名文件）；只记一次，
        // 后出现的类别不覆盖先出现的——两者哈希相同（读的都是最终落盘字节）。
        if !seen.insert(rel.clone()) {
            continue;
        }
        let abs = instance_dir.join(&rel);
        if !abs.is_file() {
            continue;
        }
        match sha1_file_hex(&abs) {
            Ok(sha1) => out.push(HostedFile { path: rel, sha1, kind }),
            Err(e) => {
                tracing::warn!(path = %abs.display(), error = %e, "整合包清单：文件哈希失败，已跳过");
            }
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-manifest-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn safe_rel_path_rejects_escapes() {
        // 正常相对路径放行
        assert!(is_safe_rel_path("mods/sodium.jar"));
        assert!(is_safe_rel_path("config/a/b.toml"));
        assert!(is_safe_rel_path("mods/sub dir/x.jar"));

        // 绝对路径 / 盘符 / UNC / 上跳 一律拒绝
        assert!(!is_safe_rel_path("/etc/passwd"));
        assert!(!is_safe_rel_path("C:/Windows/system32"));
        assert!(!is_safe_rel_path("c:relative"));
        assert!(!is_safe_rel_path("//server/share/x"));
        assert!(!is_safe_rel_path("../outside.jar"));
        assert!(!is_safe_rel_path("mods/../../etc/passwd"));
        assert!(!is_safe_rel_path("mods/./x.jar"));
        assert!(!is_safe_rel_path(""));
    }

    /// 回归：绝对路径判定必须在归一化之前。
    ///
    /// `normalize_rel_path` 会剥掉前导 `/`，若先归一化再判，`/etc/passwd`
    /// 会被静默当成合法相对路径 `etc/passwd` 放行 —— 这是一条真实的路径逃逸。
    #[test]
    fn safe_rel_path_rejects_absolute_before_normalizing() {
        assert!(!is_safe_rel_path("/etc/passwd"));
        assert!(!is_safe_rel_path("\\Windows\\system32\\drivers\\etc\\hosts"));
        assert!(!is_safe_rel_path("//attacker/share"));
        // 同时确认归一化函数本身确实会剥掉前导斜杠（即它不是安全边界）
        assert_eq!(normalize_rel_path("/etc/passwd"), "etc/passwd");
    }

    #[test]
    fn protected_path_covers_saves_only() {
        assert!(is_protected_path("saves"));
        assert!(is_protected_path("saves/world/level.dat"));
        assert!(is_protected_path("Saves/World/level.dat")); // 大小写不敏感
        assert!(is_protected_path("saves\\world\\level.dat")); // 反斜杠同样识别
        // 前缀相似但不属于 saves 的不能被误保护
        assert!(!is_protected_path("saves_backup/x.dat"));
        assert!(!is_protected_path("mods/saves.jar"));
        assert!(!is_protected_path("config/saves.toml"));
    }

    #[test]
    fn normalize_rel_path_unifies_separators() {
        assert_eq!(normalize_rel_path("mods\\a.jar"), "mods/a.jar");
        assert_eq!(normalize_rel_path("./mods/a.jar"), "mods/a.jar");
        assert_eq!(normalize_rel_path("mods/a.jar"), "mods/a.jar");
    }

    #[test]
    fn collect_hosted_files_hashes_skips_missing_and_saves() {
        let dir = temp_dir("collect");
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::create_dir_all(dir.join("saves/world")).unwrap();
        std::fs::write(dir.join("mods/a.jar"), b"aaa").unwrap();
        std::fs::write(dir.join("mods/b.jar"), b"bbb").unwrap();
        std::fs::write(dir.join("saves/world/level.dat"), b"world").unwrap();
        std::fs::write(dir.join("config.toml"), b"cfg").unwrap();

        let files = collect_hosted_files(
            &dir,
            vec![
                ("mods/a.jar".to_string(), HostedFileKind::Content),
                ("mods/b.jar".to_string(), HostedFileKind::Content),
                ("mods/missing.jar".to_string(), HostedFileKind::Content), // 不存在 → 跳过
                ("saves/world/level.dat".to_string(), HostedFileKind::Override), // 存档 → 跳过
                ("../escape.jar".to_string(), HostedFileKind::Content), // 逃逸 → 跳过
                ("config.toml".to_string(), HostedFileKind::Override),
            ],
        );

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["config.toml", "mods/a.jar", "mods/b.jar"]);
        // 排序稳定（按 path 字典序）
        assert!(files.windows(2).all(|w| w[0].path <= w[1].path));
        // 哈希确实是 SHA-1("aaa")（实测参考值，非手写）
        let a = files.iter().find(|f| f.path == "mods/a.jar").unwrap();
        assert_eq!(a.sha1, "7e240de74fb1ed08fa08d38063f6a6a91462a815");
        assert_eq!(a.kind, HostedFileKind::Content);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_hosted_files_dedups_same_path() {
        let dir = temp_dir("dedup");
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join("config/dup.toml"), b"same").unwrap();

        // 同一路径同时来自下载计划与 overrides → 只记一次
        let files = collect_hosted_files(
            &dir,
            vec![
                ("config/dup.toml".to_string(), HostedFileKind::Content),
                ("config\\dup.toml".to_string(), HostedFileKind::Override),
            ],
        );
        assert_eq!(files.len(), 1, "同一路径应去重: {files:?}");
        assert_eq!(files[0].kind, HostedFileKind::Content);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_and_load_manifest_roundtrip() {
        let home = temp_dir("roundtrip");
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let game_dir = "games/mc";
        let name = "TestPack";
        let version_dir = instance_version_dir(game_dir, name);
        std::fs::create_dir_all(version_dir.join("mods")).unwrap();
        std::fs::write(version_dir.join("mods/x.jar"), b"x").unwrap();

        let manifest = ModpackManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            game_version: "1.20.1".to_string(),
            loader: Some("forge".to_string()),
            loader_version: Some("47.1.0".to_string()),
            origin: ManifestOrigin {
                source: Some("curseforge".to_string()),
                project_id: Some("123".to_string()),
                version_id: Some("456".to_string()),
                origin: Some("resource-center".to_string()),
                version_published_at: Some("2026-01-01T00:00:00Z".to_string()),
            },
            files: collect_hosted_files(
                &version_dir,
                vec![("mods/x.jar".to_string(), HostedFileKind::Content)],
            ),
        };
        save_manifest(game_dir, name, &manifest).unwrap();

        let loaded = load_manifest(game_dir, name).expect("清单应可读回");
        assert_eq!(loaded, manifest);
        assert_eq!(loaded.origin.origin.as_deref(), Some("resource-center"));
        assert_eq!(loaded.files.len(), 1);

        // 清单缺失 → None（判定不可更新，不报错）
        assert!(load_manifest(game_dir, "NoSuchInstance").is_none());

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn load_manifest_rejects_unknown_schema_version() {
        let home = temp_dir("schema");
        let old_home = std::env::var_os("QOMICEX_HOME");
        std::env::set_var("QOMICEX_HOME", &home);

        let path = manifest_path("games/mc", "Pack");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":99,"gameVersion":"1.20.1","origin":{},"files":[]}"#,
        )
        .unwrap();

        assert!(
            load_manifest("games/mc", "Pack").is_none(),
            "未知 schema 版本必须按不可更新处理"
        );

        match old_home {
            Some(v) => std::env::set_var("QOMICEX_HOME", v),
            None => std::env::remove_var("QOMICEX_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
