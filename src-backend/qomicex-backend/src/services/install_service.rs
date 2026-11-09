// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use qomicex_core::api::installer::InstallerFactory;
use qomicex_core::builder::GameCoreBuilder;
use qomicex_core::core::GameCore;
use qomicex_core::models::download::DownloadMirror;
use qomicex_core::models::installer::{MissFileInfo, ModLoaderType};
use qomicex_core::models::java::{JavaResult, JavaState};
use qomicex_core::models::version_metadata::{CompleteVersionMetadata, JavaVersion};
use qomicex_core::services::installers::factory::DefaultInstallerFactory;
use qomicex_core::services::installers::installer::{Installer, MissFileData};
use qomicex_downloader::{DownloadEvent, DownloadManager, DownloadTask, TaskState};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::services::install_tracker::{InstallHandle, InstallStatus, InstallStepSpec};

/// 顶层管线的步骤权重预算（合成总进度按 Σweight 归一化，任意正数均可）。
pub const INSTALL_STEP_BUDGET_TOP: f64 = 100.0;

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
///
/// 编排结构（DAG 并行，见 ADR 安装管线并行化）：
/// ```text
/// fetching-json（串行）
///   ├─ [A] installer 下载 ──► loader-libs 扫描+下载（forge 系链式；Fabric 无 installer 直连）
///   ├─ [B] base 扫描+下载（vanilla 含版本 JSON 写盘）
///   └─ [C] addons 解析+下载
/// （join，任一失败 request_cancel 让其余分支在轮询点退出）
/// install-optifine? → installing-loader? → verifying-jar/finishing（串行尾）
/// ```
///
/// `step_budget`：本管线步骤权重合计（顶层传 `STEP_BUDGET_TOP`；整合包外层嵌套调用时
/// 传外层分配给"install-game"步骤的预算权重，子步骤按比例缩放追加进同一张步骤表）。
pub async fn run_install_pipeline(
    handle: &InstallHandle,
    download_manager: Arc<DownloadManager>,
    http_client: reqwest::Client,
    curse_forge_api_key: &str,
    data: InstallRequestData,
    step_budget: f64,
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

    // 分步计划（下载中心卡片步骤列表的数据源）。按入参静态推导各阶段是否出现；
    // 权重为相对值（合成时按 Σweight 归一化），参照旧线性区间的跨度比例分配。
    let mut resolved_addons = merge_addons(&addons, loader.as_deref());
    let has_loader_phase = has_loader && loader_version.is_some();
    let optifine_standalone = optifine_version
        .as_deref()
        .map(|o| !o.trim().is_empty())
        .unwrap_or(false)
        && !is_forge
        && !is_neoforge
        && !has_loader;
    {
        use InstallStepSpec as S;
        let mut plan: Vec<InstallStepSpec> = vec![S {
            id: "fetch-json",
            weight: 4.0,
        }];
        if is_forge || is_neoforge || is_cleanroom {
            plan.push(S {
                id: "installer",
                weight: 4.0,
            });
        }
        plan.push(S {
            id: "game-files",
            weight: 32.0,
        });
        if has_loader_phase {
            plan.push(S {
                id: "loader-libs",
                weight: 20.0,
            });
        }
        if optifine_standalone {
            plan.push(S {
                id: "install-optifine",
                weight: 16.0,
            });
        }
        if !resolved_addons.is_empty() {
            plan.push(S {
                id: "download-addons",
                weight: 14.0,
            });
        }
        if has_loader_phase {
            plan.push(S {
                id: "install-loader",
                weight: 18.0,
            });
        }
        plan.push(S {
            id: "finalize",
            weight: 8.0,
        });
        handle.define_steps(&plan, step_budget);
    }

    check_cancel(handle)?;
    handle.set_status(InstallStatus::Downloading);
    handle.set_stage("fetching-json");
    handle.mark_step("fetch-json", "active");

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
    handle.mark_step("fetch-json", "done");

    // === 修正版本 JSON 的 id 与版本目录一致 ===
    let mut node: Value =
        serde_json::from_str(&json_content).map_err(|e| format!("解析版本 JSON 失败: {e}"))?;
    node["id"] = Value::String(version_dir_name.clone());
    let json_content = node.to_string();

    // ⚠️ 主 jar 必须落在**版本隔离目录** versions/{version_dir_name}/{version_dir_name}.jar：
    // Forge/NeoForge processor 的 {MINECRAFT_JAR} 占位符（core forge_base.crate 的
    // main_jar_relative_path）与启动器 launch（jvm_args.rs 用 options.version=版本目录名）
    // 都以 version_dir_name 为基准。用 version_dir_name 的 JSON 扫描即可让客户端 jar 落在
    // 该目录；不能回落到共享的 versions/{gameVersion}/，否则会多出一个"孤儿" vanilla 目录
    // 并在实例列表里出现损坏的原版实例。
    let base_json_content = json_content.clone();

    // Goal 3 前置：OptiFine 作为 mod 注入 forge/neoforge 时并入 addons，
    // 必须发生在计划推导之后立刻补齐（download-addons 步骤的存在性依赖它）。
    let is_forge_like = is_forge || is_neoforge;
    if let Some(of) = optifine_version.as_deref() {
        if !of.trim().is_empty() && is_forge_like {
            resolved_addons.push(format!("optifine:{game_version}:{of}"));
        }
    }

    // === base 扫描（提前到并行段之前）===
    // installer 分支的 loader libs 与 base 分支的 miss 列表可能命中同一个
    // `libraries/*` 目标；两批并发下载会争用同一个 `.part`（DestGuard 直接失败，
    // 只能靠重试兜底，issue #316）。先拿到 base 的完整 dest 键集，installer 分支
    // 扫描后即可剔除重复项，保证同一文件只进一个批次。
    // 扫描只做本地文件存在性检查，不占下载带宽；放在 installer 下载之前也不会
    // 拖慢整体（下载才是耗时大头）。
    handle.mark_step("game-files", "active");
    handle.set_stage("scanning-base");
    check_cancel(handle)?;
    let base_miss: Vec<MissFileInfo> = install_core
        .locator()
        .get_miss_files_from_json(&base_json_content)
        .await
        .map_err(|e| format!("扫描缺失文件失败: {e}"))?
        .into_iter()
        .filter(|f| !f.path.is_empty() && !f.url.is_empty())
        .collect();
    let base_dest_keys: HashSet<String> = base_miss
        .iter()
        .map(|f| dedup_key(&normalize_sep(game_root.join(&f.path))))
        .collect();

    // === 并行段 ================================================================
    // [A] installer 下载 ──► (forge 系) loader-libs 扫描+下载（同分支链式；
    //     Fabric/Quilt 等无安装器加载器的 loader-libs 无前置依赖，直接在此执行）
    // [B] base 下载（扫描已在上方完成；vanilla 含版本 JSON 写盘）
    // [C] addons 解析 + additional-files 下载
    // tokio::join! 并发推进全部分支；任一分支失败 → request_cancel 让其余分支在
    // download_batch 轮询点自行退出，整体返回首个真实错误（快速失败）。
    let h_a = handle.clone();
    let mgr_a = download_manager.clone();
    let core_a = install_core.clone();
    let root_a = game_root.clone();
    let hdrs_a = cf_headers.clone();
    let loader_a = loader.clone();
    let lv_a = loader_version.clone();
    let gv_a = game_version.clone();
    let vdn_a = version_dir_name.clone();
    let base_keys_a = base_dest_keys.clone();
    let branch_installer = async move {
        let mut installer_path: Option<PathBuf> = None;
        if is_forge_like {
            h_a.mark_step("installer", "active");
            h_a.set_stage("downloading-installer");

            let loader_type = if is_forge {
                ModLoaderType::Forge
            } else if is_neoforge {
                ModLoaderType::NeoForge
            } else {
                ModLoaderType::Cleanroom
            };
            // 中文环境（zh*）优先 BMCLAPI（与 `/loader/versions` 的 is_chinese_lang 判定一致）。
            let prefer_bmclapi = crate::settings::load_settings()
                .language
                .trim()
                .to_ascii_lowercase()
                .starts_with("zh");
            let lver = lv_a.as_deref().unwrap_or("");
            let missing_err = || {
                format!(
                    "找不到 {} {} 的安装器",
                    loader_a.as_deref().unwrap_or(""),
                    lver
                )
            };

            // NeoForge：与 `/loader/versions` 一致走「按语言优先级 + 缓存」的获取路径（中文
            // 环境 BMCLAPI 优先）。此前安装路径恒用 official-first 的 `get_available_mod_loaders`，
            // 其回退仅在版本列表**为空**时触发；当官方 API 在部分网络下返回非空但过期/残缺的
            // 列表时不会回退，导致较新的安装器版本（如 BMC5 所需的 21.1.250）查找失败。
            let loaders = if is_neoforge {
                core_a
                    .installer_provider()
                    .get_neoforge_versions_with_priority(&gv_a, prefer_bmclapi, false)
                    .await
                    .map_err(|e| format!("获取 {loader_a:?} 可用版本失败: {e}"))?
            } else {
                core_a
                    .installer_provider()
                    .get_available_mod_loaders(&gv_a, loader_type)
                    .await
                    .map_err(|e| format!("获取 {loader_a:?} 可用版本失败: {e}"))?
            };

            // 首轮未命中且为 NeoForge 时，换另一数据源并跳过缓存重试一次（官方列表可能非空但缺该版本）。
            // issue #176：core 内部的失败原因走 `eprintln!`（不入 tracing 日志体系），
            // 故在此把「列表拿到了但没命中目标版本」这一用户可见故障记进日志，
            // 附带候选数量——否则线上只剩一句「找不到 X 的安装器」，无法区分
            // 「列表为空」与「列表非空但缺该版本」。
            let loader_count = loaders.len();
            // Forge 跨来源的版本号形态不一（整合包 version.json 给裸 `10.13.4.1614`，
            // 官方列表给 `10.13.4.1614-1.7.10`），故用裸版本号兜底匹配；其余加载器保持
            // 精确匹配，避免版本串被误归一化。
            let pick = if is_forge {
                pick_forge_loader_by_version(loaders, lver, &gv_a)
            } else {
                pick_loader_by_version(loaders, lver)
            };
            let matched = match pick {
                Some(m) => m,
                None if is_neoforge => {
                    let retry = core_a
                        .installer_provider()
                        .get_neoforge_versions_with_priority(&gv_a, !prefer_bmclapi, true)
                        .await
                        .unwrap_or_default();
                    let retry_count = retry.len();
                    pick_loader_by_version(retry, lver).ok_or_else(|| {
                        tracing::warn!(
                            loader = loader_a.as_deref().unwrap_or(""),
                            game_version = gv_a.as_str(),
                            loader_version = lver,
                            candidates = loader_count,
                            retry_candidates = retry_count,
                            "加载器版本列表未命中目标版本（已换源重试）"
                        );
                        missing_err()
                    })?
                }
                None => {
                    tracing::warn!(
                        loader = loader_a.as_deref().unwrap_or(""),
                        game_version = gv_a.as_str(),
                        loader_version = lver,
                        candidates = loader_count,
                        "加载器版本列表未命中目标版本"
                    );
                    return Err(missing_err());
                }
            };
            if matched.url.trim().is_empty() {
                tracing::warn!(
                    loader = loader_a.as_deref().unwrap_or(""),
                    game_version = gv_a.as_str(),
                    loader_version = lver,
                    "加载器版本命中但下载链接为空，疑似版本列表解析异常"
                );
                return Err(format!(
                    "{} {} 安装器的下载链接为空，可能是版本列表解析异常",
                    loader_a.as_deref().unwrap_or(""),
                    lver
                ));
            }

            let temp_dir = root_a.join("temp");
            std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建 temp 目录失败: {e}"))?;
            // 安装器直链必须按**列表里的** artifact 形态拼（1.7.10 官方为
            // `10.13.4.1614-1.7.10`，拼出 `{mc}-{forge}-{mc}`；BMCLAPI 为裸 build 号），
            // 不能沿用实例里记录的展示版本——整合包给的是裸号，直拼会 404。
            let effective_lv = matched.version.clone();
            let path = temp_dir.join(format!(
                "{}-{}-installer.jar",
                loader_a.as_deref().unwrap_or("loader"),
                effective_lv
            ));
            let prefer_official = crate::services::source_policy::SourcePlan::load().vanilla
                == crate::services::source_policy::VanillaSource::Official;
            download_installer_jar(
                &h_a,
                &mgr_a,
                &path,
                &matched.url,
                loader_a.as_deref().unwrap_or(""),
                &gv_a,
                &effective_lv,
                &hdrs_a,
                prefer_official,
            )
            .await?;
            h_a.mark_step("installer", "done");
            installer_path = Some(path);
        }
        if has_loader_phase {
            check_cancel(&h_a)?;
            h_a.mark_step("loader-libs", "active");
            h_a.set_stage("scanning-loader-libs");
            let miss_libs = get_miss_loader_libraries(
                loader_a.as_deref().unwrap_or(""),
                lv_a.as_deref().unwrap_or(""),
                &gv_a,
                &root_a,
                &vdn_a,
                installer_path.as_deref(),
                download_source_id,
            )
            .await?;
            // base 批次已覆盖的同一 dest 不再由本批次下载（issue #316）。
            let miss_libs = retain_unclaimed_libraries(miss_libs, &root_a, &base_keys_a);

            if !miss_libs.is_empty() {
                h_a.set_stage("downloading-loader-libs");
                let files: Vec<_> = miss_libs
                    .iter()
                    .map(|f| {
                        let headers = if is_cf_domain(&f.url) {
                            hdrs_a.clone()
                        } else {
                            Vec::new()
                        };
                        DownloadTarget::new(f.url.clone(), root_a.join(&f.path))
                            .with_headers(headers)
                            .with_sha1(&f.sha1)
                    })
                    .collect();
                download_batch(&h_a, &mgr_a, files, Some("loader-libs")).await?;
            }
            h_a.mark_step("loader-libs", "done");
        }
        Ok(installer_path)
    };

    let h_b = handle.clone();
    let mgr_b = download_manager.clone();
    let root_b = game_root.clone();
    let hdrs_b = cf_headers.clone();
    let vdn_b = version_dir_name.clone();
    let json_b = json_content.clone();
    let branch_base = async move {
        check_cancel(&h_b)?;
        if !base_miss.is_empty() {
            h_b.set_stage("downloading-base");
            let files: Vec<_> = base_miss
                .iter()
                .map(|f| {
                    let headers = if is_cf_domain(&f.url) {
                        hdrs_b.clone()
                    } else {
                        Vec::new()
                    };
                    DownloadTarget::new(f.url.clone(), root_b.join(&f.path))
                        .with_headers(headers)
                        .with_sha1(&f.sha1)
                })
                .collect();
            download_batch(&h_b, &mgr_b, files, Some("game-files")).await?;
        }

        if !has_loader {
            // === vanilla：写版本 JSON ===
            let version_dir = root_b.join("versions").join(&vdn_b);
            std::fs::create_dir_all(&version_dir).map_err(|e| format!("创建版本目录失败: {e}"))?;
            let json_path = version_dir.join(format!("{vdn_b}.json"));
            std::fs::write(&json_path, &json_b).map_err(|e| format!("写入版本 JSON 失败: {e}"))?;
        }
        h_b.mark_step("game-files", "done");
        Ok(())
    };

    let h_c = handle.clone();
    let mgr_c = download_manager.clone();
    let root_c = game_root.clone();
    let gv_c = game_version.clone();
    let hc_c = http_client.clone();
    let key_c = curse_forge_api_key.to_string();
    let addons_c = std::mem::take(&mut resolved_addons);
    // 加载器必装 addon（fabric-api / qsl）：这些解析失败必须让安装失败，
    // 否则会产出「报成功但缺 fabric-api」的实例（见 resolve_addons 注释）。
    let required_addons: Vec<String> = loader
        .as_deref()
        .map(default_loader_addons)
        .unwrap_or(&[])
        .iter()
        .map(|s| s.to_string())
        .collect();
    let branch_addons = async move {
        if addons_c.is_empty() {
            return Ok(());
        }
        h_c.mark_step("download-addons", "active");
        h_c.set_stage("downloading-addons");
        let (all_additional_files, failed_addons) =
            resolve_addons(&hc_c, &addons_c, &gv_c, download_source_id).await;

        let missing_required: Vec<&String> = failed_addons
            .iter()
            .filter(|f| {
                required_addons
                    .iter()
                    .any(|r| r.eq_ignore_ascii_case(f.as_str()))
            })
            .collect();
        if !missing_required.is_empty() {
            let names = missing_required
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!("必装前置模组解析失败: {names}"));
        }
        // 非必装 addon 失败只记警告：不阻断安装，但在日志里留有模块名与原因。
        if !failed_addons.is_empty() {
            tracing::warn!(
                addons = %failed_addons.join(", "),
                "部分可选 addon 解析失败，已跳过"
            );
        }

        if !all_additional_files.is_empty() {
            h_c.set_stage("downloading-additional-files");
            let files: Vec<_> = all_additional_files
                .iter()
                .map(|af| {
                    let dest =
                        root_c.join(af.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let mut headers = Vec::new();
                    if af.source.eq_ignore_ascii_case("modrinth") {
                        headers.push((
                            "User-Agent".to_string(),
                            crate::state::USER_AGENT.to_string(),
                        ));
                    }
                    let is_cf = af.source.eq_ignore_ascii_case("curseforge")
                        || is_cf_domain(&af.identifier);
                    if is_cf {
                        headers.push(("x-api-key".to_string(), key_c.clone()));
                        headers.push((
                            "User-Agent".to_string(),
                            crate::state::USER_AGENT.to_string(),
                        ));
                    }
                    DownloadTarget::new(af.identifier.clone(), dest).with_headers(headers)
                })
                .collect();
            download_batch(&h_c, &mgr_c, files, Some("download-addons")).await?;
        }
        h_c.mark_step("download-addons", "done");
        Ok(())
    };

    let (res_a, res_b, res_c) = tokio::join!(branch_installer, branch_base, branch_addons);
    // 快速失败：首个非取消类错误胜出；同时置位取消标志让仍在跑的分支尽快退出
    let first_err = [
        res_a.as_ref().err(),
        res_b.as_ref().err(),
        res_c.as_ref().err(),
    ]
    .into_iter()
    .flatten()
    .find(|e| e.as_str() != "安装已取消")
    .cloned();
    if let Some(e) = first_err {
        handle.request_cancel();
        return Err(e);
    }
    // 全部为取消类错误 → 用户手动取消路径
    check_cancel(handle)?;
    let installer_path = res_a?;
    res_b?;
    res_c?;

    // === 串行尾：OptiFine 独立安装（无加载器场景；依赖 base 分支写盘的版本 JSON）===
    if optifine_standalone {
        if let Some(of) = optifine_version.as_deref() {
            if !of.trim().is_empty() {
                handle.mark_step("install-optifine", "active");
                handle.set_stage("installing-optifine");
                check_cancel(handle)?;
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
                handle.mark_step("install-optifine", "done");
            }
        }
    }

    // === 安装加载器（join 后：installer/loader-libs/base 均已就绪）===
    if has_loader_phase {
        handle.mark_step("install-loader", "active");
        handle.set_stage("installing-loader");
        check_cancel(handle)?;
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
        handle.mark_step("install-loader", "done");
    }

    // === 校验主 jar ===
    handle.mark_step("finalize", "active");
    handle.set_stage("verifying-jar");
    check_cancel(handle)?;
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
            vec![
                DownloadTarget::new(jar.url.clone(), game_root.join(&jar.path))
                    .with_headers(headers)
                    .with_sha1(&jar.sha1),
            ],
            Some("finalize"),
        )
        .await?;
    }

    // === 收尾 ===
    handle.set_stage("finishing");
    check_cancel(handle)?;

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

    handle.mark_step("finalize", "done");
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
///
/// C# 源用 `Path.GetFullPath` 产生**非 verbatim** 的 `C:\…` 绝对路径。此处 canonicalize
/// 后剥掉 verbatim 前缀，与 C# 行为一致（connector.rs 亦已对 launch 用非 verbatim 的
/// `instance.game_dir`，共识是非 verbatim 的 game_root 交给 core/外部工具）。
pub(crate) fn absolute_path(game_dir: &str) -> PathBuf {
    let mut root = PathBuf::from(game_dir);
    if !root.is_absolute() {
        root = crate::settings::resolve_base_dir().join(root);
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
pub(crate) fn build_core(
    game_root: &Path,
    mirror: DownloadMirror,
    http_client: reqwest::Client,
) -> Arc<GameCore> {
    let mut builder = GameCoreBuilder::new();
    builder
        .configure(|o| {
            o.launcher_name = "QML".to_string();
            o.game_root = game_root.to_string_lossy().into_owned();
            o.user_agent = crate::state::USER_AGENT.to_string();
            o.cache_expiry = Duration::from_secs(1800);
        })
        .use_download_mirror(mirror)
        .with_http_client(http_client);
    builder.build()
}

/// 在加载器版本列表中按版本号忽略大小写精确匹配，返回命中的条目。
fn pick_loader_by_version(
    loaders: Vec<qomicex_core::models::installer::ModLoaderResult>,
    version: &str,
) -> Option<qomicex_core::models::installer::ModLoaderResult> {
    loaders
        .into_iter()
        .find(|l| l.version.eq_ignore_ascii_case(version))
}

/// Forge 版本号归一化：剥离 MC 版本前缀与回显后缀，得到裸 Forge 版本。
///
/// 同一份 Forge 在各来源里的形态不同（1.7.10 实测）：
/// - 官方 maven 元数据：`10.13.4.1614-1.7.10`（artifact = `{mc}-{forge}`，而该
///   时代的 Forge 版本串自身就以 `-{mc}` 结尾，于是 artifact 成 `{mc}-{forge}-{mc}`）；
/// - BMCLAPI 列表：`10.13.4.1614`（裸 build 号）；
/// - 整合包 `version.json` / Solder 清单：`10.13.4.1614`。
///
/// 三者裸版本相同，差异只在 `{mc}` 前后缀。列表里存的必须是**该来源可寻址的
/// artifact 形态**（拼安装器直链要用它），比对时则统一按裸版本，否则跨来源的
/// 版本号永不相交（实测：整合包给的 `10.13.4.1614` 匹配不到官方列表的
/// `10.13.4.1614-1.7.10`，安装以「找不到 forge 的安装器」中止）。
pub(crate) fn canonical_forge_version(game_version: &str, version: &str) -> String {
    let version = version.trim();
    let mc = game_version.trim();
    if mc.is_empty() {
        return version.to_string();
    }
    let stripped = version
        .strip_prefix(mc)
        .map(|rest| rest.strip_prefix('-').unwrap_or(rest))
        .unwrap_or(version);
    let stripped = stripped.strip_suffix(&format!("-{mc}")).unwrap_or(stripped);
    // 只有前缀/后缀本身就是 MC 版本（`1.7.10`）时才会被剥空，此时原串即版本号。
    if stripped.is_empty() {
        version.to_string()
    } else {
        stripped.to_string()
    }
}

/// 与 [`pick_loader_by_version`] 相同，但精确匹配失败时按 Forge 裸版本号兜底。
///
/// 返回列表中**真实存在**的条目：其 `version` 是当前数据源可寻址的 artifact 形态，
/// 拼安装器直链必须用它，不能沿用调用方手里那个来源未知的版本号（见
/// [`canonical_forge_version`]）。
pub(crate) fn pick_forge_loader_by_version(
    loaders: Vec<qomicex_core::models::installer::ModLoaderResult>,
    version: &str,
    game_version: &str,
) -> Option<qomicex_core::models::installer::ModLoaderResult> {
    // 列表里可能同时存在同一 build 的两种形态（官方 `{forge}-{mc}` 与 BMCLAPI 裸号），
    // 单趟遍历会让「先出现的那条」决定结果；精确匹配优先，安装器 URL 才不会落到
    // 调用方没有请求的形态上。
    if let Some(index) = loaders
        .iter()
        .position(|l| l.version.eq_ignore_ascii_case(version))
    {
        return loaders.into_iter().nth(index);
    }
    let want = canonical_forge_version(game_version, version);
    loaders
        .into_iter()
        .find(|l| canonical_forge_version(game_version, &l.version).eq_ignore_ascii_case(&want))
}

fn check_cancel(handle: &InstallHandle) -> Result<(), String> {
    if handle.is_cancelled() {
        return Err("安装已取消".to_string());
    }
    Ok(())
}

/// modpack 外层并行编排复用同一取消检查语义。
pub(crate) fn ensure_not_cancelled(handle: &InstallHandle) -> Result<(), String> {
    check_cancel(handle)
}

/// 下载加载器安装器 jar；已存在且为有效 zip 时跳过（源 `DownloadLoaderJar`）。
#[allow(clippy::too_many_arguments)]
async fn download_installer_jar(
    handle: &InstallHandle,
    mgr: &DownloadManager,
    path: &Path,
    url: &str,
    loader: &str,
    game_version: &str,
    loader_version: &str,
    cf_headers: &[(String, String)],
    prefer_official: bool,
) -> Result<(), String> {
    if path.exists() {
        let valid = std::fs::File::open(path)
            .ok()
            .and_then(|f| zip::ZipArchive::new(f).ok())
            .map(|z| !z.is_empty())
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
    // BMCLAPI 的 forge/download 端点会回 200 却不发 body（实测），而它的 URL 形状
    // 与官方 maven 不同，下载器无法自行改写。这里按加载器版本补出官方 URL，按偏好
    // 决定主选：官方优先时直接走 maven，镜像优先时留作兜底。
    // BMCLAPI 的 forge/download/{id} 端点会回 200 空 body，但 BMCLAPI 的 /maven
    // 路径代理 Forge/NeoForge maven 是正常的（实测 302 → 文件节点 200），因此
    // 两侧都用 maven URL，彻底绕开那个坏端点。
    //
    // Forge 再补一个**双后缀候选**：1.7.10~1.9 时代的 artifact 是 `{mc}-{forge}-{mc}`，
    // 而 BMCLAPI 列表只给裸 build 号（`10.13.4.1614`），据此拼出的 `{mc}-{forge}`
    // 实测 404（官方列表形态已含 `-{mc}`，主选即命中，不会走到这个候选）。
    let official_candidates = official_installer_urls(loader, game_version, loader_version);
    let mut ordered: Vec<String> = Vec::new();
    for official in official_candidates {
        let bmclapi = bmclapi_maven_mirror(&official);
        if prefer_official {
            ordered.push(official);
            ordered.extend(bmclapi);
        } else {
            ordered.extend(bmclapi);
            ordered.push(official);
        }
    }
    let (primary, mirrors) = match ordered.split_first() {
        Some((primary, rest)) => (primary.clone(), rest.to_vec()),
        // 非 maven 交付的加载器（如 Cleanroom 的 GitHub Release）：沿用列表给的直链。
        None => (url.to_string(), Vec::new()),
    };
    let mut extra = std::collections::HashMap::new();
    if !mirrors.is_empty() {
        extra.insert(primary.clone(), mirrors);
    }
    download_batch_with_mirrors(
        handle,
        mgr,
        vec![DownloadTarget::new(primary, path.to_path_buf()).with_headers(headers)],
        Some("installer"),
        extra,
    )
    .await
}

/// Forge artifact 采用 `{mc}-{forge}-{mc}` **双后缀**的 MC 版本（该时代 forge 版本串
/// 自身以 `-{mc}` 结尾，maven 再加一次前缀）。
///
/// 来源：官方 `maven-metadata.xml` 全量 5093 条 artifact 实测，满足「artifact 以
/// `-{mc}` 结尾」的仅此 6 个；1.6.4 / 1.7.2 / 1.10.2 起均为 `{mc}-{forge}` 单后缀。
const FORGE_DOUBLE_SUFFIX_MC: &[&str] = &["1.7.10", "1.8", "1.8.8", "1.8.9", "1.9", "1.9.4"];

/// 官方加载器安装器 URL 候选（按优先级排列；首项为主选）。
///
/// 除 [`official_installer_url`] 的主形态外，[`FORGE_DOUBLE_SUFFIX_MC`] 时代的
/// Forge 再补出 `{mc}-{forge}-{mc}` 双后缀候选：BMCLAPI 版本列表只给裸 build 号
/// （`10.13.4.1614`），据此拼出的 `{mc}-{forge}` 实测 404（官方列表形态已含
/// `-{mc}`，主选即命中，不会走到该候选）。候选由下载器的镜像轮换在主选 404 后接管。
fn official_installer_urls(loader: &str, game_version: &str, loader_version: &str) -> Vec<String> {
    let Some(primary) = official_installer_url(loader, game_version, loader_version) else {
        return Vec::new();
    };
    let mut urls = vec![primary];
    let echo_suffix = format!("-{}", game_version.to_ascii_lowercase());
    let needs_echo = loader.eq_ignore_ascii_case("forge")
        && FORGE_DOUBLE_SUFFIX_MC
            .iter()
            .any(|mc| mc.eq_ignore_ascii_case(game_version))
        && !loader_version.is_empty()
        && !loader_version.to_ascii_lowercase().ends_with(&echo_suffix);
    let echoed = needs_echo
        .then(|| {
            official_installer_url(
                loader,
                game_version,
                &format!("{loader_version}-{game_version}"),
            )
        })
        .flatten();
    if let Some(echoed) = echoed {
        urls.push(echoed);
    }
    urls
}

/// 官方加载器安装器 URL（Forge / NeoForge）。
///
/// NeoForge 1.20.1 仍发布在 net/neoforged/forge 坐标下（版本形如 1.20.1-47.1.x），
/// 1.20.2 起才改为 net/neoforged/neoforge 且版本号不带游戏版本前缀。
fn official_installer_url(
    loader: &str,
    game_version: &str,
    loader_version: &str,
) -> Option<String> {
    match loader.to_ascii_lowercase().as_str() {
        "forge" => Some(format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{game_version}-{loader_version}/forge-{game_version}-{loader_version}-installer.jar"
        )),
        "neoforge" => Some(if game_version == "1.20.1" {
            format!(
                "https://maven.neoforged.net/releases/net/neoforged/forge/{game_version}-{loader_version}/forge-{game_version}-{loader_version}-installer.jar"
            )
        } else {
            format!(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/{loader_version}/neoforge-{loader_version}-installer.jar"
            )
        }),
        _ => None,
    }
}

/// 官方 maven URL 对应的 BMCLAPI /maven 镜像（不可改写时返回 None）。
fn bmclapi_maven_mirror(official: &str) -> Option<String> {
    crate::services::file_mirror::vanilla_fallback(official)
        .into_iter()
        .next()
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
    core: &Arc<GameCore>,
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
            let required_java = required_java_from_json(inherits_from_json);
            let java_path = resolve_java_path(core, required_java).await?;
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

/// 解析 Java 路径（源 `ResolveJavaPath`；改用与原版启动流程一致的版本感知选择：
/// 复用 Java 管理页已保存/合并的运行时列表（Quick 扫描 + 下载目录 + 自定义注册），
/// 按所需 Java 大版本经 `recommand` 选最优。旧实现 Deep 全盘扫描取第一个 Valid，
/// 既重复扫描，又会把 Apple JavaAppletPlugin 等遗留 Java 8 误选去跑需要 Java 17
/// 的 Forge/NeoForge 处理器，导致 binarypatcher 等退出码 1）。
pub(crate) async fn resolve_java_path(
    core: &Arc<GameCore>,
    required_java: i32,
) -> Result<String, String> {
    let javas = crate::endpoints::java::merged_java_runtimes(core).await;
    let javas: Vec<JavaResult> = javas
        .into_iter()
        .filter(|j| j.state == JavaState::Valid)
        .collect();
    if javas.is_empty() {
        return Err("未找到可用的 Java 运行时，请先下载或指定 Java".to_string());
    }
    let metadata = CompleteVersionMetadata {
        id: String::new(),
        r#type: "release".into(),
        main_class: String::new(),
        inherits_from: None,
        jar: None,
        arguments: None,
        libraries: Vec::new(),
        asset_index: None,
        downloads: None,
        java_version: Some(JavaVersion {
            component: "jre-legacy".into(),
            major_version: required_java,
        }),
        minimum_launcher_version: None,
        release_time: String::new(),
        time: String::new(),
    };
    let recommended = core
        .java_provider()
        .recommand(&javas, &metadata)
        .await
        .map_err(|e| format!("选择 Java 运行时失败: {e}"))?;
    Ok(recommended.path)
}

/// 从原版版本 JSON（`inherits_from_json`）解析所需 Java 大版本
/// （`javaVersion.majorVersion`，缺失默认 8，对应 `required_java_from_path` 默认）。
fn required_java_from_json(json: &str) -> i32 {
    let Ok(node) = serde_json::from_str::<Value>(json) else {
        return 8;
    };
    node.get("javaVersion")
        .and_then(|j| j.get("majorVersion"))
        .and_then(Value::as_i64)
        .map(|m| m as i32)
        .unwrap_or(8)
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
///
/// 返回 `(解析结果, 失败的 slug)`。**不再静默吞错**：调用方据此对必装 addon
/// （`default_loader_addons`，如 fabric-api / qsl）判断是否让安装失败 —— 否则会
/// 产出「安装报成功但缺少 fabric-api」的实例，启动后大量 mod 报错且无任何线索。
async fn resolve_addons(
    http_client: &reqwest::Client,
    addon_ids: &[String],
    game_version: &str,
    download_source_id: i32,
) -> (Vec<AdditionalFile>, Vec<String>) {
    let mut result = Vec::new();
    let mut failed = Vec::new();
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
            } else {
                tracing::warn!(addon = %id, "OptiFine addon 格式非法，已跳过");
                failed.push(id.clone());
            }
            continue;
        }
        slug_list.push(id.clone());
    }

    if slug_list.is_empty() {
        return (result, failed);
    }

    // 查询 Modrinth（源并发 12，这里顺序查询足够）。
    for slug in &slug_list {
        let url = format!("https://api.modrinth.com/v2/project/{slug}/version");
        let text = match http_client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(addon = %slug, error = %e, "addon 版本请求体读取失败");
                    failed.push(slug.clone());
                    continue;
                }
            },
            Ok(resp) => {
                tracing::warn!(addon = %slug, status = %resp.status(), "addon 版本请求失败");
                failed.push(slug.clone());
                continue;
            }
            Err(e) => {
                tracing::warn!(addon = %slug, error = %e, "addon 版本请求发送失败");
                failed.push(slug.clone());
                continue;
            }
        };
        let Ok(versions) = serde_json::from_str::<Value>(&text) else {
            tracing::warn!(addon = %slug, "addon 版本响应不是合法 JSON");
            failed.push(slug.clone());
            continue;
        };
        let Some(arr) = versions.as_array() else {
            tracing::warn!(addon = %slug, "addon 版本响应不是数组");
            failed.push(slug.clone());
            continue;
        };
        let mut resolved = false;
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
                    resolved = true;
                }
            }
            break;
        }
        if !resolved {
            // 有响应但没有匹配 game_version 的文件：等价于没解析出这个 addon。
            tracing::warn!(addon = %slug, game_version = %game_version, "addon 无匹配游戏版本的文件");
            failed.push(slug.clone());
        }
    }

    (result, failed)
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

