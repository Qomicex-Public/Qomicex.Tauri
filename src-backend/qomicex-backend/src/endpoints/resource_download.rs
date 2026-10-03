//! Resource download endpoints (source: Endpoints/ResourceDownloadEndpoints.cs).
//!
//! Implements download task start, progress, cancel and batch-cancel for
//! the resource flavours (mods / resourcepacks / shaderpacks / datapacks /
//! saves / screenshots) plus a generic "download to a fixed path" variant.
//!
//! Actual downloading is delegated to the shared `state.download_manager`
//! (qomicex_downloader::DownloadManager). Task ids reported to the frontend
//! are the downloader's `TaskId` (u64) serialized as a decimal string so the
//! wire contract stays a string, as in the C# original.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use qomicex_downloader::{DownloadEvent, DownloadManager, DownloadTask, TaskId, TaskState};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::settings;
use crate::state::SharedState;

// =====================================================================
// DTO (camelCase, mirroring the C# records)
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartDownloadRequest {
    instance_id: String,
    url: String,
    file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelBatchRequest {
    task_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadStartResponse {
    task_id: String,
    file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    status: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressResponse {
    progress: f64,
    downloaded_bytes: u64,
    total_bytes: u64,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadToRequest {
    url: String,
    target_path: String,
    /// 下载完成后是否解压（#162）。见 `download_to`。
    #[serde(default)]
    extract: bool,
    /// 地图存档的目标文件夹名（#162）。给定时按**地图语义**解压：解成
    /// `saves/<worldName>/` 恰好一层，同名已存在则拒绝（用户改名后重试）。
    /// 不给定时 `extract` 走通用语义（解到 zip 所在目录）。
    #[serde(default)]
    world_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadToResponse {
    task_id: String,
    path: String,
}

// =====================================================================
// Progress bridge
// =====================================================================

/// Cached snapshot of a downloader task, fed from the download event stream.
/// The downloader only exposes `state(id) -> TaskState`; downloaded/total
/// bytes and failure detail are delivered via `subscribe()`. A single
/// background watcher subscribes once and keeps this map up to date so the
/// progress endpoint can answer without holding per-task subscribers.
#[derive(Clone)]
pub(crate) struct TaskSnapshot {
    pub(crate) status: String,
    pub(crate) downloaded: u64,
    pub(crate) total: u64,
    pub(crate) speed: u64,
    pub(crate) error: Option<String>,
    pub(crate) file_name: Option<String>,
}

/// Snapshot of all tracked download tasks (id -> snapshot), for the progress
/// SSE stream so the download center reflects live resource-download states.
pub(crate) fn download_snapshots() -> Vec<(u64, TaskSnapshot)> {
    task_registry()
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| (*id, s.clone()))
        .collect()
}

fn task_registry() -> &'static Mutex<HashMap<TaskId, TaskSnapshot>> {
    static REGISTRY: OnceLock<Mutex<HashMap<TaskId, TaskSnapshot>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 下载完成**后**需要解压的任务登记（#162）：`task_id -> 解压意图`。
///
/// `/download-to` 与 `/start` 都是「入队即返回」，此时文件还没下完，不能在请求内
/// 解压。故把解压意图登记下来，由 `ensure_watcher` 的事件循环在收到 `Completed`
/// 时取出并执行（下载器是 fsync + rename 原子完成，事件到达时文件已在最终路径）。
fn extract_intents() -> &'static Mutex<HashMap<TaskId, ExtractIntent>> {
    static INTENTS: OnceLock<Mutex<HashMap<TaskId, ExtractIntent>>> = OnceLock::new();
    INTENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 解压意图的两种形态。
#[derive(Clone, Debug, PartialEq, Eq)]
enum ExtractIntent {
    /// 普通解压：把 zip 解到 `dest_dir`（整合包等通用场景）。
    IntoDir { zip: PathBuf, dest_dir: PathBuf },
    /// 地图存档：解成 `saves_dir/<world_name>/` 一层目录（#162）。
    ///
    /// 与 `IntoDir` 分开是因为存档有额外语义：必须恰好一层（否则游戏认不出）、
    /// 同名时**不覆盖**而是报冲突让用户改名。
    World {
        zip: PathBuf,
        saves_dir: PathBuf,
        world_name: String,
    },
}

/// 登记解压意图并返回任务 id。
///
/// **必须在持锁状态下先 `add()` 再插入意图**：下载器对极小的文件可能在 `add()`
/// 返回后立刻完成，事件循环若此时取不到意图，就会把任务标成 completed 而跳过解压
/// （意图还成了永久残留）。事件循环取意图时用**同一把锁**，于是两种顺序都成立：
/// 要么它先拿到锁（此时插入还没发生 → 但它必然在 `add()` 之后才可能收到完成事件，
/// 故拿锁时插入已完成），要么插入先完成。见 `ensure_watcher` 的 Completed 分支。
fn add_with_intent(
    manager: &Arc<DownloadManager>,
    task: DownloadTask,
    intent: ExtractIntent,
) -> TaskId {
    let mut guard = extract_intents().lock().unwrap();
    let id = manager.add(task);
    guard.insert(id, intent);
    id
}

/// 解析地图存档的目标目录与名称（`/download-to` 的 worldName 语义，见 #162）。
/// 返回 `(saves 目录, 规范化后的存档名)`。
fn resolve_world_target(
    target_dir: &Path,
    world_name: &str,
) -> Result<(PathBuf, String), ApiError> {
    let name = crate::services::archive::validate_world_name(world_name)
        .map_err(|e| ApiError::bad_request("INVALID_WORLD_NAME", format!("存档名称非法: {e}")))?;
    Ok((target_dir.to_path_buf(), name))
}

/// 该路径是否是需要解压的 `.zip`（#162）。
///
/// 只认扩展名，**大小写不敏感**（`.ZIP` 同样是 zip；Windows 上文件名大小写
/// 由上游决定，不能假定小写）。非 zip（`.jar` / `.json` / `.mrpack`）一律不解压：
/// 解压它们会破坏文件本身。
fn is_zip_path(path: &Path) -> bool {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .ends_with(".zip")
}

/// 完成解压后回写状态：`completed` / `failed`（后者带上失败原因）。
fn finish_extract(id: TaskId, error: Option<String>) {
    let mut reg = task_registry().lock().unwrap();
    if let Some(s) = reg.get_mut(&id) {
        s.speed = 0;
        match error {
            None => {
                s.status = status_of(TaskState::Completed).to_string();
                if s.total > 0 {
                    s.downloaded = s.total;
                }
            }
            Some(msg) => {
                // 同名冲突用专门的 code，前端据此弹「改名」对话框。
                s.status = status_of(TaskState::Failed).to_string();
                s.error = Some(
                    if msg.starts_with(crate::services::archive::ERR_ALREADY_EXISTS) {
                        format!("SAVE_NAME_CONFLICT: {msg}")
                    } else {
                        msg
                    },
                );
            }
        }
    }
}

/// 在后台线程解压（阻塞文件 IO 不能放在事件循环里），成功后删除原 zip。
///
/// 失败时**保留** zip 并置 `failed`：C# 是 `ExtractToDirectory` 抛错后直接进 catch，
/// `File.Delete` 不会执行 —— 用户至少还能拿到已下载的包，比两样都没有好。
fn spawn_extract(id: TaskId, intent: ExtractIntent) {
    tokio::task::spawn_blocking(move || {
        let archive = crate::services::archive::extract_zip_file;
        let result = match intent {
            ExtractIntent::IntoDir { zip, dest_dir } => {
                archive(&zip, &dest_dir).map(|()| zip.clone())
            }
            // 地图存档：解成 saves/<worldName>/ 恰好一层；同名已存在则报冲突。
            ExtractIntent::World {
                zip,
                saves_dir,
                world_name,
            } => crate::services::archive::extract_world_zip(&zip, &saves_dir, &world_name)
                .map(|_| zip.clone()),
        }
        .and_then(|zip| {
            std::fs::remove_file(&zip)
                .map_err(|e| format!("解压成功但删除原压缩包失败 {}: {e}", zip.display()))
        });
        finish_extract(id, result.err());
    });
}

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Install the one-off background subscriber that mirrors downloader events
/// into the task registry. Returns immediately if already installed.
fn ensure_watcher(manager: Arc<DownloadManager>) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let mut rx = manager.subscribe();
        loop {
            match rx.recv().await {
                Ok(DownloadEvent::Progress {
                    id,
                    downloaded,
                    total,
                    speed_bps,
                    ..
                }) => {
                    let mut reg = task_registry().lock().unwrap();
                    if let Some(s) = reg.get_mut(&id) {
                        s.downloaded = downloaded;
                        s.total = total;
                        s.speed = speed_bps;
                        if total > 0 {
                            s.status = status_of(TaskState::Downloading).to_string();
                        }
                    }
                }
                Ok(DownloadEvent::StateChanged { id, state, detail }) => {
                    // #162：下载完成且登记了解压意图 → 转交解压，状态先保持
                    // 「完成」直到解压有结果由 finish_extract 回写（失败置 failed）。
                    // 这里必须在上面的快照更新之前抢走 Completed，否则会先被写成
                    // completed，解压失败也来不及反映。
                    if state == TaskState::Completed {
                        let intent = extract_intents().lock().unwrap().remove(&id);
                        if let Some(intent) = intent {
                            // 进入解压前先把快照收到「下载 100%、速度 0」：下载已
                            // 完成，若保持最后一次进度 tick 的值，下载中心会在解压
                            // 期间显示一个未满的进度条与虚假速度（CodeRabbit 评审
                            // 指出）。解压结束由 finish_extract 写终态。
                            {
                                let mut reg = task_registry().lock().unwrap();
                                if let Some(s) = reg.get_mut(&id) {
                                    s.speed = 0;
                                    if s.total > 0 {
                                        s.downloaded = s.total;
                                    }
                                }
                            }
                            spawn_extract(id, intent);
                            continue;
                        }
                    } else if matches!(state, TaskState::Failed | TaskState::Cancelled) {
                        // 下载没成功就谈不上解压：清掉意图。否则条目会随失败/取消的
                        // 任务滞留在 map 里（这些 id 虽然不会复用，但残留会一直占用
                        // 内存，且语义上是「永远不会执行的意图」）。
                        extract_intents().lock().unwrap().remove(&id);
                    }
                    let status = status_of(state).to_string();
                    let error = if state == TaskState::Failed {
                        detail
                    } else {
                        None
                    };
                    if let Some(s) = task_registry().lock().unwrap().get_mut(&id) {
                        s.status = status;
                        s.error = error;
                        // 完成时把已下载字节同步为总大小（最后一个进度 tick 可能与
                        // 完成存在节流竞态，导致快照停在未满值）。
                        if state == TaskState::Completed && s.total > 0 {
                            s.downloaded = s.total;
                        }
                        // 终态下速度必须归零，否则快照会永久残留最后一次的瞬时速度，
                        // 每个 SSE 消费者都得各自在客户端补这一下。
                        if matches!(
                            state,
                            TaskState::Completed | TaskState::Failed | TaskState::Cancelled
                        ) {
                            s.speed = 0;
                        }
                    }
                }
                Ok(DownloadEvent::GlobalProgress { .. } | DownloadEvent::Log { .. }) => {}
                Err(_) => break,
            }
        }
    });
}

/// Map a downloader TaskState to the C# session status strings.
fn status_of(state: TaskState) -> &'static str {
    match state {
        TaskState::Queued => "queued",
        TaskState::Downloading => "downloading",
        TaskState::Paused => "paused",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Cancelled => "cancelled",
    }
}

