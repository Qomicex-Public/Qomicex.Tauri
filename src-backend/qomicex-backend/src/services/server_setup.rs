// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 服务端搭建服务（整合包一键开服 / 纯净服安装）。
//!
//! 与客户端整合包安装（`endpoints/modpack.rs` 的 `run_modpack_pipeline`）共享
//! 大量底层件（DownloadManager 批量下载、CF 反查、overrides 释放、InstallTracker
//! 进度），但产物不是实例而是一个**可运行的服务端目录**：
//!
//! - 运行时按 loader 分派：vanilla server jar / fabric server-launcher jar /
//!   forge·neoforge `--installServer`（安装器 URL 由 core 的 loader provider 提供）；
//! - mods 下载后做 **client-only 过滤**（扫 jar 内 `fabric.mod.json` 的
//!   `environment` 与 `(neo)forge.mods.toml` 的 `clientSideOnly`），命中的移入
//!   `{dir}/mods-client-only/` 隔离目录（不删，可恢复）；
//! - 启动方式写 `{dir}/.qml-server/launch.json` 自描述（argfile / jar 两种模式），
//!   调用方（如服务端管理插件）据此组装 `java` 启动命令；
//! - `eula.txt` 初始为 `false`：同意流程交给调用方（EULA 门），后端不代签。
//!
//! 进度复用 `InstallTracker`（kind = "server"），任务自动出现在下载中心。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use qomicex_core::api::installer::InstallerFactory;
use qomicex_core::core::GameCore;
use qomicex_core::models::installer::ModLoaderType;
use qomicex_core::services::installers::factory::DefaultInstallerFactory;

use crate::services::install_service::{
    download_batch, ensure_not_cancelled, resolve_java_path, DownloadTarget,
};
use crate::services::install_tracker::{InstallHandle, InstallStatus, InstallStepSpec};

/// 安装器执行超时：forge `--installServer` 要下载全部服务端库，慢源下可能很久。
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(1200);
/// 取消轮询间隔（安装器运行期间）。
const CANCEL_POLL: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// 请求 DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSetupRequest {
    /// 服务端名（展示用）。
    pub name: String,
    /// 服务端根目录（绝对路径；由调用方决定，通常是 `{数据目录}/Servers/{name}`）。
    pub dir: String,
    /// 指定 Java 可执行文件；缺省按 MC 版本自动选择。
    #[serde(default)]
    pub java_path: Option<String>,
    /// `-Xmx`（MB）；写入 `user_jvm_args.txt`（forge/neo）或忽略。
    #[serde(default)]
    pub xmx_mb: Option<u32>,
    /// 任务标题（下载中心显示名）。插件发起时应传**已本地化**的标题
    /// （先经 getPluginStrings 渲染再传），缺省回退 `服务端搭建 · {name}`。
    #[serde(default)]
    pub title: Option<String>,
    // ---- 安装来源（三选一，见 [`Self::source`]）----
    // 故意不用 flatten + untagged enum：serde 的 flatten 走 Content 缓冲，与
    // untagged 匹配组合有已知兼容性坑（表现为 422 且错误信息不可读）。
    // 扁平字段 + 显式校验，报错能精确指出缺了什么。
    /// 本地整合包文件（.zip = CF 结构，.mrpack = Modrinth 结构）
    #[serde(default)]
    pub pack_path: Option<String>,
    /// 在线来源："modrinth" | "cf" | "curseforge"
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default, rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(default, rename = "fileId")]
    pub file_id: Option<String>,
    #[serde(default)]
    pub vanilla: Option<bool>,
    #[serde(default, rename = "mcVersion")]
    pub mc_version: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ServerSource {
    Vanilla {
        mc_version: String,
    },
    Online {
        source: String,
        project_id: String,
        file_id: String,
    },
    PackPath {
        pack_path: String,
    },
}

impl ServerSetupRequest {
    /// 解析安装来源（三选一），缺项/多错时返回可读错误。
    pub fn source(&self) -> Result<ServerSource, String> {
        if self.vanilla.unwrap_or(false) || self.mc_version.as_deref().is_some_and(|s| !s.trim().is_empty()) {
            let mc_version = self
                .mc_version
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or("vanilla 来源需要 mcVersion")?;
            return Ok(ServerSource::Vanilla { mc_version });
        }
        if let Some(pack_path) = self.pack_path.as_deref().filter(|s| !s.trim().is_empty()) {
            return Ok(ServerSource::PackPath { pack_path: pack_path.to_string() });
        }
        if let (Some(source), Some(project_id), Some(file_id)) = (
            self.source.as_deref().filter(|s| !s.trim().is_empty()),
            self.project_id.as_deref().filter(|s| !s.trim().is_empty()),
            self.file_id.as_deref().filter(|s| !s.trim().is_empty()),
        ) {
            return Ok(ServerSource::Online {
                source: source.to_string(),
                project_id: project_id.to_string(),
                file_id: file_id.to_string(),
            });
        }
        Err(
            "缺少安装来源：需要 packPath（本地整合包）/ source+projectId+fileId（在线整合包）/ vanilla+mcVersion（纯净服）之一"
                .to_string(),
        )
    }
}

// ---------------------------------------------------------------------------
// 管线
// ---------------------------------------------------------------------------