/// 批量下载的单条目标。
pub(crate) struct DownloadTarget {
    /// 主选下载 URL（镜像由 [`download_batch`] 按 URL 追加）。
    pub url: String,
    /// 归一化后的目标路径。
    pub dest: PathBuf,
    /// 任务级请求头。
    pub headers: Vec<(String, String)>,
    /// 期望的 SHA-1（清单/版本 JSON 给出时用于落盘前校验，不符即换源重下）。
    pub sha1: Option<String>,
    /// 期望的文件大小（仅在无摘要时用于截断检测）。
    pub expected_size: Option<u64>,
}

impl DownloadTarget {
    pub fn new(url: impl Into<String>, dest: impl Into<PathBuf>) -> Self {
        Self {
            url: url.into(),
            dest: dest.into(),
            headers: Vec::new(),
            sha1: None,
            expected_size: None,
        }
    }

    pub fn with_headers(mut self, headers: Vec<(String, String)>) -> Self {
        self.headers = headers;
        self
    }

    /// 设置期望 SHA-1；空串与纯空白视为未提供（版本 JSON 的 `sha1` 常为空）。
    pub fn with_sha1(mut self, sha1: &str) -> Self {
        let sha1 = sha1.trim();
        self.sha1 = (!sha1.is_empty()).then(|| sha1.to_string());
        self
    }

