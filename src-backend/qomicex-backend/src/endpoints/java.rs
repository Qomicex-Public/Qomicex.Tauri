//! Java 端点（对应源 Endpoints/JavaEndpoints.cs + Services/JavaRuntimeStore.cs + Services/JavaDownloadService.cs）。
//!
//! 挂 `/api/java`，含搜索 / 自定义运行时持久化 / 合并列表 / 校验 / 需求版本 /
//! 推荐 / 下载（目录 + 任务状态，内存实现，不真实下载）。
//!
//! 自包含切片：自定义运行时与下载服务均为本文件私有 struct。核心能力经
//! `qomicex_core::api::java::JavaProvider`（`AppState.core.java_provider()`）调用。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use qomicex_downloader::{DownloadEvent, DownloadManager, DownloadTask, TaskState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use qomicex_core::core::GameCore;
use qomicex_core::models::java::{
    JavaArchitecture, JavaDownloadSource, JavaPackageType, JavaPlatform, JavaResult,
    JavaSearchMode, JavaSearchOptions, JavaState, JavaType,
};
use qomicex_core::models::version_metadata::{CompleteVersionMetadata, JavaVersion};

use crate::error::{ApiError, ApiResult};
use crate::state::SharedState;

/// 模块私有聚合状态（构造时组装，替代 DI 注入）。
struct JavaStateData {
    core: Arc<GameCore>,
    store: Arc<JavaRuntimeStore>,
    download: Arc<JavaDownloadService>,
}

/// Quick 模式扫描本机 Java（对应 C# launch 流程里 `store.GetMergedAsync(Quick)`
/// 的扫描部分；调用方拿结果走 `recommand`）。
pub(crate) async fn scan_quick(core: Arc<GameCore>) -> Vec<JavaResult> {
    let provider = core.java_provider();
    let options = JavaSearchOptions {
        mode: JavaSearchMode::Quick,
        ..Default::default()
    };
    match provider.search(&options).await {
        Ok(r) => r,
        Err(_) => Vec::new(),
    }
}

/// 与 Java 管理页一致的合并运行时列表（Quick 扫描 + 下载目录 + 自定义注册），
/// 供安装等需要按版本选 Java 的场景复用，避免各自再全盘扫描。返回 `JavaResult`
/// 供 `recommand` 使用。
pub(crate) async fn merged_java_runtimes(core: &Arc<GameCore>) -> Vec<JavaResult> {
    let store = JavaRuntimeStore::new(core.clone());
    store
        .get_merged(JavaSearchMode::Quick)
        .await
        .into_iter()
        .filter_map(dto_to_result)
        .collect()
}

/// `JavaRuntimeDto` → `JavaResult`（`From<JavaResult> for JavaRuntimeDto` 的逆变换）。
fn dto_to_result(dto: JavaRuntimeDto) -> Option<JavaResult> {
    Some(JavaResult {
        path: dto.path,
        major_version: dto.major_version,
        version: dto.version,
        state: match dto.state.as_str() {
            "Valid" => JavaState::Valid,
            "InvalidPath" => JavaState::InvalidPath,
            "MissingReleaseFile" => JavaState::MissingReleaseFile,
            "CorruptedReleaseFile" => JavaState::CorruptedReleaseFile,
            _ => JavaState::UnknownError,
        },
        arch: dto.arch,
        r#type: match dto.r#type.as_str() {
            "JDK" => JavaType::JDK,
            "JRE" => JavaType::JRE,
            _ => JavaType::Unknown,
        },
        discovered_by: dto.discovered_by.unwrap_or_default(),
        name: dto.name,
    })
}

/// 进程级单例（OnceLock）：Java 状态在首次 handler 触发时按 `SharedState.core` 惰性组装。
static JAVA_STATE: OnceLock<Arc<JavaStateData>> = OnceLock::new();

fn java_data(shared: &SharedState) -> Arc<JavaStateData> {
    JAVA_STATE
        .get_or_init(|| {
            let core = shared.core.clone();
            let store = JavaRuntimeStore::new(core.clone());
            Arc::new(JavaStateData {
                core: core.clone(),
                store: store.clone(),
                download: JavaDownloadService::new(
                    core,
                    store,
                    shared.download_manager.load_full(),
                ),
            })
        })
        .clone()
}

/// 自定义 Java 运行时持久化（对应 Services/JavaRuntimeStore.cs）。
///
/// 落盘路径：`{BaseDir}/QML/java-runtimes.json`，内容为路径列表。
/// 线程安全：文件读写用互斥锁保护；异步 search 在校验时于锁外执行。
struct JavaRuntimeStore {
    core: Arc<GameCore>,
    file_path: PathBuf,
    file_lock: Mutex<()>,
}

impl JavaRuntimeStore {
    fn new(core: Arc<GameCore>) -> Arc<Self> {
        let data_dir = table_base_dir();
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("java-runtimes.json");
        Arc::new(Self {
            core,
            file_path,
            file_lock: Mutex::new(()),
        })
    }

    fn load_entries(&self) -> Vec<StoredJavaRuntime> {
        let _guard = self.file_lock.lock().unwrap();
        if !self.file_path.exists() {
            return Vec::new();
        }
        match std::fs::read_to_string(&self.file_path) {
            Ok(json) => match serde_json::from_str::<Vec<StoredJavaRuntime>>(&json) {
                Ok(entries) => entries
                    .into_iter()
                    .filter(|e| !e.path.trim().is_empty())
                    .map(|e| StoredJavaRuntime {
                        path: full_path(&e.path.trim()),
                    })
                    .fold(Vec::new(), |mut acc, e| {
                        if !acc.iter().any(|x| path_eq(&x.path, &e.path)) {
                            acc.push(e);
                        }
                        acc
                    }),
                Err(_) => Vec::new(),
            },
            Err(_) => Vec::new(),
        }
    }