/// 服务端搭建主管线。终态返回成功/取消/失败（错误串），目录内容即交付物；
/// 启动方式见 `{dir}/.qml-server/launch.json`，受限文件见 `.qml-server/blocked-mods.json`。
pub async fn run_server_pipeline(
    handle: InstallHandle,
    mgr: std::sync::Arc<qomicex_downloader::DownloadManager>,
    http: reqwest::Client,
    cf_api_key: String,
    core: std::sync::Arc<GameCore>,
    req: ServerSetupRequest,
    source: ServerSource,
) -> Result<(), String> {
    let dir = PathBuf::from(req.dir.trim());
    if req.name.trim().is_empty() {
        return Err("服务端名称不能为空".to_string());
    }
    // 下载中心对 SSE 里的未知任务自动补卡时，用这个标题做显示名
    // （调用方可传已本地化标题，缺省中文格式兜底）
    handle.set_title(req.title.as_deref().unwrap_or(&format!("服务端搭建 · {}", req.name.trim())));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建服务端目录失败: {e}"))?;

    // ---- 分步计划 ----
    let vanilla = matches!(source, ServerSource::Vanilla { .. });
    let specs: Vec<InstallStepSpec> = if vanilla {
        vec![
            InstallStepSpec { id: "server-runtime", weight: 80.0 },
            InstallStepSpec { id: "server-config", weight: 20.0 },
        ]
    } else {
        vec![
            InstallStepSpec { id: "parse-pack", weight: 5.0 },
            InstallStepSpec { id: "server-runtime", weight: 40.0 },
            InstallStepSpec { id: "download-files", weight: 25.0 },
            InstallStepSpec { id: "overrides", weight: 15.0 },
            InstallStepSpec { id: "server-config", weight: 15.0 },
        ]
    };
    handle.define_steps(&specs, crate::services::install_service::INSTALL_STEP_BUDGET_TOP);
    // 步骤标签不在此硬编码：随启动器发布的管线走前端 i18n（downloads.steps.*，
    // 可本地化）。set_step_label 通道留给插件/外部管线（渲染时优先于 i18n）。

    // ---- 1. 获取包体与解析 ----
    let mut zip_path: Option<PathBuf> = None;
    let mut game_version = String::new();
    let mut loader = String::new();
    let mut loader_version = String::new();
    let mut pack_files: Vec<crate::endpoints::modpack::ModpackFileEntry> = Vec::new();
    let mut source_kind = String::new(); // "vanilla" | "modrinth" | "curseforge"

    match &source {
        ServerSource::Vanilla { mc_version } => {
            game_version = mc_version.clone();
            source_kind = "vanilla".to_string();
        }
        ServerSource::PackPath { pack_path } => {
            handle.set_stage("parsing-pack");
            handle.mark_step("parse-pack", "active");
            let path = PathBuf::from(pack_path);
            if !path.is_file() {
                return Err(format!("整合包文件不存在: {}", path.display()));
            }
            let kind = sniff_pack_kind(&path)?;
            let parsed = parse_pack(&path, &kind)?;
            game_version = parsed.game_version.clone();
            loader = parsed.loader.clone();
            loader_version = parsed.loader_version.clone();
            pack_files = parsed.files.clone();
            source_kind = pack_kind_name(&kind).to_string();
            zip_path = Some(path);
            handle.mark_step("parse-pack", "done");
        }
        ServerSource::Online { source, project_id, file_id } => {
            handle.set_stage("downloading-pack");
            let src = source.to_ascii_lowercase();
            let (url, ext) = match src.as_str() {
                "modrinth" => {
                    let mr = core.create_modrinth_source();
                    let version = mr
                        .get_version_info(file_id)
                        .await
                        .map_err(|e| format!("获取 Modrinth 版本信息失败: {e}"))?;
                    let f = version
                        .files
                        .as_ref()
                        .and_then(|fs| fs.first())
                        .ok_or("Modrinth 版本没有可下载文件")?;
                    (f.download_url.clone(), "mrpack")
                }
                "cf" | "curseforge" => {
                    let cf = core.create_curseforge_source(&cf_api_key);
                    let url = cf
                        .get_download_url(project_id, file_id)
                        .await
                        .map_err(|e| format!("获取 CurseForge 下载链接失败: {e}"))?;
                    (url, "zip")
                }
                other => return Err(format!("服务端搭建暂不支持该来源: {other}")),
            };
            let temp_dir = dir.join("temp");
            std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建 temp 目录失败: {e}"))?;
            let path = temp_dir.join(format!("pack.{ext}"));
            handle.update(|f| {
                f.set_status(InstallStatus::Downloading);
                f.current_file = format!("整合包包体: {url}");
            });
            download_batch(
                &handle,
                &mgr,
                vec![(
                    url.clone(),
                    path.clone(),
                    crate::endpoints::modpack::modpack_headers(&url, &cf_api_key),
                )],
                None,
            )
            .await?;

            handle.set_stage("parsing-pack");
            handle.mark_step("parse-pack", "active");
            let kind = sniff_pack_kind(&path)?;
            let parsed = parse_pack(&path, &kind)?;
            game_version = parsed.game_version.clone();
            loader = parsed.loader.clone();
            loader_version = parsed.loader_version.clone();
            pack_files = parsed.files.clone();
            source_kind = pack_kind_name(&kind).to_string();
            zip_path = Some(path);
            handle.mark_step("parse-pack", "done");
        }
    }

    if game_version.trim().is_empty() {
        return Err("无法确定 Minecraft 版本".to_string());
    }

    // 服务端搭建只支持这些 loader；其余（quilt 等）明确报错而不是装出一半。
    let loader_lc = loader.to_ascii_lowercase();
    match loader_lc.as_str() {
        "" | "vanilla" | "fabric" | "forge" | "neoforge" => {}
        other => return Err(format!("服务端搭建暂不支持加载器: {other}")),
    }

    // ---- 2. 服务端运行时 ----
    handle.set_stage("server-runtime");
    handle.mark_step("server-runtime", "active");
    let java_path = match req.java_path.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(p) => p.to_string(),
        None => {
            let required = crate::endpoints::java::minecraft_to_java_version(&game_version);
            resolve_java_path(&core, required)
                .await
                .map_err(|e| format!("解析 Java 失败: {e}"))?
        }
    };
    install_server_runtime(
        &handle,
        &mgr,
        &http,
        &core,
        &dir,
        &game_version,
        &loader_lc,
        &loader_version,
        &java_path,
    )
    .await?;
    handle.mark_step("server-runtime", "done");

    // ---- 3. mods / 文件下载（并行 overrides） ----
    if source_kind == "modrinth" || source_kind == "curseforge" {
        let h_g = handle.clone();
        let mgr_g = mgr.clone();
        let core_g = core.clone();
        let key_g = cf_api_key.clone();
        let dir_g = dir.clone();
        let kind_g = source_kind.clone();
        let files_g = pack_files.clone();
        let branch_files = async move {
            h_g.mark_step("download-files", "active");
            h_g.set_stage("server-files");
            let plan = crate::services::source_policy::SourcePlan::load();
            let result: Result<(), String> = match kind_g.as_str() {
                "modrinth" => {
                    let mut targets: Vec<DownloadTarget> = Vec::new();
                    for f in &files_g {
                        let Some(url) = f.download_url.as_deref().filter(|u| !u.is_empty()) else {
                            continue;
                        };
                        // mrpack 的 path 是完整相对路径（mods/x.jar、config/y.toml…）
                        let dest = dir_g.join(&f.path);
                        let (u, headers) = crate::endpoints::modpack::mirror_mod_url(
                            url.to_string(),
                            &key_g,
                            &plan,
                        );
                        targets.push((u, dest, headers));
                    }
                    // 分批提交（每批 = 全局并发上限）：一次性塞入数百个任务时，
                    // 小文件的排队/探测会挤压大文件分片的分段带宽（下载器分段
                    // 许可证被小任务占用），表现为"看似单文件串行 + 速度异常"。
                    // 分批让每批内大小文件混合，批间顺序推进，进度仍按总文件数推进。
                    let batch_size = 64usize;
                    for chunk in targets.chunks(batch_size) {
                        download_batch(&h_g, &mgr_g, chunk.to_vec(), Some("download-files")).await?;
                    }
                    Ok(())
                }
                "curseforge" => {
                    let fids: Vec<i64> = files_g
                        .iter()
                        .filter_map(|f| f.path.split_once(':'))
                        .filter_map(|(_, fid)| fid.parse::<i64>().ok())
                        .collect();
                    let cf = core_g.create_curseforge_source(&key_g);
                    h_g.update(|f| {
                        f.current_file = format!("批量解析 CurseForge 文件链接 ({} 个)...", fids.len());
                    });
                    let info_map = cf
                        .get_files_batch(&fids)
                        .await
                        .map_err(|e| format!("批量获取 CurseForge 文件信息失败: {e}"))?;
                    let mut targets: Vec<DownloadTarget> = Vec::new();
                    let mut blocked: Vec<crate::services::modpack_blocked::BlockedModFile> =
                        Vec::new();
                    for f in &files_g {
                        let Some((proj, fid)) = f.path.split_once(':') else { continue };
                        let Ok(fidn) = fid.parse::<i64>() else { continue };
                        let Some(info) = info_map.get(&fidn) else { continue };
                        let project_id = proj.trim().parse::<i64>().unwrap_or(0);
                        if let Some(b) = crate::services::modpack_blocked::blocked_from_batch(
                            info, project_id,
                        ) {
                            blocked.push(b);
                            continue;
                        }
                        let download_url = info.download_url.as_deref().unwrap_or_default();
                        let filename = info.file_name.clone().unwrap_or_else(|| {
                            download_url
                                .rsplit('/')
                                .next()
                                .unwrap_or("mod.jar")
                                .to_string()
                        });
                        let dest = dir_g.join("mods").join(&filename);
                        let (u, headers) = crate::endpoints::modpack::mirror_mod_url(
                            download_url.to_string(),
                            &key_g,
                            &plan,
                        );
                        targets.push((u, dest, headers));
                    }
                    // 阻塞清单写 .qml-server/（服务端目录没有 versions/{name} 结构）
                    if let Err(e) = save_server_blocked(&dir_g, &blocked) {
                        return Err(format!("写入分发受限清单失败: {e}"));
                    }
                    if !blocked.is_empty() {
                        h_g.set_blocked_files(blocked.len() as i32);
                        tracing::warn!(
                            dir = %dir_g.display(),
                            count = blocked.len(),
                            "服务端搭建: {} 个必需文件因作者关闭第三方分发需手动补全",
                            blocked.len(),
                        );
                    }
                    // 同 modrinth 分支：分批提交，避免小文件挤压大文件分段带宽
                    for chunk in targets.chunks(64) {
                        download_batch(&h_g, &mgr_g, chunk.to_vec(), Some("download-files")).await?;
                    }
                    Ok(())
                }
                _ => Ok(()),
            };
            if result.is_ok() {
                h_g.mark_step("download-files", "done");
            }
            result
        };

        // overrides 与文件下载并行（与客户端整合包管线一致：接受小概率写竞争）
        let h_o = handle.clone();
        let dir_o = dir.clone();
        let kind_o = source_kind.clone();
        let zip_o = zip_path.clone();
        let branch_overrides = async move {
            h_o.mark_step("overrides", "active");
            h_o.set_stage("server-overrides");
            let factory = DefaultInstallerFactory;
            let zip_str = zip_o
                .as_ref()
                .and_then(|p| p.to_str())
                .ok_or("整合包文件缺失")?;
            let dir_str = dir_o.to_string_lossy().into_owned();
            // 服务端目录无版本隔离：overrides 直落到根
            let inst = if kind_o == "modrinth" {
                factory.create_modrinth_modpack(&dir_str, false, zip_str)
            } else {
                factory.create_curseforge_modpack(&dir_str, false, zip_str)
            };
            inst.install("", "", None, None, None, None)
                .await
                .map_err(|e| format!("释放整合包覆盖文件失败: {e}"))?;
            h_o.mark_step("overrides", "done");
            Ok(())
        };

        let (res_g, res_o) = tokio::join!(branch_files, branch_overrides);
        // 快速失败：首个非取消类错误胜出
        let first_err = [res_g.as_ref().err(), res_o.as_ref().err()]
            .into_iter()
            .flatten()
            .find(|e| e.as_str() != "安装已取消")
            .cloned();
        if let Some(e) = first_err {
            handle.request_cancel();
            return Err(e);
        }
        ensure_not_cancelled(&handle)?;
        res_g?;
        res_o?;
    }

    // ---- 4. client-only mod 过滤 ----
    handle.set_stage("filter-client-mods");
    handle.update(|f| {
        f.set_status(InstallStatus::Extracting);
        f.current_file = "扫描 client-only 模组...".to_string();
    });
    let moved = filter_client_only_mods(&dir).map_err(|e| format!("扫描 client-only 模组失败: {e}"))?;
    if !moved.is_empty() {
        tracing::info!(
            dir = %dir.display(),
            count = moved.len(),
            "服务端搭建: client-only 模组已移入 mods-client-only/"
        );
        handle.update(|f| {
            f.current_file = format!("已隔离 {} 个 client-only 模组", moved.len());
        });
    }

    // ---- 5. 基础配置（已存在的文件不覆盖：overrides 可能已带） ----
    handle.set_stage("server-config");
    handle.mark_step("server-config", "active");
    write_base_config(&dir, req.xmx_mb).map_err(|e| format!("写入基础配置失败: {e}"))?;
    write_launch_manifest(&dir, &game_version, &loader, &loader_version)
        .map_err(|e| format!("写入启动清单失败: {e}"))?;
    handle.mark_step("server-config", "done");

    handle.update(|f| {
        f.set_status(InstallStatus::Finishing);
        f.stage = "finishing".to_string();
        f.current_file = "服务端搭建完成".to_string();
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// 包体解析
// ---------------------------------------------------------------------------

enum PackKind {
    Modrinth,
    Curseforge,
}

fn pack_kind_name(kind: &PackKind) -> &'static str {
    match kind {
        PackKind::Modrinth => "modrinth",
        PackKind::Curseforge => "curseforge",
    }
}

fn parse_pack(
    zip_path: &Path,
    kind: &PackKind,
) -> Result<crate::endpoints::modpack::ParsedModpack, String> {
    match kind {
        PackKind::Modrinth => crate::endpoints::modpack::parse_modrinth_index(zip_path)
            .map_err(|e| format!("解析 modrinth.index.json 失败: {e}")),
        PackKind::Curseforge => crate::endpoints::modpack::parse_curseforge_manifest(zip_path)
            .map_err(|e| format!("解析 manifest.json 失败: {e}")),
    }
}

/// 按包内条目判断 .zip/.mrpack 的清单类型：有 modrinth.index.json → Modrinth；
/// 否则尝试 manifest.json → CurseForge。
pub fn sniff_pack_kind(zip_path: &Path) -> Result<PackKind, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开整合包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取整合包失败: {e}"))?;
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| format!("读取整合包条目失败: {e}"))?
            .name()
            .map(|n| n.into_owned())
            .unwrap_or_default();
        if name.eq_ignore_ascii_case("modrinth.index.json") {
            return Ok(PackKind::Modrinth);
        }
        if name.eq_ignore_ascii_case("manifest.json") {
            return Ok(PackKind::Curseforge);
        }
    }
    Err("无法识别整合包格式（既无 modrinth.index.json 也无 manifest.json）".to_string())
}