    /// 设置期望文件大小；非正数视为未提供。
    pub fn with_size(mut self, size: Option<i64>) -> Self {
        self.expected_size = size.and_then(|n| u64::try_from(n).ok()).filter(|n| *n > 0);
        self
    }
}

/// 目标目录所在文件系统是否大小写不敏感（`Foo.jar` 与 `foo.jar` 会落到同一个文件）。
///
/// 平台差异比"Windows 不敏感 / Linux 敏感"更细：Windows 支持按目录开启的大小写敏感 NTFS
/// 目录（WSL 子树 / `fsutil file setCaseSensitiveInfo`），macOS 也支持大小写敏感的
/// APFS/HFS+ 卷。因此不按平台猜，而是实测：在目标目录里建一个探针文件，再用仅大小写不同的
/// 名字去访问——能访问到就说明文件系统不敏感。
///
/// 目标目录本身可能还不存在（下载任务的父目录要到 `download_batch` 里才
/// `create_dir_all`），所以探测会**沿路径向上找第一个已存在的祖先目录**：卷的大小写敏感性
/// 对整棵树一致（WSL 的 per-dir 标志虽可按目录设，但只在已存在的目录上有意义，向上取到
/// 已存在层即够用），这保证全新游戏目录也能得到正确结论。
///
/// 只缓存**确定**的结果（成功探测出敏感/不敏感）。以下情况返回 `false`（保守：不折叠）
/// 且不写缓存，下次调用会重新探测：
///
/// - 连已存在祖先都找不到（空路径/纯盘符）；
/// - 创建探针失败（权限、只读、磁盘满）；
/// - 撞上同名残留（可能是别的进程/上次崩溃留下的）；
/// - 读回内容不符。
///
/// 把 `false` 缓存下来会让"目录刚建好"的后续调用永远拿不到正确结论，重新引入 `.part` 争用
/// （#124 评审）；而缓存 `true` 是安全的——文件系统不会在进程生命期内从敏感变成不敏感。
///
/// 探测串行化（持锁做 I/O）：避免两个并发导入同时在同一目录建/删探针，把彼此的临时文件当成
/// "撞名残留"而误判为敏感。探测本身是几次小文件 I/O，锁只在高并发安装的首个文件上才有代价。
#[cfg(any(windows, target_os = "macos"))]
fn dir_is_case_insensitive(dir: &Path) -> bool {
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, bool>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let key = normalize_sep(dir.to_path_buf());
    let mut cache = cache.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(v) = cache.get(&key) {
        return *v;
    }
    let verdict = probe_case_insensitive(&key);
    if verdict {
        cache.insert(key, verdict);
    }
    verdict
}

/// 实测大小写敏感性：探针文件 + 仅大小写不同的别名。`dir` 必须已存在（调用方负责向上找
/// 已存在祖先）。返回 `true` 表示"确认不敏感"，`false` 表示"确认敏感"或"测不出"。
#[cfg(any(windows, target_os = "macos"))]
fn probe_case_insensitive(dir: &Path) -> bool {
    use std::io::Write;
    let probe = dir.join(".__qmx_case_probe__");
    if probe.exists() {
        // 撞上同名残留：测不出，保守判定为敏感、不缓存（下次重新探测）。
        return false;
    }
    let created = std::fs::File::create(&probe)
        .and_then(|mut f| f.write_all(b"1"))
        .is_ok();
    if !created {
        return false;
    }
    // 仅大小写不同的别名能否访问到同一文件 → 文件系统不敏感。
    let probe_other = probe.with_file_name(".__QMX_CASE_PROBE__");
    let verdict = probe_other.exists() && std::fs::read(&probe_other).is_ok_and(|b| b == b"1");
    let _ = std::fs::remove_file(&probe);
    verdict
}

/// 从 `dir` 开始沿路径向上找第一个**已存在**的目录，对它做大小写探测。
/// 全部祖先都不存在时返回 `false`（保守：不折叠），交由上层决定是否重新探测。
#[cfg(any(windows, target_os = "macos"))]
fn probe_case_insensitive_walk_up(dir: &Path) -> bool {
    let mut current = Some(dir);
    while let Some(d) = current {
        if d.is_dir() {
            return probe_case_insensitive(d);
        }
        current = d.parent();
    }
    false
}

#[cfg(not(any(windows, target_os = "macos")))]
fn dir_is_case_insensitive(_dir: &Path) -> bool {
    false
}

