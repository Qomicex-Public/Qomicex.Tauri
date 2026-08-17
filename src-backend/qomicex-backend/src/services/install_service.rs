//! 加载器安装流水线（对应源 `InstallTracker.RunInstallAsync` + `InstallLoader` +
//! `GetMissLoaderLibraries` + `ResolveAddonsAsync`）。
//!
//! 源 C# 通过 `GameCoreBuilder` 构造一次性 `GameCore`（`GameRoot = gameDir`、
//! `UseDownloadMirror(mirror)`），再调用 `Version`/`Locator`/`InstallerProvider`/
//! `Installer` 完成 vanilla + 加载器安装。Rust 侧同样用 `GameCoreBuilder` 构造
//! 临时 core（builder 对 installer_provider / installer_factory / locator 均有默认
//! 实现），因此整个流水线在本模块内完成，无需依赖全局 core。
//!
//! 下载统一走 `DownloadManager`（pause/resume/cancel 由事件循环协作），
//! 与源 `DownloadSession` 的语义对齐。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use qomicex_core::api::installer::InstallerFactory;
use qomicex_core::builder::GameCoreBuilder;
use qomicex_core::core::GameCore;
use qomicex_core::models::download::DownloadMirror;
use qomicex_core::models::installer::{MissFileInfo, ModLoaderType};
use qomicex_core::models::java::{JavaSearchMode, JavaSearchOptions, JavaState};
use qomicex_core::services::installers::factory::DefaultInstallerFactory;
use qomicex_core::services::installers::installer::{Installer, MissFileData};
use qomicex_downloader::{DownloadEvent, DownloadManager, DownloadTask, TaskState};
use serde_json::Value;

use crate::services::install_tracker::{InstallHandle, InstallStatus};

/// 安装流水线输入参数（由 `install_instance` 从 `InstallerRequest` + 实例组装）。
#[derive(Debug, Clone)]
pub struct InstallRequestData {
    /// 纯游戏版本号（如 "1.20.1"）。
    pub game_version: String,
    /// 实例目录（`instance.game_dir`，可能为相对路径）。
    pub game_dir: String,
    /// 版本隔离目录名（`instance.name`，如 "1.20.1-Forge-47.1.0"）。
    pub version_dir_name: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    pub addons: Vec<String>,
    pub download_threads: i32,
    pub version_isolation: bool,
    pub download_source_id: i32,
    pub optifine_version: Option<String>,
}

/// 附加文件（源 `AdditionalFile` record：Source / Identifier / RelativePath）。
#[derive(Debug, Clone)]
struct AdditionalFile {
    source: String,
    identifier: String,
    relative_path: String,
}

/// 需要 x-api-key 的 CurseForge 域名（源 `CfDomains`）。
const CF_DOMAINS: &[&str] = &[
    "forgecdn.net",
    "curseforge.com",
    "cursecdn.com",
    "edge.forgecdn.net",
    "media.forgecdn.net",
    "mediafilez.forgecdn.net",
];

/// 加载器默认附带 addon（源 `DefaultLoaderAddons`）。
fn default_loader_addons(loader: &str) -> &'static [&'static str] {
    match loader.to_ascii_lowercase().as_str() {
        "fabric" => &["fabric-api"],
        "quilt" => &["qsl"],
        _ => &[],
    }
}

/// 构建基于指定 game_dir 的一次性 core（install 流水线与 launch repair 共用；
/// 对应源 repair 阶段用 `GameCoreBuilder` 以 `gameDir` 为根重建 core，而非全局
/// settings 根目录 —— 修复源修复阶段路径错位的 bug）。
pub fn build_repair_core(
    game_dir: &str,
    download_source_id: i32,
    http_client: reqwest::Client,
) -> Arc<GameCore> {
    let game_root = absolute_path(game_dir);
    let mirror = if download_source_id == 1 {
        DownloadMirror::Bmclapi
    } else {
        DownloadMirror::Official
    };
    build_core(&game_root, mirror, http_client)
}