// ---------------------------------------------------------------------------
// 服务端运行时安装（vanilla / fabric / forge / neoforge）
// ---------------------------------------------------------------------------

async fn install_server_runtime(
    handle: &InstallHandle,
    mgr: &std::sync::Arc<qomicex_downloader::DownloadManager>,
    http: &reqwest::Client,
    core: &std::sync::Arc<GameCore>,
    dir: &Path,
    game_version: &str,
    loader: &str,
    loader_version: &str,
    java_path: &str,
) -> Result<(), String> {
    match loader {
        "" | "vanilla" => install_vanilla_server(handle, mgr, http, dir, game_version).await,
        "fabric" => install_fabric_server(handle, mgr, http, dir, game_version, loader_version).await,
        "forge" | "neoforge" => {
            install_forge_server(
                handle, mgr, core, dir, game_version, loader, loader_version, java_path,
            )
            .await
        }
        other => Err(format!("服务端搭建暂不支持加载器: {other}")),
    }
}

/// vanilla：version manifest → version JSON `downloads.server` → server.jar。
async fn install_vanilla_server(
    handle: &InstallHandle,
    mgr: &std::sync::Arc<qomicex_downloader::DownloadManager>,
    http: &reqwest::Client,
    dir: &Path,
    game_version: &str,
) -> Result<(), String> {
    handle.update(|f| {
        f.current_file = format!("获取 Minecraft {game_version} 服务端信息...");
    });
    let manifest: serde_json::Value = http
        .get("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("获取版本清单失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析版本清单失败: {e}"))?;
    let version_url = manifest["versions"]
        .as_array()
        .and_then(|vs| {
            vs.iter()
                .find(|v| v["id"].as_str() == Some(game_version))
                .and_then(|v| v["url"].as_str())
        })
        .ok_or_else(|| format!("版本清单中没有 {game_version}"))?;
    let version_json: serde_json::Value = http
        .get(version_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("获取版本 JSON 失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析版本 JSON 失败: {e}"))?;
    let server_url = version_json["downloads"]["server"]["url"]
        .as_str()
        .filter(|u| !u.is_empty())
        .ok_or("版本 JSON 中没有服务端下载地址（该版本可能未提供服务端）")?;
    let dest = dir.join("server.jar");
    handle.update(|f| {
        f.current_file = format!("下载 server.jar: {server_url}");
    });
    download_batch(
        handle,
        mgr,
        vec![(server_url.to_string(), dest, Vec::new())],
        Some("server-runtime"),
    )
    .await
}

/// meta/fabricmc.net 的 meta 端点 → QML-Mirror 通道（加载器元数据小、边缘强缓存；
/// 流量分工见 file_mirror 模块头）。带官方兜底。
async fn meta_get_json(http: &reqwest::Client, official_url: &str) -> Result<serde_json::Value, String> {
    let mirror = crate::services::file_mirror::loader_mirror_url(official_url);
    let mut urls = Vec::new();
    if let Some(m) = mirror.as_deref() {
        urls.push(m.to_string());
    }
    urls.push(official_url.to_string());
    let mut last_err = String::new();
    for u in urls {
        match http.get(&u).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(v) => return Ok(v),
                    Err(e) => last_err = format!("解析 {u} 失败: {e}"),
                }
            }
            Ok(resp) => last_err = format!("{u} 状态码 {}", resp.status()),
            Err(e) => last_err = format!("请求 {u} 失败: {e}"),
        }
    }
    Err(last_err)
}