/// 判重键：归一化分隔符；若目标**父目录**所在文件系统大小写不敏感，再折叠大小写
/// （`Foo.jar` 与 `foo.jar` 会落在同一个文件上，也就共用同一个 `.part`）。
/// 键只用于判重，返回的目标路径保留原始大小写。
///
/// 大小写敏感卷上不折叠是安全侧的选择：漏合并只是多下一个同样的文件（能被 #122 的主修复
/// 覆盖：同路径字节相同的重复仍会被合并），而误合并会静默丢文件。
fn dedup_key(dest: &Path) -> String {
    let normalized = normalize_sep(dest.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let insensitive = dest
        .parent()
        .map(|p| {
            let p = normalize_sep(p.to_path_buf());
            // 目录不存在时沿祖先向上探测，全新游戏目录也能得到正确结论（#124 评审）。
            #[cfg(any(windows, target_os = "macos"))]
            {
                if p.is_dir() {
                    dir_is_case_insensitive(&p)
                } else {
                    probe_case_insensitive_walk_up(&p)
                }
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                dir_is_case_insensitive(&p)
            }
        })
        .unwrap_or(false);
    if insensitive {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// 被合并掉的重复目标。同 dest 的 URL 不一定是纯冗余（镜像/下载源差异、官方源在部分
/// 地区不可达），调用方应把 `url` 挂成保留条目的镜像备选，`name` 用于日志。
pub(crate) struct DroppedTarget {
    /// 判重键（`dedup_key`）——调用方按它归并/查找镜像表。用 `PathBuf` 做键会在大小写
    /// 折叠生效时与保留条目失配（`Foo.jar`/`foo.jar` 键相同、路径不同），导致镜像丢失。
    pub key: String,
    /// 展示名（文件名），仅用于日志。
    pub name: String,
    /// 被丢弃条目的 URL。
    pub url: String,
    /// 被丢弃条目的任务级请求头（同 dest 不同源时可能需要各自的鉴权头，如 CF `x-api-key`）。
    pub headers: Vec<(String, String)>,
}

/// miss 记录的判重键。与 [`dedup_miss_files`] 内部使用的键一致，供调用方按同一键空间归并
/// 镜像表（如实例资源补全）。`root` 是该记录的下载根，语义同 [`dedup_miss_files`]。
pub(crate) fn miss_file_key(path: &str, root: &Path) -> String {
    let root = normalize_sep(root.to_path_buf());
    dedup_key(&root.join(path))
}

/// 被合并目标 → 按判重键归并的镜像备选表（URL 去重、保持首次出现顺序）。
/// 抽成纯函数以便跨平台单测：insert 与 lookup 必须共用同一键空间，否则镜像会被静默丢弃。
pub(crate) fn merge_dropped_mirrors(dropped: Vec<DroppedTarget>) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::with_capacity(dropped.len());
    for d in dropped {
        let e = map.entry(d.key).or_default();
        // 同一 dest 的多个重复条目常给出字节相同的 URL（同 hash 资源），去重可避免主 URL
        // 重试耗尽后白跑一轮一模一样的请求。
        if !e.contains(&d.url) {
            e.push(d.url);
        }
    }
    map
}

/// 把被合并条目抢救出来的 URL 并入保留条目的镜像表：跳过与主 URL 相同的纯冗余项，并避免与
/// 既有镜像（如 `mirror_fallback_urls` 的同组节点）重复。
pub(crate) fn attach_mirrors(mirrors: &mut Vec<String>, url: &str, extra: Option<Vec<String>>) {
    for m in extra.unwrap_or_default() {
        if m == url || mirrors.contains(&m) {
            continue;
        }
        mirrors.push(m);
    }
}

/// 按目标路径去重（保留首次出现），返回 `(去重后列表, 被合并的重复目标)`。
///
/// 为什么必须去重：同一 `dest` 的两个下载任务会共用同一个 `.part` 中间文件
/// （`DownloadTask::part_path()` = dest 同名 + `.part`）。两个任务交错执行时，先完成者把
/// `.part` rename 成 dest，后完成者的 `finalize_part` 再打开 `.part` 就是 `os error 2`，
/// 整个安装以「下载阶段失败」告终（issue #122）。
///
/// 重复来源已实证（GTNH 2.9.0-RC-1 单次安装实测 dropped=12，首个就是 #122 报错的那个
/// `.part`）：
///
/// - 资源索引里同一 hash 的多个条目：`get_miss_assets` 按 `objects.values()` 展开，不同
///   资源名（语言文件/音效等）内容相同 → hash 相同 → 本地路径
///   `assets/objects/{hash[..2]}/{hash}` 也相同；
/// - 同坐标的「普通 jar 条目」与「natives 条目」：`check_libs_ver` 分组键给 natives 加
///   角色后缀，两者分到不同组而都保留，`downloads.artifact` 又是同一个 jar。
///
/// 归一化与判重都在本函数内完成（幂等）：调用方无需先 `normalize_sep`，避免将来新调用方
/// 忘记预归一化而重新引入 `.part` 竞态。返回的目标路径即归一化后的路径。
///
/// 大小写折叠只在目标父目录**确实**大小写不敏感时发生（`dedup_key` 会实测）：大小写敏感卷
/// 上 `Foo.jar` 与 `foo.jar` 是两个文件，折叠会静默丢掉第二个。
pub(crate) fn dedup_download_targets(
    files: Vec<DownloadTarget>,
) -> (Vec<DownloadTarget>, Vec<DroppedTarget>) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut kept: Vec<DownloadTarget> = Vec::with_capacity(files.len());
    let mut dropped: Vec<DroppedTarget> = Vec::new();
    for target in files {
        let dest = normalize_sep(target.dest);
        let key = dedup_key(&dest);
        let target = DownloadTarget { dest, ..target };
        if let Some(&kept_index) = seen.get(&key) {
            // name 只在重复分支里算：kept 条目的展示名由 download_batch 的 file_names 统一
            // 算一次，这里对上千条 miss 每条都算一遍纯属浪费。
            let name = target
                .dest
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| target.dest.to_string_lossy().into_owned());
            if !has_integrity_metadata(&kept[kept_index]) && has_integrity_metadata(&target) {
                // 重复条目带了校验元数据而先到的那条没有（如先追加的直链 + 后到的
                // CurseForge 条目）：校验值只描述它自己那条 URL 的字节，不能挪给别的 URL，
                // 所以让带元数据的条目当主目标，旧 URL 降级成镜像（镜像字节不符会被校验
                // 拒掉并继续换源）。直接丢弃则整条下载失去校验。
                let old = std::mem::replace(&mut kept[kept_index], target);
                dropped.push(DroppedTarget {
                    key,
                    name,
                    url: old.url,
                    headers: old.headers,
                });
            } else if integrity_metadata_conflicts(&kept[kept_index], &target) {
                // 两个 URL 都给了校验值且对不上：说明它们不是同一个文件，把冲突 URL 当镜像
                // 只会让下载在「换源 → 校验失败 → 换源」之间空转。
                tracing::warn!(
                    key = %key,
                    kept = %kept[kept_index].url,
                    duplicate = %target.url,
                    "download_batch: 重复目标的完整性元数据冲突，忽略冲突 URL"
                );
            } else {
                // 两侧校验元数据不冲突：把重复条目缺的那一侧补到保留条目上
                // （例如保留条目只有期望大小、重复条目带 SHA-1），再把它降级成镜像。
                merge_integrity_metadata(&mut kept[kept_index], &target);
                dropped.push(DroppedTarget {
                    key,
                    name,
                    url: target.url,
                    headers: target.headers,
                });
            }
            continue;
        }
        seen.insert(key, kept.len());
        kept.push(target);
    }
    (kept, dropped)
}

/// 两个绝对 URL 是否同源（scheme/host/port 一致）。解析失败按字符串比较。
fn same_origin(a: &str, b: &str) -> bool {
    match (url::Url::parse(a), url::Url::parse(b)) {
        (Ok(a), Ok(b)) => {
            a.scheme() == b.scheme()
                && a.host_str() == b.host_str()
                && a.port_or_known_default() == b.port_or_known_default()
        }
        _ => a == b,
    }
}

/// 是否带可校验内容的信息（SHA-1 或期望字节数）。
fn has_integrity_metadata(target: &DownloadTarget) -> bool {
    target.sha1.is_some() || target.expected_size.is_some()
}

/// 两个目标给出的校验值是否**互相矛盾**（任一侧缺省不算矛盾）。
fn integrity_metadata_conflicts(a: &DownloadTarget, b: &DownloadTarget) -> bool {
    let sha1_conflict = match (&a.sha1, &b.sha1) {
        (Some(left), Some(right)) => !left.eq_ignore_ascii_case(right),
        _ => false,
    };
    let size_conflict = match (a.expected_size, b.expected_size) {
        (Some(left), Some(right)) => left != right,
        _ => false,
    };
    sha1_conflict || size_conflict
}

/// 把重复条目的 SHA-1 / 期望大小补到保留条目上（调用方已排除冲突）。
fn merge_integrity_metadata(kept: &mut DownloadTarget, duplicate: &DownloadTarget) {
    if kept.sha1.is_none() {
        kept.sha1 = duplicate.sha1.clone();
    }
    if kept.expected_size.is_none() {
        kept.expected_size = duplicate.expected_size;
    }
}

/// 按 `path` 去重 `MissFileInfo`（保留首次出现），返回 `(去重后列表, 被合并的记录)`。
/// 语义与理由同 [`dedup_download_targets`]：同一 dest 的两个下载任务会共用 `.part`
/// 并互相删除，issue #122。用于直接消费 `get_miss_files_*` 结果的调用方
/// （如实例资源补全）：保留的记录原样返回（UI 展示的名称不变），被合并的记录整体
/// 返回，调用方可取其中的 URL 挂镜像备选、取 name 记日志。
///
/// 判重键同样在函数内归一化（`normalize_sep`，并按目标父目录实测的大小写敏感性决定是否
/// 折叠——见 `dedup_key`），core 拼出的 maven 路径带 `/`、不同安装器/下载源还可能给出
/// 大小写不同的路径，在不区分大小写的文件系统上它们指向同一个文件。
///
/// `root` 是这些 miss 记录真正的下载根（如游戏的 `.minecraft`），必须传：`MissFileInfo.path`
/// 是**相对**路径，直接拿它做键会让大小写探测去问"后端进程工作目录下的相对目录"——那不是
/// 文件实际落盘的位置，结论可能与实际目标卷相反（#124 评审）。
pub(crate) fn dedup_miss_files(
    files: Vec<MissFileInfo>,
    root: &Path,
) -> (Vec<MissFileInfo>, Vec<DroppedTarget>) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut kept: Vec<MissFileInfo> = Vec::with_capacity(files.len());
    let mut dropped: Vec<DroppedTarget> = Vec::new();
    let root = normalize_sep(root.to_path_buf());
    for f in files {
        let key = dedup_key(&root.join(&f.path));
        if !seen.insert(key.clone()) {
            // MissFileInfo 不带任务级请求头，补全路径的 URL 与保留条目同源（同一份 miss
            // 列表），沿用保留条目的头即可。
            dropped.push(DroppedTarget {
                key,
                name: f.name,
                url: f.url,
                headers: Vec::new(),
            });
            continue;
        }
        kept.push(f);
    }
    (kept, dropped)
}

/// 跨批次去重（issue #316）：installer 分支的 loader libs 与 base 分支可能命中
/// 同一个 `libraries/*` 目标。`claimed` 是 base 批次已经要下载的 dest 键集，
/// 命中即从本批次剔除 —— 同一文件只下一次，也不再有 DestGuard 目标占用失败。
///
/// 被剔除条目的 URL 不再参与 base 批次的镜像回退（base 自身已有官方/BMCLAPI
/// 兜底）；跨批次共享镜像需要延迟 base 下载或下载器支持 late-mirror，留待后续。
fn retain_unclaimed_libraries(
    files: Vec<MissFileData>,
    root: &Path,
    claimed: &HashSet<String>,
) -> Vec<MissFileData> {
    if claimed.is_empty() {
        return files;
    }
    let root = normalize_sep(root.to_path_buf());
    files
        .into_iter()
        .filter(|f| !claimed.contains(&dedup_key(&root.join(&f.path))))
        .collect()
}

/// 批量下载。进度按已下载字节比例写入 `step_id` 指定步骤的 percent，
/// 并由 tracker 重算合成总进度（并行管线中多个批次各自驱动自己的步骤）。
/// pause/cancel 由事件循环协作转发给 `DownloadManager`。
/// 运行期 stall 超时：事件已开始流动后，若此期间无任何事件则判定卡死。
/// 不用于冷启动：第一批任务在 semaphore 排队 + probe（HEAD + Range GET） +
/// CurseForge CDN 重定向解析期间可能需要数十秒，用短超时会误杀。
/// pub(crate)：modpack 在线安装管道（endpoints/modpack.rs）复用同一批逻辑。
const DOWNLOAD_BATCH_TIMEOUT: Duration = Duration::from_secs(120);
/// 冷启动宽容超时：从调用到第一个事件到达的最长容忍时间。
/// 覆盖 semaphore 等待（全局并发上限）+ probe 重试 + 首文件 TCP 建连。
const COLD_START_TIMEOUT: Duration = Duration::from_secs(180);

/// 暂存区文件是否仍满足当前目标的完整性元数据。
///
/// `resume_existing` 只比「记录的大小 == 磁盘大小」时，同尺寸坏字节会被当成完成；
/// 有 SHA-1 时必须重新算一遍，否则安装会带着损坏的库继续。
fn staged_file_matches_target(path: &std::path::Path, target: &DownloadTarget) -> bool {
    use sha1::Digest;
    use std::io::Read;

    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    if let Some(expected) = target.expected_size {
        if meta.len() != expected {
            return false;
        }
    }
    let Some(expected_sha1) = target.sha1.as_deref() else {
        return true;
    };
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = sha1::Sha1::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let Ok(n) = reader.read(&mut buf) else {
            return false;
        };
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    actual.eq_ignore_ascii_case(expected_sha1)
}

pub(crate) async fn download_batch(
    handle: &InstallHandle,
    mgr: &DownloadManager,
    files: Vec<DownloadTarget>,
    step_id: Option<&str>,
) -> Result<(), String> {
    download_batch_with_mirrors(
        handle,
        mgr,
        files,
        step_id,
        std::collections::HashMap::new(),
    )
    .await
}