/// 运行完整安装流水线。成功返回 `Ok(())`；失败返回错误消息（runner 会置 failed）。
pub async fn run_install_pipeline(
    handle: &InstallHandle,
    download_manager: Arc<DownloadManager>,
    http_client: reqwest::Client,
    curse_forge_api_key: &str,
    data: InstallRequestData,
) -> Result<(), String> {
    let InstallRequestData {
        game_version,
        game_dir,
        version_dir_name,
        loader,
        loader_version,
        addons,
        download_threads,
        version_isolation,
        download_source_id,
        optifine_version,
    } = data;

    let game_root = absolute_path(&game_dir);
    let mirror = if download_source_id == 1 {
        DownloadMirror::Bmclapi
    } else {
        DownloadMirror::Official
    };
    let install_core = build_core(&game_root, mirror, http_client.clone());

    let cf_headers = vec![("x-api-key".to_string(), curse_forge_api_key.to_string())];

    let lower_loader = loader.as_deref().map(|l| l.to_ascii_lowercase());
    let is_forge = lower_loader.as_deref() == Some("forge");
    let is_neoforge = lower_loader.as_deref() == Some("neoforge");
    let is_cleanroom = lower_loader.as_deref() == Some("cleanroom");
    let has_loader = loader
        .as_deref()
        .map(str::trim)
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    check_cancel(handle)?;
    handle.set_status(InstallStatus::Downloading);
    handle.set_stage("fetching-json");
    handle.set_progress(0.0);

    // === Phase 1: 版本清单 + 原始版本 JSON ===
    let manifest = install_core
        .version()
        .get_manifest(false)
        .await
        .map_err(|e| format!("获取版本清单失败: {e}"))?;
    let version_info = manifest
        .versions
        .iter()
        .find(|v| v.id == game_version)
        .ok_or_else(|| format!("未找到版本 {game_version}"))?;
    let json_content = http_client
        .get(&version_info.url)
        .send()
        .await
        .map_err(|e| format!("下载版本 JSON 失败: {e}"))?
        .text()
        .await
        .map_err(|e| format!("读取版本 JSON 失败: {e}"))?;
    handle.set_progress(3.0);

    check_cancel(handle)?;

    // === Phase 2: 下载加载器安装器（forge / neoforge / cleanroom）===
    let mut installer_path: Option<PathBuf> = None;
    if is_forge || is_neoforge || is_cleanroom {
        handle.set_stage("downloading-installer");
        handle.set_progress(4.0);

        let loader_type = if is_forge {
            ModLoaderType::Forge
        } else if is_neoforge {
            ModLoaderType::NeoForge
        } else {
            ModLoaderType::Cleanroom
        };
        let loaders = install_core
            .installer_provider()
            .get_available_mod_loaders(&game_version, loader_type)
            .await
            .map_err(|e| format!("获取 {loader:?} 可用版本失败: {e}"))?;
        let loader_version = loader_version.as_deref().unwrap_or("");
        let matched = loaders
            .iter()
            .find(|l| l.version.eq_ignore_ascii_case(loader_version))
            .ok_or_else(|| {
                format!(
                    "找不到 {} {} 的安装器",
                    loader.as_deref().unwrap_or(""),
                    loader_version
                )
            })?;
        if matched.url.trim().is_empty() {
            return Err(format!(
                "{} {} 安装器的下载链接为空，可能是版本列表解析异常",
                loader.as_deref().unwrap_or(""),
                loader_version
            ));
        }

        let temp_dir = game_root.join("temp");
        std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建 temp 目录失败: {e}"))?;
        let path = temp_dir.join(format!(
            "{}-{}-installer.jar",
            loader.as_deref().unwrap_or("loader"),
            loader_version
        ));
        download_installer_jar(handle, &download_manager, &path, &matched.url, &cf_headers).await?;
        installer_path = Some(path);
    }

    // === 修正版本 JSON 的 id 与版本目录一致 ===
    let mut node: Value =
        serde_json::from_str(&json_content).map_err(|e| format!("解析版本 JSON 失败: {e}"))?;
    node["id"] = Value::String(version_dir_name.clone());
    let json_content = node.to_string();

    // ⚠️ 基础文件/主 jar 扫描必须用「原版 id（game_version）」的版本 JSON：
    // 安装流水线把 id 改写成 version_dir_name 后，get_miss_main_jar 会把 minecraft 客户端
    // jar 下载到 versions/{version_dir_name}/{version_dir_name}.jar；但 Forge/NeoForge 的
    // processor {MINECRAFT_JAR} 固定指向 versions/{gameVersion}/{gameVersion}.jar（共享目录，
    // 见 AGENTS.md 路径系统）。两者不一致 → binarypatcher --clean 找不到原版 jar →
    // FileNotFoundException → 退出码 1。用原版 id 扫描即可让 jar 落在
    // versions/{game_version}/{game_version}.jar，与处理器及 launch 一致。
    let base_json_content = {
        let mut base_node: Value =
            serde_json::from_str(&json_content).map_err(|e| format!("解析版本 JSON 失败: {e}"))?;
        base_node["id"] = Value::String(game_version.clone());
        base_node.to_string()
    };

    // === Phase 3: 扫描 + 下载 vanilla 基础文件 ===
    handle.set_stage("scanning-base");
    handle.set_progress(5.0);
    let miss_files = install_core
        .locator()
        .get_miss_files_from_json(&base_json_content)
        .await
        .map_err(|e| format!("扫描缺失文件失败: {e}"))?;
    let miss_files: Vec<MissFileInfo> = miss_files
        .into_iter()
        .filter(|f| !f.path.is_empty() && !f.url.is_empty())
        .collect();

    if !miss_files.is_empty() {
        handle.set_stage("downloading-base");
        let files: Vec<_> = miss_files
            .iter()
            .map(|f| {
                let headers = if is_cf_domain(&f.url) {
                    cf_headers.clone()
                } else {
                    Vec::new()
                };
                (f.url.clone(), game_root.join(&f.path), headers)
            })
            .collect();
        download_batch(handle, &download_manager, files, 5.0, 35.0).await?;
    } else {
        handle.set_progress(35.0);
    }

    check_cancel(handle)?;

    // === Phase 4: 加载器依赖库 ===
    if has_loader && loader_version.is_some() {
        handle.set_stage("scanning-loader-libs");
        handle.set_progress(35.0);
        let miss_libs = get_miss_loader_libraries(
            loader.as_deref().unwrap_or(""),
            loader_version.as_deref().unwrap_or(""),
            &game_version,
            &game_root,
            &version_dir_name,
            installer_path.as_deref(),
            download_source_id,
        )
        .await?;

        if !miss_libs.is_empty() {
            handle.set_stage("downloading-loader-libs");
            let files: Vec<_> = miss_libs
                .iter()
                .map(|f| {
                    let headers = if is_cf_domain(&f.url) {
                        cf_headers.clone()
                    } else {
                        Vec::new()
                    };
                    (f.url.clone(), game_root.join(&f.path), headers)
                })
                .collect();
            download_batch(handle, &download_manager, files, 35.0, 55.0).await?;
        }
    } else if !has_loader {
        // === vanilla：写版本 JSON ===
        let version_dir = game_root.join("versions").join(&version_dir_name);
        std::fs::create_dir_all(&version_dir).map_err(|e| format!("创建版本目录失败: {e}"))?;
        let json_path = version_dir.join(format!("{version_dir_name}.json"));
        std::fs::write(&json_path, &json_content)
            .map_err(|e| format!("写入版本 JSON 失败: {e}"))?;
    }

    // === Goal 2: 合并 addons（用户 + 加载器默认）===
    let mut resolved_addons = merge_addons(&addons, loader.as_deref());

    // === Goal 3: OptiFine 特殊路径 ===
    if let Some(of) = optifine_version.as_deref() {
        if !of.trim().is_empty() {
            let is_forge_like = is_forge || is_neoforge;
            if is_forge_like {
                // OptiFine 作为 mod 注入 forge/neoforge
                resolved_addons.push(format!("optifine:{game_version}:{of}"));
            } else if !has_loader {
                // 无加载器 → 独立安装路径（源为 C# bug，会走 InstallLoader 抛
                // NotSupportedException；此处补全 optifine case）
                handle.set_stage("installing-optifine");
                handle.set_progress(70.0);
                install_loader(
                    &install_core,
                    &version_dir_name,
                    &json_content,
                    &game_root,
                    "optifine",
                    of,
                    &game_version,
                    None,
                    download_source_id,
                )
                .await?;
                handle.set_progress(75.0);
            }
        }
    }

    // === Goal 6: 解析 addons → AdditionalFile ===
    let mut all_additional_files = Vec::new();
    if !resolved_addons.is_empty() {
        handle.set_stage("downloading-addons");
        handle.set_progress(65.0);
        all_additional_files.extend(
            resolve_addons(
                &http_client,
                &resolved_addons,
                &game_version,
                download_source_id,
            )
            .await,
        );
    }

    // === Goal 6: 下载附加文件 ===
    if !all_additional_files.is_empty() {
        handle.set_stage("downloading-additional-files");
        handle.set_progress(70.0);
        let files: Vec<_> = all_additional_files
            .iter()
            .map(|af| {
                let dest = game_root.join(
                    af.relative_path
                        .replace('/', &std::path::MAIN_SEPARATOR.to_string()),
                );
                let mut headers = Vec::new();
                if af.source.eq_ignore_ascii_case("modrinth") {
                    headers.push(("User-Agent".to_string(), "QomicexLauncher/1.0".to_string()));
                }
                let is_cf =
                    af.source.eq_ignore_ascii_case("curseforge") || is_cf_domain(&af.identifier);
                if is_cf {
                    headers.push(("x-api-key".to_string(), curse_forge_api_key.to_string()));
                    headers.push(("User-Agent".to_string(), "QomicexLauncher/1.0".to_string()));
                }
                (af.identifier.clone(), dest, headers)
            })
            .collect();
        download_batch(handle, &download_manager, files, 70.0, 85.0).await?;
    } else {
        handle.set_progress(85.0);
    }

    check_cancel(handle)?;

    // === Phase 6: 安装加载器 ===
    if has_loader && loader_version.is_some() {
        handle.set_stage("installing-loader");
        handle.set_progress(88.0);
        install_loader(
            &install_core,
            &version_dir_name,
            &json_content,
            &game_root,
            loader.as_deref().unwrap_or(""),
            loader_version.as_deref().unwrap_or(""),
            &game_version,
            installer_path.as_deref(),
            download_source_id,
        )
        .await?;
        handle.set_progress(92.0);
    }

    check_cancel(handle)?;

    // === Phase 5: 校验主 jar ===
    handle.set_stage("verifying-jar");
    handle.set_progress(92.0);
    let miss_jar = install_core
        .locator()
        .get_miss_main_jar_from_json(&base_json_content)
        .await
        .map_err(|e| format!("扫描主 jar 失败: {e}"))?;
    if let Some(jar) = miss_jar {
        let headers = if is_cf_domain(&jar.url) {
            cf_headers.clone()
        } else {
            Vec::new()
        };
        download_batch(
            handle,
            &download_manager,
            vec![(jar.url.clone(), game_root.join(&jar.path), headers)],
            92.0,
            98.0,
        )
        .await?;
    } else {
        handle.set_progress(98.0);
    }

    check_cancel(handle)?;

    // === Phase 7: 收尾 ===
    handle.set_stage("finishing");
    handle.set_progress(98.0);

    if version_isolation && has_loader {
        let iso_dir = game_root.join("versions").join(&version_dir_name);
        for sub in [
            "mods",
            "saves",
            "resourcepacks",
            "shaderpacks",
            "screenshots",
            "datapacks",
            "crash-reports",
            "schematics",
        ] {
            let _ = std::fs::create_dir_all(iso_dir.join(sub));
        }
    }

    if let Some(path) = &installer_path {
        let _ = std::fs::remove_file(path);
    }

    handle.set_progress(100.0);
    let _ = download_threads;
    Ok(())
}