    fn save_entries(&self, entries: &[StoredJavaRuntime]) {
        let _guard = self.file_lock.lock().unwrap();
        if let Some(parent) = self.file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string(entries).unwrap_or_else(|_| "[]".to_string());
        let _ = std::fs::write(&self.file_path, json);
    }

    /// 校验并返回全部已存自定义运行时（对应 GetCustomAsync，DiscoveredBy="Custom"）。
    async fn get_custom(&self) -> Vec<JavaRuntimeDto> {
        let entries = self.load_entries();
        let mut results = Vec::new();
        for entry in entries {
            if let Some(runtime) = self.validate_path(&entry.path).await {
                results.push(with_discovered_by(runtime, "Custom"));
            }
        }
        results
    }

    /// 添加自定义运行时（对应 AddCustomAsync）。
    async fn add_custom(&self, path: String) -> ApiResult<JavaRuntimeDto> {
        let normalized = full_path(&path.trim());
        let runtime = self.validate_path(&normalized).await.ok_or_else(|| {
            ApiError::not_found("JAVA_RUNTIME_NOT_FOUND", "无法识别该路径下的 Java 运行时")
        })?;

        let mut entries = self.load_entries();
        if !entries.iter().any(|e| path_eq(&e.path, &normalized)) {
            entries.push(StoredJavaRuntime { path: normalized });
            self.save_entries(&entries);
        }
        Ok(with_discovered_by(runtime, "Custom"))
    }

    /// 移除自定义运行时（对应 RemoveCustomAsync）。
    async fn remove_custom(&self, path: String) {
        let normalized = full_path(&path.trim());
        let mut entries = self.load_entries();
        let before = entries.len();
        entries.retain(|e| !path_eq(&e.path, &normalized));
        if entries.len() != before {
            self.save_entries(&entries);
        }
    }

    /// 扫描 + 下载目录 + 自定义合并（对应 GetMergedAsync）。
    async fn get_merged(&self, mode: JavaSearchMode) -> Vec<JavaRuntimeDto> {
        let options = JavaSearchOptions {
            mode,
            ..Default::default()
        };
        let scanned = self.search_provider(&options).await;
        let mut merged: HashMap<String, JavaRuntimeDto> = HashMap::new();
        for r in scanned {
            merged.insert(full_path(&r.path), JavaRuntimeDto::from(r));
        }
        for r in self.scan_java_download_dir().await {
            merged.entry(full_path(&r.path)).or_insert(r);
        }
        for r in self.get_custom().await {
            merged.insert(full_path(&r.path), r);
        }
        merged.into_values().collect()
    }

    /// 扫描下载目录下的已装运行时（对应 ScanJavaDownloadDirAsync，DiscoveredBy="DownloadDir"）。
    async fn scan_java_download_dir(&self) -> Vec<JavaRuntimeDto> {
        let dir = java_download_dir();
        if !dir.exists() {
            return Vec::new();
        }
        let java_name: &str = if cfg!(windows) { "java.exe" } else { "java" };
        let mut results = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let mut found = Vec::new();
        collect_files_recursive(&dir, &mut found);
        for file in found {
            let is_java_exe = file
                .file_name()
                .map(|n| n.to_string_lossy().as_ref() == java_name)
                .unwrap_or(false);
            if !is_java_exe {
                continue;
            }
            let Some(java_home) = file.parent().and_then(|b| b.parent()) else {
                continue;
            };
            if java_home.as_os_str().is_empty() {
                continue;
            }
            let options = JavaSearchOptions {
                mode: JavaSearchMode::Custom,
                custom_root_path: Some(java_home.to_string_lossy().into_owned()),
                scan_hidden_folders: true,
                max_depth: 5,
                max_results: 50,
                ..Default::default()
            };
            for r in self.search_provider(&options).await {
                if !seen.iter().any(|p| path_eq(p, &r.path)) {
                    seen.push(r.path.clone());
                    results.push(with_discovered_by(JavaRuntimeDto::from(r), "DownloadDir"));
                }
            }
        }
        results
    }

    /// 校验单一路径（对应 ValidatePathAsync，Custom 模式 root=父父目录）。
    ///
    /// 兼容目录输入：传入 java 安装根目录（如 `...\jre-legacy` 或
    /// `...\.minecraft\runtime\java-runtime-alpha`）时自动定位 `bin/java(.exe)`
    /// 再校验（C# 原版仅支持 exe 文件路径；目录输入在手动添加场景常见）。
    async fn validate_path(&self, java_path: &str) -> Option<JavaRuntimeDto> {
        let java_path = full_path(java_path);
        let java_path = resolve_java_executable(&java_path)?;
        let java_home = Path::new(&java_path)
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_string_lossy().into_owned())?;
        if java_home.is_empty() {
            return None;
        }
        let options = JavaSearchOptions {
            mode: JavaSearchMode::Custom,
            custom_root_path: Some(java_home),
            scan_hidden_folders: true,
            max_depth: 2,
            max_results: 20,
            ..Default::default()
        };
        let results = self.search_provider(&options).await;
        results
            .into_iter()
            .map(JavaRuntimeDto::from)
            .find(|r| path_eq(&full_path(&r.path), &java_path))
    }

    /// 调用核心 JavaProvider.search，失败返回空（对应 C# `catch {}` 语义）。
    async fn search_provider(&self, options: &JavaSearchOptions) -> Vec<JavaResult> {
        let provider = self.core.java_provider();
        match provider.search(options).await {
            Ok(r) => r,
            Err(e) => {
                log_download_dir_error(&format!("Java search failed: {e}"));
                Vec::new()
            }
        }
    }
}