/// 与 download_batch 相同，额外按主 URL 附加镜像（安装器等无法从 URL 推导兜底的场景）。
pub(crate) async fn download_batch_with_mirrors(
    handle: &InstallHandle,
    mgr: &DownloadManager,
    files: Vec<DownloadTarget>,
    step_id: Option<&str>,
    mut extra_by_url: std::collections::HashMap<String, Vec<String>>,
) -> Result<(), String> {
    if files.is_empty() {
        if let Some(sid) = step_id {
            handle.set_step_percent(sid, 100.0);
        }
        return Ok(());
    }

    // 同一 dest 的两个任务会共用 `{dest}.part`：交错执行时先完成者 rename 掉 .part，
    // 后完成者 finalize 直接 os error 2（issue #122）。整合包/版本安装的 miss 列表里
    // 「普通 jar 条目 + 同坐标 natives 条目」就是同一路径两条，必须先合并。
    // 归一化 + 判重都在 dedup 内部完成（幂等），返回的 dest 即归一化后的路径：
    // create_dir_all/rename 需要一个平台分隔符形式（Windows 的 verbatim 路径不允许 `/`，
    // core 拼出的 maven 路径却带 `/`，混用时报 ERROR_INVALID_NAME）。
    //
    // 注意：去重只覆盖**本批次**。`run_install_pipeline` 的 installer/base 两批
    // 在下载前已按 dest 键集跨批次合并（`retain_unclaimed_libraries`）；addons 与
    // 其余管线（modpack 的 game/files/overrides）扫描的目录互不相交。新增批次若
    // 再次重叠，仍会回到同 dest 争用 `.part` 的老问题。
    // 判重（含大小写敏感性探测）依赖目标父目录存在，而父目录平时要到下面的任务构建循环里
    // 才 create_dir_all。先统一建好，探测才不会落到"目录不存在"的保守分支——在不区分大小写
    // 的游戏目录上，两个仅大小写不同的目标若探测不到就会被判为敏感而漏合并，重新争用同一个
    // `.part`（#124 评审）。
    for target in &files {
        if let Some(parent) = target.dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let (files, duplicate_targets) = dedup_download_targets(files);
    let duplicates_len = duplicate_targets.len();
    // 被合并条目的鉴权头：保留条目没有头而它有头时补上。
    // 头只属于它原来的 URL：跨源转移会把凭据发给另一台主机，因此存下来源 URL，
    // 使用前再做同源判断。
    let mut dropped_headers: HashMap<String, Vec<(String, Vec<(String, String)>)>> = HashMap::new();
    for d in &duplicate_targets {
        if !d.headers.is_empty() {
            dropped_headers
                .entry(d.key.clone())
                .or_default()
                .push((d.url.clone(), d.headers.clone()));
        }
    }
    // 被合并掉的 URL 不是纯冗余：同 dest 不同源时它可能是唯一可达的源，挂成保留条目的镜像
    // 备选（与 mirror_fallback_urls 同一套故障转移），避免主 URL 不可达即整批失败。
    // 键与判重完全一致（dedup_key）：大小写不敏感的目录上 Foo.jar/foo.jar 去重键相同而
    // PathBuf 不同，用 PathBuf 做键会 remove 落空、镜像被静默丢弃。
    let mut extra_mirrors = merge_dropped_mirrors(duplicate_targets);
    let rescue_urls: usize = extra_mirrors.values().map(Vec::len).sum();
    let mut attached_urls = 0usize;

    // 上一轮失败后从暂存区恢复的实例目录：只复用**大小与暂存记录一致**的文件。
    // 记录缺失或大小不符一律重下——截断/过期的文件混进来比多下一次更糟。
    let (files, pre_done) = if handle.resume_existing() {
        let mut kept = Vec::with_capacity(files.len());
        let mut done = 0u64;
        for f in files {
            let recorded_ok = handle.resume_size_of(&f.dest).is_some_and(|expected| {
                std::fs::metadata(&f.dest)
                    .map(|m| m.is_file() && m.len() == expected)
                    .unwrap_or(false)
            });
            let complete = recorded_ok && staged_file_matches_target(&f.dest, &f);
            if complete {
                done += 1;
            } else {
                kept.push(f);
            }
        }
        (kept, done)
    } else {
        (files, 0u64)
    };

    // Pre-compute display names before consuming `files` in the loop below.
    let file_names: Vec<String> = files
        .iter()
        .map(|t| {
            t.dest
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| t.url.split('/').next_back().unwrap_or(&t.url).to_string())
                .to_string()
        })
        .collect();

    // Subscribe BEFORE adding tasks so no events are lost. `mgr.add()` sends
    // `StateChanged::Queued` synchronously and the dispatcher may immediately
    // transition to `Downloading`; a late subscriber would miss those ticks.
    let mut rx = mgr.subscribe();

    // 偏好只决定优先级，兜底是通用的：模组文件挂镜像/官方另一侧，原版文件挂
    // 官方/BMCLAPI 另一侧。两套函数对不匹配的 host 都返回空，可无脑叠加。
    let plan = crate::services::source_policy::SourcePlan::load();
    let mut ids = Vec::new();
    let mut file_url: HashMap<u64, String> = HashMap::new();
    for target in files {
        let url = target.url;
        // 父目录已在判重前统一创建，这里只兜底极端情况（判重后父目录被删）。
        let mut mirrors = crate::services::source_policy::mod_fallbacks(&url, &plan);
        let extra = extra_by_url.remove(&url);
        mirrors.extend(crate::services::source_policy::vanilla_fallback_urls(&url));
        // 加载器 meta/installer（QML-Mirror ↔ 官方互换，流量分工见 file_mirror 模块头）
        mirrors.extend(crate::services::file_mirror::loader_fallback_urls(&url));
        // 查表键与判重键一致；attach_mirrors 会跳过与主 URL 相同的纯冗余项与既有镜像。
        let key = dedup_key(&target.dest);
        let before = mirrors.len();
        attach_mirrors(&mut mirrors, &url, extra);
        attach_mirrors(&mut mirrors, &url, extra_mirrors.remove(&key));
        attached_urls += mirrors.len() - before;
        // 补上被合并条目自带的鉴权头（保留条目没有头时）；只接受同源 URL 的头，
        // 避免把凭据发给 promoted/镜像后的另一台主机。
        let mut headers = target.headers;
        if headers.is_empty() {
            if let Some(list) = dropped_headers.remove(&key) {
                headers = list
                    .into_iter()
                    .filter(|(source_url, _)| same_origin(source_url, &url))
                    .flat_map(|(_, h)| h)
                    .collect();
            }
        }
        let mut task = DownloadTask::new(&url, target.dest);
        // Authorization 是主机凭据：只允许发给同源镜像，避免换源时把 Bearer 外发。
        if headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        {
            let before = mirrors.len();
            mirrors.retain(|m| same_origin(m, &url));
            if mirrors.len() != before {
                tracing::warn!(
                    url = %crate::util::url::redact_url(&url),
                    dropped = before - mirrors.len(),
                    "带 Authorization 的任务丢弃跨源镜像，避免凭据外发"
                );
            }
        }
        task.headers = headers;
        if let Some(sha1) = &target.sha1 {
            task = task.with_sha1_hex(sha1);
        }
        if let Some(size) = target.expected_size {
            task = task.with_expected_size(size);
        }
        if !mirrors.is_empty() {
            task = task.with_mirrors(mirrors);
        }
        let id = mgr.add(task);
        file_url.insert(id, url);
        ids.push(id);
    }
    // 兜底告警：未被消费的镜像说明键空间又漂移了（曾因 PathBuf vs dedup_key 失配静默丢过
    // 一次），宁可吵出来也不要静默。
    if !extra_mirrors.is_empty() {
        tracing::warn!(
            leftover = extra_mirrors.len(),
            "download_batch: 有重复条目的镜像备选未能挂到保留任务上（键失配），已丢弃"
        );
    }
    if rescue_urls > 0 {
        tracing::info!(
            dropped = duplicates_len,
            rescue_urls,
            attached_urls,
            "download_batch: 合并重复下载目标（同 dest 多任务会互相删 .part，issue #122），不同源 URL 已并入镜像备选"
        );
    }

    // 已存在的文件计入分母与已完成数：重试时进度从上次的位置继续，而不是从 0 重数。
    let total = ids.len() as u64 + pre_done;
    tracing::info!(
        tasks = ids.len(),
        pre_done,
        total,
        mirrors_attached = attached_urls,
        plan = %plan.vanity_debug(),
        "download_batch 开始"
    );
    if ids.is_empty() {
        if let Some(sid) = step_id {
            handle.set_step_percent(sid, 100.0);
        }
        handle.update(|f| {
            f.total_files = total as i32;
            f.completed_files = total as i32;
        });
        return Ok(());
    }
    let id_set: HashSet<u64> = ids.iter().copied().collect();
    let mut done_ids: HashSet<u64> = HashSet::new();
    let mut failed: Option<String> = None;
    let mut failed_count: usize = 0;
    // 同 dest 的并发任务在 DownloadManager 层会短暂互斥；失败详情是「正在被另一个
    // 下载任务写入」时不是真失败，等对方完成后重试，避免跨批次安装直接失败。
    let mut dest_retries: HashMap<u64, u32> = HashMap::new();
    let mut prog: HashMap<u64, (u64, u64)> = HashMap::new();
    // 每任务**最近一次原始上报**的 downloaded（不做只增钳位）。仅用于 stall 看门狗的
    // 活跃判定：下载器重试会把计数打回 0，展示值因高水位不变，若用它判活会漏掉
    // 「正在重下」这一真实活动（见事件处理处注释）。
    let mut prog_raw: HashMap<u64, u64> = HashMap::new();
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
    // 上一次对账时间：主循环里按 1s 节流，与事件到达与否无关。
    let mut last_poll = Instant::now();
    // 批次进度累加器：吸收「分母随新任务增长」与「分子被重试清零」两处回退，
    // 保证同一批次内展示的百分比单调不减（见 BatchProgress 注释）。
    let mut batch_pct = BatchProgress::default();

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
            // 超时前一并记录各任务状态分布与最近失败原因：只报"超时"没法区分
            // 「全在排队」「全部卡在探测」「段重试耗尽」，线上只能靠它定位。
            let mut counts: std::collections::BTreeMap<String, usize> =
                std::collections::BTreeMap::new();
            let mut last_error_sample: Option<String> = None;
            for id in &ids {
                if done_ids.contains(id) {
                    continue;
                }
                let key = match mgr.state(*id).await {
                    Ok(state) => format!("{state:?}"),
                    Err(_) => "gone".to_string(),
                };
                *counts.entry(key).or_default() += 1;
                if last_error_sample.is_none() {
                    if let Some(e) = mgr.last_error(*id).await {
                        let name = file_name
                            .get(id)
                            .cloned()
                            .unwrap_or_else(|| format!("#{id}"));
                        let url = file_url.get(id).cloned().unwrap_or_default();
                        last_error_sample = Some(format!("{name}（url={url}）: {e}"));
                    }
                }
            }
            let pending = ids.len() as u64 - done_ids.len() as u64;
            tracing::warn!(
                done = done_ids.len() as u64 + pre_done,
                total,
                pending,
                states = ?counts,
                last_error = ?last_error_sample,
                timeout_s = stall_limit.as_secs(),
                "下载批次无进展，判定超时"
            );
            for id in &ids {
                let _ = mgr.cancel(*id).await;
            }
            // 已记录到具体失败原因时优先返回真因（Failed 事件可能已被广播竞态吞掉，
            // 因此这里从 `failed` 读取而不是直接丢弃）；看门狗只在无失败但卡死时兜底。
            let timeout_msg = format!(
                "下载超时：{}s 内无进展，{} 个文件未完成（状态 {:?}）",
                stall_limit.as_secs(),
                pending,
                counts
            );
            return Err(failed
                .clone()
                .or_else(|| last_error_sample.map(|e| format!("{timeout_msg}；最近错误: {e}")))
                .unwrap_or(timeout_msg));
        }

        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(DownloadEvent::Progress { id, downloaded, total: t, speed_bps, .. })
                    if id_set.contains(&id) => {
                        started = true;
                        // 活跃判定用**原始上报值**，与展示用的高水位分开：
                        // 下载器流式路径重试时会把 downloaded 打回 0 再涨回来
                        // （engine.rs::run_streamed 重试前 stats.downloaded.store(0)）。
                        // 若拿「只增不减的展示值」判活，重下期间 downloaded 一直不超过
                        // 旧高水位 → last_event 长时间不刷新 → 重下超过 120s 时
                        // stall 看门狗会误杀仍在正常传输的任务。故此处比较原始值：
                        // 只要字节数发生变化就说明在传数据，必须续命。
                        let prev_raw = prog_raw.entry(id).or_insert(downloaded);
                        if *prev_raw != downloaded {
                            last_event = Instant::now();
                            *prev_raw = downloaded;
                        }
                        // 展示用高水位：只增不减，吸收重试清零（「200/300 跳回 100/300」）。
                        let e = prog.entry(id).or_insert((0, 0));
                        if downloaded > e.0 {
                            e.0 = downloaded;
                        }
                        if t > 0 {
                            e.1 = t;
                        }
                        e.1 = e.1.max(e.0);
                        if speed_bps > 0 {
                            task_speed.insert(id, speed_bps);
                        }
                    }
                Ok(DownloadEvent::StateChanged { id, state, detail, .. })
                    if id_set.contains(&id) => {
                        last_event = Instant::now();
                        started = true;
                        let mut retried = false;
                        if state == TaskState::Failed {
                            if let Some(reason) = detail.as_deref() {
                                if is_dest_contention(reason) {
                                    let attempt = dest_retries.entry(id).or_insert(0);
                                    *attempt += 1;
                                    if *attempt <= 5 {
                                        tracing::warn!(
                                            id,
                                            attempt = *attempt,
                                            "目标文件被并发任务占用，稍后重试"
                                        );
                                        let _ = mgr.retry(id).await;
                                        retried = true;
                                    }
                                }
                            }
                        }
                        if !retried {
                            apply_terminal_state(
                                id,
                                state,
                                detail,
                                &mut done_ids,
                                &mut prog,
                                &mut task_speed,
                                &mut failed,
                                &mut failed_count,
                                &file_name,
                                &file_url,
                            );
                        }
                    }
                Ok(_) => {}
                // 事件积压（订阅端落后）不代表下载停摆，但也不能据此续命看门狗：
                // 通道里别的任务在动并不说明本批次在动。这里只记录，活性交给字节轮询。
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "下载批次事件通道落后，改由轮询判定活性");
                }
                Err(broadcast::error::RecvError::Closed) => {
                    return Err("下载器事件通道已关闭".to_string());
                }
            },
            // 固定 300ms 的"心跳"：没有事件时也要周期性醒来复查看门狗。
            // 不能写成 select 里新建的 `sleep(5s)`：分支每轮重建，事件持续到达时计时器
            // 永远重新开始，挂在分支里的对账会被饿死。对账本身在 select 之外按 1s 节流，
            // 与哪个分支先返回无关。
            _ = tokio::time::sleep(Duration::from_millis(300)) => {}
        }

        // 对账与活性判定放在主循环里按 1s 节流执行：无论事件是否丢失、是否持续到达，
        // 都能把终态任务计入 done，并用真实字节数续命看门狗。
        if last_poll.elapsed() >= Duration::from_secs(1) {
            last_poll = Instant::now();
            if poll_task_states(
                mgr,
                &id_set,
                &mut done_ids,
                &mut prog,
                &mut prog_raw,
                &mut task_speed,
                &mut failed,
                &mut failed_count,
                &file_name,
                &file_url,
                &mut dest_retries,
            )
            .await
            {
                started = true;
                last_event = Instant::now();
            }
        }

        let done = done_ids.len() as u64 + pre_done;
        // 已传输比例按「已完成文件数 + 在途文件的完成度」计算，而不是纯字节比：
        // 未开始的文件既不在 `prog` 分子也不在分母，纯字节比会在仅剩几十个未调度
        // 文件时冲到 99%（409/493 却显示 99%→100%）。文件数口径下 409/493 就是 83%。
        let inflight = inflight_credit(&prog, &done_ids);
        // 在途文件的部分完成度已经包含在 `inflight` 里，无需再与历史高水位之外的口径对齐；
        // BatchProgress 仍负责吸收重试清零带来的回退。
        let pct_in = batch_pct.observe(done, total, inflight);
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
            f.total_files = total as i32;
            f.completed_files = done as i32;
            f.current_file = current_file;
            // 当前批次（文件）的真实下载进度 0-100；批次结束清 0（阶段即将切换）
            f.current_file_progress = if done >= total { 0.0 } else { pct_in * 100.0 };
            // 字节比例写入本批次对应步骤并重算合成总进度
            let pct = if done >= total { 100.0 } else { pct_in * 100.0 };
            if let Some(sid) = step_id {
                f.set_step_percent(sid, pct);
            }
            // 批次冷启动（HEAD/Range 探测期）task_speed 为空：保留上一批次速度，
            // 避免批次切换瞬间速度掉 0 让 UI 闪回 "—"；有真实事件后照常覆盖。
            if !task_speed.is_empty() {
                f.speed = current_speed;
            }
            if paused_now {
                f.speed = 0.0;
                f.stage = "paused".to_string();
            }
        });

        if done >= total {
            break;
        }
    }

    match failed {
        Some(e) => {
            let summary = if failed_count > 1 {
                format!("{failed_count} 个文件下载失败，首个: {e}")
            } else {
                e
            };
            tracing::error!(
                failed = failed_count,
                total,
                detail = %summary,
                "download_batch 失败"
            );
            Err(summary)
        }
        None => Ok(()),
    }
}