/// fabric：meta 的 loader 版本 + installer 版本 → server-launcher jar（免安装可直接跑）。
async fn install_fabric_server(
    handle: &InstallHandle,
    mgr: &std::sync::Arc<qomicex_downloader::DownloadManager>,
    http: &reqwest::Client,
    dir: &Path,
    game_version: &str,
    loader_version: &str,
) -> Result<(), String> {
    handle.update(|f| {
        f.current_file = "获取 Fabric 服务端启动器...".to_string();
    });
    // loader 版本：mrpack 里已带（如 "0.16.9"）；缺失时取最新 stable（走镜像通道）。
    let loader_version = match loader_version.trim() {
        "" => {
            let list = meta_get_json(
                http,
                "https://meta.fabricmc.net/v2/versions/loader",
            )
            .await
            .map_err(|e| format!("获取 Fabric loader 版本失败: {e}"))?;
            list.as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|v| v["stable"].as_bool() == Some(true))
                        .or_else(|| arr.first())
                })
                .and_then(|v| v["version"].as_str())
                .ok_or("Fabric loader 版本列表为空")?
                .to_string()
        }
        v => v.to_string(),
    };
    // installer 版本是另一个维度（mrpack 不带），取最新 stable（走镜像通道）。
    let inst = meta_get_json(
        http,
        "https://meta.fabricmc.net/v2/versions/installer",
    )
    .await
    .map_err(|e| format!("获取 Fabric installer 版本失败: {e}"))?;
    let installer_version = inst
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|v| v["stable"].as_bool() == Some(true))
                .or_else(|| arr.first())
        })
        .and_then(|v| v["version"].as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Fabric installer 版本列表为空")?
        .to_string();
    let official_url = format!(
        "https://meta.fabricmc.net/v2/versions/loader/{game_version}/{loader_version}/{installer_version}/server/jar"
    );
    // server jar 下载主选 QML-Mirror（download_batch 会自动挂官方兜底，
    // 见 install_service 的 loader_fallback_urls）。
    let url = crate::services::file_mirror::loader_mirror_url(&official_url)
        .unwrap_or(official_url);
    let dest = dir.join("fabric-server-launch.jar");
    handle.update(|f| {
        f.current_file = format!("下载 Fabric 服务端启动器: {url}");
    });
    download_batch(handle, mgr, vec![(url, dest, Vec::new())], Some("server-runtime")).await
}

