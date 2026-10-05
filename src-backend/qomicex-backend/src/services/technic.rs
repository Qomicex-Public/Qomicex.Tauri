//! Technic SingleZip 整合包探测与元数据解析（issue #123 期1）。
//!
//! SingleZip：单个 zip，zip 根目录内容**就是** minecraft 目录（`bin/`、`mods/`、
//! `config/`…）。探测特征：中央目录含 `bin/modpack.jar` 或 `bin/version.json`。
//!
//! 转换算法对齐 Prism `TechnicPackProcessor.cpp`：
//! - MC 版本 = `bin/version.json`（或 modpack.jar **内** `version.json`）的
//!   `inheritsFrom`；缺失时 jar 内 `fmlversion.properties` 的 `fmlbuild.mcversion` 兜底。
//! - loader 识别：遍历 version.json `libraries[]` 的 maven 坐标，匹配
//!   forge / fabric / quilt / neoforge 特征，取出 loader 版本交给标准安装管线
//!   （`run_install_pipeline`）安装 game + loader。
//! - `modpack.jar` 内**无** `version.json` 的古董包需要 jarmod 注入（QML core
//!   版本 JSON 体系无此概念）→ 报 [`JARMOD_UNSUPPORTED`]，由 #180 承接。
//!
//! 本模块只做「探测 + 解析 + 识别」，返回纯数据；zip 解压、版本 JSON 构建
//! （Mojang base 由 `run_install_pipeline` 经 core 拉）、内容拷贝由调用方
//! `endpoints/modpack.rs` 的 technic 导入管线完成。

use std::io::Read;
use std::path::Path;

use serde_json::Value;

/// 古董包（jar 内无 version.json）在**未实现 JarMod 前**的拒绝错误码。
///
/// 期2（#180）起该路径已支持：保留常量仅用于历史错误串的兼容识别（release notes /
/// 用户历史日志里可能出现），新代码不应再产生它。
pub const JARMOD_UNSUPPORTED: &str = "TECHNIC_JARMOD_UNSUPPORTED";

/// Technic 包元数据（解析结果，前端预览 + 导入管线共用）。
#[derive(Debug, Clone, PartialEq)]
pub struct TechnicMeta {
    /// 实例名：bin/version.json `name` 缺失时退化为 zip 文件名（调用方回退）。
    pub name: Option<String>,
    /// MC 版本（`inheritsFrom`，fmlversion.properties 兜底）。
    pub game_version: String,
    /// 识别出的加载器（小写，run_install_pipeline 可直接消费；无 loader 为 None）。
    pub loader: Option<String>,
    /// 加载器版本。
    pub loader_version: Option<String>,
    /// 是否需要把 `bin/modpack.jar` 作为 **JarMod** 注入（issue #180）。
    ///
    /// 仅古董包（jar 内无 `version.json`）为 `true`；标准包的内容已在包根 `mods/` 等
    /// 目录就位，jar 本体不注入（对齐 Prism 只消费 version.json 的行为）。
    pub jarmod: bool,
}