/// 批次进度（0.0-1.0），按文件数口径。
///
/// `inflight` 是在途文件完成度之和（每项 0.0-1.0）。已完成的文件贡献 1，未开始的文件
/// 贡献 0：409/493 文件、其中若干在途时得到 83%~99% 之间的值，只有全部文件结束时才
/// 到 100%。旧实现用 Σdl/Σtot，未开始的文件对分子分母都是 0，会提前冲到 99%。
fn batch_percent(done: u64, total: u64, inflight: f64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    if done >= total {
        return 1.0;
    }
    // 每个未结束文件的在途贡献上限为 0.99：最后一个文件字节已经传完、但 Completed 事件
    // 还没到达时，in-flight 会等于剩余文件数，不加这层就会提前报满。`done` 才是唯一判据。
    let remaining = (total - done) as f64;
    let capped = inflight.min(remaining * 0.99);
    ((done as f64 + capped) / total as f64).clamp(0.0, 1.0)
}

/// 在途文件的完成度之和（每项 0.0-1.0）。
///
/// 已完成的任务已经由 `done` 计数，必须跳过，否则会被重复计算：50 个文件下完 18 个时
/// 会算成 (18+18)/50 = 72%，部分完成阶段直接冲到 100%。
fn inflight_credit(prog: &HashMap<u64, (u64, u64)>, done_ids: &HashSet<u64>) -> f64 {
    let mut acc = 0.0f64;
    for (id, (d, t)) in prog {
        if done_ids.contains(id) || *t == 0 {
            continue;
        }
        acc += (*d as f64 / *t as f64).min(1.0);
    }
    acc
}

/// 批次进度累加器：保证展示值在批次内**单调不减**。
///
/// 两个回退来源都被吸收：
/// 1. 分母变化 —— 重试时 `pre_done` 与在途任务数会变，分子分母可能不同步；
/// 2. 分子清零 —— 下载器流式路径每次重试前 `stats.downloaded.store(0)`
///    （engine.rs::run_streamed），单文件已下载字节会归零（「200/300 跳回 100/300」）。
///
/// 单任务字节的钳位由事件处理处完成（`e.0` 只增），本结构负责批次级高水位。
#[derive(Default)]
struct BatchProgress {
    /// 已展示过的最大百分比（0.0-1.0）。
    high_water: f64,
}

impl BatchProgress {
    /// 记录一次采样并返回单调化后的百分比（0.0-1.0）。
    fn observe(&mut self, done: u64, total: u64, inflight: f64) -> f64 {
        // batch_percent 在 done >= total 时已返回 1.0，故取 max 即可：批次结束的
        // 终态自然封顶 100%，且不会让进度回退。
        self.high_water = self.high_water.max(batch_percent(done, total, inflight));
        self.high_water
    }
}

/// 目标文件被同 dest 的并发任务短暂占用（DownloadManager 的 DestGuard），不是真失败。
fn is_dest_contention(reason: &str) -> bool {
    reason.contains("目标文件正在被另一个下载任务写入")
}