/// Java 下载服务（对应 Services/JavaDownloadService.cs）。
///
/// 任务状态为内存字典；落盘目录 `{BaseDir}/QML/Runtime/Java`。
/// 真实管线：queued → resolving → downloading（共享 `DownloadManager`，
/// 暂停/取消/进度与下载中心同一通道）→ extracting → registering
/// （自动写入自定义运行时列表）→ completed。
struct JavaDownloadService {
    core: Arc<GameCore>,
    store: Arc<JavaRuntimeStore>,
    manager: Arc<DownloadManager>,
    tasks: Mutex<HashMap<String, JavaDownloadTaskState>>,
}

impl JavaDownloadService {
    fn new(
        core: Arc<GameCore>,
        store: Arc<JavaRuntimeStore>,
        manager: Arc<DownloadManager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            core,
            store,
            manager,
            tasks: Mutex::new(HashMap::new()),
        })
    }

    fn get_catalog(&self) -> JavaDownloadCatalogResponse {
        let host = host_platform();
        JavaDownloadCatalogResponse {
            vendors: vec![
                JavaDownloadVendorInfo {
                    id: "temurin".into(),
                    name: "Temurin".into(),
                    platforms: vec![host.clone()],
                    architectures: vec!["x64".into(), "arm64".into(), "x86".into()],
                    versions: vec![8, 11, 17, 21, 25],
                    is_recommended: Some(true),
                },
                JavaDownloadVendorInfo {
                    id: "zulu".into(),
                    name: "Zulu".into(),
                    platforms: vec![host],
                    architectures: vec!["x64".into(), "arm64".into(), "x86".into()],
                    versions: vec![8, 11, 17, 21, 25],
                    is_recommended: None,
                },
            ],
        }
    }

    async fn start(
        self: &Arc<Self>,
        request: JavaDownloadStartRequest,
    ) -> ApiResult<JavaDownloadStartResponse> {
        let host = host_platform();
        if !request.platform.eq_ignore_ascii_case(&host) {
            return Err(ApiError::bad_request(
                "JAVA_DOWNLOAD_PLATFORM_NOT_SUPPORTED",
                "首版仅支持下载当前宿主平台的 Java 包",
            ));
        }

        let task_id = new_task_id();
        let target_dir = java_download_dir()
            .join(&request.vendor)
            .join(request.version.to_string())
            .join(format!("{}-{}", request.platform, request.architecture))
            .to_string_lossy()
            .into_owned();

        self.tasks.lock().unwrap().insert(
            task_id.clone(),
            JavaDownloadTaskState {
                task_id: task_id.clone(),
                status: "queued".into(),
                target_dir: target_dir.clone(),
                ..Default::default()
            },
        );

        let this = self.clone();
        let spawn_task_id = task_id.clone();
        tokio::spawn(async move {
            this.run_task(spawn_task_id, request).await;
        });

        Ok(JavaDownloadStartResponse {
            task_id,
            status: "queued".to_string(),
            target_dir,
        })
    }

    /// 后台任务状态机（对应 C# RunTaskAsync）。
    async fn run_task(self: Arc<Self>, task_id: String, request: JavaDownloadStartRequest) {
        let mut tmp_dir: Option<PathBuf> = None;
        let result = self.run_task_inner(&task_id, request, &mut tmp_dir).await;
        match result {
            Ok(TaskExit::Done) => {}
            Ok(TaskExit::Cancelled) => {
                // 外部 cancel 已置状态，保留不动（防止 extracting 阶段被覆盖）。
            }
            Err(message) => {
                self.update_task(&task_id, |t| {
                    t.status = "failed".into();
                    t.error = Some(message);
                    t.speed = 0.0;
                });
            }
        }
        if let Some(dir) = tmp_dir {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    async fn run_task_inner(
        &self,
        task_id: &str,
        request: JavaDownloadStartRequest,
        tmp_dir: &mut Option<PathBuf>,
    ) -> Result<TaskExit, String> {
        if self.is_cancelled(task_id) {
            return Ok(TaskExit::Cancelled);
        }

        self.set_status(task_id, "resolving");
        let (url, file_name) = resolve_package(&self.core, &request)
            .await
            .map_err(|e| e.message)?;
        if self.is_cancelled(task_id) {
            return Ok(TaskExit::Cancelled);
        }
        self.update_task(task_id, |t| {
            t.file_name = file_name.clone();
            t.download_url = url.clone();
        });

        self.set_status(task_id, "downloading");
        let tmp = java_download_dir().join(".tmp").join(task_id);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        *tmp_dir = Some(tmp.clone());
        let archive_path = tmp.join(&file_name);

        let mut rx = self.manager.subscribe();
        let dl_id = self
            .manager
            .add(DownloadTask::new(url, archive_path.clone()));
        self.update_task(task_id, |t| t.dl_task_id = Some(dl_id));

        loop {
            match rx.recv().await {
                Ok(DownloadEvent::Progress {
                    id,
                    downloaded,
                    total,
                    speed_bps,
                    ..
                }) if id == dl_id => {
                    self.update_task(task_id, |t| {
                        t.progress = if total > 0 {
                            (downloaded as f64 / total as f64) * 100.0
                        } else {
                            0.0
                        };
                        t.speed = speed_bps as f64;
                    });
                }
                Ok(DownloadEvent::StateChanged { id, state, detail }) if id == dl_id => match state
                {
                    TaskState::Completed => break,
                    TaskState::Failed => return Err(detail.unwrap_or_else(|| "下载失败".into())),
                    TaskState::Cancelled => return Ok(TaskExit::Cancelled),
                    TaskState::Paused => {
                        // 外部 pause 已置 java 状态；等待 resume 后事件继续。
                        self.update_task(task_id, |t| t.speed = 0.0);
                    }
                    TaskState::Queued | TaskState::Downloading => {}
                },
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return Err("下载通道已关闭".into()),
            }
        }
        if self.is_cancelled(task_id) {
            return Ok(TaskExit::Cancelled);
        }
        self.update_task(task_id, |t| {
            t.progress = 100.0;
            t.speed = 0.0;
        });

        self.set_status(task_id, "extracting");
        let target_dir = self.target_dir_of(task_id).unwrap_or_default();
        extract_archive(&archive_path, &PathBuf::from(&target_dir), &file_name)?;
        if self.is_cancelled(task_id) {
            return Ok(TaskExit::Cancelled);
        }

        self.set_status(task_id, "registering");
        let java_exe = find_java_executable(Path::new(&target_dir))
            .ok_or_else(|| "解压后未找到 Java 可执行文件".to_string())?;
        self.store
            .add_custom(java_exe)
            .await
            .map_err(|e| e.message)?;

        self.update_task(task_id, |t| {
            t.progress = 100.0;
            t.speed = 0.0;
        });
        self.set_status(task_id, "completed");
        Ok(TaskExit::Done)
    }

    fn get_progress(&self, task_id: &str) -> Option<JavaDownloadProgressResponse> {
        let guard = self.tasks.lock().unwrap();
        guard.get(task_id).map(|t| t.progress_response())
    }

    async fn cancel(&self, task_id: &str) -> bool {
        let dl_id = {
            let mut guard = self.tasks.lock().unwrap();
            let Some(t) = guard.get_mut(task_id) else {
                return false;
            };
            t.status = "cancelled".to_string();
            t.speed = 0.0;
            t.dl_task_id
        };
        if let Some(id) = dl_id {
            let _ = self.manager.cancel(id).await;
        }
        true
    }

    async fn pause(&self, task_id: &str) -> bool {
        let dl_id = {
            let mut guard = self.tasks.lock().unwrap();
            let Some(t) = guard.get_mut(task_id) else {
                return false;
            };
            if t.status != "downloading" {
                return false;
            }
            t.status = "paused".to_string();
            t.dl_task_id
        };
        if let Some(id) = dl_id {
            if let Err(e) = self.manager.pause(id).await {
                eprintln!("[JavaDownloadService] pause failed: {e}");
            }
        }
        true
    }

    async fn resume(&self, task_id: &str) -> bool {
        let dl_id = {
            let mut guard = self.tasks.lock().unwrap();
            let Some(t) = guard.get_mut(task_id) else {
                return false;
            };
            if t.status != "paused" {
                return false;
            }
            t.status = "downloading".to_string();
            t.dl_task_id
        };
        if let Some(id) = dl_id {
            if let Err(e) = self.manager.resume(id).await {
                eprintln!("[JavaDownloadService] resume failed: {e}");
            }
        }
        true
    }

    fn get_all_active(&self) -> Vec<JavaDownloadProgressResponse> {
        let guard = self.tasks.lock().unwrap();
        guard
            .values()
            .filter(|t| {
                matches!(
                    t.status.as_str(),
                    "queued"
                        | "resolving"
                        | "downloading"
                        | "paused"
                        | "extracting"
                        | "registering"
                )
            })
            .map(|t| t.progress_response())
            .collect()
    }

    /// 全部任务（含终态），供 `/progress/stream` 推送，前端才能收到 completed。
    fn get_all(&self) -> Vec<JavaDownloadProgressResponse> {
        let guard = self.tasks.lock().unwrap();
        guard.values().map(|t| t.progress_response()).collect()
    }

    // ---------------- 内部 ----------------

    fn set_status(&self, task_id: &str, status: &str) {
        self.update_task(task_id, |t| t.status = status.to_string());
    }

    fn update_task(&self, task_id: &str, f: impl FnOnce(&mut JavaDownloadTaskState)) {
        if let Ok(mut guard) = self.tasks.lock() {
            if let Some(t) = guard.get_mut(task_id) {
                f(t);
            }
        }
    }

    fn is_cancelled(&self, task_id: &str) -> bool {
        self.tasks
            .lock()
            .map(|g| {
                g.get(task_id)
                    .map(|t| t.status == "cancelled")
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn target_dir_of(&self, task_id: &str) -> Option<String> {
        self.tasks
            .lock()
            .map(|g| g.get(task_id).map(|t| t.target_dir.clone()))
            .unwrap_or(None)
    }
}

enum TaskExit {
    Done,
    Cancelled,
}

/// 任务内部状态（对应 C# JavaDownloadTaskState）。
#[derive(Default)]
struct JavaDownloadTaskState {
    task_id: String,
    status: String,
    progress: f64,
    speed: f64,
    file_name: String,
    target_dir: String,
    error: Option<String>,
    #[allow(dead_code)]
    download_url: String,
    dl_task_id: Option<u64>,
}

impl JavaDownloadTaskState {
    fn progress_response(&self) -> JavaDownloadProgressResponse {
        JavaDownloadProgressResponse {
            task_id: self.task_id.clone(),
            status: self.status.clone(),
            progress: self.progress,
            speed: self.speed,
            file_name: self.file_name.clone(),
            target_dir: self.target_dir.clone(),
            error: self.error.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/java/search", get(search))
        .route(
            "/java/custom",
            get(get_custom).post(add_custom).delete(remove_custom),
        )
        .route("/java/list", get(list))
        .route("/java/validate", post(validate))
        .route("/java/requirement", get(requirement))
        .route("/java/recommended", post(recommended))
        .route("/java/download/catalog", get(download_catalog))
        .route("/java/download/start", post(download_start))
        .route("/java/download/progress/{taskId}", get(download_progress))
        .route("/java/download/{taskId}", delete(download_cancel))
        .route("/java/download/{taskId}/pause", post(download_pause))
        .route("/java/download/{taskId}/resume", post(download_resume))
        .route("/java/download/active", get(download_active))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn search(
    State(s): State<SharedState>,
    Query(q): Query<ModeQuery>,
) -> ApiResult<Json<Vec<JavaRuntimeDto>>> {
    let mode = parse_search_mode(q.mode.as_deref())?;
    let options = JavaSearchOptions {
        mode,
        ..Default::default()
    };
    let results = java_data(&s)
        .core
        .java_provider()
        .search(&options)
        .await
        .map_err(map_core_error)?;
    // 合并启动器自带的下载目录（C# 原版只有 /list 合并；前端扫描走 /search，
    // 不加则下载安装的 Java 永远不出现在扫描结果，见 javaStore.scanRuntimes）
    let data = java_data(&s);
    let mut merged: HashMap<String, JavaRuntimeDto> = HashMap::new();
    for r in results {
        merged.insert(full_path(&r.path), JavaRuntimeDto::from(r));
    }
    for r in data.store.scan_java_download_dir().await {
        merged.entry(full_path(&r.path)).or_insert(r);
    }
    Ok(Json(merged.into_values().collect()))
}

async fn get_custom(State(s): State<SharedState>) -> ApiResult<Json<Vec<JavaRuntimeDto>>> {
    Ok(Json(java_data(&s).store.get_custom().await))
}

async fn add_custom(
    State(s): State<SharedState>,
    Json(req): Json<JavaPathRequest>,
) -> ApiResult<Json<JavaRuntimeDto>> {
    Ok(Json(java_data(&s).store.add_custom(req.path).await?))
}

async fn remove_custom(
    State(s): State<SharedState>,
    Json(req): Json<JavaPathRequest>,
) -> ApiResult<StatusCode> {
    java_data(&s).store.remove_custom(req.path).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn list(
    State(s): State<SharedState>,
    Query(q): Query<ModeQuery>,
) -> ApiResult<Json<Vec<JavaRuntimeDto>>> {
    let mode = parse_search_mode(q.mode.as_deref())?;
    Ok(Json(java_data(&s).store.get_merged(mode).await))
}

async fn validate(
    State(s): State<SharedState>,
    Json(req): Json<JavaPathRequest>,
) -> ApiResult<Json<JavaRuntimeDto>> {
    let java_path = full_path(&req.path);
    let Some(java_home) = Path::new(&java_path).parent().and_then(|p| p.parent()) else {
        return Err(ApiError::not_found(
            "JAVA_RUNTIME_NOT_FOUND",
            "无法识别该路径下的 Java 运行时",
        ));
    };
    if java_home.as_os_str().is_empty() {
        return Err(ApiError::not_found(
            "JAVA_RUNTIME_NOT_FOUND",
            "无法识别该路径下的 Java 运行时",
        ));
    }

    let options = JavaSearchOptions {
        mode: JavaSearchMode::Custom,
        custom_root_path: Some(java_home.to_string_lossy().into_owned()),
        scan_hidden_folders: true,
        max_depth: 2,
        max_results: 20,
        ..Default::default()
    };
    let results = java_data(&s)
        .core
        .java_provider()
        .search(&options)
        .await
        .map_err(map_core_error)?;
    let match_path = full_path(&java_path);
    let runtime = results
        .into_iter()
        .find(|r| path_eq(&full_path(&r.path), &match_path))
        .ok_or_else(|| {
            ApiError::not_found("JAVA_RUNTIME_NOT_FOUND", "无法识别该路径下的 Java 运行时")
        })?;
    Ok(Json(JavaRuntimeDto::from(runtime)))
}

async fn requirement(
    Query(q): Query<RequirementQuery>,
) -> ApiResult<Json<JavaRequirementResponse>> {
    let path = Path::new(&q.game_dir)
        .join("versions")
        .join(&q.version)
        .join(format!("{}.json", q.version));
    let required = get_required_java_version(&path)?;
    Ok(Json(JavaRequirementResponse {
        required_major_version: required,
    }))
}

async fn recommended(
    State(s): State<SharedState>,
    Json(req): Json<JavaRecommendRequest>,
) -> ApiResult<Json<JavaRuntimeDto>> {
    let search_options = JavaSearchOptions {
        mode: JavaSearchMode::Quick,
        ..Default::default()
    };
    let java_list = java_data(&s)
        .core
        .java_provider()
        .search(&search_options)
        .await
        .map_err(map_core_error)?;

    let require_java = minecraft_to_java_version(&req.minecraft_version);
    let metadata = CompleteVersionMetadata {
        id: req.minecraft_version,
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
            major_version: require_java,
        }),
        minimum_launcher_version: None,
        release_time: String::new(),
        time: String::new(),
    };

    let recommended = java_data(&s)
        .core
        .java_provider()
        .recommand(&java_list, &metadata)
        .await
        .map_err(map_core_error)?;
    Ok(Json(JavaRuntimeDto::from(recommended)))
}

async fn download_catalog(
    State(s): State<SharedState>,
) -> ApiResult<Json<JavaDownloadCatalogResponse>> {
    Ok(Json(java_data(&s).download.get_catalog()))
}

async fn download_start(
    State(s): State<SharedState>,
    Json(req): Json<JavaDownloadStartRequest>,
) -> ApiResult<Json<JavaDownloadStartResponse>> {
    Ok(Json(java_data(&s).download.start(req).await?))
}

async fn download_progress(
    State(s): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<JavaDownloadProgressResponse>> {
    match java_data(&s).download.get_progress(&task_id) {
        Some(p) => Ok(Json(p)),
        None => Err(ApiError::not_found(
            "JAVA_DOWNLOAD_TASK_NOT_FOUND",
            "Java 下载任务不存在",
        )),
    }
}

async fn download_cancel(
    State(s): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<StatusCode> {
    if java_data(&s).download.cancel(&task_id).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found(
            "JAVA_DOWNLOAD_TASK_NOT_FOUND",
            "Java 下载任务不存在",
        ))
    }
}

async fn download_pause(
    State(s): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<StatusCode> {
    if java_data(&s).download.pause(&task_id).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found(
            "JAVA_DOWNLOAD_TASK_NOT_FOUND",
            "Java 下载任务不存在",
        ))
    }
}

async fn download_resume(
    State(s): State<SharedState>,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<StatusCode> {
    if java_data(&s).download.resume(&task_id).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found(
            "JAVA_DOWNLOAD_TASK_NOT_FOUND",
            "Java 下载任务不存在",
        ))
    }
}

async fn download_active(
    State(s): State<SharedState>,
) -> ApiResult<Json<Vec<JavaDownloadProgressResponse>>> {
    Ok(Json(java_data(&s).download.get_all_active()))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ModeQuery {
    mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequirementQuery {
    game_dir: String,
    version: String,
}

fn parse_search_mode(mode: Option<&str>) -> ApiResult<JavaSearchMode> {
    match mode {
        None => Ok(JavaSearchMode::Quick),
        Some(m) if m.is_empty() || m.eq_ignore_ascii_case("quick") => Ok(JavaSearchMode::Quick),
        Some(m) if m.eq_ignore_ascii_case("deep") => Ok(JavaSearchMode::Deep),
        _ => Err(ApiError::bad_request(
            "JAVA_SEARCH_MODE_INVALID",
            "无效的 Java 搜索模式",
        )),
    }
}

fn minecraft_to_java_version(mc_version: &str) -> i32 {
    let part = match mc_version.split('-').next() {
        Some(s) => s,
        None => return 17,
    };
    let mut segments = part.split('.');
    let major = match next_u32(&mut segments) {
        Some(v) => v,
        None => return 17,
    };
    let minor = match next_u32(&mut segments) {
        Some(v) => v,
        None => return 8,
    };
    let build = match next_u32(&mut segments) {
        Some(v) => v,
        None => 0,
    };

    if major >= 1 && minor >= 21 {
        return 21;
    }
    if major >= 1 && minor >= 20 && build >= 5 {
        return 21;
    }
    if major >= 1 && minor >= 18 {
        return 17;
    }
    if major >= 1 && minor >= 17 {
        return 16;
    }
    if major >= 1 && minor >= 16 {
        return 11;
    }
    8
}

fn next_u32(segments: &mut dyn Iterator<Item = &str>) -> Option<u32> {
    segments.next().and_then(|s| s.parse::<u32>().ok())
}

fn get_required_java_version(json_path: &Path) -> ApiResult<i32> {
    if !json_path.exists() {
        return Err(ApiError::not_found("VERSION_NOT_FOUND", "版本文件不存在"));
    }
    let content = std::fs::read_to_string(json_path)?;
    let node: Value =
        serde_json::from_str(&content).map_err(|e| ApiError::internal(e.to_string()))?;

    if let Some(maj) = node
        .get("javaVersion")
        .and_then(|jv| jv.get("majorVersion"))
        .and_then(Value::as_i64)
    {
        return Ok(maj as i32);
    }
    if let Some(inherits) = node.get("inheritsFrom").and_then(Value::as_str) {
        if let Some(parent_dir) = json_path.parent().and_then(Path::parent) {
            let parent_version_path = parent_dir
                .join("versions")
                .join(inherits)
                .join(format!("{inherits}.json"));
            return get_required_java_version(&parent_version_path);
        }
    }
    Ok(8)
}

async fn resolve_package(
    core: &Arc<GameCore>,
    request: &JavaDownloadStartRequest,
) -> ApiResult<(String, String)> {
    let (source, platform, arch, package_type) = match request.vendor.as_str() {
        "temurin" => (
            JavaDownloadSource::Adoptium,
            map_platform(&request.platform)?,
            map_architecture(&request.architecture)?,
            JavaPackageType::JDK,
        ),
        "zulu" => (
            JavaDownloadSource::Zulu,
            map_platform(&request.platform)?,
            map_architecture(&request.architecture)?,
            JavaPackageType::JDK,
        ),
        _ => {
            return Err(ApiError::not_found(
                "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND",
                "未找到可用的 Java 下载包",
            ))
        }
    };

    let packages = core
        .java_provider()
        .get_packages(request.version, platform, arch, package_type, source)
        .await
        .map_err(map_core_error)?;
    let pkg = packages.into_iter().next().ok_or_else(|| {
        ApiError::not_found(
            "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND",
            "未找到可用的 Java 下载包",
        )
    })?;
    Ok((pkg.download_url, pkg.file_name))
}

fn map_platform(platform: &str) -> ApiResult<JavaPlatform> {
    match platform.to_ascii_lowercase().as_str() {
        "windows" => Ok(JavaPlatform::Windows),
        "linux" => Ok(JavaPlatform::Linux),
        "macos" => Ok(JavaPlatform::MacOS),
        _ => Err(ApiError::bad_request(
            "JAVA_DOWNLOAD_PLATFORM_INVALID",
            "不支持的操作系统平台",
        )),
    }
}

fn map_architecture(arch: &str) -> ApiResult<JavaArchitecture> {
    match arch.to_ascii_lowercase().as_str() {
        "x64" => Ok(JavaArchitecture::X64),
        "arm64" => Ok(JavaArchitecture::Arm64),
        _ => Err(ApiError::bad_request(
            "JAVA_DOWNLOAD_ARCH_INVALID",
            "不支持的 CPU 架构",
        )),
    }
}

fn host_platform() -> String {
    if cfg!(windows) {
        "windows".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else if cfg!(target_os = "macos") {
        "macos".into()
    } else {
        "unknown".into()
    }
}

fn new_task_id() -> String {
    let n = uuid::Uuid::new_v4();
    n.to_string().replace('-', "")[..12].to_string()
}

fn map_core_error(e: qomicex_core::error::Error) -> ApiError {
    ApiError::internal(e.to_string())
}

fn with_discovered_by(mut r: JavaRuntimeDto, discovered_by: &str) -> JavaRuntimeDto {
    r.discovered_by = Some(discovered_by.to_string());
    r
}

fn full_path(p: &str) -> String {
    let path = Path::new(p.trim());
    if path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }
    crate::settings::resolve_base_dir()
        .join(path)
        .to_string_lossy()
        .into_owned()
}

fn path_eq(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        // core 的 normalize_path 统一正斜杠（util/platform.rs），后端 full_path
        // 保留反斜杠 → 比较前归一化分隔符，否则 `C:/a` vs `C:\a` 恒不等（手动添加
        // Java / 下载注册均 404 JAVA_RUNTIME_NOT_FOUND）
        a.replace('\\', "/")
            .eq_ignore_ascii_case(&b.replace('\\', "/"))
    } else {
        a == b
    }
}

/// 路径归一为 java 可执行文件：已是 exe 文件 → 原样；目录 → 递归找
/// `bin/java(.exe)`（validate_path 目录输入兼容）。
fn resolve_java_executable(p: &str) -> Option<String> {
    let path = Path::new(p);
    if path.is_file() {
        return Some(p.to_string());
    }
    if !path.is_dir() {
        return None;
    }
    let java_name: &str = if cfg!(windows) { "java.exe" } else { "java" };
    let mut found = Vec::new();
    collect_files_recursive(path, &mut found);
    found
        .into_iter()
        .find(|f| {
            let name_ok = f
                .file_name()
                .map(|n| n.to_string_lossy().as_ref() == java_name)
                .unwrap_or(false);
            let in_bin = f
                .parent()
                .and_then(|par| par.file_name())
                .map(|n| n.eq_ignore_ascii_case("bin"))
                .unwrap_or(false);
            name_ok && in_bin
        })
        .map(|f| f.to_string_lossy().into_owned())
}

fn collect_files_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// `{BaseDir}/QML`（对应 AppPaths.BaseDir + "QML"）。
fn table_base_dir() -> PathBuf {
    crate::settings::resolve_base_dir().join("QML")
}

/// `{BaseDir}/QML/Runtime/Java`（对应 JavaDownloadService.GetBaseDir）。
fn java_download_dir() -> PathBuf {
    let dir = table_base_dir().join("Runtime").join("Java");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 解压下载包（对应 C# ExtractAsync）：zip 直接解压；tar.gz 解压后补可执行位。
fn extract_archive(archive_path: &Path, target_dir: &Path, file_name: &str) -> Result<(), String> {
    std::fs::create_dir_all(target_dir).map_err(|e| e.to_string())?;
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        archive.extract(target_dir).map_err(|e| e.to_string())
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        archive.unpack(target_dir).map_err(|e| e.to_string())?;
        set_executable_permissions(target_dir);
        Ok(())
    } else {
        Err("当前仅支持 zip / tar.gz 自动解压".to_string())
    }
}

/// unix 下恢复 `bin/java` 的可执行位（tar 解压不保留权限，对应 C# SetExecutablePermissions）。
#[cfg(unix)]
fn set_executable_permissions(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut found = Vec::new();
    collect_files_recursive(root, &mut found);
    for f in found {
        let in_bin = f
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.eq_ignore_ascii_case("bin"))
            .unwrap_or(false);
        if in_bin {
            let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755));
        }
    }
}

#[cfg(not(unix))]
fn set_executable_permissions(_root: &Path) {}

/// 解压结果中定位 `bin/java(.exe)`（对应 C# FindJavaExecutable）。
fn find_java_executable(root: &Path) -> Option<String> {
    let java_name: &str = if cfg!(windows) { "java.exe" } else { "java" };
    let mut found = Vec::new();
    collect_files_recursive(root, &mut found);
    found
        .into_iter()
        .find(|p| {
            let name_ok = p
                .file_name()
                .map(|n| n.to_string_lossy().as_ref() == java_name)
                .unwrap_or(false);
            let in_bin = p
                .parent()
                .and_then(|par| par.file_name())
                .map(|n| n.eq_ignore_ascii_case("bin"))
                .unwrap_or(false);
            name_ok && in_bin
        })
        .map(|p| p.to_string_lossy().into_owned())
}

/// 全部 Java 下载任务快照（含终态），供 `/progress/stream` 推送
/// `javaDownloads` 通道（前端下载中心依赖它推进任务状态）。
pub(crate) fn active_java_download_snapshots() -> Vec<Value> {
    let Some(state) = JAVA_STATE.get() else {
        return Vec::new();
    };
    state
        .download
        .get_all()
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "taskId": p.task_id,
                "status": p.status,
                "progress": p.progress,
                "speed": p.speed,
                "fileName": p.file_name,
                "targetDir": p.target_dir,
                "error": p.error,
            })
        })
        .collect()
}