/// 探测 zip 是否为 Technic SingleZip 包。
///
/// 只读中央目录（`file_names()`）而不 `by_index()`：后者会为每个条目 seek 并读
/// 本地文件头，大包（issue #119）下探测本身就会退化成上万次随机读。
pub fn is_technic_zip(zip_path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(zip_path) else {
        return false;
    };
    let Ok(archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    for name in archive.file_names() {
        if name == "bin/modpack.jar" || name == "bin/version.json" {
            return true;
        }
    }
    false
}

/// modpack.jar 读入内存的上限（CodeRabbit review：zip 压缩比攻击面）。
/// Technic modpack.jar 实际为 2~20 MB 级（多为合并的 Forge universal + 基础库），
/// 256 MiB 上限留足余量且杜绝 4 GiB 级炸压。
const MAX_JAR_BYTES: u64 = 256 * 1024 * 1024;

/// 元数据条目（version.json / fmlversion.properties）解压后字节上限。
/// 真实 version.json 为 KB 级；1 MiB 覆盖一切合法包且防炸压。
pub(crate) const MAX_METADATA_ENTRY_BYTES: u64 = 1024 * 1024;

/// 有界读字符串：超过 [`MAX_METADATA_ENTRY_BYTES`] 视为非法条目返回 None。
pub(crate) fn read_bounded_string<R: std::io::Read>(entry: &mut R) -> Option<String> {
    let mut bytes = Vec::new();
    std::io::Read::take(entry, MAX_METADATA_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_METADATA_ENTRY_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// 从 Technic SingleZip 包解析元数据（探测已由调用方完成）。
///
/// 读取顺序对齐 Prism `TechnicPackProcessor`：
/// 1. `bin/version.json` 存在 → 直接用（部分包把 version.json 放 zip 根 bin/ 下）；
/// 2. 否则打开 `bin/modpack.jar`：
///    - jar 内有 `version.json` → 用 jar 内的（Technic 1.5.2+ 标准包；真实包
///      实测如 Agrarian Skies：jar 内 version.json **无** `inheritsFrom`，MC 版本
///      由 jar 内 `fmlversion.properties` 的 `fmlbuild.mcversion` 兜底）；
///    - jar 内无 `version.json` → 古董包：Prism 走 installJarMods 注入路线
///      （含 fmlversion/forgeversion.properties 解析），QML 无 jarmod 能力，
///      明确报 [`JARMOD_UNSUPPORTED`]（#180）。
/// 3. 两者都缺失 → 非法包（bin/ 探测命中但条目不可读）。
pub fn parse_technic_zip(zip_path: &Path) -> Result<TechnicMeta, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开整合包文件失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;

    if let Ok(mut entry) = archive.by_name("bin/version.json") {
        let content = read_bounded_string(&mut entry)
            .ok_or_else(|| "读取 bin/version.json 失败或超出 1 MiB 限制".to_string())?;
        let root: Value = serde_json::from_str(&content)
            .map_err(|e| format!("解析 bin/version.json 失败: {e}"))?;
        return meta_from_version_json(&root, None);
    }

    // bin/version.json 不在 zip 根：打开 modpack.jar 找
    let mut jar = archive
        .by_name("bin/modpack.jar")
        .map_err(|_| "整合包缺少 bin/modpack.jar".to_string())?;
    // 大小预检 + take 双保险（中央目录的 size 由包作者控制，不可信）。
    if jar.size() > MAX_JAR_BYTES {
        return Err(format!(
            "bin/modpack.jar 过大（{} MiB，上限 256 MiB），疑似异常包",
            jar.size() / 1024 / 1024
        ));
    }
    let mut jar_bytes = Vec::new();
    std::io::Read::take(&mut jar, MAX_JAR_BYTES)
        .read_to_end(&mut jar_bytes)
        .map_err(|e| format!("读取 bin/modpack.jar 失败: {e}"))?;
    drop(jar);
    let mut inner = zip::ZipArchive::new(std::io::Cursor::new(&jar_bytes))
        .map_err(|e| format!("bin/modpack.jar 不是有效的 zip: {e}"))?;

    // 先判存在再读（借用分两段，避免 entry 借用与 fml 读取冲突）
    let has_version_json = inner.by_name("version.json").is_ok();
    if has_version_json {
        let content = {
            let mut entry = inner
                .by_name("version.json")
                .map_err(|e| format!("读取 modpack.jar 内 version.json 失败: {e}"))?;
            read_bounded_string(&mut entry).ok_or_else(|| {
                "读取 modpack.jar 内 version.json 失败或超出 1 MiB 限制".to_string()
            })?
        };
        let root: Value = serde_json::from_str(&content)
            .map_err(|e| format!("解析 modpack.jar 内 version.json 失败: {e}"))?;
        // fml 兜底 MC 版本（Prism 同款）：version.json 的 inheritsFrom 缺失时，
        // 用 jar 内 fmlversion.properties 的 fmlbuild.mcversion。
        let fml_mc = read_fml_mcversion(&mut inner);
        return meta_from_version_json(&root, fml_mc.as_deref());
    }

    // === 古董包：jar 内无 version.json → 需要 JarMod 注入（issue #180）===
    // Prism 行为（`TechnicPackProcessor.cpp`）：net.minecraft + installJarMods({modpack.jar})，
    // MC 版本走 fmlversion.properties，Forge 版本走 forgeversion.properties。
    // QML 侧对应实现：把 jar 作为 jarmod 落盘 + 在版本 JSON 声明 `jarmods`，
    // 由 core 启动链合并出派生 jar（见 qomicex-core-rust/src/services/jarmod.rs）。
    let game_version = read_fml_mcversion(&mut inner).unwrap_or_default();
    if game_version.is_empty() {
        return Err(
            "TECHNIC_ANCIENT_PACK_NO_VERSION: modpack.jar 内无 version.json，且 \
             fmlversion.properties 缺少 fmlbuild.mcversion（无法确定 Minecraft 版本）"
                .to_string(),
        );
    }
    // Forge 版本：forge.major.minor.revision.build（Prism 同款拼接）。
    let loader_version = read_forge_version(&mut inner);
    let (loader, loader_version) = match loader_version {
        Some(v) => (Some("forge".to_string()), Some(v)),
        // 无 forgeversion.properties：可能是不带 Forge 的纯 jarmod 包（F1b 夹具场景）
        None => (None, None),
    };
    Ok(TechnicMeta {
        name: None,
        game_version,
        loader,
        loader_version,
        // 古董包必须注入 modpack.jar 本体（这是它唯一的 mod 载体）
        jarmod: true,
    })
}

/// 读 jar 内 `forgeversion.properties` 并拼出 Forge 版本（Prism `TechnicPackProcessor` 同款）。
///
/// 拼法：`{forge.major.number}.{forge.minor.number}.{forge.revision.number}.{forge.build.number}`
/// （如 9.11.1.965）。任一字段缺失/非数字 → `None`（宁可不识别 loader，也不要拼出一个
/// 不存在的版本号让安装管线去 404）。
fn read_forge_version<R: std::io::Read + std::io::Seek>(
    inner: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let mut entry = inner.by_name("forgeversion.properties").ok()?;
    let content = read_bounded_string(&mut entry)?;
    let mut major = None;
    let mut minor = None;
    let mut revision = None;
    let mut build = None;
    for line in content.lines() {
        let line = line.trim();
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "forge.major.number" => major = Some(v.to_string()),
            "forge.minor.number" => minor = Some(v.to_string()),
            "forge.revision.number" => revision = Some(v.to_string()),
            "forge.build.number" => build = Some(v.to_string()),
            _ => {}
        }
    }
    // 四个字段必须齐备**且都是数字**才拼版本号（与函数注释的承诺一致）。
    //
    // 只查非空是不够的：`forge.major.number=abc` 这类畸形属性文件会拼出
    // `abc.11.1.965` 并被交给安装管线去下载一个不存在的 Forge 版本，最终报出难以理解
    // 的 404（CodeRabbit PR #190 finding）。宁可识别不出 loader，也不要造出假版本号。
    let parts = [major?, minor?, revision?, build?];
    if parts.iter().any(|p| !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    Some(format!(
        "{}.{}.{}.{}",
        parts[0], parts[1], parts[2], parts[3]
    ))
}

/// 读 jar 内 `fmlversion.properties` 的 `fmlbuild.mcversion`（INI 风格，键名精确
/// 匹配；Prism 用 INIFile 语义，等价于首个 `fmlbuild.mcversion=<v>` 行）。
fn read_fml_mcversion<R: std::io::Read + std::io::Seek>(
    inner: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let mut entry = inner.by_name("fmlversion.properties").ok()?;
    let content = read_bounded_string(&mut entry)?;
    for line in content.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("fmlbuild.mcversion=") {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// 从 version.json（zip 根 bin/ 或 modpack.jar 内）提取元数据。
///
/// MC 版本 = `inheritsFrom`，缺失时用 `fml_mc_version`（jar 内
/// fmlversion.properties 的 `fmlbuild.mcversion`，Prism 同款兜底）；
/// loader 由 `libraries[]` 坐标识别；`name` 为展示名（缺失时调用方退化为
/// zip 文件名）。
fn meta_from_version_json(
    root: &Value,
    fml_mc_version: Option<&str>,
) -> Result<TechnicMeta, String> {
    let game_version = root
        .get("inheritsFrom")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or(fml_mc_version)
        .unwrap_or_default()
        .to_string();
    if game_version.is_empty() {
        return Err(
            "version.json 缺少 inheritsFrom 且无 fmlversion.properties 兜底（无法确定 Minecraft 版本）"
                .to_string(),
        );
    }
    let (loader, loader_version) = detect_loader(root);
    let name = root
        .get("name")
        .and_then(Value::as_str)
        .map(String::from)
        .filter(|s| !s.is_empty());
    Ok(TechnicMeta {
        name,
        game_version,
        loader,
        loader_version,
        // 标准包（jar 内含 version.json）：内容在包根 mods/ 等目录已就位，
        // jar 本体**不注入**（对齐 Prism 只消费 version.json 的行为）。
        jarmod: false,
    })
}

/// classify（拖拽分类）专用薄包装：只取 loader 名（Option<String>）。
pub fn detect_loader_for_classify(root: &Value) -> (Option<String>, Option<String>) {
    detect_loader(root)
}

/// 遍历 version.json `libraries[]` 坐标识别 loader（对齐 Prism `TechnicPackProcessor`）。
///
/// 命中顺序：neoforge（需从 game 参数反查版本）→ forge（fmlloader/forge/
/// minecraftforge 坐标）→ fabric → quilt。多 loader 并存时取首个命中
/// （Prism 为逐个 setComponentVersion；实际包内不会混装）。
fn detect_loader(root: &Value) -> (Option<String>, Option<String>) {
    let libraries = match root.get("libraries").and_then(Value::as_array) {
        Some(a) => a,
        None => return (None, None),
    };

    for lib in libraries {
        let Some(name) = lib.get("name").and_then(Value::as_str) else {
            continue;
        };
        // neoforge：坐标无法直接给版本，从 arguments.game 的 --fml.neoForgeVersion /
        // --fml.forgeVersion 后随参数取（Prism 同款； Technic 时代的包不会有，
        // 仅为前向兼容保留）。
        if name.starts_with("net.neoforged.fancymodloader:") {
            let mut prev_flag = false;
            let mut ver: Option<String> = None;
            if let Some(args) = root
                .get("arguments")
                .and_then(|a| a.get("game"))
                .and_then(Value::as_array)
            {
                for a in args {
                    let s = a.as_str().unwrap_or_default();
                    if prev_flag {
                        ver = Some(s.to_string());
                        break;
                    }
                    prev_flag = s == "--fml.neoForgeVersion" || s == "--fml.forgeVersion";
                }
            }
            if let Some(v) = ver.filter(|s| !s.is_empty()) {
                return (Some("neoforge".to_string()), Some(v));
            }
            continue;
        }
        // forge：fmlloader / forge / minecraftforge 坐标
        if name.starts_with("net.minecraftforge:fmlloader:")
            || name.starts_with("net.minecraftforge:forge:")
        {
            return (Some("forge".to_string()), Some(forge_version_from(name)));
        }
        if name.starts_with("net.minecraftforge:minecraftforge:") {
            return (Some("forge".to_string()), Some(forge_version_from(name)));
        }
        if name.starts_with("net.fabricmc:fabric-loader:") {
            let v = name.split(':').nth(2).unwrap_or_default().to_string();
            return (Some("fabric".to_string()), non_empty(v));
        }
        if name.starts_with("org.quiltmc:quilt-loader:") {
            let v = name.split(':').nth(2).unwrap_or_default().to_string();
            return (Some("quilt".to_string()), non_empty(v));
        }
    }
    (None, None)
}

/// 从 forge 库坐标提取 loader 版本。
///
/// 坐标版本段形如：
/// - `1.7.10-10.13.4.1614-1.7.10`（MC-forge-MC 双后缀）→ 取倒数第二段
///   `10.13.4.1614`（Prism `section('-', 1, 1)` 等价语义：首个 `-` 后到
///   末个 `-` 前）；
/// - `1.7.10-14.23.5.2859`（MC-forge）→ 取末段 `14.23.5.2859`；
/// - `7.8.1.738` / `9.10.1.868`（无 MC 前缀的老坐标）→ 原样。
///
/// 统一规则：**以最后一个 `-` 分段**——最后一段是与 MC 同形的回显（或不存在）
/// 时取倒数第二段，否则取最后一段；再校验首段是否 MC 版本形（`1.x`）以跳过
/// 无前缀坐标。
fn forge_version_from(name: &str) -> String {
    let version = name.split(':').nth(2).unwrap_or_default();
    let parts: Vec<&str> = version.split('-').collect();
    if parts.len() < 2 {
        return version.to_string();
    }
    // 首段必须是 `1.x` 形（MC 版本前缀），否则整个版本串就是 forge 版本
    // （如 `7.8.1.738` 不带前缀的情况实际不会带 `-`，此处防御 `9.x-1` 类）。
    let first_is_mc = parts[0].starts_with("1.") && parts[0].split('.').count() >= 2;
    if !first_is_mc {
        return version.to_string();
    }
    // `1.7.10-10.13.4.1614-1.7.10`：末段与首段相同（MC 回显）→ 倒数第二段
    if parts.len() >= 3 && parts[parts.len() - 1] == parts[0] {
        return parts[parts.len() - 2].to_string();
    }
    // `1.7.10-14.23.5.2859`：末段即 forge 版本
    parts[parts.len() - 1].to_string()
}

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn vjson(inherits: &str, libs: &[&str]) -> Value {
        let libraries: Vec<Value> = libs
            .iter()
            .map(|n| serde_json::json!({ "name": n }))
            .collect();
        serde_json::json!({ "inheritsFrom": inherits, "libraries": libraries })
    }

    #[test]
    fn detect_forge_modern() {
        let root = vjson(
            "1.7.10",
            &["net.minecraftforge:fmlloader:1.7.10-14.23.5.2859"],
        );
        let (loader, ver) = detect_loader(&root);
        assert_eq!(loader.as_deref(), Some("forge"));
        assert_eq!(ver.as_deref(), Some("14.23.5.2859"));
    }

    #[test]
    fn detect_forge_1710_double_dash() {
        // `1.7.10-10.13.4.1614-1.7.10` → 取第一段
        let root = vjson(
            "1.7.10",
            &["net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10"],
        );
        let (loader, ver) = detect_loader(&root);
        assert_eq!(loader.as_deref(), Some("forge"));
        assert_eq!(ver.as_deref(), Some("10.13.4.1614"));
    }

    #[test]
    fn detect_forge_legacy_coordinate() {
        let root = vjson("1.5.2", &["net.minecraftforge:minecraftforge:7.8.1.738"]);
        let (loader, ver) = detect_loader(&root);
        assert_eq!(loader.as_deref(), Some("forge"));
        assert_eq!(ver.as_deref(), Some("7.8.1.738"));
    }

    #[test]
    fn detect_fabric_and_quilt() {
        let root = vjson("1.20.1", &["net.fabricmc:fabric-loader:0.15.11"]);
        assert_eq!(detect_loader(&root).0.as_deref(), Some("fabric"));
        let root = vjson("1.20.1", &["org.quiltmc:quilt-loader:0.26.0"]);
        assert_eq!(detect_loader(&root).0.as_deref(), Some("quilt"));
    }

    #[test]
    fn detect_neoforge_via_game_args() {
        let mut root = vjson("1.20.4", &["net.neoforged.fancymodloader:loader:2.3.1"]);
        root["arguments"]["game"] = serde_json::json!(["--fml.neoForgeVersion", "20.4.237"]);
        let (loader, ver) = detect_loader(&root);
        assert_eq!(loader.as_deref(), Some("neoforge"));
        assert_eq!(ver.as_deref(), Some("20.4.237"));
    }

    #[test]
    fn detect_vanilla_no_libraries() {
        let root = vjson("1.6.4", &[]);
        let (loader, ver) = detect_loader(&root);
        assert!(loader.is_none());
        assert!(ver.is_none());
    }

    #[test]
    fn meta_requires_inherits_from() {
        let root = serde_json::json!({ "name": "x", "libraries": [] });
        assert!(meta_from_version_json(&root, None).is_err());
    }

    #[test]
    fn meta_falls_back_to_fml_mcversion() {
        // 真实场景（Agrarian Skies，issue #123 期1 实测发现）：
        // modpack.jar 内 version.json 无 inheritsFrom，靠 fmlversion.properties
        // 的 fmlbuild.mcversion 兜底 MC 版本；loader 从 libraries 坐标识别。
        let root = serde_json::json!({
            "id": "1.6.4-Forge9.11.1.965",
            "libraries": [ { "name": "net.minecraftforge:minecraftforge:9.11.1.965" } ]
        });
        let meta = meta_from_version_json(&root, Some("1.6.4")).unwrap();
        assert_eq!(meta.game_version, "1.6.4");
        assert_eq!(meta.loader.as_deref(), Some("forge"));
        assert_eq!(meta.loader_version.as_deref(), Some("9.11.1.965"));
        // 无兜底则报错
        assert!(meta_from_version_json(&root, None).is_err());
    }

    #[test]
    fn forge_version_plain() {
        assert_eq!(
            forge_version_from("net.minecraftforge:forge:9.10.1.868"),
            "9.10.1.868"
        );
        assert_eq!(
            forge_version_from("net.minecraftforge:fmlloader:1.12.2-14.23.5.2859"),
            "14.23.5.2859"
        );
    }

    // -----------------------------------------------------------------------
    // zip 级集成测试（真实 zip 夹具走 is_technic_zip + parse_technic_zip）
    // -----------------------------------------------------------------------

    /// 测试专用临时目录。
    fn temp_zip_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qml-technic-test-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 构造一个嵌套 zip（technic 包 zip 内的 modpack.jar，jar 内再含若干条目）。
    fn build_modpack_jar(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(buf);
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        let cursor = zip.finish().unwrap();
        cursor.into_inner()
    }

    /// 构造 SingleZip 包：entries 为 zip 根条目。
    fn write_technic_zip(dir: &Path, entries: &[(&str, Vec<u8>)]) -> std::path::PathBuf {
        let zip_path = dir.join("pack.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, data) in entries {
            zip.start_file(name.to_string(), zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        zip_path
    }

    const FORGE_1710_VERSION_JSON: &str = r#"{
        "name": "TestForgePack",
        "inheritsFrom": "1.7.10",
        "libraries": [
            {"name": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10"},
            {"name": "com.mojang:minecraft:1.7.10"}
        ]
    }"#;

    #[test]
    fn is_technic_zip_detects_modpack_jar() {
        let dir = temp_zip_dir("detect-jar");
        let zip_path = write_technic_zip(
            &dir,
            &[
                ("bin/modpack.jar", build_modpack_jar(&[])),
                ("mods/a.jar", b"dummy".to_vec()),
            ],
        );
        assert!(super::is_technic_zip(&zip_path));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn is_technic_zip_detects_bin_version_json() {
        let dir = temp_zip_dir("detect-vjson");
        let zip_path = write_technic_zip(
            &dir,
            &[(
                "bin/version.json",
                br#"{"inheritsFrom":"1.6.4","libraries":[]}"#.to_vec(),
            )],
        );
        assert!(super::is_technic_zip(&zip_path));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn is_technic_zip_rejects_other_packs() {
        let dir = temp_zip_dir("reject");
        let zip_path = write_technic_zip(
            &dir,
            &[
                (
                    "modrinth.index.json",
                    br#"{"game":"minecraft","files":[]}"#.to_vec(),
                ),
                ("mods/a.jar", b"dummy".to_vec()),
            ],
        );
        assert!(!super::is_technic_zip(&zip_path));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_from_zip_root_bin_version_json() {
        // bin/version.json 在 zip 根：直接读
        let dir = temp_zip_dir("root-vjson");
        let zip_path = write_technic_zip(
            &dir,
            &[
                (
                    "bin/version.json",
                    FORGE_1710_VERSION_JSON.as_bytes().to_vec(),
                ),
                ("mods/a.jar", b"dummy".to_vec()),
            ],
        );
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert_eq!(meta.name.as_deref(), Some("TestForgePack"));
        assert_eq!(meta.game_version, "1.7.10");
        assert_eq!(meta.loader.as_deref(), Some("forge"));
        assert_eq!(meta.loader_version.as_deref(), Some("10.13.4.1614"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_from_modpack_jar_inner_version_json() {
        // 标准 Technic 包：version.json 在 modpack.jar 内
        let dir = temp_zip_dir("jar-vjson");
        let jar = build_modpack_jar(&[
            ("version.json", FORGE_1710_VERSION_JSON.as_bytes()),
            (
                "fmlversion.properties",
                b"fmlbuild.mcversion=1.7.10\n".as_slice(),
            ),
        ]);
        let zip_path = write_technic_zip(
            &dir,
            &[("bin/modpack.jar", jar), ("mods/b.jar", b"dummy".to_vec())],
        );
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert_eq!(meta.name.as_deref(), Some("TestForgePack"));
        assert_eq!(meta.game_version, "1.7.10");
        assert_eq!(meta.loader.as_deref(), Some("forge"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_ancient_pack_uses_fml_and_marks_jarmod() {
        // 古董包（issue #180）：jar 内无 version.json → MC 版本走 fmlversion.properties，
        // 并要求把 jar 本体作为 jarmod 注入。
        let dir = temp_zip_dir("ancient");
        let jar = build_modpack_jar(&[(
            "fmlversion.properties",
            b"fmlbuild.mcversion=1.4.7\n".as_slice(),
        )]);
        let zip_path = write_technic_zip(&dir, &[("bin/modpack.jar", jar)]);
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert_eq!(meta.game_version, "1.4.7");
        assert!(meta.jarmod, "古董包必须标记需要 jarmod 注入");
        // 无 forgeversion.properties → 不识别 loader（纯 jarmod 包）
        assert!(meta.loader.is_none());
        assert!(meta.loader_version.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_ancient_pack_reads_forge_version() {
        // 真实 Agrarian Skies 形态（F1a 夹具同款）：fmlversion.properties 给 MC，
        // forgeversion.properties 四个数字段拼出 Forge 版本（Prism 同款）。
        let dir = temp_zip_dir("ancient-forge");
        let jar = build_modpack_jar(&[
            (
                "fmlversion.properties",
                b"fmlbuild.mcversion=1.6.4\n".as_slice(),
            ),
            (
                "forgeversion.properties",
                b"forge.major.number=9\nforge.minor.number=11\nforge.revision.number=1\nforge.build.number=965\n"
                    .as_slice(),
            ),
        ]);
        let zip_path = write_technic_zip(&dir, &[("bin/modpack.jar", jar)]);
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert_eq!(meta.game_version, "1.6.4");
        assert_eq!(meta.loader.as_deref(), Some("forge"));
        assert_eq!(meta.loader_version.as_deref(), Some("9.11.1.965"));
        assert!(meta.jarmod);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_ancient_pack_incomplete_forge_version_yields_no_loader() {
        // forgeversion.properties 缺字段 → 不拼出半截版本号（否则安装管线会去 404）。
        // 这是「宁可不识别 loader，也不要造出不存在的版本」的回归护栏。
        let dir = temp_zip_dir("ancient-partial-forge");
        let jar = build_modpack_jar(&[
            (
                "fmlversion.properties",
                b"fmlbuild.mcversion=1.6.4\n".as_slice(),
            ),
            (
                "forgeversion.properties",
                b"forge.major.number=9\nforge.minor.number=11\n".as_slice(),
            ),
        ]);
        let zip_path = write_technic_zip(&dir, &[("bin/modpack.jar", jar)]);
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert_eq!(meta.game_version, "1.6.4");
        assert!(meta.loader.is_none(), "缺字段时不应识别出 loader");
        assert!(meta.jarmod);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_ancient_pack_non_numeric_forge_version_yields_no_loader() {
        // 四字段齐备但含非数字（畸形属性文件）→ 不得拼出 `abc.11.1.965` 这种假版本号
        // （CodeRabbit PR #190 finding：函数注释承诺非数字返回 None，实现须一致）。
        let dir = temp_zip_dir("ancient-nonnumeric-forge");
        let jar = build_modpack_jar(&[
            (
                "fmlversion.properties",
                b"fmlbuild.mcversion=1.6.4\n".as_slice(),
            ),
            (
                "forgeversion.properties",
                b"forge.major.number=abc\nforge.minor.number=11\nforge.revision.number=1\nforge.build.number=965\n"
                    .as_slice(),
            ),
        ]);
        let zip_path = write_technic_zip(&dir, &[("bin/modpack.jar", jar)]);
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert_eq!(meta.game_version, "1.6.4");
        assert!(
            meta.loader.is_none(),
            "非数字版本字段不应被拼成 Forge 版本号（否则安装管线会去下载不存在的版本）"
        );
        assert!(meta.jarmod);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_ancient_pack_without_fml_mcversion_is_error() {
        // 既无 version.json 又无 fmlbuild.mcversion → 无法确定 MC 版本，必须明确报错
        // （不能猜一个版本让后续安装乱跑）。
        let dir = temp_zip_dir("ancient-nofml");
        let jar = build_modpack_jar(&[("dummy.txt", b"x".as_slice())]);
        let zip_path = write_technic_zip(&dir, &[("bin/modpack.jar", jar)]);
        let err = super::parse_technic_zip(&zip_path).unwrap_err();
        assert!(
            err.contains("TECHNIC_ANCIENT_PACK_NO_VERSION"),
            "应明确报缺 MC 版本，实际: {err}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn standard_pack_is_not_marked_as_jarmod() {
        // 标准包（含 version.json）**不**需要 jarmod —— 这条断言保证 #180 的改动
        // 对期1 已支持的包零影响。
        let dir = temp_zip_dir("std-no-jarmod");
        let zip_path = write_technic_zip(
            &dir,
            &[(
                "bin/version.json",
                br#"{"inheritsFrom":"1.6.4","libraries":[]}"#.to_vec(),
            )],
        );
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert!(!meta.jarmod, "标准包不应标记 jarmod");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_vanilla_technic_pack_no_loader() {
        // 纯净包（bin/version.json 无 loader 库）
        let dir = temp_zip_dir("vanilla");
        let zip_path = write_technic_zip(
            &dir,
            &[(
                "bin/version.json",
                br#"{"inheritsFrom":"1.6.4","libraries":[]}"#.to_vec(),
            )],
        );
        let meta = super::parse_technic_zip(&zip_path).unwrap();
        assert_eq!(meta.game_version, "1.6.4");
        assert!(meta.loader.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