// =====================================================================
// 内部 helpers
// =====================================================================

/// 将 game_dir 规范化为绝对路径（源 launch/install 中 `Canonicalize` 逻辑）。
///
/// ⚠️ 与 C# Core 的关键差异修复：Windows 上 `std::fs::canonicalize` 返回带 `\\?\`
/// verbatim 前缀的路径（如 `\\?\C:\...\.minecraft`）。该前缀会：
/// 1) 让 verbatim 语法下 `/` 不再是路径分隔符 → `std::fs::write` 报 os error 123；
/// 2) **Java/二进制补丁等外部工具解析 `\\?\C:\…` 时会丢掉一个反斜杠**，导致
///    binarypatcher 建 `--output` 父目录报 `Could not make output folders` → 退出码 1。
/// C# 源用 `Path.GetFullPath` 产生**非 verbatim** 的 `C:\…` 绝对路径。此处 canonicalize
/// 后剥掉 verbatim 前缀，与 C# 行为一致（connector.rs 亦已对 launch 用非 verbatim 的
/// `instance.game_dir`，共识是非 verbatim 的 game_root 交给 core/外部工具）。
fn absolute_path(game_dir: &str) -> PathBuf {
    let mut root = PathBuf::from(game_dir);
    if !root.is_absolute() {
        root = std::env::current_dir().unwrap_or_default().join(root);
    }
    strip_verbatim_prefix(root.canonicalize().unwrap_or(root))
}