/// Apply a terminal-state event to the batch tracking maps. Extracted so the
/// polling fallback can reuse the exact same logic without duplicating state
/// machines.
#[allow(clippy::too_many_arguments)]
fn apply_terminal_state(
    id: u64,
    state: TaskState,
    detail: Option<String>,
    done_ids: &mut HashSet<u64>,
    prog: &mut HashMap<u64, (u64, u64)>,
    task_speed: &mut HashMap<u64, u64>,
    failed: &mut Option<String>,
    failed_count: &mut usize,
    file_name: &HashMap<u64, String>,
    file_url: &HashMap<u64, String>,
) {
    if done_ids.contains(&id) {
        return;
    }
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
            *failed_count += 1;
            if failed.is_none() {
                // 只保留首个失败的真因，但必须带文件名 + URL：用户日志里
                // 光一句「下载失败」无法定位是哪个文件、哪个源、什么状态码。
                let name = file_name
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{id}"));
                let url = crate::util::url::redact_url(
                    file_url.get(&id).map(String::as_str).unwrap_or(""),
                );
                let reason = crate::util::url::redact_urls_in_text(
                    &detail.unwrap_or_else(|| "下载器未返回原因".to_string()),
                );
                *failed = Some(format!("{name} 下载失败（url={url}）: {reason}"));
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
/// catches terminal states whose broadcast `StateChanged` events were dropped
/// (channel lag / 与 SSE watcher 竞争)，避免 `download_batch` 的 `done_ids`
/// 永久为空、进度卡在 0/N。
///
/// `state()` 只有枚举值；失败原因经 `last_error()` 补齐，避免轮询兜底把真因
/// 退化成无信息量的「下载失败」。
#[allow(clippy::too_many_arguments)]
async fn poll_task_states(
    mgr: &DownloadManager,
    id_set: &HashSet<u64>,
    done_ids: &mut HashSet<u64>,
    prog: &mut HashMap<u64, (u64, u64)>,
    prog_raw: &mut HashMap<u64, u64>,
    task_speed: &mut HashMap<u64, u64>,
    failed: &mut Option<String>,
    failed_count: &mut usize,
    file_name: &HashMap<u64, String>,
    file_url: &HashMap<u64, String>,
    dest_retries: &mut HashMap<u64, u32>,
) -> bool {
    let mut active = false;
    for &id in id_set {
        if done_ids.contains(&id) {
            continue;
        }
        // 字节数是「真的在传」的唯一可靠证据：状态停在 Downloading 也可能是卡住的。
        if let Ok(p) = mgr.progress(id).await {
            let prev_raw = prog_raw.entry(id).or_insert(p.downloaded);
            if *prev_raw != p.downloaded {
                *prev_raw = p.downloaded;
                active = true;
            }
            let e = prog.entry(id).or_insert((0, 0));
            if p.downloaded > e.0 {
                e.0 = p.downloaded;
            }
            if p.total > 0 {
                e.1 = p.total;
            }
            e.1 = e.1.max(e.0);
        }
        if let Ok(state) = mgr.state(id).await {
            if matches!(
                state,
                TaskState::Completed | TaskState::Failed | TaskState::Cancelled
            ) {
                let detail = mgr.last_error(id).await;
                if state == TaskState::Failed {
                    if let Some(reason) = detail.as_deref() {
                        if is_dest_contention(reason) {
                            let attempt = dest_retries.entry(id).or_insert(0);
                            *attempt += 1;
                            if *attempt <= 5 {
                                let _ = mgr.retry(id).await;
                                active = true;
                                continue;
                            }
                        }
                    }
                }
                apply_terminal_state(
                    id,
                    state,
                    detail,
                    done_ids,
                    prog,
                    task_speed,
                    failed,
                    failed_count,
                    file_name,
                    file_url,
                );
                active = true;
            }
        }
    }
    active
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_forge_installer_url_uses_maven_coordinate() {
        assert_eq!(
            official_installer_url("Forge", "1.20.1", "47.4.0").as_deref(),
            Some(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar"
            )
        );
    }

    #[test]
    fn official_neoforge_installer_url_depends_on_game_version() {
        assert_eq!(
            official_installer_url("NeoForge", "1.20.1", "47.1.106").as_deref(),
            Some(
                "https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar"
            )
        );
        assert_eq!(
            official_installer_url("NeoForge", "1.21.1", "21.1.172").as_deref(),
            Some(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-installer.jar"
            )
        );
    }

    #[test]
    fn official_installer_url_is_none_for_other_loaders() {
        assert_eq!(official_installer_url("Fabric", "1.20.1", "0.15.0"), None);
        assert_eq!(official_installer_url("Cleanroom", "1.12.2", "0.2.5"), None);
    }

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

    #[test]
    fn absolute_path_relative_anchors_to_base_dir_not_root() {
        // macOS 打包 App 的进程 cwd 是 `/`；相对 game_dir 必须锚定到数据目录，
        // 否则会变成 `/.minecraft`（根目录只读 → 写报错）。
        // 本测试对 QOMICEX_HOME 只读，但 expected 与 absolute_path 内部是两次独立
        // env 读取；必须与 error_report 等改写该变量的测试共用 ENV_LOCK，否则
        // 两次读取可能落入对方的改写窗口（实测会随并行调度偶发失败）。
        let _env_guard = crate::services::error_report::tests::ENV_LOCK
            .lock()
            .unwrap();
        let expected = crate::settings::resolve_base_dir().join(".minecraft");
        let got = absolute_path(".minecraft");
        assert_eq!(
            got, expected,
            "relative game_dir must anchor to BaseDir, not cwd"
        );
    }

    #[test]
    fn pick_loader_by_version_matches_case_insensitively_and_reports_miss() {
        use qomicex_core::models::installer::{ModLoaderResult, ModLoaderType};
        let mk = |v: &str| ModLoaderResult {
            r#type: ModLoaderType::NeoForge,
            version: v.to_string(),
            game_version: "1.21.1".to_string(),
            url: format!("https://example/{v}.jar"),
            sha1: String::new(),
            is_recommand: true,
            release_time: String::new(),
        };

        // 命中（忽略大小写）：BMC5 需要的 21.1.250 存在时必须被选中。
        let list = vec![mk("21.1.249"), mk("21.1.250")];
        let got = pick_loader_by_version(list, "21.1.250").expect("应命中 21.1.250");
        assert_eq!(got.url, "https://example/21.1.250.jar");

        // 未命中：列表非空但缺目标版本 → None（此前安装因不重试而直接失败）。
        let list = vec![mk("21.1.248"), mk("21.1.249")];
        assert!(pick_loader_by_version(list, "21.1.250").is_none());
    }

    /// Forge 版本号在各来源里的形态不同（官方列表 `10.13.4.1614-1.7.10` /
    /// BMCLAPI 与整合包 version.json 的裸 `10.13.4.1614`），归一化后必须相等。
    #[test]
    fn canonical_forge_version_strips_mc_prefix_and_echo() {
        assert_eq!(
            canonical_forge_version("1.7.10", "10.13.4.1614-1.7.10"),
            "10.13.4.1614"
        );
        assert_eq!(
            canonical_forge_version("1.8.9", "11.15.1.2318-1.8.9"),
            "11.15.1.2318"
        );
        // 完整 artifact 形态（带 mc 前缀 + 回显后缀）
        assert_eq!(
            canonical_forge_version("1.7.10", "1.7.10-10.13.4.1614-1.7.10"),
            "10.13.4.1614"
        );
        // 裸形态 / 单后缀时代：原样返回
        assert_eq!(
            canonical_forge_version("1.7.10", "10.13.4.1614"),
            "10.13.4.1614"
        );
        assert_eq!(
            canonical_forge_version("1.12.2", "14.23.5.2860"),
            "14.23.5.2860"
        );
        // 整串就是 MC 版本时不得剥成空串
        assert_eq!(canonical_forge_version("1.7.10", "1.7.10"), "1.7.10");
    }

    /// 回归（实测故障：`找不到 forge 10.13.4.1614 的安装器`）：整合包 version.json
    /// 给的裸版本号必须能命中官方列表的 artifact 形态，且返回列表里真实存在的那一条
    /// ——安装器直链要用它的 `version` 拼，沿用裸号会 404。
    #[test]
    fn pick_forge_loader_by_version_matches_across_source_forms() {
        use qomicex_core::models::installer::{ModLoaderResult, ModLoaderType};
        let mk = |v: &str| ModLoaderResult {
            r#type: ModLoaderType::Forge,
            version: v.to_string(),
            game_version: "1.7.10".to_string(),
            url: format!("https://example/{v}.jar"),
            sha1: String::new(),
            is_recommand: false,
            release_time: String::new(),
        };

        let list = vec![mk("10.13.4.1566-1.7.10"), mk("10.13.4.1614-1.7.10")];
        let got = pick_forge_loader_by_version(list, "10.13.4.1614", "1.7.10")
            .expect("裸版本号应命中官方 artifact 形态");
        assert_eq!(got.version, "10.13.4.1614-1.7.10");
        assert_eq!(got.url, "https://example/10.13.4.1614-1.7.10.jar");

        // 列表已是裸形态（BMCLAPI）时原样命中
        let list = vec![mk("10.13.4.1614")];
        assert_eq!(
            pick_forge_loader_by_version(list, "10.13.4.1614", "1.7.10")
                .unwrap()
                .version,
            "10.13.4.1614"
        );

        // 列表里确实没有该版本 → None（不造必然 404 的版本号）
        let list = vec![mk("10.13.4.1566-1.7.10")];
        assert!(pick_forge_loader_by_version(list, "10.13.4.1614", "1.7.10").is_none());

        // 古董包（Tekkit 1.2.5）的 `modpack.jar` 只有 fmlversion.properties，拿到的是裸
        // build 号（如 176），官方列表是 `1.2.5-3.4.9.171` 形态：必须匹配不到——一旦
        // 命中就会切到「1.2.5 无 installer 可用」的 Forge 管线，古董包反而装不上。
        let list = vec![mk("1.2.5-3.4.9.171")];
        assert!(pick_forge_loader_by_version(list, "176", "1.2.5").is_none());
    }

    /// 同一 build 的两种形态同时出现在列表里时，命中调用方请求的那个形态，不受
    /// 列表顺序影响（否则安装器 URL 会指向没请求的那条）。
    #[test]
    fn pick_forge_loader_by_version_prefers_exact_form() {
        use qomicex_core::models::installer::{ModLoaderResult, ModLoaderType};
        let mk = |v: &str| ModLoaderResult {
            r#type: ModLoaderType::Forge,
            version: v.to_string(),
            game_version: "1.7.10".to_string(),
            url: format!("https://example/{v}.jar"),
            sha1: String::new(),
            is_recommand: false,
            release_time: String::new(),
        };

        let list = vec![mk("10.13.4.1614-1.7.10"), mk("10.13.4.1614")];
        assert_eq!(
            pick_forge_loader_by_version(list, "10.13.4.1614", "1.7.10")
                .unwrap()
                .version,
            "10.13.4.1614"
        );

        let list = vec![mk("10.13.4.1614"), mk("10.13.4.1614-1.7.10")];
        assert_eq!(
            pick_forge_loader_by_version(list, "10.13.4.1614-1.7.10", "1.7.10")
                .unwrap()
                .version,
            "10.13.4.1614-1.7.10"
        );
    }

    /// BMCLAPI 列表只给裸 build 号时主选 URL 必然 404（实测），必须补出
    /// `{mc}-{forge}-{mc}` 双后缀候选作镜像兜底。
    #[test]
    fn official_installer_urls_adds_double_suffix_forge_candidate() {
        let urls = official_installer_urls("forge", "1.7.10", "10.13.4.1614");
        assert_eq!(urls.len(), 2, "裸 build 号应补出双后缀候选: {urls:?}");
        assert!(
            urls[0].ends_with("/forge/1.7.10-10.13.4.1614/forge-1.7.10-10.13.4.1614-installer.jar")
        );
        assert!(urls[1].ends_with(
            "/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-installer.jar"
        ));

        // 官方列表形态（已含 `-{mc}`）：不重复补候选
        assert_eq!(
            official_installer_urls("forge", "1.7.10", "10.13.4.1614-1.7.10").len(),
            1
        );
        // 单后缀时代（1.12.2 无 `{mc}-{forge}-{mc}` artifact）：不补
        assert_eq!(
            official_installer_urls("forge", "1.12.2", "14.23.5.2860").len(),
            1
        );
        // 非 maven 交付的加载器：无候选
        assert!(official_installer_urls("fabric", "1.20.1", "0.15.0").is_empty());
    }

    #[test]
    fn required_java_from_json_reads_java_version() {
        // MC 1.20.1 原版 JSON：javaVersion.majorVersion = 17（Forge 26.2 处理器依赖）
        let json =
            r#"{"id":"1.20.1","javaVersion":{"component":"java-runtime-delta","majorVersion":17}}"#;
        assert_eq!(required_java_from_json(json), 17);
        // 1.21.1：majorVersion = 21
        let json = r#"{"id":"1.21.1","javaVersion":{"majorVersion":21}}"#;
        assert_eq!(required_java_from_json(json), 21);
        // 无 javaVersion → 默认 8（对应 required_java_from_path 默认）
        assert_eq!(required_java_from_json(r#"{"id":"1.12.2"}"#), 8);
        // 非法 / 空 JSON → 默认 8
        assert_eq!(required_java_from_json("not json"), 8);
        assert_eq!(required_java_from_json(""), 8);
    }

    fn target(url: &str, dest: &str) -> DownloadTarget {
        DownloadTarget::new(url.to_string(), PathBuf::from(dest))
    }

    /// issue #122：同一 dest 的两条（普通 jar 条目 + 同坐标 natives 条目共享
    /// `downloads.artifact`）必须合并成一条。否则两个任务共用 `{dest}.part`，
    /// 交错执行时后完成者的 finalize 打开 `.part` 报 os error 2，整个安装失败。
    ///
    /// 路径统一用 `/`：CI 的 backend-check 跑在 ubuntu 上，`\` 在 Unix 不是分隔符，
    /// `Path::file_name()` 会退化成整条字符串（与 Windows 行为不同）。
    #[test]
    fn dedup_download_targets_merges_same_dest() {
        let jar = "libraries/org/lwjgl3/lwjgl/3.3.3/lwjgl-3.3.3.jar";
        let natives = "libraries/org/lwjgl3/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar";
        let (kept, dropped) = dedup_download_targets(vec![
            target("https://cdn/lwjgl-3.3.3.jar", jar),
            // 同一坐标的 natives 条目：check_libs_ver 分组键带角色后缀 → 与普通条目
            // 分到不同组而都保留，artifact 却是同一个 jar。
            target("https://cdn/lwjgl-3.3.3.jar", jar),
            target("https://cdn/lwjgl-3.3.3-natives-windows.jar", natives),
        ]);
        assert_eq!(
            kept.len(),
            2,
            "普通 jar 与 natives jar 都应保留，重复的普通 jar 合并"
        );
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].name, "lwjgl-3.3.3.jar");
        assert_eq!(kept[0].dest, PathBuf::from(jar));
        assert_eq!(kept[1].dest, PathBuf::from(natives));
    }

    /// 同 dest 不同 URL 时，被合并的 URL 必须回传给调用方挂镜像备选——它可能是唯一可达
    /// 的源（镜像/下载源差异、官方源局部不可达），直接丢弃会让主 URL 挂掉即整批失败。
    #[test]
    fn dedup_download_targets_rescues_duplicate_source_url() {
        let (kept, dropped) = dedup_download_targets(vec![
            target("https://official/a.jar", "g/a.jar"),
            target("https://mirror/a.jar", "g/a.jar"),
        ]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].url, "https://official/a.jar", "保留首次出现的条目");
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].url, "https://mirror/a.jar");
        // 键即判重键：调用方按它就能把保留条目与抢救 URL 对上。
        assert_eq!(dropped[0].key, dedup_key(Path::new("g/a.jar")));
    }

    /// 重复条目带校验值而先到的那条没有时，必须让带校验值的条目当主目标：SHA-1 只描述它
    /// 自己那条 URL 的字节，挪给别的 URL 会误判；直接丢弃则整条下载失去校验。
    #[test]
    fn dedup_download_targets_promotes_target_with_checksum() {
        let (kept, dropped) = dedup_download_targets(vec![
            target("https://cdn/a.jar", "mods/a.jar"),
            target("https://edge.forgecdn.net/a.jar", "mods/a.jar")
                .with_sha1("AABBCC")
                .with_size(Some(1024)),
        ]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].url, "https://edge.forgecdn.net/a.jar");
        assert_eq!(kept[0].sha1.as_deref(), Some("AABBCC"));
        assert_eq!(kept[0].expected_size, Some(1024));
        // 旧 URL 仍作为镜像备选回传，不能连带丢掉可达源。
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].url, "https://cdn/a.jar");
        assert_eq!(dropped[0].key, dedup_key(Path::new("mods/a.jar")));
    }

    /// 保留条目只有期望大小时，重复条目的 SHA-1 必须合并进来，否则同尺寸坏字节
    /// 仍会通过校验。
    #[test]
    fn dedup_download_targets_merges_missing_sha1() {
        let (kept, dropped) = dedup_download_targets(vec![
            target("https://cdn/a.jar", "mods/a.jar").with_size(Some(1024)),
            target("https://other/a.jar", "mods/a.jar")
                .with_sha1("AABBCC")
                .with_size(Some(1024)),
        ]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].sha1.as_deref(), Some("AABBCC"));
        assert_eq!(kept[0].expected_size, Some(1024));
        assert_eq!(dropped.len(), 1, "重复 URL 仍应作为镜像备选");
    }

    #[test]
    fn same_origin_compares_scheme_host_port() {
        assert!(same_origin("https://a.example/x", "https://a.example/y"));
        assert!(!same_origin("https://a.example/x", "http://a.example/x"));
        assert!(!same_origin("https://a.example/x", "https://b.example/x"));
        assert!(!same_origin(
            "https://a.example/x",
            "https://a.example:8443/x"
        ));
    }

    /// 两个 URL 都带校验值且对不上：它们不是同一个文件。保留先到的可校验条目，冲突 URL
    /// 既不能当主目标也不能当镜像（只会让下载在换源与校验失败之间空转）。
    #[test]
    fn dedup_download_targets_drops_conflicting_checksum() {
        let (kept, dropped) = dedup_download_targets(vec![
            target("https://cdn/a.jar", "mods/a.jar").with_sha1("aabbcc"),
            target("https://other/a.jar", "mods/a.jar").with_sha1("ddeeff"),
        ]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].url, "https://cdn/a.jar");
        assert!(dropped.is_empty(), "校验冲突的 URL 不应挂成镜像");
    }

    /// 归一化必须在判重之前，且由去重函数自己完成（调用方无需先 normalize_sep）：
    /// core 拼出的 maven 路径带 `/`，与 `\` 形态是同一个目标。这里刻意**不**预归一化，
    /// 直接喂原始字符串，才能锁住顺序（ubuntu 上该用例不编译也不运行，靠 Windows 覆盖）。
    #[cfg(windows)]
    #[test]
    fn dedup_download_targets_compares_after_separator_normalization() {
        let (kept, dropped) = dedup_download_targets(vec![
            target(
                "https://cdn/asm.jar",
                r"C:\g\libraries\org/ow2/asm/asm/9.10.1/asm-9.10.1.jar",
            ),
            target(
                "https://cdn/asm.jar",
                r"C:\g\libraries\org\ow2\asm\asm\9.10.1\asm-9.10.1.jar",
            ),
        ]);
        assert_eq!(kept.len(), 1, "归一化后同一路径只应保留一条");
        assert_eq!(dropped.len(), 1);
        // 返回的 dest 已归一化为平台分隔符（Windows 上不带 `/`），可直接 create/rename。
        assert_eq!(
            kept[0].dest,
            PathBuf::from(r"C:\g\libraries\org\ow2\asm\asm\9.10.1\asm-9.10.1.jar")
        );
    }

    /// 目标**父目录真实存在**时，`Foo.jar` 与 `foo.jar` 在大小写不敏感的文件系统上是同一个
    /// 文件（也共用同一个 `.part`），判重键必须折叠大小写；键折叠但保留条目的路径维持原始
    /// 大小写。
    ///
    /// 目录必须真的创建出来：`dedup_key` 会探测父目录实际的大小写敏感性（见
    /// `dir_is_case_insensitive`），用不存在的路径只会得到保守的"敏感"结论。
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn dedup_download_targets_folds_case_on_case_insensitive_fs() {
        let dir = std::env::temp_dir().join(format!("qomicex-dedup-case-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let foo = dir.join("Foo.jar");
        let bar = dir.join("foo.jar");
        let (kept, dropped) = dedup_download_targets(vec![
            target("https://cdn/Foo.jar", &foo.to_string_lossy()),
            target("https://cdn/foo.jar", &bar.to_string_lossy()),
        ]);
        if dir_is_case_insensitive(&dir) {
            assert_eq!(kept.len(), 1, "该文件系统大小写不敏感 → 只保留一条");
            assert_eq!(dropped.len(), 1);
            assert_eq!(kept[0].dest, foo, "保留条目的路径维持原始大小写");
        } else {
            // 开发机恰好是大小写敏感卷：两个目标都应保留（这条路径由下面那条用例覆盖）。
            assert_eq!(kept.len(), 2, "该文件系统大小写敏感 → 两条都保留");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 大小写敏感的目标目录上 `Foo.jar` 与 `foo.jar` 是两个不同文件，**不能**折叠——
    /// 否则第二个永远不会被下载（#124 评审）。
    ///
    /// 用**空父目录名**构造"连已存在祖先都找不到"的兜底路径，在任何开发机上都能跑。
    #[test]
    fn dedup_key_keeps_case_when_sensitivity_unknown() {
        let foo = Path::new("Foo.jar");
        let bar = Path::new("foo.jar");
        assert!(
            dedup_key(foo) != dedup_key(bar),
            "探测不到大小写敏感性时必须保持大小写区分，否则会静默丢文件"
        );
    }

    /// 探测不到时**不得缓存 `false`**：目录后建起来，再问一次必须拿到真实结论。
    ///
    /// 这正是 #124 评审的回归点——把 `false`（目录不存在）缓存下来后，即使随后
    /// `download_batch` 建好了父目录，判重仍判"敏感"而漏合并，两个仅大小写不同的目标重新
    /// 争用同一个 `.part`。
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn dir_is_case_insensitive_does_not_cache_negative_results() {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-case-cache-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        // 目录还不存在 → 单纯目录名（无已存在祖先可问），得到 false。
        assert!(
            !dir_is_case_insensitive(&dir),
            "空目录名得不到结论时应为 false"
        );
        // 建好目录：现在能问到真实结论，且必须与"整卷是否敏感"一致。
        std::fs::create_dir_all(&dir).unwrap();
        let verdict = dir_is_case_insensitive(&dir);
        assert_eq!(
            verdict,
            probe_case_insensitive(&dir),
            "目录已存在时必须重新探测，不能沿用之前缓存的 false"
        );
        // 确认后的 true 会被缓存：第二次调用走缓存仍得同一答案。
        assert_eq!(dir_is_case_insensitive(&dir), verdict);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `dedup_miss_files`：同一 `path` 的多条 miss 记录按路径合并，保留首次出现的记录
    /// （UI 展示的 name 不变），被合并的记录整体回传（调用方取其 URL 挂镜像备选）。
    #[test]
    fn dedup_miss_files_merges_same_path() {
        let mk = |name: &str, path: &str| qomicex_core::models::installer::MissFileInfo {
            name: name.to_string(),
            url: "https://cdn/x.jar".to_string(),
            sha1: String::new(),
            path: path.to_string(),
        };
        // root 必须真的存在，且按 pid 隔离：`dedup_key` 会探测父目录的大小写敏感性，
        // 目录不存在时 `probe_case_insensitive_walk_up` 会一路向上找已存在祖先，
        // 最终落到共享的 `%TEMP%` 并在那里建同名探针文件。与同样探测 `%TEMP%` 的
        // 其它测试并发时，双方会看到对方残留的探针 → 探测得到不一致的结论 →
        // 去重键不一致（issue #166 的 flaky 根因）。
        // 建好目录后探测只发生在本目录内，不再与其它测试共享探针位置。
        let root = std::env::temp_dir().join(format!("qomicex-miss-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let (kept, dropped) = dedup_miss_files(
            vec![
                mk(
                    "org.lwjgl3:lwjgl:3.3.3",
                    "libraries/org/lwjgl3/lwjgl/3.3.3/lwjgl-3.3.3.jar",
                ),
                mk(
                    "org.lwjgl3:lwjgl:3.3.3",
                    "libraries/org/lwjgl3/lwjgl/3.3.3/lwjgl-3.3.3.jar",
                ),
                mk(
                    "org.lwjgl3:lwjgl:3.3.3:natives-windows",
                    "libraries/org/lwjgl3/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar",
                ),
            ],
            &root,
        );
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].name, "org.lwjgl3:lwjgl:3.3.3");
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].name, "org.lwjgl3:lwjgl:3.3.3");
        // 探测会在 root 内留下 .__qmx_case_probe__ 残留，测完清理避免堆积。
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 跨批次去重（#316）：base 批次已覆盖的 dest 从 loader 批次剔除，避免两批
    /// 争用同一个 `.part`；未命中的目标保持不动，空键集时原样返回。
    #[test]
    fn retain_unclaimed_libraries_drops_dests_covered_by_base() {
        let root = std::env::temp_dir().join(format!("qomicex-cross-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let mk = |path: &str| MissFileData {
            name: "x".to_string(),
            path: path.to_string(),
            url: "https://cdn/x.jar".to_string(),
            sha1: String::new(),
        };
        let shared = "libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar";
        let claimed: HashSet<String> = [dedup_key(&normalize_sep(root.join(shared)))]
            .into_iter()
            .collect();

        let kept = retain_unclaimed_libraries(
            vec![
                mk(shared),
                mk("libraries/net/minecraftforge/forge/1.20.1/forge.jar"),
            ],
            &root,
            &claimed,
        );
        assert_eq!(kept.len(), 1);
        assert_eq!(
            kept[0].path,
            "libraries/net/minecraftforge/forge/1.20.1/forge.jar"
        );

        assert_eq!(
            retain_unclaimed_libraries(vec![mk(shared)], &root, &HashSet::new()).len(),
            1,
            "base 没有缺失文件时不能丢任何 loader 条目"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 判重键由去重函数内部归一化：`/` 与 `\` 形态是同一个目标（core 的 maven 路径带
    /// `/`），不预归一化直接喂原始字符串，锁住"归一化先于判重"的顺序。
    #[cfg(windows)]
    #[test]
    fn dedup_miss_files_normalizes_separators_before_comparing() {
        let mk = |name: &str, path: &str| qomicex_core::models::installer::MissFileInfo {
            name: name.to_string(),
            url: "https://cdn/asm.jar".to_string(),
            sha1: String::new(),
            path: path.to_string(),
        };
        // 同 `dedup_miss_files_merges_same_path`：root 必须存在且按 pid 隔离，
        // 否则大小写探测会上溯到共享 `%TEMP%` 与并发测试互撞（issue #166）。
        let root =
            std::env::temp_dir().join(format!("qomicex-miss-root-sep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let (kept, dropped) = dedup_miss_files(
            vec![
                mk(
                    "org.ow2.asm:asm:9.10.1",
                    r"libraries\org\ow2\asm\asm\9.10.1\asm-9.10.1.jar",
                ),
                mk(
                    "org.ow2.asm:asm:9.10.1",
                    "libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar",
                ),
            ],
            &root,
        );
        assert_eq!(kept.len(), 1, "归一化后同一路径只应保留一条");
        assert_eq!(dropped.len(), 1);
        // 保留的是首次出现的原始记录（含原始分隔符），UI 名称不受影响。
        assert_eq!(kept[0].name, "org.ow2.asm:asm:9.10.1");
        // 同 merges_same_path：清理探测残留。
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- merge_dropped_mirrors / attach_mirrors（跨平台可测，不依赖 cfg(windows)） ---

    fn dropped(key: &str, url: &str) -> DroppedTarget {
        DroppedTarget {
            key: key.to_string(),
            name: "x.jar".to_string(),
            url: url.to_string(),
            headers: Vec::new(),
        }
    }

    fn miss(name: &str, path: &str, url: &str) -> qomicex_core::models::installer::MissFileInfo {
        qomicex_core::models::installer::MissFileInfo {
            name: name.to_string(),
            url: url.to_string(),
            sha1: String::new(),
            path: path.to_string(),
        }
    }

    /// 抢救出来的镜像必须能用**保留条目的键**取回：insert 与 lookup 共用 dedup_key，
    /// 这正是大小写折叠生效时 PathBuf 键失配、镜像被静默丢弃的那个坑（issue #124 评审）。
    #[test]
    fn merge_dropped_mirrors_keyed_by_dedup_key() {
        let map = merge_dropped_mirrors(vec![dropped("k1", "https://mirror/a.jar")]);
        assert_eq!(
            map.get("k1").map(Vec::as_slice),
            Some(&["https://mirror/a.jar".to_string()][..])
        );
        // lookup 端用同一函数算键（模拟 download_batch 的 remove）
        assert!(merge_dropped_mirrors(vec![dropped(
            &dedup_key(Path::new("g/a.jar")),
            "https://mirror/a.jar"
        )])
        .contains_key(&dedup_key(Path::new("g/a.jar"))));
    }

    /// 已完成的任务不得重复计入在途完成度（409/493 显示 99% 的成因之一）。
    #[test]
    fn inflight_credit_skips_completed_tasks() {
        let mut prog: HashMap<u64, (u64, u64)> = HashMap::new();
        prog.insert(1, (100, 100)); // 已完成
        prog.insert(2, (50, 100)); // 在途一半
        prog.insert(3, (0, 0)); // 大小未知
        let done: HashSet<u64> = [1u64].into_iter().collect();
        let credit = inflight_credit(&prog, &done);
        assert!(
            (credit - 0.5).abs() < 1e-9,
            "只应统计在途任务，实际 {credit}"
        );
        // 已完成 1 个 + 在途 0.5 → 50 个文件时是 3%？
        let pct = batch_percent(1, 50, credit);
        assert!((pct - 1.5 / 50.0).abs() < 1e-9);
    }

    /// 进度按文件数口径：409/493 已完成、其余在途时不能显示 99%~100%。
    ///
    /// 旧实现用 Σdl/Σtot，未开始的文件对分子分母都贡献 0，最后 84 个文件还没调度就
    /// 冲到 99%（截图里「409/493 文件 100%」的成因）。
    #[test]
    fn batch_percent_counts_files_not_bytes() {
        // 493 个文件里 409 个已完成，剩余 84 个中 10 个各下了一半
        let pct = batch_percent(409, 493, 5.0);
        assert!(
            (pct - 414.0 / 493.0).abs() < 1e-9,
            "应按 (已完成 + 在途完成度) / 总数 计算，实际 {pct}"
        );
        assert!(pct < 0.85, "409/493 应显示约 84%，实际 {pct}");
        // 仅剩 1 个文件时也不允许报满
        assert!(batch_percent(492, 493, 0.99) < 1.0);
        // 在途贡献满额（最后一份字节已传完、终态事件未到）同样不得报满
        assert!(batch_percent(492, 493, 1.0) < 1.0);
        assert!(batch_percent(490, 493, 10.0) < 1.0);
    }

    /// 批次展示进度不得回退：在途文件的字节被重试清零时，高水位吸收回退。
    #[test]
    fn batch_progress_does_not_regress_when_inflight_resets() {
        let mut bp = BatchProgress::default();
        let p1 = bp.observe(100, 493, 40.0);
        assert!(p1 > 0.28, "首次采样应为 (100+40)/493，实际 {p1}");

        // 在途任务重试，完成度归零 → 裸值下降
        let raw = batch_percent(100, 493, 0.0);
        assert!(raw < p1, "前提校验：在途清零确实拉低瞬时百分比");

        let p2 = bp.observe(100, 493, 0.0);
        assert_eq!(p2, p1, "回退被高水位吸收，保持峰值");
    }

    /// 单调性在整批采样序列下持续成立（覆盖在途波动 / 完成数递增 / 结束）。
    #[test]
    fn batch_progress_monotonic_over_sample_sequence() {
        let mut bp = BatchProgress::default();
        let mut last = 0.0f64;
        // (done, total, inflight)：模拟 493 文件、并发 64，中间夹带在途清零的采样。
        let samples: &[(u64, u64, f64)] = &[
            (0, 493, 0.0),
            (0, 493, 0.0),
            (60, 493, 20.0),
            (60, 493, 0.0), // 在途被重试清零
            (180, 493, 64.0),
            (409, 493, 5.0),
            (493, 493, 0.0),
        ];
        for &(d, t, inflight) in samples {
            let p = bp.observe(d, t, inflight);
            assert!(
                p >= last,
                "进度回退：{last} -> {p} @ sample(done={d}, total={t}, inflight={inflight})"
            );
            last = p;
        }
        assert_eq!(last, 1.0, "末次采样全部完成后必须封顶 100%");
    }

    /// 单任务 downloaded 被下载器清零（流式路径重试前 `stats.downloaded.store(0)`）
    /// 时，展示进度不得归零 —— 「200/300 跳回 100/300」的成因。
    ///
    /// 复刻事件处理处的钳位（只增不减），并用未修复写法作对照。
    #[test]
    fn per_task_downloaded_is_clamped_monotonic() {
        let seq = [100u64, 200, 0, 100, 300];

        // 修复后：仅当 downloaded > e.0 才更新
        let mut e0 = 0u64;
        for dl in seq {
            if dl > e0 {
                e0 = dl;
            }
        }
        assert_eq!(e0, 300, "单任务已下载字节必须单调不减");

        // 对照：未修复的无条件赋值会回退到 0
        let mut hist = Vec::new();
        for dl in seq {
            let bad = dl; // 修复前：`e.0 = downloaded;`
            hist.push(bad);
        }
        assert_eq!(
            hist,
            vec![100, 200, 0, 100, 300],
            "前提校验：未修复时会回退到 0"
        );
    }

    /// 全部完成后必须报满；空批次不得除零。
    #[test]
    fn batch_percent_reaches_full_when_all_done() {
        assert_eq!(batch_percent(8, 8, 0.0), 1.0);
        assert!(batch_percent(7, 8, 0.0) < 1.0);
        assert_eq!(batch_percent(0, 0, 0.0), 0.0);
    }

    /// 回归：已上报的任务全部下完、但仍有文件排队时不得显示 100%。
    #[test]
    fn batch_progress_does_not_lock_hundred_while_tasks_queued() {
        let mut bp = BatchProgress::default();
        // 总 300 个文件，只有 8 个已完成，其余在途但完成度为 0
        let p = bp.observe(8, 300, 0.0);
        assert!(p < 1.0, "仍有文件排队时不应显示 100%，实际 {p}");
        // 在途文件陆续推进：进度上升
        let p2 = bp.observe(8, 300, 10.0);
        assert!(p2 > p, "在途推进应让进度上升（{p} -> {p2}）");
        assert!(p2 < 1.0);
        // 真正全部完成才允许 100%
        let p3 = bp.observe(300, 300, 0.0);
        assert_eq!(p3, 1.0, "整批完成必须报满");
    }

    /// 回归（CodeRabbit review）：stall 看门狗的活跃判定必须基于**原始上报值**，
    /// 不能用只增不减的展示值。
    ///
    /// 重试场景：downloaded 打回 0 再涨回，展示值不变；若用它判活，
    /// `last_event` 在重下期间不刷新，重下超过 120s 会被看门狗误杀。
    #[test]
    fn stall_watchdog_activity_uses_raw_value_not_high_water() {
        // 原始上报序列：涨到 200 → 重试清零 → 重新涨到 200+
        let raw_seq = [100u64, 200, 0, 50, 200, 300];
        let mut last_event_updates_with_raw = 0;
        let mut last_event_updates_with_high_water = 0;
        let mut raw_prev: Option<u64> = None;
        let mut display = 0u64;

        for dl in raw_seq {
            // 新实现：比较原始值
            if raw_prev != Some(dl) {
                last_event_updates_with_raw += 1;
                raw_prev = Some(dl);
            }
            // 旧实现（用展示高水位判活）
            if dl > display {
                last_event_updates_with_high_water += 1;
                display = dl;
            }
        }

        // 原始值判活：6 次采样全部视为「有变化」→ 每次续命
        assert_eq!(
            last_event_updates_with_raw, 6,
            "原始值判活应捕捉每次字节变化"
        );
        // 高水位判活：重试期间（0、50）与回落（200）都不刷新 → 只认出 3 次
        // （100 / 200 / 300），漏掉重下过程中的真实活动
        assert_eq!(
            last_event_updates_with_high_water, 3,
            "前提校验：高水位判活会漏掉重试期间的活动"
        );
        assert!(
            last_event_updates_with_raw > last_event_updates_with_high_water,
            "原始值判活必须比高水位判活更灵敏，否则会误杀重下中的任务"
        );
    }

    /// 同一个 dest 的多个重复条目常给出字节相同的 URL，归并表必须去重。
    #[test]
    fn merge_dropped_mirrors_dedups_repeated_urls() {
        let map = merge_dropped_mirrors(vec![
            dropped("k1", "https://cdn/x.jar"),
            dropped("k1", "https://cdn/x.jar"),
            dropped("k1", "https://mirror/x.jar"),
        ]);
        assert_eq!(map.get("k1").map(Vec::len), Some(2), "同一 URL 只保留一条");
        assert_eq!(
            map.get("k1").map(|v| v[0].as_str()),
            Some("https://cdn/x.jar"),
            "保持首次出现顺序"
        );
    }

    /// attach 时跳过与主 URL 相同的纯冗余项，并避免与既有镜像重复。
    #[test]
    fn attach_mirrors_skips_duplicates_and_primary() {
        let mut mirrors = vec!["https://mirror/a.jar".to_string()];
        attach_mirrors(
            &mut mirrors,
            "https://official/a.jar",
            Some(vec![
                "https://official/a.jar".to_string(), // 与主 URL 相同 → 跳过
                "https://mirror/a.jar".to_string(),   // 已存在 → 跳过
                "https://cdn-b/a.jar".to_string(),    // 新源 → 追加
            ]),
        );
        assert_eq!(
            mirrors,
            vec![
                "https://mirror/a.jar".to_string(),
                "https://cdn-b/a.jar".to_string()
            ]
        );

        let mut empty: Vec<String> = Vec::new();
        attach_mirrors(&mut empty, "https://official/a.jar", None);
        assert!(empty.is_empty());
    }

    /// miss 记录的判重键与 `miss_file_key` 一致，调用方才能按同一键空间查到镜像。
    #[test]
    fn miss_file_key_matches_dedup_miss_files_keying() {
        let root =
            std::env::temp_dir().join(format!("qomicex-miss-root-key-{}", std::process::id()));
        // 必须真的存在：大小写探测只对已存在目录给出确定结论，否则两侧可能分别得到
        // “无结论→不折叠”和“探测成功→折叠”而大小写不一致。
        std::fs::create_dir_all(&root).unwrap();
        let (kept, dropped) = dedup_miss_files(
            vec![
                miss("a", "libraries/g/a.jar", "https://cdn/a.jar"),
                miss("a", "libraries/g/a.jar", "https://mirror/a.jar"),
            ],
            &root,
        );
        assert_eq!(kept.len(), 1);
        assert_eq!(dropped.len(), 1);
        assert_eq!(miss_file_key(&kept[0].path, &root), dropped[0].key);
    }
}