/// 下载管线未实现时的错误占位（对应 C# Trace.WriteLine 语义）。
fn log_download_dir_error(msg: &str) {
    eprintln!("[JavaEndpoints] {msg}");
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// Java 探测结果响应（复制 core `JavaResult`，但 `state`/`type` 按 C# 后端
/// 全局 `UseStringEnumConverter` 序列化为字符串，`majorVersion` 保持数字），
/// 与前端 `JavaRuntime` 期望一致（`type`/`state` 为 string）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaRuntimeDto {
    path: String,
    major_version: i32,
    version: String,
    state: String,
    arch: String,
    #[serde(rename = "type")]
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    discovered_by: Option<String>,
    name: String,
}

impl From<JavaResult> for JavaRuntimeDto {
    fn from(r: JavaResult) -> Self {
        Self {
            path: r.path,
            major_version: r.major_version,
            version: r.version,
            state: java_state_to_string(r.state),
            arch: r.arch,
            r#type: java_type_to_string(r.r#type),
            discovered_by: Some(r.discovered_by).filter(|s| !s.is_empty()),
            name: r.name,
        }
    }
}

fn java_state_to_string(s: JavaState) -> String {
    match s {
        JavaState::Valid => "Valid".into(),
        JavaState::InvalidPath => "InvalidPath".into(),
        JavaState::MissingReleaseFile => "MissingReleaseFile".into(),
        JavaState::CorruptedReleaseFile => "CorruptedReleaseFile".into(),
        JavaState::UnknownError => "UnknownError".into(),
    }
}