/// Windows：剥掉 `std::fs::canonicalize` 产生的 `\\?\` verbatim 前缀，还原为 C# 的
/// `Path.GetFullPath` 语义（`C:\…`）。本地盘符形式 `\\?\C:\…` → `C:\…`；UNC verbatim
/// `\\?\UNC\server\share\…` → `\\server\share\…`；其余（如 `\\?\pipe\…`）原样返回。
#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    const LONG_PREFIX: &str = r"\\?\";
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(LONG_PREFIX) {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            PathBuf::from(format!(r"\\{unc}"))
        } else if rest.len() >= 2 && rest.as_bytes()[1] == b':' {
            PathBuf::from(rest.to_string())
        } else {
            path
        }
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

/// 构建一次性安装 core（对应源 `GameCoreBuilder` 配置）。
fn build_core(
    game_root: &Path,
    mirror: DownloadMirror,
    http_client: reqwest::Client,
) -> Arc<GameCore> {
    let mut builder = GameCoreBuilder::new();
    builder
        .configure(|o| {
            o.launcher_name = "QML".to_string();
            o.game_root = game_root.to_string_lossy().into_owned();
            o.user_agent = "QomicexLauncher/1.0".to_string();
            o.cache_expiry = Duration::from_secs(1800);
        })
        .use_download_mirror(mirror)
        .with_http_client(http_client);
    builder.build()
}

fn check_cancel(handle: &InstallHandle) -> Result<(), String> {
    if handle.is_cancelled() {
        return Err("安装已取消".to_string());
    }
    Ok(())
}

/// 下载加载器安装器 jar；已存在且为有效 zip 时跳过（源 `DownloadLoaderJar`）。
async fn download_installer_jar(
    handle: &InstallHandle,
    mgr: &DownloadManager,
    path: &Path,
    url: &str,
    cf_headers: &[(String, String)],
) -> Result<(), String> {
    if path.exists() {
        let valid = std::fs::File::open(path)
            .ok()
            .and_then(|f| zip::ZipArchive::new(f).ok())
            .map(|z| z.len() > 0)
            .unwrap_or(false);
        if valid {
            return Ok(());
        }
        let _ = std::fs::remove_file(path);
    }
    let headers = if is_cf_domain(url) {
        cf_headers.to_vec()
    } else {
        Vec::new()
    };
    download_batch(
        handle,
        mgr,
        vec![(url.to_string(), path.to_path_buf(), headers)],
        4.0,
        5.0,
    )
    .await
}

/// 获取加载器缺失依赖库（源 `GetMissLoaderLibraries` 的参数映射逐字对齐）。
async fn get_miss_loader_libraries(
    loader: &str,
    loader_version: &str,
    game_version: &str,
    game_dir: &Path,
    version_dir_name: &str,
    installer_path: Option<&Path>,
    download_source_id: i32,
) -> Result<Vec<MissFileData>, String> {
    let factory = DefaultInstallerFactory;
    let game_dir_str = game_dir.to_string_lossy().into_owned();
    let lower = loader.to_ascii_lowercase();

    let inst: Box<dyn Installer + Send + Sync> = match lower.as_str() {
        "forge" if installer_path.is_some() => {
            factory.create_forge(download_source_id, &game_dir_str, game_version)
        }
        "neoforge" if installer_path.is_some() => {
            factory.create_neoforge(download_source_id, &game_dir_str, game_version)
        }
        "fabric" => factory.create_fabric(download_source_id, &game_dir_str),
        "legacyfabric" => factory.create_legacy_fabric(download_source_id, &game_dir_str),
        "quilt" => factory.create_quilt(download_source_id, &game_dir_str),
        "babric" => factory.create_babric(download_source_id, &game_dir_str),
        "cleanroom" if installer_path.is_some() => {
            factory.create_cleanroom(download_source_id, &game_dir_str)
        }
        _ => return Ok(Vec::new()),
    };

    let (para1, para2, para3): (Option<&str>, Option<&str>, Option<&str>) = match lower.as_str() {
        "forge" | "neoforge" | "cleanroom" => {
            let p = installer_path
                .ok_or("加载器安装器缺失")?
                .to_str()
                .ok_or("安装器路径非法")?;
            (Some(p), Some(version_dir_name), None)
        }
        "fabric" | "legacyfabric" | "quilt" | "babric" => (
            Some(loader_version),
            Some(game_version),
            Some(&game_dir_str),
        ),
        _ => (None, None, None),
    };

    inst.get_miss_libraries(para1, para2, para3)
        .await
        .map_err(|e| format!("扫描加载器依赖库失败: {e}"))
}