/// Resolve the per-task (or not-found) progress response.
fn build_progress(task_id: TaskId) -> DownloadProgressResponse {
    let reg = task_registry().lock().unwrap();
    let snapshot = reg.get(&task_id).cloned();
    drop(reg);

    match snapshot {
        Some(s) => {
            let progress = if s.total > 0 {
                (s.downloaded as f64 / s.total as f64) * 100.0
            } else if s.status == "completed" {
                100.0
            } else {
                0.0
            };
            DownloadProgressResponse {
                progress,
                downloaded_bytes: s.downloaded,
                total_bytes: s.total,
                status: s.status,
                error: s.error,
                file_name: s.file_name,
            }
        }
        // Unknown id: report not_found. The background watcher mirrors
        // DownloadEvent progress into the registry, so an id that never hit
        // the registry is outside this backend's task set. (Avoid awaiting
        // DownloadManager::state here: its future is not Send, which would
        // make this handler ineligible as an axum handler.)
        None => DownloadProgressResponse {
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            status: "not_found".to_string(),
            error: None,
            file_name: None,
        },
    }
}

// =====================================================================
// Router — prefix string `/api/resource-download` (matches C# MapGroup).
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/resource-download/start", post(start))
        .route("/resource/classify-file", post(classify_file))
        .route("/resource-download/download-to", post(download_to))
        .route("/resource-download/{taskId}/progress", get(progress))
        .route("/resource-download/{taskId}/cancel", post(cancel))
        .route("/resource-download/cancel-batch", post(cancel_batch))
}

