//! Version 端点（对应源 Endpoints/VersionEndpoints.cs）。
//! 版本清单/最新/已安装/远程/扫描（loader 探测 + 6 级回退）/元数据/安装/卸载。
//!
//! 依赖：core version 门面（AppState.core.version()）、InstanceService（AppState.instance，
//! 用于 /versions/scan 的实例自动修复）。
//!
//! 与源的差异：
//! - ResolveGameVersion 第 1 级 `GameVersionHelper.FromJar` 已接线到 core
//!   `util::version_json::from_jar`（jar 内 version.json → class 常量池 →
//!   已知 SHA1 映射表），回退顺序与源一致：JAR → clientVersion →
//!   minecraftVersion → inheritsFrom → arguments → regex → id（见
//!   `from_jar_game_version`）。
//! - `/versions/{name}` 及子路由通过 axum 静态路由优先匹配，与较长的
//!   `/latest`/`/installed`/`/remote`/`/scan` 无冲突。

use std::path::{Path, PathBuf};

use axum::extract::{Path as AxumPath, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;

use qomicex_core::models::local::LocalVersionInfo;
use qomicex_core::models::version_manifest::{LatestVersionInfo, ManifestVersionInfo};
use qomicex_core::models::version_metadata::CompleteVersionMetadata;

use crate::error::{ApiError, ApiResult};
use crate::services::instance::InstanceService;
use crate::services::scan_cache::CachedVersion;
use crate::state::SharedState;
use crate::util::pcl_icon::resolve_pcl_icon;

/// 版本扫描的并行度（`std::thread::scope` 小线程池）。版本目录互不依赖，纯磁盘 I/O；
/// 钳位上限是为避免几十个实例时线程风暴（低配机械盘上并发的边际收益会趋零）。
const MAX_SCAN_WORKERS: usize = 6;

// =====================================================================
// DTO
// =====================================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ScannedVersionEntry {
    name: String,
    game_version: String,
    state: String,
    state_describe: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    loaders: Option<Vec<ScannedLoaderEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_data: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScannedLoaderEntry {
    pub(crate) r#type: String,
    pub(crate) version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanVersionsResponse {
    path: String,
    versions: Vec<ScannedVersionEntry>,
    no_json_dirs: Vec<String>,
    /// 有版本目录未命中扫描指纹缓存、只能用 JSON 链给出 gameVersion 时为 `true`，
    /// 前端应再发一次 `?mode=full` 回填 jar 级结果（见第 4 期两段式扫描）。
    refine_required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForceRefreshQuery {
    force_refresh: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanQuery {
    game_dir: String,
    /// `fast`（默认）/ `full`。见 `scan_impl` 的两级短路说明。
    mode: Option<String>,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/versions", get(versions))
        .route("/versions/latest", get(latest))
        .route("/versions/installed", get(installed))
        .route("/versions/remote", get(remote))
        .route("/versions/scan", get(scan))
        .route("/versions/{name}", get(version_metadata))
        .route("/versions/{name}/install", post(install_version))
        .route("/versions/{name}/uninstall", post(uninstall_version))
}

// =====================================================================
// Handlers
// =====================================================================

async fn versions(
    State(state): State<SharedState>,
    Query(q): Query<ForceRefreshQuery>,
) -> ApiResult<Json<Vec<ManifestVersionInfo>>> {
    let versions = state
        .core
        .version()
        .get_available_versions(q.force_refresh.unwrap_or(false))
        .await
        .map_err(map_core_err)?;
    Ok(Json(versions))
}

async fn latest(
    State(state): State<SharedState>,
    Query(q): Query<ForceRefreshQuery>,
) -> ApiResult<Json<LatestVersionInfo>> {
    let latest = state
        .core
        .version()
        .get_latest_versions(q.force_refresh.unwrap_or(false))
        .await
        .map_err(map_core_err)?;
    Ok(Json(latest))
}

async fn installed(State(state): State<SharedState>) -> ApiResult<Json<Vec<LocalVersionInfo>>> {
    Ok(Json(state.core.version().get_installed_versions()))
}

async fn remote(
    State(state): State<SharedState>,
    Query(_q): Query<RemoteQuery>,
) -> ApiResult<Json<Vec<ManifestVersionInfo>>> {
    match state.core.version().get_available_versions(false).await {
        Ok(versions) => Ok(Json(versions)),
        Err(_) => Ok(Json(Vec::new())),
    }
}

/// 扫描的磁盘 I/O 全部走 `spawn_blocking` 执行。同步扫描在集成包目录上要跑几秒到
/// 几十秒，若留在 tokio worker 上会把 `/api/health` 轮询等一起卡住。
async fn scan(
    State(state): State<SharedState>,
    Query(q): Query<ScanQuery>,
) -> ApiResult<Json<ScanVersionsResponse>> {
    let requested_full = match q.mode.as_deref() {
        None | Some("fast") => false,
        Some("full") => true,
        Some(other) => {
            // 显式拒绝未知取值：静默按 fast 处理会让调用方（含插件）以为跑了完整扫描。
            return Err(ApiError::bad_request(
                "INVALID_SCAN_MODE",
                format!("mode only accepts fast/full, got: {other}"),
            ));
        }
    };
    // 用户设置「跳过 jar 级探测」优先于请求参数：开启后 mode=full 静默降级为 fast，
    // refineRequired 恒为 false（否则前端会反复发注定被降级的 full 请求）。
    let skip_jar = state
        .settings
        .read()
        .await
        .scan_skip_jar_probe
        .unwrap_or(false);
    if skip_jar && requested_full {
        tracing::debug!("scan: skip_jar_probe enabled, downgrading mode=full to fast");
    }
    let full_mode = requested_full && !skip_jar;
    let game_dir = q.game_dir.clone();
    let state = state.clone();
    tokio::task::spawn_blocking(move || scan_impl(&state, &game_dir, full_mode, skip_jar))
        .await
        .map_err(|e| ApiError::internal(format!("scan task failed: {e}")))?
}

/// 扫描 `{gameDir}/versions/` 下的已装版本，返回探测结果。
///
/// 每个版本目录的成本结构（73 个实例实测，jar ~10MB/个）：
/// - 读 `{name}.json` + `detect_loaders`：毫秒级（73 个合计约 100ms）；
/// - 打开 `{name}.jar` 读 `version.json`：73 个合计约 1.6-2s；
/// - 前两级都读不到 → 整包 SHA1（1.24GB）：冷盘 **37.6s** —— 这就是用户看到的"1 分多钟"。
///
/// 所以按"版本目录"做两级短路：
/// 1. **指纹命中的版本目录完全不打开 jar**，直接复用上次的 `game_version`/`loaders`；
/// 2. 未命中的版本目录在 `fast` 下只跑 JSON 链（`refineRequired` 提示前端再 `full`），
///    在 `full` 下才付 jar 级的钱，并把结果写回指纹缓存。
fn scan_impl(
    state: &SharedState,
    game_dir: &str,
    full_mode: bool,
    skip_jar: bool,
) -> ApiResult<Json<ScanVersionsResponse>> {
    let abs_dir =
        std::path::absolute(game_dir).unwrap_or_else(|_| Path::new(game_dir).to_path_buf());
    let versions_dir = abs_dir.join("versions");
    // 缓存 key：规范化后的绝对路径，同一目录的不同写法命中同一份缓存。
    let cache_key = abs_dir.to_string_lossy().into_owned();
    let started = std::time::Instant::now();

    tracing::info!(
        game_dir = %game_dir,
        abs_dir = %abs_dir.display(),
        versions_dir = %versions_dir.display(),
        versions_exists = versions_dir.is_dir(),
        mode = if full_mode { "full" } else { "fast" },
        "scan"
    );

    if !versions_dir.is_dir() {
        // 目录被整体删掉/改名 → 丢掉该 gameDir 的缓存，避免缓存文件无限增长。
        state.scan_cache.drop_game_dir(&cache_key);
        state.scan_cache.flush();
        return Ok(Json(ScanVersionsResponse {
            path: abs_dir.to_string_lossy().into_owned(),
            versions: Vec::new(),
            no_json_dirs: Vec::new(),
            refine_required: false,
        }));
    }

    // 1. 收集版本目录（73 次 metadata 约 1ms）。排序只为输出稳定（前端列表不跳动）。
    let mut inputs: Vec<ScanInput> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&versions_dir) {
        for dir in entries.flatten() {
            let dir_path = dir.path();
            if !dir_path.is_dir() {
                continue;
            }
            let name = dir.file_name().to_string_lossy().into_owned();
            inputs.push(ScanInput { name, dir_path });
        }
    }
    inputs.sort_by(|a, b| a.name.cmp(&b.name));

    // 2. 逐版本探测。版本之间互不依赖，用小线程池并行（纯磁盘 I/O，不涉及 async）；
    //    并发度钳位是为了避免几十个实例时线程风暴。
    let workers = inputs.len().clamp(1, MAX_SCAN_WORKERS);
    // `&str` 是 Copy：`move` 闭包共享同一份缓存 key，不会转移所有权。
    let cache_key = cache_key.as_str();
    let outcomes: Vec<ScanOutcome> = if workers <= 1 {
        inputs
            .iter()
            .filter_map(|input| scan_one_version(state, cache_key, input, full_mode))
            .collect()
    } else {
        let chunk_len = inputs.len().div_ceil(workers).max(1);
        std::thread::scope(|scope| {
            let handles: Vec<_> = inputs
                .chunks(chunk_len)
                .map(|chunk| {
                    scope.spawn(move || {
                        chunk
                            .iter()
                            .filter_map(|input| {
                                scan_one_version(state, cache_key, input, full_mode)
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| match h.join() {
                    Ok(outcomes) => outcomes,
                    // 工作线程 panic 时不能静默丢弃：那一整块版本目录会从响应里消失，
                    // 而接口仍返回 200。至少留下痕迹，方便定位是哪个目录的什么数据触发的。
                    Err(e) => {
                        tracing::error!(
                            chunk_start = ?inputs.first().map(|i| i.name.clone()),
                            "scan: worker thread panicked, its versions are omitted: {e:?}"
                        );
                        Vec::new()
                    }
                })
                .collect()
        })
    };

    // 3. 淘汰已删除版本目录的缓存条目（保留本次扫到的），然后统一落盘一次。
    state
        .scan_cache
        .prune_versions(cache_key, inputs.iter().map(|i| i.name.as_str()));

    let result: Vec<ScannedVersionEntry> = outcomes.iter().map(|o| o.entry.clone()).collect();
    let cache_hits = outcomes.iter().filter(|o| !o.cache_missed).count();
    let cache_misses = outcomes.len() - cache_hits;
    state.scan_cache.flush();

    tracing::info!(
        count = result.len(),
        cache_hits,
        cache_misses,
        elapsed_ms = started.elapsed().as_millis() as u64,
        mode = if full_mode { "full" } else { "fast" },
        "scan: found versions"
    );
    // 自动修复只在 full 段做。fast 段的 gameVersion 是 JSON 链的猜测值，把它
    // 写回 instances.json 会在 full 段失败/超时后永久留下脏数据（ADR-082 决策 4）。
    if full_mode {
        fix_instance_game_versions(&state.instance, &result, game_dir);
        fix_instance_loaders(&state.instance, &result, game_dir);
    }

    Ok(Json(ScanVersionsResponse {
        path: abs_dir.to_string_lossy().into_owned(),
        versions: result,
        no_json_dirs: Vec::new(),
        // fast 段有未命中缓存的版本 → 它们的 gameVersion 只是 JSON 链的猜测，
        // 前端应再发 `mode=full` 用 jar 级结果回填。
        // `skip_jar` 打开时不能要求 refine：请求里的 `mode=full` 已被静默降级，
        // 恒为 true 的 refineRequired 只会让前端反复发注定被降级的 full 扫描。
        refine_required: cache_misses > 0 && !full_mode && !skip_jar,
    }))
}

/// 一个待扫描的版本目录。
struct ScanInput {
    name: String,
    dir_path: PathBuf,
}

/// 单版本探测结果 + 是否发生了缓存未命中。
struct ScanOutcome {
    entry: ScannedVersionEntry,
    cache_missed: bool,
}

/// 探测单个版本目录；`{name}.json` 损坏/不可解析时返回 `None`（原行为：跳过）。
fn scan_one_version(
    state: &SharedState,
    cache_key: &str,
    input: &ScanInput,
    full_mode: bool,
) -> Option<ScanOutcome> {
    let name = input.name.as_str();
    let dir_path = input.dir_path.as_path();
    let json_path = dir_path.join(format!("{name}.json"));
    if !json_path.is_file() {
        return Some(ScanOutcome {
            entry: ScannedVersionEntry {
                name: name.to_string(),
                game_version: name.to_string(),
                state: "Corrupted".to_string(),
                state_describe: "版本文件缺失".to_string(),
                loaders: None,
                icon_data: None,
            },
            cache_missed: false,
        });
    }

    let root = match std::fs::read(&json_path).and_then(|bytes| {
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
    }) {
        Ok(root) => root,
        Err(e) => {
            tracing::warn!(name = %name, error = %e, "scan: failed to parse json");
            return None;
        }
    };

    let id = root
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| name.to_string());
    let inherits_from = root
        .get("inheritsFrom")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mc_version = root
        .get("minecraftVersion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let client_version = root
        .get("clientVersion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let main_class = root
        .get("mainClass")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let loaders = detect_loaders(&root, &main_class, &id, inherits_from.as_deref());
    let loaders_opt = (!loaders.is_empty()).then_some(loaders);

    // ── 指纹命中：直接复用 jar 级探测结果，完全不打开 jar ──
    // JSON 仍要解析：响应的 `name` 来自 JSON 的 `id`（可能与目录名不同），
    // 且 `detect_loaders` 只读 JSON —— 这两件事加起来也就几十毫秒。
    //
    // 指纹覆盖：`{name}.json` + **`effective_jar_path` 选出的那个 jar**
    // （`inheritsFrom != id` 时是 `{inheritsFrom}.jar`，不是 `{name}.jar`）。
    let effective_jar = effective_jar_path(dir_path, inherits_from.as_deref(), &id);
    let Some(fingerprint) = state
        .scan_cache
        .fingerprint(&json_path, effective_jar.as_deref())
    else {
        // json 的 metadata 都拿不到：按原行为仍然给出条目，只是不进缓存。
        tracing::warn!(name = %name, "scan: cannot stat version json");
        let game_version = resolve_game_version_from_json(
            &root,
            &id,
            inherits_from.as_deref(),
            client_version.as_deref(),
            mc_version.as_deref(),
        );
        return Some(ScanOutcome {
            entry: ScannedVersionEntry {
                name: id,
                game_version,
                state: "Available".to_string(),
                state_describe: String::new(),
                loaders: loaders_opt,
                icon_data: resolve_pcl_icon(dir_path),
            },
            cache_missed: true,
        });
    };
    if let Some(hit) = state.scan_cache.get(cache_key, name, &fingerprint) {
        return Some(ScanOutcome {
            entry: ScannedVersionEntry {
                name: id,
                game_version: hit.game_version,
                state: "Available".to_string(),
                state_describe: String::new(),
                loaders: loaders_opt,
                icon_data: resolve_pcl_icon(dir_path),
            },
            cache_missed: false,
        });
    }

    let game_version = if full_mode {
        let v = resolve_game_version(
            &root,
            &id,
            inherits_from.as_deref(),
            client_version.as_deref(),
            mc_version.as_deref(),
            dir_path,
        );
        // 写回缓存：下次同样的指纹直接命中，省掉 jar 的花销。
        // 用的就是上面 `get` 时那份指纹（同一个 jar 选择逻辑），避免两侧不一致。
        state.scan_cache.put(
            cache_key,
            name,
            CachedVersion {
                game_version: v.clone(),

                ..fingerprint
            },
        );
        v
    } else {
        // fast：不碰 jar，只走 JSON 链；真正准确的值由随后的 mode=full 回填。
        resolve_game_version_from_json(
            &root,
            &id,
            inherits_from.as_deref(),
            client_version.as_deref(),
            mc_version.as_deref(),
        )
    };

    Some(ScanOutcome {
        entry: ScannedVersionEntry {
            name: id,
            game_version,
            state: "Available".to_string(),
            state_describe: String::new(),
            loaders: loaders_opt,
            icon_data: resolve_pcl_icon(dir_path),
        },
        cache_missed: true,
    })
}

async fn version_metadata(
    State(state): State<SharedState>,
    AxumPath(name): AxumPath<String>,
) -> ApiResult<Json<CompleteVersionMetadata>> {
    let metadata = state
        .core
        .version()
        .get_version_metadata(&name)
        .await
        .map_err(map_core_err)?;
    Ok(Json(metadata))
}

async fn install_version(
    State(state): State<SharedState>,
    AxumPath(name): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    state
        .core
        .version()
        .install_version(&name, None)
        .await
        .map_err(map_core_err)?;
    Ok(Json(MessageResponse {
        message: format!("Installing version {name}"),
        version_id: Some(name),
    }))
}

async fn uninstall_version(
    State(state): State<SharedState>,
    AxumPath(name): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    if !state.core.version().is_version_installed(&name) {
        return Err(ApiError::not_found(
            "VERSION_NOT_FOUND",
            format!("Version {name} is not installed"),
        ));
    }
    state
        .core
        .version()
        .uninstall_version(&name)
        .await
        .map_err(map_core_err)?;
    Ok(Json(MessageResponse {
        message: format!("Uninstalled version {name}"),
        version_id: None,
    }))
}

#[derive(Deserialize)]
struct RemoteQuery {
    #[allow(dead_code)]
    source: Option<i32>,
}

// =====================================================================
// 工具
// =====================================================================

fn map_core_err(e: qomicex_core::error::Error) -> ApiError {
    match e {
        qomicex_core::error::Error::VersionNotFound { message, .. } => {
            ApiError::not_found("VERSION_NOT_FOUND", message)
        }
        other => ApiError::internal(other.to_string()),
    }
}

/// 从 JAR 读取游戏版本（对应源 `GameVersionHelper.FromJar`）。
///
/// 实现位于 core `util::version_json::from_jar`：jar 内 version.json →
/// Minecraft.class 常量池 → MinecraftServer.class 常量池 → 已知 SHA1 映射表。
/// 该级在回退链第 1 位（源顺序，jar 是实际运行的本体，识别最准确）。
/// release 构建实测 9 版本全量 scan 首扫 2.49s / 热扫 0.59s（与 C# 同量级）；
/// debug 构建 SHA1 慢 20-50 倍属 dev 模式现象，不为它加缓存。
fn from_jar_game_version(jar_path: &Path) -> Option<String> {
    qomicex_core::util::version_json::from_jar(&jar_path.to_string_lossy())
}

/// jar 级探测实际会打开的那个 jar 路径（`{inheritsFrom}.jar` 优先，回退 `{id}.jar`）。
///
/// 抽成函数是给指纹用的：缓存指纹必须覆盖**真正被打开的那个 jar**，否则
/// 改了 `{inheritsFrom}.jar` 而它又不是 `{id}.jar` 时会读到旧版本号。
pub(crate) fn effective_jar_path(
    version_dir: &Path,
    inherits_from: Option<&str>,
    id: &str,
) -> Option<PathBuf> {
    let jar_id = inherits_from.unwrap_or(id);
    let primary = version_dir.join(format!("{jar_id}.jar"));
    if primary.is_file() {
        return Some(primary);
    }
    if jar_id != id {
        let fallback = version_dir.join(format!("{id}.jar"));
        if fallback.is_file() {
            return Some(fallback);
        }
    }
    None
}

/// JAR 级探测（`resolve_game_version` 的第 1 级）：打开 `{jarId}.jar` 读版本号。
///
/// 成本最高的探测级（zip 中央目录 → 常量池 → 整包 SHA1），所以扫描按版本目录缓存
/// 它的结果（见 `services/scan_cache.rs`）；只在缓存未命中时才走到这里。
fn game_version_from_jar(
    version_dir: &Path,
    inherits_from: Option<&str>,
    id: &str,
) -> Option<String> {
    let jar_path = effective_jar_path(version_dir, inherits_from, id)?;
    let v = from_jar_game_version(&jar_path)?;
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// 游戏版本探测回退链（源 6 级：JAR → clientVersion → minecraftVersion →
/// inheritsFrom → arguments → regex → id 兜底）。
///
/// JAR 级保持源顺序的第 1 位：jar 是实际运行的游戏本体，识别结果最准确。
/// 性能实测（9 jar ≈150MB，含 GTNH 类无 version.json 条目）：
/// release 首扫 2.49s / 热扫 0.59s；from_jar 短路设计下仅第 1 级命中的 jar
/// 产生 IO，无 version.json 的 jar 走常量池（毫秒级）或 SHA1（合计 <100ms），
/// zip 中央目录读取被 OS 文件缓存吸收，无需结果缓存。
///
/// pub(crate)：connector.rs host_port 从进程 --gameDir/--version 读版本 JSON 时复用。
pub(crate) fn resolve_game_version(
    root: &serde_json::Value,
    id: &str,
    inherits_from: Option<&str>,
    client_version: Option<&str>,
    mc_version: Option<&str>,
    version_dir: &Path,
) -> String {
    // 1. JAR（最高精度）
    if let Some(v) = game_version_from_jar(version_dir, inherits_from, id) {
        return v;
    }

    resolve_game_version_from_json(root, id, inherits_from, client_version, mc_version)
}

/// 仅走 JSON 回退链的第 2-6 级（不碰 jar）。
///
/// `/versions/scan?mode=fast` 用它：先毫秒级出列表，jar 级结果由被缓存或后续
/// `mode=full` 补齐。语义上等价于原 `resolve_game_version` 去掉第 1 级。
pub(crate) fn resolve_game_version_from_json(
    root: &serde_json::Value,
    id: &str,
    inherits_from: Option<&str>,
    client_version: Option<&str>,
    mc_version: Option<&str>,
) -> String {
    // 2. clientVersion（源安装器 MergeVersionJson 后写入）
    if let Some(cv) = client_version {
        if !cv.is_empty() {
            return cv.to_string();
        }
    }

    // 3. minecraftVersion（vanilla JSON 标准字段）
    if let Some(mv) = mc_version {
        if !mv.is_empty() {
            return mv.to_string();
        }
    }

    // 4. inheritsFrom（Forge/NeoForge 未合并 JSON 标准字段）
    if let Some(inf) = inherits_from {
        if !inf.is_empty() {
            return inf.to_string();
        }
    }

    // 5. arguments.game 中的 --fml.mcVersion（Forge 1.13+）
    if let Some(serde_json::Value::Array(game)) = root.pointer("/arguments/game") {
        for i in 0..game.len().saturating_sub(1) {
            if game[i].as_str() == Some("--fml.mcVersion") {
                if let Some(v) = game[i + 1].as_str() {
                    if !v.is_empty() {
                        return v.to_string();
                    }
                }
            }
        }
    }

    // 6. 从 id 正则提取前导版本号（^(\d+\.\d+(?:\.\d+)?)）
    if let Some(prefix) = extract_version_prefix(id) {
        return prefix;
    }

    id.to_string()
}

/// 手动实现源正则 `^(\d+\.\d+(?:\.\d+)?)`（避免引入 regex crate）。
fn extract_version_prefix(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut i = 0;

    fn consume_digits(bytes: &[u8], n: usize, i: &mut usize) -> Option<()> {
        let start = *i;
        while *i < n && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        if *i == start {
            None
        } else {
            Some(())
        }
    }

    consume_digits(bytes, n, &mut i)?; // \d+
    if i < n && bytes[i] == b'.' {
        i += 1;
    } else {
        return None;
    }
    consume_digits(bytes, n, &mut i)?; // \d+
    if i < n && bytes[i] == b'.' {
        let save = i;
        i += 1;
        if consume_digits(bytes, n, &mut i).is_none() {
            i = save; // 回退：不带可选 .\d+
        }
    }
    Some(s[..i].to_string())
}

/// Loader 探测（逐字移植源 DetectLoaders）。
/// 提取 loader 版本（对齐 C# core `GetModloaderType`：版本号含 `-` 且恰好 2 段时取后段，
/// 否则用全名。如 `1.12.2-14.23.5.2860` → `14.23.5.2860`；`21.1.233` → `21.1.233`）。
fn extract_loader_version(raw: &str) -> String {
    let ver_parts: Vec<&str> = raw.split('-').collect();
    if ver_parts.len() == 2 {
        ver_parts[1].to_string()
    } else {
        raw.to_string()
    }
}

fn has_loader(types: &[ScannedLoaderEntry], r#type: &str) -> bool {
    types.iter().any(|t| t.r#type == r#type)
}

/// 加载器探测（对齐 C# core `DefaultVersionLocator.GetModloaderType` 的完整语义；
/// 补充 Neo 端点的 inheritsFrom 猜测作为 Unknown 兜底前的最后一级）：
/// - libraries：OptiFine / LiteLoader / Cleanroom / 老版 Forge（`parts[1]=="forge"`）/
///   新版 Forge（`fmlloader`）/ Babric / Fabric（含 LegacyFabric）/ Quilt
/// - arguments：`--fml.neoForgeVersion` / `--fml.forgeVersion` 下一元素
/// - mainClass 精确匹配（Vanilla / Quilt / NeoForge / Fabric / Forge / Cleanroom）
/// - `net.minecraft.launchwrapper.Launch`（无其他 loader 时）→ Vanilla
/// - 兜底：inheritsFrom 按 id 猜测 → 仍空则 Unknown
/// pub(crate)：connector.rs host_port 复用。
pub(crate) fn detect_loaders(
    root: &serde_json::Value,
    main_class: &str,
    id: &str,
    inherits_from: Option<&str>,
) -> Vec<ScannedLoaderEntry> {
    let mut types: Vec<ScannedLoaderEntry> = Vec::new();

    // ── 1. libraries（对齐 C#：name.ToLower() 全名 contains 预过滤 + parts 精确判定）──
    if let Some(serde_json::Value::Array(libs)) = root.get("libraries") {
        for lib in libs {
            let name = lib.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let lower = name.to_lowercase();
            let parts: Vec<&str> = name.split(':').collect();
            if parts.len() < 3 {
                continue;
            }

            if lower.contains("optifine")
                && parts[1] == "optifine"
                && !has_loader(&types, "OptiFine")
            {
                types.push(ScannedLoaderEntry {
                    r#type: "OptiFine".into(),
                    version: extract_loader_version(parts[2]),
                });
            }
            if lower.contains("liteloader")
                && parts[1] == "liteloader"
                && !has_loader(&types, "LiteLoader")
            {
                types.push(ScannedLoaderEntry {
                    r#type: "LiteLoader".into(),
                    version: extract_loader_version(parts[2]),
                });
            }
            if lower.contains("cleanroom")
                && parts[1].to_lowercase().contains("cleanroom")
                && !has_loader(&types, "Cleanroom")
            {
                types.push(ScannedLoaderEntry {
                    r#type: "Cleanroom".into(),
                    version: extract_loader_version(parts[2]),
                });
            }
            // 老版 Forge（≤1.12.2）：`net.minecraftforge:forge:1.12.2-14.23.5.2860`
            if lower.contains("forge") && parts[1] == "forge" && !has_loader(&types, "Forge") {
                types.push(ScannedLoaderEntry {
                    r#type: "Forge".into(),
                    version: extract_loader_version(parts[2]),
                });
            }
            // 新版 Forge（1.13+）：`net.minecraftforge:fmlloader:1.20.1-47.2.0`
            if lower.contains("minecraftforge")
                && parts[1] == "fmlloader"
                && !has_loader(&types, "Forge")
            {
                types.push(ScannedLoaderEntry {
                    r#type: "Forge".into(),
                    version: extract_loader_version(parts[2]),
                });
            }
            // NeoForge：`net.neoforged:neoforge:{ver}` 库形态（部分版本 JSON 无
            // --fml.neoForgeVersion 参数时靠此识别；mainClass 精确匹配兜底）
            if lower.contains("neoforge")
                && parts[1] == "neoforge"
                && !has_loader(&types, "NeoForge")
            {
                types.push(ScannedLoaderEntry {
                    r#type: "NeoForge".into(),
                    version: extract_loader_version(parts[2]),
                });
            }
            if lower.contains("babric")
                && parts[0].eq_ignore_ascii_case("babric")
                && !has_loader(&types, "Babric")
            {
                types.push(ScannedLoaderEntry {
                    r#type: "Babric".into(),
                    version: "Unknown".into(),
                });
            }
            if lower.contains("fabric")
                && !has_loader(&types, "Babric")
                && (parts[1] == "fabric" || parts[1] == "fabric-loader")
            {
                if parts[0].to_lowercase().contains("legacyfabric") {
                    if !has_loader(&types, "LegacyFabric") {
                        types.push(ScannedLoaderEntry {
                            r#type: "LegacyFabric".into(),
                            version: parts[2].to_string(),
                        });
                    }
                } else if !has_loader(&types, "Fabric") {
                    types.push(ScannedLoaderEntry {
                        r#type: "Fabric".into(),
                        version: parts[2].to_string(),
                    });
                }
            }
            if lower.contains("quilt")
                && (parts[1] == "quilt" || parts[1] == "quilt-loader")
                && !has_loader(&types, "Quilt")
            {
                types.push(ScannedLoaderEntry {
                    r#type: "Quilt".into(),
                    version: parts[2].to_string(),
                });
            }
        }
    }

    // ── 2. arguments（对齐 C#：--fml.neoForgeVersion / --fml.forgeVersion 的下一非参数元素）──
    if let Some(serde_json::Value::Array(game)) = root.pointer("/arguments/game") {
        let mut prev: Option<String> = None;
        for item in game {
            let Some(s) = item.as_str() else {
                prev = None;
                continue;
            };
            if prev.as_deref() == Some("--fml.neoForgeVersion") && !s.starts_with("--") {
                if !has_loader(&types, "NeoForge") {
                    types.push(ScannedLoaderEntry {
                        r#type: "NeoForge".into(),
                        version: s.to_string(),
                    });
                }
                break;
            }
            if prev.as_deref() == Some("--fml.forgeVersion") && !s.starts_with("--") {
                if !has_loader(&types, "Forge") {
                    types.push(ScannedLoaderEntry {
                        r#type: "Forge".into(),
                        version: s.to_string(),
                    });
                }
            }
            prev = Some(s.to_string());
        }
    }

    // ── 3. mainClass 精确匹配（对齐 C#：小写精确字符串）──
    let mc = main_class.to_lowercase();
    if mc == "net.minecraft.client.main.main" {
        return vec![ScannedLoaderEntry {
            r#type: "Vanilla".into(),
            version: String::new(),
        }];
    }
    if !has_loader(&types, "Quilt") && mc == "org.quiltmc.loader.impl.launch.knot.knotclient" {
        types.push(ScannedLoaderEntry {
            r#type: "Quilt".into(),
            version: String::new(),
        });
    }
    if !has_loader(&types, "NeoForge")
        && !has_loader(&types, "Forge")
        && mc == "cpw.mods.bootstraplauncher.bootstraplauncher"
    {
        types.push(ScannedLoaderEntry {
            r#type: "NeoForge".into(),
            version: String::new(),
        });
    }
    if !has_loader(&types, "Fabric")
        && !has_loader(&types, "Babric")
        && mc == "net.fabricmc.loader.impl.launch.knot.knotclient"
    {
        types.push(ScannedLoaderEntry {
            r#type: "Fabric".into(),
            version: String::new(),
        });
    }
    if !has_loader(&types, "Forge") && mc == "net.minecraftforge.bootstrap.bootstraplauncher" {
        types.push(ScannedLoaderEntry {
            r#type: "Forge".into(),
            version: String::new(),
        });
    }
    if !has_loader(&types, "Cleanroom") && mc == "top.outlands.foundation.boot.foundation" {
        types.push(ScannedLoaderEntry {
            r#type: "Cleanroom".into(),
            version: String::new(),
        });
    }

    // ── 4. 老版原版（≤1.12.2）：launchwrapper 且无任何 loader → Vanilla ──
    if mc == "net.minecraft.launchwrapper.launch"
        && !has_loader(&types, "OptiFine")
        && !has_loader(&types, "Forge")
        && !has_loader(&types, "NeoForge")
        && !has_loader(&types, "LiteLoader")
        && !has_loader(&types, "Fabric")
        && !has_loader(&types, "Quilt")
        && !has_loader(&types, "Cleanroom")
        && !has_loader(&types, "Babric")
    {
        return vec![ScannedLoaderEntry {
            r#type: "Vanilla".into(),
            version: String::new(),
        }];
    }

    // ── 5. 兜底：inheritsFrom 按 id 猜测（Neo 端点级，C# core 无此级）→ 仍空则 Unknown ──
    if types.is_empty() {
        if let Some(inherits) = inherits_from {
            if inherits != id {
                let lower_id = id.to_lowercase();
                let guess = if lower_id.contains("-forge-") {
                    Some("Forge")
                } else if lower_id.contains("-fabric-") {
                    Some("Fabric")
                } else if lower_id.contains("-quilt-") {
                    Some("Quilt")
                } else if lower_id.contains("-neoforge-") {
                    Some("NeoForge")
                } else if lower_id.contains("-cleanroom") {
                    Some("Cleanroom")
                } else if lower_id.contains("-legacyfabric-") {
                    Some("LegacyFabric")
                } else if lower_id.contains("-babric-") {
                    Some("Babric")
                } else {
                    None
                };
                if let Some(g) = guess {
                    types.push(ScannedLoaderEntry {
                        r#type: g.into(),
                        version: id.to_string(),
                    });
                }
            }
        }
    }
    if types.is_empty() {
        types.push(ScannedLoaderEntry {
            r#type: "Unknown".into(),
            version: "Unknown".into(),
        });
    }

    types
}

/// 自动修复 gameVersion 不匹配的既有实例（对应源 FixInstanceGameVersions）。
fn fix_instance_game_versions(
    instances: &InstanceService,
    scanned: &[ScannedVersionEntry],
    game_dir: &str,
) {
    for inst in instances.get_all() {
        if inst.game_dir != game_dir {
            continue;
        }
        let Some(scanned_version) = scanned.iter().find(|s| s.name == inst.name) else {
            continue;
        };
        // Corrupted 条目的 game_version 是目录名占位（非探测结果），写回会把
        // 实例 gameVersion 污染成实例名（Issue #85）。
        if scanned_version.state != "Available" || scanned_version.game_version.is_empty() {
            continue;
        }
        if inst.game_version != scanned_version.game_version {
            tracing::info!(
                name = %inst.name,
                old = %inst.game_version,
                new = %scanned_version.game_version,
                "scan: fixing instance gameVersion"
            );
            let mut updated = inst.clone();
            updated.game_version = scanned_version.game_version.clone();
            let uid = updated.id.clone();
            instances.update(&uid, updated);
        }
    }
}

/// 自动修复 loader 缺失/不匹配的既有实例（对应源 FixInstanceLoaders）。
fn fix_instance_loaders(
    instances: &InstanceService,
    scanned: &[ScannedVersionEntry],
    game_dir: &str,
) {
    for inst in instances.get_all() {
        if inst.game_dir != game_dir {
            continue;
        }
        let Some(scanned_version) = scanned.iter().find(|s| s.name == inst.name) else {
            continue;
        };
        let Some(first) = scanned_version.loaders.as_ref().and_then(|l| l.first()) else {
            continue;
        };
        // Vanilla/Unknown 不写入实例 loader（原版实例 loader 保持空，未知版本不猜测覆盖）
        if first.r#type == "Vanilla" || first.r#type == "Unknown" {
            continue;
        }
        if inst.loader.as_deref() != Some(first.r#type.as_str())
            || inst.loader_version.as_deref() != Some(first.version.as_str())
        {
            tracing::info!(
                name = %inst.name,
                old_loader = inst.loader.as_deref().unwrap_or(""),
                old_ver = inst.loader_version.as_deref().unwrap_or(""),
                new_loader = %first.r#type,
                new_ver = %first.version,
                "scan: fixing instance loader"
            );
            let mut updated = inst.clone();
            updated.loader = Some(first.r#type.clone());
            updated.loader_version = Some(first.version.clone());
            let uid = updated.id.clone();
            instances.update(&uid, updated);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        effective_jar_path, fix_instance_game_versions, resolve_game_version, ScannedVersionEntry,
    };
    use crate::services::instance::GameInstance;
    use crate::services::instance::InstanceService;
    use std::io::Write as _;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-version-scan-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(name: &str, game_version: &str, state: &str) -> ScannedVersionEntry {
        ScannedVersionEntry {
            name: name.to_string(),
            game_version: game_version.to_string(),
            state: state.to_string(),
            state_describe: String::new(),
            loaders: None,
            icon_data: None,
        }
    }

    fn instance(name: &str, game_dir: &str, game_version: &str) -> GameInstance {
        let mut inst = GameInstance::default();
        inst.name = name.to_string();
        inst.game_version = game_version.to_string();
        inst.game_dir = game_dir.to_string();
        inst
    }

    /// Issue #85：Corrupted 条目的 game_version 是目录名占位（= 实例名 = 整合包名），
    /// fix 不得把实例 gameVersion 覆盖成它。
    #[test]
    fn fix_skips_corrupted_scan_entries() {
        let dir = temp_dir("corrupted");
        let svc = InstanceService::new_for_test(&dir);
        svc.create(instance("GTNH 2.8.4", "C:/mc", "1.7.10"));
        let scanned = vec![entry("GTNH 2.8.4", "GTNH 2.8.4", "Corrupted")];
        fix_instance_game_versions(&svc, &scanned, "C:/mc");
        assert_eq!(svc.get_all()[0].game_version, "1.7.10");
    }

    /// Available 且值不同 → 正常写回（修复扫描漂移的正向语义不受影响）。
    #[test]
    fn fix_updates_on_available_entries() {
        let dir = temp_dir("available");
        let svc = InstanceService::new_for_test(&dir);
        svc.create(instance("GTNH 2.8.4", "C:/mc", "9.9.9"));
        let scanned = vec![entry("GTNH 2.8.4", "1.7.10", "Available")];
        fix_instance_game_versions(&svc, &scanned, "C:/mc");
        assert_eq!(svc.get_all()[0].game_version, "1.7.10");
    }

    /// resolve_game_version：id 无版本号前缀且无任何版本字段 → 返回 id（现状兜底）；
    /// id 形如 "1.12.2-Forge-..." → 第 5 级正则提取 "1.12.2"。
    #[test]
    fn resolve_falls_back_to_id_when_no_fields() {
        let root = serde_json::json!({});
        assert_eq!(
            resolve_game_version(&root, "GTNH 2.8.4", None, None, None, &PathBuf::new()),
            "GTNH 2.8.4"
        );
        assert_eq!(
            resolve_game_version(
                &root,
                "1.12.2-Forge-14.23.5.2860",
                None,
                None,
                None,
                &PathBuf::new()
            ),
            "1.12.2"
        );
    }

    /// 回退顺序：JAR 第 1 位（源顺序，识别最准确）。version_dir 下放置可解析的
    /// jar（内含 version.json id="9.9.9"），JSON 带 minecraftVersion="1.21.1"：
    /// JAR 优先应返回 "9.9.9"；若未来有人把 JAR 移到 JSON 之后（曾致 GTNH 场景
    /// 回退到实例名），本测试失败。
    #[test]
    fn resolve_prefers_jar_over_json_fields() {
        use zip::ZipWriter;

        let dir = temp_dir("jar-over-json");
        std::fs::create_dir_all(&dir).unwrap();
        let jar_path = dir.join("SomePack 1.0.jar");
        let file = std::fs::File::create(&jar_path).unwrap();
        let mut zip = ZipWriter::new(file);
        zip.start_file("version.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"id":"9.9.9"}"#).unwrap();
        zip.finish().unwrap();

        let root = serde_json::json!({});
        assert_eq!(
            resolve_game_version(&root, "SomePack 1.0", None, None, Some("1.21.1"), &dir),
            "9.9.9"
        );
    }

    /// jar 级探测实际打开的路径：`{inheritsFrom}.jar` 优先，回退 `{id}.jar`。
    /// 指纹必须覆盖它，否则只记 `{id}.jar` 会漏掉 `{inheritsFrom}.jar` 的变化。
    #[test]
    fn effective_jar_path_prefers_inherits_then_falls_back() {
        let base = temp_dir("effective-jar");
        let name = "1.20.1-Forge-47.2.0";
        let vdir = base.join("versions").join(name);
        std::fs::create_dir_all(&vdir).unwrap();
        std::fs::write(vdir.join(format!("{name}.json")), "{}").unwrap();
        std::fs::write(vdir.join(format!("{name}.jar")), b"mine").unwrap();

        // 只有 {id}.jar
        assert_eq!(
            effective_jar_path(&vdir, Some("1.20.1-parent"), name),
            Some(vdir.join(format!("{name}.jar")))
        );

        // 同时存在 {inheritsFrom}.jar → 优先它（与 game_version_from_jar 的选择一致）
        std::fs::write(vdir.join("1.20.1-parent.jar"), b"parent").unwrap();
        assert_eq!(
            effective_jar_path(&vdir, Some("1.20.1-parent"), name),
            Some(vdir.join("1.20.1-parent.jar"))
        );

        // 两个都没有（jar 缺失）→ None
        let other = base.join("versions/other");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(
            effective_jar_path(&other, Some("1.20.1-parent"), name),
            None
        );

        // inheritsFrom == id 时不重复探测同一个路径
        assert_eq!(
            effective_jar_path(&vdir, Some(name), name),
            Some(vdir.join(format!("{name}.jar")))
        );
        let _ = std::fs::remove_dir_all(&base);

        #[test]
        fn from_jar_reads_version_json_entry() {
            use zip::ZipWriter;

            let dir = temp_dir("jar-vjson");
            std::fs::create_dir_all(&dir).unwrap();
            let jar_path = dir.join("vjson-probe.jar");
            let file = std::fs::File::create(&jar_path).unwrap();
            let mut zip = ZipWriter::new(file);
            zip.start_file("version.json", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(br#"{"id":"1.2.3-probe"}"#).unwrap();
            zip.finish().unwrap();

            assert_eq!(
                super::from_jar_game_version(&jar_path).as_deref(),
                Some("1.2.3-probe")
            );
        }
    }
}