fn java_type_to_string(t: JavaType) -> String {
    match t {
        JavaType::Unknown => "Unknown".into(),
        JavaType::JDK => "JDK".into(),
        JavaType::JRE => "JRE".into(),
    }
}

#[derive(Deserialize)]
struct JavaPathRequest {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JavaRecommendRequest {
    minecraft_version: String,
    #[allow(dead_code)]
    game_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaRequirementResponse {
    required_major_version: i32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredJavaRuntime {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JavaDownloadStartRequest {
    vendor: String,
    version: i32,
    platform: String,
    architecture: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaDownloadStartResponse {
    task_id: String,
    status: String,
    target_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaDownloadProgressResponse {
    task_id: String,
    status: String,
    progress: f64,
    speed: f64,
    file_name: String,
    target_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaDownloadVendorInfo {
    id: String,
    name: String,
    platforms: Vec<String>,
    architectures: Vec<String>,
    versions: Vec<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_recommended: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaDownloadCatalogResponse {
    vendors: Vec<JavaDownloadVendorInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_round_trips_back_to_result() {
        // merged_java_runtimes 依赖 DTO → JavaResult 逆变换；字段必须无损。
        let r = JavaResult {
            path: "/tmp/java17/bin/java".to_string(),
            major_version: 17,
            version: "17.0.11".to_string(),
            state: JavaState::Valid,
            arch: "x64".to_string(),
            r#type: JavaType::JDK,
            discovered_by: "Custom".to_string(),
            name: "Java 17.0.11".to_string(),
        };
        let dto = JavaRuntimeDto::from(r.clone());
        let back = dto_to_result(dto).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn dto_state_and_type_strings_map_back() {
        let r = JavaRuntimeDto {
            path: "/tmp/java8/bin/java".to_string(),
            major_version: 8,
            version: "1.8.0_502".to_string(),
            state: "Valid".to_string(),
            arch: "x64".to_string(),
            r#type: "JRE".to_string(),
            discovered_by: Some("DownloadDir".to_string()),
            name: "Java 1.8.0_502".to_string(),
        };
        let back = dto_to_result(r).unwrap();
        assert_eq!(back.state, JavaState::Valid);
        assert_eq!(back.r#type, JavaType::JRE);
        assert_eq!(back.discovered_by, "DownloadDir");
    }
}