/// 安装加载器（源 `InstallLoader` 参数映射逐字对齐；补充 optifine case 修复上游 bug）。
async fn install_loader(
    core: &GameCore,
    version_id: &str,
    inherits_from_json: &str,
    game_dir: &Path,
    loader: &str,
    loader_version: &str,
    game_version: &str,
    installer_path: Option<&Path>,
    download_source_id: i32,
) -> Result<(), String> {
    let factory = DefaultInstallerFactory;
    let game_dir_str = game_dir.to_string_lossy().into_owned();
    let lower = loader.to_ascii_lowercase();

    let (inst, para1, para2): (
        Box<dyn Installer + Send + Sync>,
        Option<String>,
        Option<String>,
    ) = match lower.as_str() {
        "forge" | "neoforge" => {
            let p = installer_path
                .ok_or("找不到加载器安装器")?
                .to_str()
                .ok_or("安装器路径非法")?
                .to_string();
            let java_path = resolve_java_path(core).await?;
            let inst = if lower == "forge" {
                factory.create_forge(download_source_id, &game_dir_str, game_version)
            } else {
                factory.create_neoforge(download_source_id, &game_dir_str, game_version)
            };
            (inst, Some(java_path), Some(p))
        }
        "fabric" => (
            factory.create_fabric(download_source_id, &game_dir_str),
            Some(loader_version.to_string()),
            Some(game_version.to_string()),
        ),
        "legacyfabric" => (
            factory.create_legacy_fabric(download_source_id, &game_dir_str),
            Some(loader_version.to_string()),
            Some(game_version.to_string()),
        ),
        "quilt" => (
            factory.create_quilt(download_source_id, &game_dir_str),
            Some(loader_version.to_string()),
            Some(game_version.to_string()),
        ),
        "liteloader" => (
            factory.create_liteloader(download_source_id, &game_dir_str, game_version),
            Some(loader_version.to_string()),
            Some(game_version.to_string()),
        ),
        "babric" => (
            factory.create_babric(download_source_id, &game_dir_str),
            Some(loader_version.to_string()),
            Some(game_version.to_string()),
        ),
        "cleanroom" => {
            let p = installer_path
                .ok_or("找不到加载器安装器")?
                .to_str()
                .ok_or("安装器路径非法")?
                .to_string();
            let inst = factory.create_cleanroom(download_source_id, &game_dir_str);
            (inst, None, Some(p))
        }
        "optifine" => (
            factory.create_optifine(download_source_id, &game_dir_str, game_version),
            Some(loader_version.to_string()),
            Some(game_version.to_string()),
        ),
        other => return Err(format!("不支持的加载器: {other}")),
    };

    inst.install(
        version_id,
        inherits_from_json,
        para1.as_deref(),
        para2.as_deref(),
        None,
        None,
    )
    .await
    .map_err(|e| format!("安装 {loader} 失败: {e}"))
}

/// 解析 Java 路径（源 `ResolveJavaPath`：Deep 扫描取第一个 Valid）。
async fn resolve_java_path(core: &GameCore) -> Result<String, String> {
    let options = JavaSearchOptions {
        mode: JavaSearchMode::Deep,
        ..Default::default()
    };
    let javas = core
        .java_provider()
        .search(&options)
        .await
        .map_err(|e| format!("扫描 Java 失败: {e}"))?;
    javas
        .into_iter()
        .find(|j| j.state == JavaState::Valid)
        .map(|j| j.path)
        .ok_or_else(|| "未找到可用的 Java 运行时，请先下载或指定 Java".to_string())
}

/// 合并用户 addons 与加载器默认 addon（源 `MergeAddons`）。
fn merge_addons(user_addons: &[String], loader: Option<&str>) -> Vec<String> {
    let mut result: Vec<String> = user_addons.to_vec();
    if let Some(l) = loader {
        for d in default_loader_addons(l) {
            if !result.iter().any(|r| r.eq_ignore_ascii_case(d)) {
                result.push(d.to_string());
            }
        }
    }
    result
}