// =====================================================================
// Handlers
// =====================================================================

/// POST /api/resource-download/start
/// Start downloading a resource file into the resolved target directory
/// (either the explicit targetPath or the instance's version-isolated dir).
async fn start(
    State(state): State<SharedState>,
    Json(req): Json<StartDownloadRequest>,
) -> ApiResult<Json<DownloadStartResponse>> {
    ensure_watcher(state.download_manager.load_full());

    let cat = match req.category.as_deref().map(|c| c.to_lowercase()).as_deref() {
        Some("resourcepacks" | "resourcepack") => "resourcepacks",
        Some("shaderpacks" | "shader") => "shaderpacks",
        Some("datapacks" | "datapack") => "datapacks",
        Some("saves" | "save") => "saves",
        Some("screenshots") => "screenshots",
        _ => "mods",
    };

    let target_dir: PathBuf = if let Some(tp) = &req.target_path {
        PathBuf::from(tp.trim())
    } else {
        let inst = state
            .instance
            .get_by_id(&req.instance_id)
            .ok_or_else(|| ApiError::not_found("INSTANCE_NOT_FOUND", "Instance not found"))?;
        let isolation = inst
            .version_isolation
            .unwrap_or_else(settings::get_global_version_isolation);
        let game_dir = if isolation {
            PathBuf::from(&inst.game_dir)
        } else {
            PathBuf::from(inst.resolved_game_dir.as_deref().unwrap_or(&inst.game_dir))
        };
        if isolation {
            game_dir.join("versions").join(&inst.name).join(cat)
        } else {
            game_dir.join(cat)
        }
    };

    std::fs::create_dir_all(&target_dir)?;

    // 地图存档（saves）下载的是 zip，需在下完后解压成 saves/<存档名>/（#162）。
    let full_path = target_dir.join(&req.file_name);
    // 存档名取 zip 的文件名主干（`MyWorld.zip` → `MyWorld`），与用户在
    // Minecraft 里看到的世界名一致。
    //
    // 这里**没有用户交互**（与 `/download-to` 的改名对话框不同），故按 CodeRabbit
    // 评审：入队前就清成合法名并避开同名，否则非法名/同名会等到下载**跑完**才失败，
    // 白下一遍且这条路径无从重试。
    let world_name = if cat == "saves" && is_zip_path(&full_path) {
        let stem = full_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let cleaned = crate::services::archive::sanitize_world_name(&stem);
        let base = if cleaned.is_empty() {
            "world".to_string()
        } else {
            cleaned
        };
        Some(crate::services::archive::unique_world_name(
            &target_dir,
            &base,
        ))
    } else {
        None
    };
    // 资源下载源：重写文件 CDN 域名（官方/QML Mirror）。api-key 按重写前的原始 host 判断。
    let download_url = crate::services::file_mirror::rewrite_file_cdn(
        &req.url,
        state.settings.read().await.file_download_source,
    );
    let mirrors = crate::services::file_mirror::mirror_fallback_urls(&download_url);
    let mut task = DownloadTask::new(download_url, full_path.clone());
    if !mirrors.is_empty() {
        task = task.with_mirrors(mirrors);
    }
    if is_cf_url(&req.url) && !state.curse_forge_api_key.is_empty() {
        task = task.with_header("x-api-key", state.curse_forge_api_key.clone());
    }

    let id = match world_name {
        Some(name) => add_with_intent(
            &state.download_manager.load_full(),
            task,
            ExtractIntent::World {
                zip: full_path,
                saves_dir: target_dir.clone(),
                world_name: name,
            },
        ),
        None => state.download_manager.load_full().add(task),
    };

    let file_name = req.file_name.clone();
    {
        let mut reg = task_registry().lock().unwrap();
        reg.insert(
            id,
            TaskSnapshot {
                status: "queued".to_string(),
                downloaded: 0,
                total: 0,
                speed: 0,
                error: None,
                file_name: Some(file_name.clone()),
            },
        );
    }

    Ok(Json(DownloadStartResponse {
        task_id: id.to_string(),
        file_name,
    }))
}