/// forge / neoforge：下载 installer jar → `java -jar installer.jar --installServer`。
async fn install_forge_server(
    handle: &InstallHandle,
    mgr: &std::sync::Arc<qomicex_downloader::DownloadManager>,
    core: &std::sync::Arc<GameCore>,
    dir: &Path,
    game_version: &str,
    loader: &str,
    loader_version: &str,
    java_path: &str,
) -> Result<(), String> {
    let loader_type = match loader {
        "forge" => ModLoaderType::Forge,
        _ => ModLoaderType::NeoForge,
    };
    handle.update(|f| {
        f.current_file = format!("获取 {loader} {loader_version} 安装器...");
    });
    let versions = core
        .installer_provider()
        .get_available_mod_loaders(game_version, loader_type)
        .await
        .map_err(|e| format!("获取 {loader} 版本列表失败: {e}"))?;
    let target = versions
        .iter()
        .find(|v| v.version == loader_version)
        .or_else(|| {
            // loader_version 为空或不匹配时退推荐位
            versions
                .iter()
                .find(|v| v.is_recommand)
                .or_else(|| versions.first())
        })
        .ok_or_else(|| format!("{loader} {loader_version} 不存在或不可用（MC {game_version}）"))?;
    let installer_url_official = target.url.clone();
    if installer_url_official.trim().is_empty() {
        return Err(format!("{loader} {loader_version} 未提供安装器下载地址"));
    }
    // 安装器走 QML-Mirror 主选（官方兜底由 download_batch 的 loader_fallback_urls
    // 自动挂上）；小文件 + 边缘强缓存，不打爆镜像带宽。
    let installer_url = crate::services::file_mirror::loader_mirror_url(&installer_url_official)
        .unwrap_or(installer_url_official);

    let temp_dir = dir.join("temp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建 temp 目录失败: {e}"))?;
    let installer_path = temp_dir.join(format!("{loader}-installer.jar"));
    download_batch(
        handle,
        mgr,
        vec![(installer_url, installer_path.clone(), Vec::new())],
        Some("server-runtime"),
    )
    .await?;

    handle.update(|f| {
        f.set_status(InstallStatus::Installing);
        f.current_file = format!("运行 {loader} 服务端安装器（可能需要数分钟）...");
    });
    let mut cmd = tokio::process::Command::new(java_path);
    cmd.arg("-jar")
        .arg(&installer_path)
        .arg("--installServer")
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动安装器失败（Java: {java_path}）: {e}"))?;

    // stdout/stderr 逐行转发到进度 current_file（安装器输出只用于展示，不落盘）
    let h_out = handle.clone();
    let mut stdout = child.stdout.take();
    let t_out = tokio::spawn(async move {
        let Some(reader) = stdout.take() else { return };
        pump_lines(reader, &h_out).await;
    });
    let h_err = handle.clone();
    let mut stderr = child.stderr.take();
    let t_err = tokio::spawn(async move {
        let Some(reader) = stderr.take() else { return };
        pump_lines(reader, &h_err).await;
    });

    // 等待退出 + 取消轮询 + 超时兜底
    let mut interval = tokio::time::interval(CANCEL_POLL);
    interval.tick().await; // 首个 tick 立即返回，跳过
    let status = loop {
        tokio::select! {
            st = child.wait() => break st.map_err(|e| format!("等待安装器退出失败: {e}")),
            _ = interval.tick() => {
                if handle.is_cancelled() {
                    let _ = child.kill().await;
                    let _ = t_out.await;
                    let _ = t_err.await;
                    return Err("安装已取消".to_string());
                }
            }
            _ = tokio::time::sleep(INSTALLER_TIMEOUT) => {
                let _ = child.kill().await;
                return Err("服务端安装器执行超时（>20 分钟），请检查网络或手动安装".to_string());
            }
        }
    };
    let _ = t_out.await;
    let _ = t_err.await;
    let status = status?;
    if !status.success() {
        return Err(format!(
            "{loader} 服务端安装器退出码 {:?}（详见进度输出的 [installer] 日志）",
            status.code()
        ));
    }
    // 清理安装器
    let _ = std::fs::remove_file(&installer_path);
    Ok(())
}