/// 解析 addon 列表为 AdditionalFile（源 `ResolveAddonsAsync`；Modrinth slug 查询 +
/// OptiFine 特例格式 `optifine:{mc}:{type}-{patch}`）。
async fn resolve_addons(
    http_client: &reqwest::Client,
    addon_ids: &[String],
    game_version: &str,
    download_source_id: i32,
) -> Vec<AdditionalFile> {
    let mut result = Vec::new();
    let mut slug_list = Vec::new();

    for id in addon_ids {
        if id.to_ascii_lowercase().starts_with("optifine:") {
            let parts: Vec<&str> = id.split(':').collect();
            if parts.len() >= 3 {
                let mc_ver = parts[1];
                let of_ver = parts[2];
                let of_parts: Vec<&str> = of_ver.split('-').collect();
                let (typ, patch) = if of_parts.len() >= 2 {
                    (of_parts[0], of_parts[1])
                } else {
                    ("HD_U", of_ver)
                };
                let base_url = if download_source_id == 1 {
                    "https://bmclapi2.bangbang93.com/optifine"
                } else {
                    "https://optifine.net/download"
                };
                let url = format!("{base_url}/{mc_ver}/{typ}/{patch}");
                let filename = format!("OptiFine-{mc_ver}_{typ}_{patch}.jar");
                result.push(AdditionalFile {
                    source: if download_source_id == 1 {
                        "url".to_string()
                    } else {
                        "modrinth".to_string()
                    },
                    identifier: url,
                    relative_path: format!("mods/{filename}"),
                });
            }
            continue;
        }
        slug_list.push(id.clone());
    }

    if slug_list.is_empty() {
        return result;
    }

    // 查询 Modrinth（源并发 12，这里顺序查询足够）。
    for slug in &slug_list {
        let url = format!("https://api.modrinth.com/v2/project/{slug}/version");
        let text = match http_client.get(&url).send().await {
            Ok(resp) => match resp.text().await {
                Ok(t) => t,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        let Ok(versions) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(arr) = versions.as_array() else {
            continue;
        };
        for v in arr {
            let matches_game = v["game_versions"]
                .as_array()
                .map(|a| a.iter().any(|x| x.as_str() == Some(game_version)))
                .unwrap_or(false);
            if !matches_game {
                continue;
            }
            let Some(files) = v["files"].as_array() else {
                continue;
            };
            if let Some(f0) = files.first() {
                let file_url = f0["url"].as_str().unwrap_or("");
                let filename = f0["filename"].as_str().unwrap_or("");
                if !file_url.is_empty() {
                    result.push(AdditionalFile {
                        source: "modrinth".to_string(),
                        identifier: file_url.to_string(),
                        relative_path: format!("mods/{filename}"),
                    });
                }
            }
            break;
        }
    }

    result
}

/// 判断 URL 是否属于 CurseForge 域名（源 `IsCfDomain`）。
fn is_cf_domain(url: &str) -> bool {
    let host = url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .unwrap_or("")
        .to_ascii_lowercase();
    CF_DOMAINS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// Windows：verbatim 路径（`\\?\` 前缀）中 `/` 是非法分隔符，统一替换为 `\`。
/// Unix 下无操作。
fn normalize_sep(dest: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = dest.to_string_lossy();
        if s.contains('/') {
            PathBuf::from(s.replace('/', "\\"))
        } else {
            dest
        }
    }
    #[cfg(not(windows))]
    {
        dest
    }
}

/// 批量下载（源 `RunBatchAsync(startPct, endPct)`）。进度按已下载字节映射到
/// `[start_pct, end_pct]`；pause/cancel 由事件循环协作转发给 `DownloadManager`。
/// 运行期 stall 超时：事件已开始流动后，若此期间无任何事件则判定卡死。
/// 不用于冷启动：第一批任务在 semaphore 排队 + probe（HEAD + Range GET） +
/// CurseForge CDN 重定向解析期间可能需要数十秒，用短超时会误杀。
/// pub(crate)：modpack 在线安装管道（endpoints/modpack.rs）复用同一批逻辑。
const DOWNLOAD_BATCH_TIMEOUT: Duration = Duration::from_secs(120);
/// 冷启动宽容超时：从调用到第一个事件到达的最长容忍时间。
/// 覆盖 semaphore 等待（全局并发上限）+ probe 重试 + 首文件 TCP 建连。
const COLD_START_TIMEOUT: Duration = Duration::from_secs(180);

pub(crate) async fn download_batch(
    handle: &InstallHandle,
    mgr: &DownloadManager,
    files: Vec<(String, PathBuf, Vec<(String, String)>)>,
    start_pct: f64,
    end_pct: f64,
) -> Result<(), String> {
    if files.is_empty() {
        handle.set_progress(end_pct);
        return Ok(());
    }

    // Windows：`canonicalize` 产生的 `\\?\` verbatim 路径不允许 `/` 分隔符。
    // core 安装器（NeoForge 等）经 `path_combine` 字符串拼接会保留 maven 路径的 `/`
    // （如 `libraries\org/ow2/asm/asm/9.10.1/asm-9.10.1.jar`），此处统一钳位为平台
    // 分隔符，否则 create_dir_all/rename 报 ERROR_INVALID_NAME (os error 123)。
    let files: Vec<(String, PathBuf, Vec<(String, String)>)> = files
        .into_iter()
        .map(|(url, dest, headers)| (url, normalize_sep(dest), headers))
        .collect();

    // Pre-compute display names before consuming `files` in the loop below.
    let file_names: Vec<String> = files
        .iter()
        .map(|(url, dest, _)| {
            dest.file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| url.split('/').next_back().unwrap_or(url).to_string())
                .to_string()
        })
        .collect();

    // Subscribe BEFORE adding tasks so no events are lost. `mgr.add()` sends
    // `StateChanged::Queued` synchronously and the dispatcher may immediately
    // transition to `Downloading`; a late subscriber would miss those ticks.
    let mut rx = mgr.subscribe();

    let mut ids = Vec::new();
    for (url, dest, headers) in files {
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut task = DownloadTask::new(url, dest);
        task.headers = headers;
        ids.push(mgr.add(task));
    }

    let total = ids.len() as u64;
    let id_set: HashSet<u64> = ids.iter().copied().collect();
    let mut done_ids: HashSet<u64> = HashSet::new();
    let mut failed: Option<String> = None;
    let mut prog: HashMap<u64, (u64, u64)> = HashMap::new();
    let mut file_name: HashMap<u64, String> = HashMap::new();
    let mut task_speed: HashMap<u64, u64> = HashMap::new();
    for (&id, name) in ids.iter().zip(file_names.iter()) {
        file_name.insert(id, name.clone());
    }
    let mut paused_now = false;
    // Cold-start: no events from the downloader yet. The downloader needs
    // time for semaphore scheduling, URL probing (HEAD + Range GET), and
    // CurseForge CDN redirect resolution before the first Progress event
    // arrives. Use a generous timeout here so a batch of small loader lib
    // files doesn't time out while the first few are still being probed.
    //
    // Once any event arrives we flip `started` to true and switch to the
    // shorter stall timeout, catching genuinely stuck downloads without
    // penalizing cold start.
    let mut last_event = Instant::now() - DOWNLOAD_BATCH_TIMEOUT;
    let mut started = false;

    loop {
        if handle.is_cancelled() {
            for id in &ids {
                let _ = mgr.cancel(*id).await;
            }
            return Err("安装已取消".to_string());
        }
        if handle.is_paused() && !paused_now {
            paused_now = true;
            for id in &ids {
                let _ = mgr.pause(*id).await;
            }
        } else if !handle.is_paused() && paused_now {
            paused_now = false;
            for id in &ids {
                let _ = mgr.resume(*id).await;
            }
        }
        // 暂停期间挂起 stall 看门狗：暂停的任务不发事件，继续按“卡死”计时会误杀
        if paused_now {
            last_event = Instant::now();
        }

        let stall_limit = if started {
            DOWNLOAD_BATCH_TIMEOUT
        } else {
            COLD_START_TIMEOUT
        };
        if last_event.elapsed() > stall_limit {
            for id in &ids {
                let _ = mgr.cancel(*id).await;
            }
            // 已记录到具体失败原因时优先返回真因（Failed 事件可能已被广播竞态吞掉，
            // 因此这里从 `failed` 读取而不是直接丢弃）；看门狗只在无失败但卡死时兜底
            return Err(failed
                .clone()
                .unwrap_or_else(|| "下载超时：文件下载未在预期时间内完成".to_string()));
        }

        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(DownloadEvent::Progress { id, downloaded, total: t, speed_bps, .. }) => {
                    if id_set.contains(&id) {
                        started = true;
                        let e = prog.entry(id).or_insert((0, 0));
                        // 只有真实进展（字节数变化）才算活跃：任务卡在重试/无数据时的
                        // 0 字节节流上报不得给 stall 看门狗续命
                        if downloaded > e.0 {
                            last_event = Instant::now();
                        }
                        e.0 = downloaded;
                        if t > 0 {
                            e.1 = t;
                        }
                        e.1 = e.1.max(e.0);
                        if speed_bps > 0 {
                            task_speed.insert(id, speed_bps);
                        }
                    }
                }
                Ok(DownloadEvent::StateChanged { id, state, detail, .. }) => {
                    if id_set.contains(&id) {
                        last_event = Instant::now();
                        started = true;
                        apply_terminal_state(id, state, detail, &mut done_ids, &mut prog, &mut task_speed, &mut failed);
                    }
                }
                _ => {}
            },
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                // Broadcast events can be lost (single-consumer channel, SSE
                // watcher may grab them first). Poll the downloader's internal
                // state as a fallback so Completed/Failed/Cancelled tasks are
                // always reconciled.
                if started {
                    // DEBUG-PROBE
                    let states = mgr.list().await;
                    let stuck: Vec<_> = states.iter()
                        .filter(|(id, st)| id_set.contains(id) && matches!(st, TaskState::Queued | TaskState::Downloading))
                        .take(8).map(|(id, st)| format!("{id}:{st:?}")).collect();
                    eprintln!("[download_batch probe] done={} total={} stuck_visible={:?}", done_ids.len(), total, stuck);
                    poll_task_states(mgr, &id_set, &mut done_ids, &mut prog, &mut task_speed, &mut failed).await;
                }
            }
        }

        let done = done_ids.len() as u64;
        let (sum_dl, sum_tot) = {
            let mut dl = 0u64;
            let mut tot = 0u64;
            for (d, t) in prog.values() {
                dl += *d;
                tot += t.max(d);
            }
            (dl, tot)
        };
        let pct_in = if done >= total {
            1.0
        } else if sum_tot > 0 {
            (sum_dl as f64 / sum_tot as f64).min(1.0)
        } else {
            0.0
        };
        // Current file: the active (not-yet-completed) task whose last speed
        // was highest. If everything is done, clear so the UI shows the final
        // "completed" state without a stale file name.
        let current_file = if done >= total {
            String::new()
        } else {
            task_speed
                .iter()
                .filter(|(id, _)| !done_ids.contains(id))
                .max_by_key(|(_, &spd)| spd)
                .and_then(|(id, _)| file_name.get(id).cloned())
                .unwrap_or_default()
        };
        let current_speed = task_speed.values().max().copied().unwrap_or(0) as f64;

        handle.update(|f| {
            f.progress = (start_pct + pct_in * (end_pct - start_pct)).clamp(start_pct, end_pct);
            f.total_files = total as i32;
            f.completed_files = done as i32;
            f.current_file = current_file;
            // 当前批次（文件）的真实下载进度 0-100；批次结束清 0（阶段即将切换）
            f.current_file_progress = if done >= total { 0.0 } else { pct_in * 100.0 };
            f.speed = current_speed;
            if paused_now {
                f.stage = "paused".to_string();
            }
        });

        if done >= total {
            break;
        }
    }

    match failed {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Apply a terminal-state event to the batch tracking maps. Extracted so the
/// polling fallback can reuse the exact same logic without duplicating state
/// machines.
fn apply_terminal_state(
    id: u64,
    state: TaskState,
    detail: Option<String>,
    done_ids: &mut HashSet<u64>,
    prog: &mut HashMap<u64, (u64, u64)>,
    task_speed: &mut HashMap<u64, u64>,
    failed: &mut Option<String>,
) {
    match state {
        TaskState::Completed => {
            done_ids.insert(id);
            if let Some(e) = prog.get_mut(&id) {
                if e.1 > 0 {
                    e.0 = e.1;
                }
            }
            task_speed.remove(&id);
        }
        TaskState::Failed => {
            // 计入完成数：否则部分失败时 done < total 永不满足，批次死等到
            // stall 看门狗触发（且超时错误会掩盖真实失败原因）
            done_ids.insert(id);
            task_speed.remove(&id);
            if failed.is_none() {
                *failed = detail.or_else(|| Some("下载文件校验失败".to_string()));
            }
        }
        TaskState::Cancelled => {
            done_ids.insert(id);
            task_speed.remove(&id);
        }
        _ => {}
    }
}

/// Poll the downloader's public `state()` API for each tracked task. This
/// catches terminal states whose broadcast `StateChanged` events were consumed
/// by the SSE watcher (single-consumer channel — events reach only one
/// subscriber). The SSE watcher runs independently and frequently wins the
/// race, leaving `download_batch`'s `done_ids` permanently empty and progress
/// stuck at 0/N.
///
/// Note: `state()` only returns the `TaskState`, not the error detail string.
/// Failed-task detection still works (loop exits via `done_ids`), but the
/// detailed error message is best-effort — the broadcast path carries it when
/// it wins the race.
async fn poll_task_states(
    mgr: &DownloadManager,
    id_set: &HashSet<u64>,
    done_ids: &mut HashSet<u64>,
    prog: &mut HashMap<u64, (u64, u64)>,
    task_speed: &mut HashMap<u64, u64>,
    _failed: &mut Option<String>,
) {
    for &id in id_set {
        if done_ids.contains(&id) {
            continue;
        }
        if let Ok(state) = mgr.state(id).await {
            if matches!(
                state,
                TaskState::Completed | TaskState::Failed | TaskState::Cancelled
            ) {
                apply_terminal_state(id, state, None, done_ids, prog, task_speed, _failed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_prefix_removes_long_path_prefix() {
        // canonicalize 在 Windows 上产出 `\\?\C:\…`；binarypatcher/Java 解析 `\\?\C:\…`
        // 会丢一个反斜杠，导致 --output 建目录失败 → 退出码 1。剥前缀后应为非 verbatim 盘符路径。
        let p = strip_verbatim_prefix(PathBuf::from(r"\\?\C:\Games\.minecraft"));
        assert_eq!(p, PathBuf::from(r"C:\Games\.minecraft"), "got {p:?}");
        // 深路径 / libraries 组合
        let p2 = strip_verbatim_prefix(PathBuf::from(
            r"\\?\C:\Games\.minecraft\libraries\net\minecraftforge\forge\26.2-65.1.1",
        ));
        assert_eq!(
            p2,
            PathBuf::from(r"C:\Games\.minecraft\libraries\net\minecraftforge\forge\26.2-65.1.1"),
            "got {p2:?}"
        );
        // UNC verbatim → `\\server\share`
        let p3 = strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\srv\share\mc"));
        assert_eq!(p3, PathBuf::from(r"\\srv\share\mc"), "got {p3:?}");
        // 已是非 verbatim → 原样
        let p4 = strip_verbatim_prefix(PathBuf::from(r"C:\Games"));
        assert_eq!(p4, PathBuf::from(r"C:\Games"));
    }

    #[cfg(windows)]
    #[test]
    fn absolute_path_is_non_verbatim() {
        // 真实目录 canonicalize 后剥前缀：不应再有 `\\?\` 前缀
        let p = absolute_path(&std::env::current_dir().unwrap().to_string_lossy());
        let s = p.to_string_lossy().to_string();
        assert!(
            !s.starts_with(r"\\?\"),
            "absolute_path 不应返回 verbatim 路径: {s}"
        );
    }
}