/// POST /api/resource-download/download-to
/// Download a file to an explicit absolute path.
async fn download_to(
    State(state): State<SharedState>,
    Json(req): Json<DownloadToRequest>,
) -> ApiResult<Json<DownloadToResponse>> {
    ensure_watcher(state.download_manager.load_full());

    let target = PathBuf::from(req.target_path.trim());
    let target_dir = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&target_dir)?;

    let file_name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    // 资源下载源：重写文件 CDN 域名（官方/QML Mirror）。api-key 按重写前的原始 host 判断。
    let download_url = crate::services::file_mirror::rewrite_file_cdn(
        &req.url,
        state.settings.read().await.file_download_source,
    );
    let mirrors = crate::services::file_mirror::mirror_fallback_urls(&download_url);
    let mut task = DownloadTask::new(download_url, target.clone());
    if !mirrors.is_empty() {
        task = task.with_mirrors(mirrors);
    }
    if is_cf_url(&req.url) && !state.curse_forge_api_key.is_empty() {
        task = task.with_header("x-api-key", state.curse_forge_api_key.clone());
    }

    // #162：地图存档走的是本端点（前端 `ResourceDetail` 用 downloadTo 落 saves/）。
    //
    // 两种解压语义：
    // - 给了 `worldName` → 地图语义：解成 `saves/<worldName>/` 恰好一层，
    //   同名已存在时**拒绝并让前端弹改名对话框**（不静默覆盖用户已有世界）。
    //   冲突在这里**开下载之前**就判定，避免白下一遍再失败。
    // - 只给 `extract` → 通用语义：解到 zip 所在目录（C# 的
    //   `ExtractToDirectory(fullPath, targetDir)`）。
    //
    // 注意 `worldName` **出现即走地图语义**（哪怕值是空白）：空白名由
    // `resolve_world_target` 判为非法返回 400，而不是悄悄退回「解到 saves/ 根」——
    // 后者正是 #162 要修坏的布局（level.dat 摊在 saves/ 下，游戏认不出）。
    let intent = match req.world_name.as_deref() {
        Some(raw_name) => {
            if !is_zip_path(&target) {
                // 非 zip 却要求按存档解压：多半是上游文件改名/扩展名异常。
                return Err(ApiError::bad_request(
                    "NOT_AN_ARCHIVE",
                    "该文件不是 .zip，无法作为地图存档解压",
                ));
            }
            let (saves_dir, name) = resolve_world_target(&target_dir, raw_name)?;
            // 冲突预检：目标世界目录已存在 → 409，前端据此弹「改名」对话框。
            let dest = saves_dir.join(&name);
            if dest.exists() {
                return Err(ApiError::conflict(
                    "SAVE_NAME_CONFLICT",
                    format!("已存在同名存档「{name}」，请换一个名称"),
                ));
            }
            Some(ExtractIntent::World {
                zip: target.clone(),
                saves_dir,
                world_name: name,
            })
        }
        None if req.extract && is_zip_path(&target) => Some(ExtractIntent::IntoDir {
            zip: target.clone(),
            dest_dir: target_dir.clone(),
        }),
        None => None,
    };

    let id = match intent {
        Some(intent) => add_with_intent(&state.download_manager.load_full(), task, intent),
        None => state.download_manager.load_full().add(task),
    };

    let path = target.to_string_lossy().into_owned();
    {
        let mut reg = task_registry().lock().unwrap();
        reg.insert(
            id,
            TaskSnapshot {
                status: "queued".to_string(),
                downloaded: 0,
                total: 0,
                speed: 0,
                error: None,
                file_name: Some(file_name.clone()),
            },
        );
    }

    Ok(Json(DownloadToResponse {
        task_id: id.to_string(),
        path,
    }))
}