/// 安装器输出逐行搬运到进度 current_file。
async fn pump_lines<R: tokio::io::AsyncRead + Unpin>(reader: R, handle: &InstallHandle) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if !line.trim().is_empty() => {
                let text = line.trim().to_string();
                handle.update(|f| f.current_file = format!("[installer] {text}"));
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
}

// ---------------------------------------------------------------------------
// client-only 过滤
// ---------------------------------------------------------------------------

/// 扫描 `{dir}/mods/*.jar`，把 client-only 的移入 `{dir}/mods-client-only/`。
/// 移动清单写入 `{dir}/.qml-server/client-only.json` 供 UI 展示与恢复。
pub fn filter_client_only_mods(dir: &Path) -> Result<Vec<String>, String> {
    let mods_dir = dir.join("mods");
    if !mods_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut moved: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&mods_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("jar")) {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if classify_mod_side(&bytes) != Some(true) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let quarantine = dir.join("mods-client-only");
        std::fs::create_dir_all(&quarantine).map_err(|e| e.to_string())?;
        std::fs::rename(&path, quarantine.join(&name))
            .map_err(|e| format!("移动 client-only 模组失败 {}: {e}", path.display()))?;
        moved.push(name);
    }
    if !moved.is_empty() {
        let manifest_dir = dir.join(".qml-server");
        let _ = std::fs::create_dir_all(&manifest_dir);
        let _ = std::fs::write(
            manifest_dir.join("client-only.json"),
            serde_json::to_vec_pretty(&moved).unwrap_or_default(),
        );
    }
    Ok(moved)
}