/// GET /api/resource-download/{taskId}/progress
async fn progress(
    State(_state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<DownloadProgressResponse>> {
    if let Ok(id) = task_id.parse::<TaskId>() {
        let resp = build_progress(id);
        if resp.status != "not_found" {
            return Ok(Json(resp));
        }
    }
    // Fallback: plugin-started downloads use a Guid string task id; the
    // download center also polls them through this endpoint when the SSE
    // channel has not yet delivered an entry.
    if let Some(json) = crate::endpoints::plugin::session_progress_json(&task_id) {
        let resp = serde_json::from_value::<DownloadProgressResponse>(json)
            .map_err(|_| ApiError::internal("invalid plugin session snapshot"))?;
        return Ok(Json(resp));
    }
    Ok(Json(DownloadProgressResponse {
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        status: "not_found".to_string(),
        error: None,
        file_name: None,
    }))
}

/// POST /api/resource-download/{taskId}/cancel
async fn cancel(
    State(state): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<StatusResponse>> {
    let id: TaskId = task_id.parse().map_err(|_| {
        ApiError::bad_request("INVALID_TASK_ID", "Task id must be a numeric string")
    })?;
    // Cancel is best-effort in the original: a missing task still replies
    // `{ status: "cancelled" }`. Ignore TaskNotFound here to match that.
    let _ = state.download_manager.load_full().cancel(id).await;
    Ok(Json(StatusResponse {
        status: "cancelled".to_string(),
    }))
}

/// POST /api/resource-download/cancel-batch
async fn cancel_batch(
    State(state): State<SharedState>,
    Json(req): Json<CancelBatchRequest>,
) -> ApiResult<Json<StatusResponse>> {
    let mut ids: Vec<TaskId> = Vec::with_capacity(req.task_ids.len());
    for raw in &req.task_ids {
        if let Ok(id) = raw.parse::<TaskId>() {
            ids.push(id);
        }
    }
    for id in ids {
        let _ = state.download_manager.load_full().cancel(id).await;
    }
    Ok(Json(StatusResponse {
        status: "cancelled".to_string(),
    }))
}

// =====================================================================
// Helpers
// =====================================================================

/// Detect CurseForge download hosts so the x-api-key header is attached.
///
/// **按解析后的 host 判定，不做整串子串匹配**：`x-api-key` 是真实凭据，子串匹配会
/// 让 `http://evil.example/?x=curseforge.com` 这类 URL 命中并把密钥发给任意主机
/// （凭据外泄）。只接受域名本身或其子域（`mediafilez.forgecdn.net` 命中，
/// `evil-forgecdn.net.attacker.com` 不命中）。
///
/// R6 修：`pub(crate)` — `instance_files` 的 mod 下载（install / change-version）
/// 复用同一判定，避免两处各维护一份域名列表而漂移。
pub(crate) fn is_cf_url(url: &str) -> bool {
    const CF_DOMAINS: &[&str] = &["forgecdn.net", "curseforge.com"];
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    CF_DOMAINS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

// =====================================================================
// Local file classification (drag-and-drop install entry)
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyFileRequest {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyFileResponse {
    /// `modpack` | `mod` | `resourcepack` | `shaderpack` | `unknown`
    file_type: String,
    file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pack_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    game_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    /// 文件字节数：前端据此给大型整合包的导入请求分级放宽超时（issue #119）。
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
}

/// POST /api/resource/classify-file — sniff a local file dropped onto the
/// launcher window and report its installable type plus modpack preview
/// metadata (name / game version / loader) for the confirm dialog.
///
/// Zip contents decide between the flavours: modpack markers first
/// (`qmodpack.index.json`, `modrinth.index.json`, CF `manifest.json` with
/// `manifestType == minecraftModpack`), then the `shaders/` layout, then a
/// root `pack.mcmeta`.
async fn classify_file(
    Json(req): Json<ClassifyFileRequest>,
) -> ApiResult<Json<ClassifyFileResponse>> {
    let path = PathBuf::from(req.path.trim());
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("CLASSIFY_PATH_INVALID", "Invalid file path"))?;
    // 存在性与大小用同一次 stat：is_file() 与 metadata() 分成两次系统调用会多一次
    // 磁盘查找，还多一个「检查后文件被移走」的窗口。
    let file_size = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => Some(m.len()),
        _ => {
            return Err(ApiError::not_found("FILE_NOT_FOUND", "File does not exist"));
        }
    };
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let (file_type, meta) = match ext.as_str() {
        "jar" | "litemod" => ("mod", None),
        "zip" | "mrpack" => classify_zip(&path, ext == "mrpack"),
        _ => ("unknown", None),
    };
    let meta = meta.unwrap_or_default();

    Ok(Json(ClassifyFileResponse {
        file_type: file_type.to_string(),
        file_name,
        pack_name: meta.name,
        game_version: meta.game_version,
        loader: meta.loader,
        summary: meta.summary,
        file_size,
    }))
}

#[derive(Default)]
struct PackMeta {
    name: Option<String>,
    game_version: Option<String>,
    loader: Option<String>,
    summary: Option<String>,
}

fn classify_zip(path: &Path, is_mrpack_ext: bool) -> (&'static str, Option<PackMeta>) {
    let Ok(file) = std::fs::File::open(path) else {
        return ("unknown", None);
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return ("unknown", None);
    };

    let mut has_mr = false;
    let mut has_qml = false;
    let mut has_cf_manifest = false;
    let mut has_mmc = false;
    let mut has_shaders = false;
    let mut has_mcmeta = false;
    // mmc-pack.json 的完整条目名（可能是 `xxx/mmc-pack.json`）：探测时顺手记下，
    // 免得 multimc_pack_meta 再走一遍全表、重复一份匹配规则。
    let mut mmc_entry: Option<String> = None;
    // 条目探测只读中央目录（file_names 不触发逐条目本地头读取）：GTNH 这类 1.6 万
    // 条目的包，by_index() 逐条目 seek 会让 classify 退化成上万次随机读（issue #119）。
    // 代价是「探测」与「可读性」解耦：本地头损坏的条目以前会被 by_index() skip、整个包落到
    // 别的分类或 unknown；现在它仍会被探测到并归类（例如 modpack），classify 带着缺失的元数据
    // 成功返回，真正的失败由随后的解析/安装处以明确错误报告——比误分类成 unknown 更好排查。
    for name in archive.file_names() {
        match name {
            "modrinth.index.json" => has_mr = true,
            "qmodpack.index.json" => has_qml = true,
            "manifest.json" => has_cf_manifest = true,
            "pack.mcmeta" => has_mcmeta = true,
            n if n == "mmc-pack.json" || n.ends_with("/mmc-pack.json") => {
                has_mmc = true;
                mmc_entry.get_or_insert_with(|| n.to_string());
            }
            _ => {}
        }
        if name.starts_with("shaders/") {
            has_shaders = true;
        }
    }

    // Modpack markers win. A stray `manifest.json` without the CF
    // manifestType is not a modpack and falls through to the other flavours.
    if has_mr || (is_mrpack_ext && !has_qml) {
        return (
            "modpack",
            Some(pack_meta_from(
                &mut archive,
                "modrinth.index.json",
                "modrinth",
            )),
        );
    }
    if has_qml {
        return (
            "modpack",
            Some(pack_meta_from(
                &mut archive,
                "qmodpack.index.json",
                "modrinth",
            )),
        );
    }
    if has_cf_manifest && is_cf_modpack_manifest(&mut archive) {
        return (
            "modpack",
            Some(pack_meta_from(&mut archive, "manifest.json", "curseforge")),
        );
    }
    if has_mmc {
        return (
            "modpack",
            multimc_pack_meta(&mut archive, mmc_entry.as_deref()),
        );
    }

    if has_shaders {
        return ("shaderpack", None);
    }
    if has_mcmeta {
        return ("resourcepack", None);
    }
    ("unknown", None)
}

fn is_cf_modpack_manifest(archive: &mut zip::ZipArchive<std::fs::File>) -> bool {
    read_entry_json(archive, "manifest.json")
        .and_then(|v| {
            v.get("manifestType")
                .and_then(|t| t.as_str())
                .map(String::from)
        })
        .as_deref()
        == Some("minecraftModpack")
}

/// MultiMC 整合包预览元数据：name 取自 instance.cfg 的 `name=`，
/// game_version/loader 取自 mmc-pack.json 的 components。
/// 实例根以 mmc-pack.json 所在目录为准（根级或嵌套顶层实例目录，如 MultiMC 导出）。
fn multimc_pack_meta(
    archive: &mut zip::ZipArchive<std::fs::File>,
    mmc_entry: Option<&str>,
) -> Option<PackMeta> {
    // classify_zip 已把 mmc-pack.json 的条目名带过来；没带（直接调用）时只读中央目录
    // 找一遍，避免 by_index() 逐条目 seek（issue #119）。
    let mmc_path = match mmc_entry {
        Some(p) => p.to_string(),
        None => archive
            .file_names()
            .find(|n| *n == "mmc-pack.json" || n.ends_with("/mmc-pack.json"))?
            .to_string(),
    };

    let prefix = mmc_path.strip_suffix("mmc-pack.json").unwrap_or_default();
    let cfg_path = format!("{prefix}instance.cfg");

    let mut name = None;
    if let Ok(mut f) = archive.by_name(&cfg_path) {
        let mut text = String::new();
        if std::io::Read::read_to_string(&mut f, &mut text).is_ok() {
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("name=") {
                    let v = v.trim();
                    if !v.is_empty() {
                        name = Some(v.to_string());
                    }
                    break;
                }
            }
        }
    }
    let root = read_entry_json(archive, &mmc_path)?;
    let components = root.get("components").and_then(|c| c.as_array());
    let game_version = components
        .and_then(|cs| {
            cs.iter()
                .find(|c| c.get("uid").and_then(|u| u.as_str()) == Some("net.minecraft"))
        })
        .and_then(|c| str_field(c, "version"));
    let loader = components.and_then(|cs| {
        for c in cs {
            let uid = c.get("uid").and_then(|u| u.as_str()).unwrap_or("");
            let n = match uid {
                "net.fabricmc.fabric-loader" => Some("fabric".to_string()),
                "org.quiltmc.quilt-loader" => Some("quilt".to_string()),
                "net.minecraftforge" | "net.minecraftforge.forge" => Some("forge".to_string()),
                "net.neoforged" => Some("neoforge".to_string()),
                _ => None,
            };
            if n.is_some() {
                return n;
            }
        }
        None
    });
    Some(PackMeta {
        name,
        game_version,
        loader,
        summary: None,
    })
}

fn pack_meta_from(
    archive: &mut zip::ZipArchive<std::fs::File>,
    marker: &str,
    kind: &str,
) -> PackMeta {
    let Some(root) = read_entry_json(archive, marker) else {
        return PackMeta::default();
    };
    if kind == "curseforge" {
        let mc = root.get("minecraft");
        PackMeta {
            name: str_field(&root, "name"),
            game_version: mc.and_then(|m| str_field(m, "version")),
            loader: mc
                .and_then(|m| m.get("modLoaders"))
                .and_then(|l| l.as_array())
                .and_then(|a| a.first())
                .and_then(|l| l.get("id"))
                .and_then(|v| v.as_str())
                .map(|v| short_loader_id(v.to_string())),
            summary: None,
        }
    } else {
        // Modrinth index: `dependencies` maps {minecraft, fabric-loader, ...};
        // qmodpack.index.json keeps a compatible shape when present.
        let deps = root.get("dependencies").and_then(|d| d.as_object());
        PackMeta {
            name: str_field(&root, "name"),
            game_version: deps
                .and_then(|d| d.get("minecraft"))
                .and_then(|v| v.as_str())
                .map(String::from),
            loader: deps
                .and_then(|d| d.keys().find(|k| k.as_str() != "minecraft").cloned())
                .map(short_loader_id),
            summary: str_field(&root, "summary"),
        }
    }
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

fn short_loader_id(id: String) -> String {
    match id.as_str() {
        "fabric-loader" => "fabric".to_string(),
        "quilt-loader" => "quilt".to_string(),
        _ => id.split('-').next().unwrap_or(&id).to_string(),
    }
}

fn read_entry_json(
    archive: &mut zip::ZipArchive<std::fs::File>,
    entry_name: &str,
) -> Option<serde_json::Value> {
    let mut f = archive.by_name(entry_name).ok()?;
    serde_json::from_reader(&mut f).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_zip(tag: &str, entries: &[(&str, &str)]) -> PathBuf {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("qomicex-classify-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pack.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, content) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    /// 只读中央目录的探测必须仍然认出 MultiMC 包，且 `multimc_pack_meta` 能从嵌套目录
    /// 取到 instance.cfg 的 name 与 mmc-pack.json 的 components（by_index → file_names 的
    /// 替换没有行为回归，issue #119）。
    #[test]
    fn classify_zip_detects_multimc_pack_metadata() {
        let path = write_zip(
            "multimc",
            &[
                (
                    "GT New Horizons 2.9.0-RC-1/mmc-pack.json",
                    r#"{"components":[{"uid":"net.minecraft","version":"1.7.10"},{"uid":"net.minecraftforge","version":"10.13.4.1614"}]}"#,
                ),
                (
                    "GT New Horizons 2.9.0-RC-1/instance.cfg",
                    "name=GTNH 2.9.0-RC-1\n",
                ),
                ("GT New Horizons 2.9.0-RC-1/.minecraft/mods/a.jar", "x"),
            ],
        );
        let (kind, meta) = classify_zip(&path, false);
        assert_eq!(kind, "modpack");
        let meta = meta.expect("MultiMC 预览元数据");
        assert_eq!(meta.name.as_deref(), Some("GTNH 2.9.0-RC-1"));
        assert_eq!(meta.game_version.as_deref(), Some("1.7.10"));
        assert_eq!(meta.loader.as_deref(), Some("forge"));
    }

    /// 各 flavor 的标识都要认出来：Modrinth / CurseForge / shaderpack / resourcepack，
    /// 以及没有任何标识时回落 unknown。
    #[test]
    fn classify_zip_detects_all_markers() {
        let mrpack = write_zip(
            "mrpack",
            &[(
                "modrinth.index.json",
                r#"{"game":"minecraft","name":"MR","versionId":"1","dependencies":{"minecraft":"1.20.1","fabric-loader":"0.15.0"},"files":[]}"#,
            )],
        );
        let (kind, meta) = classify_zip(&mrpack, false);
        assert_eq!(kind, "modpack");
        assert_eq!(meta.and_then(|m| m.game_version).as_deref(), Some("1.20.1"));

        let cf = write_zip(
            "cf",
            &[(
                "manifest.json",
                r#"{"manifestType":"minecraftModpack","name":"CF","minecraft":{"version":"1.19.2","modLoaders":[{"id":"forge-43.2.0"}]}}"#,
            )],
        );
        assert_eq!(classify_zip(&cf, false).0, "modpack");

        let shader = write_zip("shader", &[("shaders/shadoc.json", "{}")]);
        assert_eq!(classify_zip(&shader, false).0, "shaderpack");

        let rp = write_zip("rp", &[("pack.mcmeta", "{}")]);
        assert_eq!(classify_zip(&rp, false).0, "resourcepack");

        let none = write_zip("none", &[("readme.txt", "hi")]);
        assert_eq!(classify_zip(&none, false).0, "unknown");
    }

    /// **安全回归**：`is_cf_url` 决定是否把配置的 CurseForge `x-api-key` 发给目标主机。
    /// 早期实现是整串 `contains` 子串匹配，攻击者用一个域名只是「出现在 URL 文本里」的
    /// 无关地址（如 `http://evil.example/?ref=curseforge.com`）即可骗取凭据。
    /// 必须按解析后的 host 判定：只有域名本身或其子域才算。
    #[test]
    fn is_cf_url_matches_only_real_cf_hosts() {
        // 真域名与子域 → 命中（需要带 key）
        assert!(is_cf_url(
            "https://mediafilez.forgecdn.net/files/1234/5678/mod.jar"
        ));
        assert!(is_cf_url("https://edge.forgecdn.net/a.jar"));
        assert!(is_cf_url("https://forgecdn.net/a.jar"));
        assert!(is_cf_url("https://www.curseforge.com/a"));
        assert!(is_cf_url("https://curseforge.com/a"));
        // 大小写不敏感
        assert!(is_cf_url("https://EDGE.ForgeCDN.net/a.jar"));
    }

    /// **安全回归（凭据外泄）**：这些 URL 在旧的子串实现下会命中并把 `x-api-key`
    /// 发给攻击者控制的主机。修复后必须全部判为「非 CF」。
    #[test]
    fn is_cf_url_rejects_lookalikes_and_embedded_domains() {
        let attackers = [
            // 域名只出现在 query / path / fragment 中 —— 目标主机与 CF 无关
            "http://evil.example/?ref=curseforge.com",
            "http://evil.example/curseforge.com/x.jar",
            "http://evil.example/#forgecdn.net",
            // 作为子串出现在攻击者域名中间
            "http://evil-curseforge.com.attacker.net/x.jar",
            "http://curseforge.com.attacker.net/x.jar",
            "http://forgecdn.net.attacker.net/x.jar",
            // 后缀伪装（不是合法的 `.forgecdn.net` 子域边界）
            "http://notforgecdn.net/x.jar",
            "http://mycurseforge.com/x.jar",
            // 非法 URL 一律不命中
            "not a url",
            "curseforge.com",
            "",
        ];
        for url in attackers {
            assert!(
                !is_cf_url(url),
                "该 URL 不得被判为 CurseForge 主机（否则会泄露 x-api-key）: {url}"
            );
        }
    }

    // =================================================================
    // #162 地图存档解压
    // =================================================================

    /// 只有 `.zip` 需要解压，且**大小写不敏感**。
    ///
    /// 关键反例：`.jar`（模组本体）、`.mrpack`、`.json`（FTB 导出）都不是 zip
    /// 存档，解压会破坏文件；而 `.ZIP` 必须在 Windows 上同样识别。
    #[test]
    fn is_zip_path_only_matches_zip_case_insensitively() {
        for yes in ["a.zip", "world.ZIP", "World.Zip", "C:/games/saves/x.zip"] {
            assert!(is_zip_path(Path::new(yes)), "{yes:?} 应被识别为 zip");
        }
        for no in [
            "mod.jar",
            "pack.mrpack",
            "export.json",
            "zip",
            ".zipx",
            "a.zip.txt",
            "a.zi",
            "",
        ] {
            assert!(!is_zip_path(Path::new(no)), "{no:?} 不应被识别为 zip");
        }
    }

    /// 解压意图的登记/取出/清除语义（map 行为直接决定会不会解压错文件）。
    ///
    /// 取出即消费：第二次必须拿不到，否则重试/重启会重复解压。
    #[test]
    fn extract_intent_is_single_shot_and_clearable() {
        let id: TaskId = 987_654_321;
        let intent = ExtractIntent::World {
            zip: PathBuf::from("C:/x/world.zip"),
            saves_dir: PathBuf::from("C:/x/saves"),
            world_name: "MyMap".to_string(),
        };
        extract_intents().lock().unwrap().insert(id, intent.clone());

        let got = extract_intents().lock().unwrap().remove(&id);
        assert!(matches!(got, Some(ExtractIntent::World { .. })));
        assert!(
            extract_intents().lock().unwrap().remove(&id).is_none(),
            "意图取出后必须已被消费"
        );

        // 再次登记后清除（模拟下载失败/取消）：不能再残留。
        extract_intents().lock().unwrap().insert(id, intent);
        extract_intents().lock().unwrap().remove(&id);
        assert!(extract_intents().lock().unwrap().remove(&id).is_none());
    }

    /// 存档名合法性在端点层被前置校验（它会成为 saves/ 下的目录名）。
    #[test]
    fn resolve_world_target_rejects_bad_names() {
        let dir = PathBuf::from("C:/saves");
        assert!(resolve_world_target(&dir, "../evil").is_err());
        assert!(resolve_world_target(&dir, "a/b").is_err());
        assert!(resolve_world_target(&dir, "   ").is_err());
        let (saves, name) = resolve_world_target(&dir, "  My World ").unwrap();
        assert_eq!(saves, dir);
        assert_eq!(name, "My World");
    }

    /// **回归**：`worldName` 出现就必须走地图语义，空白值返回 400 而不是
    /// 悄悄退回「解到 saves/ 根」。
    ///
    /// 退回去的后果正是 #162 要修的坏布局（`level.dat` 摊在 `saves/` 下、
    /// 游戏认不出），而且用户不会收到任何提示——比直接报错更难排查。
    #[test]
    fn blank_world_name_is_rejected_not_downgraded() {
        let dir = PathBuf::from("C:/saves");
        for blank in ["", "   ", "\t"] {
            assert!(
                resolve_world_target(&dir, blank).is_err(),
                "{blank:?} 必须被拒绝（不得降级为通用解压）"
            );
        }
    }

    /// `extract` 是可选字段：老客户端（不带该字段）必须仍能反序列化，
    /// 且默认 **false** —— 不能让所有普通下载都变成解压。
    #[test]
    fn download_to_request_extract_defaults_to_false() {
        let legacy: DownloadToRequest =
            serde_json::from_str(r#"{"url":"https://x/a.jar","targetPath":"C:/m/a.jar"}"#).unwrap();
        assert!(!legacy.extract, "缺省必须不解压");

        let on: DownloadToRequest = serde_json::from_str(
            r#"{"url":"https://x/w.zip","targetPath":"C:/s/w.zip","extract":true}"#,
        )
        .unwrap();
        assert!(on.extract);

        // worldName 缺省为 None（普通解压/不解压），给定时按地图语义处理。
        assert!(legacy.world_name.is_none());
        let world: DownloadToRequest = serde_json::from_str(
            r#"{"url":"https://x/w.zip","targetPath":"C:/s/w.zip","extract":true,"worldName":"MyMap"}"#,
        )
        .unwrap();
        assert_eq!(world.world_name.as_deref(), Some("MyMap"));
    }
}