/// 判断 mod jar 是否 client-only。`Some(true)` = 仅客户端；`Some(false)` = 明确双端/服务端；
/// `None` = 元数据缺失或无法判断（保守保留在 mods/）。
pub fn classify_mod_side(jar_bytes: &[u8]) -> Option<bool> {
    let cursor = std::io::Cursor::new(jar_bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;

    // Fabric: fabric.mod.json 的 environment ["client","server"] 两位。
    if let Ok(mut entry) = archive.by_name("fabric.mod.json") {
        let mut text = String::new();
        if read_to_string_lossy(&mut entry, &mut text).is_some() {
            if let Some(v) = is_client_only_fabric_json(&text) {
                return Some(v);
            }
        }
    }
    // Forge / NeoForge：mods.toml 的 clientSideOnly 显式 true（老 Forge 约定）。
    for name in ["META-INF/mods.toml", "META-INF/neoforge.mods.toml"] {
        if let Ok(mut entry) = archive.by_name(name) {
            let mut text = String::new();
            if read_to_string_lossy(&mut entry, &mut text).is_some() {
                if let Some(v) = is_client_only_forge_toml(&text) {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn read_to_string_lossy<R: Read>(reader: &mut R, out: &mut String) -> Option<()> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).ok()?;
    out.push_str(&String::from_utf8_lossy(&bytes));
    Some(())
}

/// fabric.mod.json → 是否 client-only。
/// `environment` 第一位=客户端要求，第二位=服务端要求。新值域
/// "*"/"required"/"optional"/"unsupported"，旧值域 "*"（=required）/"client"（=unsupported）/"server"（=required）。
/// 服务端必需 → 双端；服务端不需要且客户端必需 → client-only；其余 → None（保守保留）。
pub fn is_client_only_fabric_json(text: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let env = v.get("environment")?.as_array()?;
    let side = |i: usize| -> String {
        env.get(i)
            .and_then(|x| x.as_str())
            .unwrap_or("*")
            .to_ascii_lowercase()
    };
    // 旧值域归一：client=服务端不支持，server=服务端必需
    let server_raw = side(1);
    let server = match server_raw.as_str() {
        "client" => "unsupported",
        "server" => "required",
        other => other,
    };
    match server {
        "*" | "required" => Some(false),
        "unsupported" | "optional" => {
            let client = side(0);
            Some(client == "*" || client == "required")
        }
        _ => None,
    }
}

/// (neo)forge.mods.toml → 是否 client-only。只认显式 `clientSideOnly=true`（老 Forge 约定）；
/// 没有该键 → None（保守保留。displayTest 的语义是"服务端如何校验客户端列表"，
/// 不代表 mod 不能在服务端加载）。
pub fn is_client_only_forge_toml(text: &str) -> Option<bool> {
    for line in text.lines() {
        let t = line.split('#').next().unwrap_or(line).trim();
        if let Some((k, v)) = t.split_once('=') {
            if k.trim().eq_ignore_ascii_case("clientSideOnly") {
                return Some(v.trim().trim_matches('"').eq_ignore_ascii_case("true"));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 启动方式探测（写 launch.json）
// ---------------------------------------------------------------------------

/// 从 run.bat / run.sh 文本提取 `@libraries/...` argfile 相对路径。
/// 同一行可能有多个 `@`（如 bat 里 `"@here\java.exe" @libraries/...`），逐个尝试。
pub fn parse_argfile_from_script(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        let mut from = 0;
        while let Some(rel) = t[from..].find('@') {
            let at = from + rel;
            from = at + 1;
            let rest = &t[at + 1..];
            let end = rest
                .find(|c: char| c.is_whitespace())
                .unwrap_or(rest.len());
            let candidate = rest[..end].trim_matches(|c| c == '"' || c == '\'');
            if candidate.starts_with("libraries/")
                && (candidate.ends_with(".txt") || candidate.ends_with(".args"))
            {
                return Some(candidate.replace('\\', "/"));
            }
        }
    }
    None
}

/// 从根目录 jar 清单（带大小）挑主 jar：
/// forge-universal > neoforge > server.jar > fabric-server-launch > 最大 jar。
pub fn pick_launch_jar(entries: &[(String, u64)]) -> Option<String> {
    let lower = |s: &str| s.to_ascii_lowercase();
    let has = |kw: &str| entries.iter().any(|(n, _)| lower(n).contains(kw));
    let pick = |pred: &dyn Fn(&(String, u64)) -> bool| -> Option<String> {
        entries.iter().find(|e| pred(e)).map(|(n, _)| n.clone())
    };
    if has("forge") && has("universal") {
        return pick(&|(n, _)| {
            let l = lower(n);
            l.contains("forge") && l.contains("universal")
        });
    }
    if has("neoforge") {
        return pick(&|(n, _)| lower(n).contains("neoforge"));
    }
    if entries.iter().any(|(n, _)| lower(n) == "server.jar") {
        return Some("server.jar".to_string());
    }
    if has("fabric-server-launch") {
        return Some("fabric-server-launch.jar".to_string());
    }
    entries
        .iter()
        .filter(|(n, _)| lower(n).ends_with(".jar"))
        .max_by_key(|(_, size)| *size)
        .map(|(n, _)| n.clone())
}

/// 探测启动方式并写 `{dir}/.qml-server/launch.json`：
/// forge/neo 1.17+ 安装器会生成 run.bat/run.sh 引用 win_args.txt/unix_args.txt
/// → mode=argfile（`java @argfile`）；否则在根目录找主 jar → mode=jar。
pub fn write_launch_manifest(
    dir: &Path,
    game_version: &str,
    loader: &str,
    loader_version: &str,
) -> Result<(), String> {
    let run_bat = std::fs::read_to_string(dir.join("run.bat")).ok();
    let run_sh = std::fs::read_to_string(dir.join("run.sh")).ok();
    let argfile_win = run_bat.as_deref().and_then(parse_argfile_from_script);
    let argfile_unix = run_sh.as_deref().and_then(parse_argfile_from_script);

    let mut doc = serde_json::json!({
        "gameVersion": game_version,
        "loader": loader,
        "loaderVersion": loader_version,
    });
    if argfile_win.is_some() || argfile_unix.is_some() {
        doc["mode"] = serde_json::Value::String("argfile".to_string());
        if let Some(w) = argfile_win {
            doc["windowsArgfile"] = serde_json::Value::String(w);
        }
        if let Some(u) = argfile_unix {
            doc["unixArgfile"] = serde_json::Value::String(u);
        }
    } else {
        // 收集根目录 jar（带大小，兜底取最大）
        let mut entries: Vec<(String, u64)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jar")) {
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    entries.push((e.file_name().to_string_lossy().into_owned(), size));
                }
            }
        }
        // 排除安装器残留
        entries.retain(|(n, _)| !n.to_ascii_lowercase().contains("installer"));
        let jar = pick_launch_jar(&entries).ok_or_else(|| {
            "未在服务端目录找到可启动的 jar（安装器可能未成功执行）".to_string()
        })?;
        doc["mode"] = serde_json::Value::String("jar".to_string());
        doc["jar"] = serde_json::Value::String(jar);
    }

    let manifest_dir = dir.join(".qml-server");
    std::fs::create_dir_all(&manifest_dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(manifest_dir.join("launch.json"), bytes).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 基础配置
// ---------------------------------------------------------------------------

/// 写 eula.txt（false）/ server.properties 模板 / user_jvm_args.txt。已存在的文件不覆盖
/// （overrides 可能已带正式配置）。
pub fn write_base_config(dir: &Path, xmx_mb: Option<u32>) -> Result<(), String> {
    let ensure = |name: &str, content: &str| -> Result<(), String> {
        let p = dir.join(name);
        if !p.exists() {
            std::fs::write(&p, content).map_err(|e| format!("写 {name} 失败: {e}"))?;
        }
        Ok(())
    };
    ensure(
        "eula.txt",
        "# 同意即视为接受 Minecraft EULA: https://aka.ms/MinecraftEULA\neula=false\n",
    )?;
    ensure(
        "server.properties",
        "#Minecraft server properties\nonline-mode=true\n",
    )?;
    if let Some(xmx) = xmx_mb.filter(|v| *v > 0) {
        ensure(
            "user_jvm_args.txt",
            &format!("# 由 Qomicex 服务端搭建生成\n-Xmx{xmx}M\n"),
        )?;
    }
    Ok(())
}

/// 把分发受限清单写到 `{dir}/.qml-server/blocked-mods.json`（空清单删除）。
fn save_server_blocked(
    dir: &Path,
    blocked: &[crate::services::modpack_blocked::BlockedModFile],
) -> Result<(), String> {
    let manifest_dir = dir.join(".qml-server");
    std::fs::create_dir_all(&manifest_dir).map_err(|e| e.to_string())?;
    let path = manifest_dir.join("blocked-mods.json");
    if blocked.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(blocked).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fabric_environment_client_only() {
        assert_eq!(
            is_client_only_fabric_json(r#"{"environment": ["*", "client"]}"#),
            Some(true)
        );
        assert_eq!(
            is_client_only_fabric_json(r#"{"environment": ["*", "*"]}"#),
            Some(false)
        );
        assert_eq!(
            is_client_only_fabric_json(r#"{"environment": ["*"]}"#),
            Some(false),
            "缺 server 位按 * 处理（双端）"
        );
        assert_eq!(
            is_client_only_fabric_json(r#"{"environment": ["required", "unsupported"]}"#),
            Some(true)
        );
        assert_eq!(
            is_client_only_fabric_json(r#"{"environment": ["optional", "optional"]}"#),
            Some(false),
            "双 optional 不判 client-only（保守保留）"
        );
        assert_eq!(is_client_only_fabric_json(r#"{"name":"x"}"#), None);
        assert_eq!(is_client_only_fabric_json("not json"), None);
    }

    #[test]
    fn forge_toml_clientside_only() {
        assert_eq!(
            is_client_only_forge_toml("# comment\nclientSideOnly=true\n[[mods]]\n"),
            Some(true)
        );
        assert_eq!(
            is_client_only_forge_toml("clientSideOnly=false\n"),
            Some(false)
        );
        assert_eq!(
            is_client_only_forge_toml("[[mods]]\nmodId=\"x\"\n"),
            None,
            "无 clientSideOnly → 保守 None（保留）"
        );
    }

    #[test]
    fn argfile_parsed_from_run_script() {
        let bat = "@echo off\r\n\"@here\\java.exe\" @libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt %*\r\n";
        assert_eq!(
            parse_argfile_from_script(bat),
            Some("libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt".to_string())
        );
        let sh = "#!/usr/bin/env bash\njava @libraries/net/neoforged/neoforge/20.4.80/unix_args.txt \"$@\"\n";
        assert_eq!(
            parse_argfile_from_script(sh),
            Some("libraries/net/neoforged/neoforge/20.4.80/unix_args.txt".to_string())
        );
        assert_eq!(parse_argfile_from_script("java -jar server.jar"), None);
        assert_eq!(
            parse_argfile_from_script("@other.txt"),
            None,
            "非 libraries/ 前缀不认"
        );
    }

    #[test]
    fn launch_jar_pick_prefers_forge_universal() {
        let entries: Vec<(String, u64)> = [
            ("forge-1.12.2-14.23.5.2859-universal.jar", 5u64),
            ("forge-1.12.2-14.23.5.2859.jar", 1),
            ("server.jar", 50),
        ]
        .iter()
        .map(|(n, s)| (n.to_string(), *s))
        .collect();
        let picked = pick_launch_jar(&entries).unwrap();
        assert!(picked.contains("universal"), "picked={picked}");

        let entries: Vec<(String, u64)> = vec![("server.jar".to_string(), 50)];
        assert_eq!(pick_launch_jar(&entries), Some("server.jar".to_string()));

        let entries: Vec<(String, u64)> = vec![("fabric-server-launch.jar".to_string(), 1)];
        assert_eq!(
            pick_launch_jar(&entries),
            Some("fabric-server-launch.jar".to_string())
        );

        // 兜底取最大 jar
        let entries: Vec<(String, u64)> =
            vec![("a.jar".to_string(), 1), ("b.jar".to_string(), 9)];
        assert_eq!(pick_launch_jar(&entries), Some("b.jar".to_string()));
    }
}
