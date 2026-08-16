//! 导出任务跟踪：`POST /modpack/export` 创建异步导出任务（返回 taskId），
//! `GET /modpack/export/task/{taskId}` 轮询进度，`POST .../cancel` 取消
//! （`AtomicBool` 标志，build_export_zip 在反查批次/逐文件处检查并尽快中断），
//! `GET .../download` 取 zip 字节（未传 targetPath 时的浏览器 fallback）。
//!
//! 产物落盘 `{BaseDir}/temp/export-{taskId}.zip`：
//! - 传了 `targetPath`：任务完成后由后端 `fs::copy` 到目标路径，成功后删除临时文件；
//! - 未传 `targetPath`：临时文件保留，供 `download` 端点读取（读后任务清理）。
//!
//! 任务保留策略：完成/取消/失败后保留最近 [`MAX_RETAINED_TASKS`] 个（最老终态任务
//! 被淘汰），避免无限增长。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use qomicex_core::core::GameCore;
use serde::Serialize;

use crate::services::instance::GameInstance;
use crate::services::modpack_export::{build_export_zip, ExportFormat, ExportProgress};
use crate::settings;

/// 保留的最多终态任务数（超出淘汰最老）。
const MAX_RETAINED_TASKS: usize = 20;

/// 任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportTaskStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// 对外进度快照（`GET /modpack/export/task/{taskId}` 响应）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTaskSnapshot {
    pub task_id: String,
    pub instance_id: String,
    pub status: ExportTaskStatus,
    /// 阶段：lookup / manifest / packing（完成/失败后为最后阶段）。
    pub stage: &'static str,
    /// 总体进度 0-100。
    pub percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct ExportTask {
    task_id: String,
    instance_id: String,
    /// 导出格式（download 端点文件名扩展名依据）。
    format: ExportFormat,
    status: ExportTaskStatus,
    stage: &'static str,
    percent: f64,
    current_file: Option<String>,
    error: Option<String>,
    /// 产物 zip 落盘路径（targetPath 模式复制成功后清除）。
    zip_path: Option<PathBuf>,
    created_at: Instant,
    cancel: Arc<AtomicBool>,
}

/// 格式 → download 文件扩展名。
fn format_ext(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::CurseForge => "zip",
        ExportFormat::Modrinth => "mrpack",
        ExportFormat::Qomicex => "qmodpack",
    }
}

impl ExportTask {
    fn snapshot(&self) -> ExportTaskSnapshot {
        ExportTaskSnapshot {
            task_id: self.task_id.clone(),
            instance_id: self.instance_id.clone(),
            status: self.status,
            stage: self.stage,
            percent: self.percent,
            current_file: self.current_file.clone(),
            error: self.error.clone(),
        }
    }
}

/// 导出任务管理器（挂载 AppState）。
pub struct ExportTaskManager {
    tasks: Mutex<HashMap<String, Arc<Mutex<ExportTask>>>>,
}

impl ExportTaskManager {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }

    /// 创建并启动导出任务，立即返回 taskId。
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        core: &Arc<GameCore>,
        cf_api_key: &str,
        instance: &GameInstance,
        format: ExportFormat,
        include_saves: bool,
        include_screenshots: bool,
        include_files: Option<Vec<String>>,
        name_override: Option<String>,
        version_override: Option<String>,
        author_override: Option<String>,
        target_path: Option<String>,
    ) -> String {
        let task_id = format!("{:x}", uuid::Uuid::new_v4());
        let task = Arc::new(Mutex::new(ExportTask {
            task_id: task_id.clone(),
            instance_id: instance.id.clone(),
            format,
            status: ExportTaskStatus::Running,
            stage: "lookup",
            percent: 0.0,
            current_file: None,
            error: None,
            zip_path: None,
            created_at: Instant::now(),
            cancel: Arc::new(AtomicBool::new(false)),
        }));

        {
            let mut map = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            map.insert(task_id.clone(), task.clone());
            // 淘汰最老终态任务（超上限时）
            while map.len() > MAX_RETAINED_TASKS {
                let oldest_terminal = map
                    .iter()
                    .filter(|(_, t)| {
                        let t = t.lock().unwrap_or_else(|p| p.into_inner());
                        t.status != ExportTaskStatus::Running
                    })
                    .min_by_key(|(_, t)| t.lock().unwrap_or_else(|p| p.into_inner()).created_at)
                    .map(|(k, _)| k.clone());
                match oldest_terminal {
                    Some(k) => {
                        let t = map.remove(&k).expect("key just iterated");
                        let removed = t.lock().unwrap_or_else(|p| p.into_inner()).zip_path.take();
                        if let Some(z) = removed {
                            let _ = std::fs::remove_file(&z);
                        }
                    }
                    None => break,
                }
            }
        }

        let task_for_worker = task.clone();
        let core_c = core.clone();
        let cf_key_c = cf_api_key.to_string();
        let instance_c = instance.clone();
        let base_dir = settings::resolve_base_dir();
        let target_c = target_path.clone();
        let task_id_c = task_id.clone();

        // 独立线程 + 独立 tokio runtime 执行导出：
        // 打包（Deflated 压缩）、落盘 fs::write、fs::copy 都是阻塞 CPU/IO，
        // 若跑在主 runtime 的 worker 上会冻结 HTTP 请求处理（复现：大包导出时
        // 轮询请求排队 10s+，前端 15s 超时）。独立线程让阻塞完全脱离主 runtime。
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().expect("创建导出任务 runtime 失败");
            rt.block_on(async move {
                let cancel = task_for_worker
                    .lock()
                    .unwrap_or_else(|g| g.into_inner())
                    .cancel
                    .clone();
                let include_set =
                    include_files.map(|v| v.into_iter().collect::<std::collections::HashSet<_>>());
                let mut progress = |p: ExportProgress| {
                    let mut t = task_for_worker.lock().unwrap_or_else(|g| g.into_inner());
                    t.stage = p.stage;
                    t.percent = p.percent;
                    t.current_file = p.current_file.clone();
                };
                let result = build_export_zip(
                    &core_c,
                    &cf_key_c,
                    &instance_c,
                    format,
                    include_saves,
                    include_screenshots,
                    include_set.as_ref(),
                    name_override.as_deref(),
                    version_override.as_deref(),
                    author_override.as_deref(),
                    &mut progress,
                    &cancel,
                )
                .await;

                let cancel_flag = cancel.load(Ordering::Relaxed);

                match result {
                    Ok(bytes) => {
                        let zip_path = base_dir
                            .join("temp")
                            .join(format!("export-{task_id_c}.zip"));
                        if let Some(parent) = zip_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if let Err(e) = std::fs::write(&zip_path, &bytes) {
                            let mut t = task_for_worker.lock().unwrap_or_else(|g| g.into_inner());
                            t.status = ExportTaskStatus::Failed;
                            t.stage = "packing";
                            t.error = Some(format!("写入临时文件失败: {e}"));
                            return;
                        }

                        match target_c {
                            Some(target) => {
                                let copy_result = std::fs::copy(&zip_path, &target);
                                let _ = std::fs::remove_file(&zip_path);
                                let mut t =
                                    task_for_worker.lock().unwrap_or_else(|g| g.into_inner());
                                match copy_result {
                                    Ok(_) => {
                                        t.status = ExportTaskStatus::Completed;
                                        t.stage = "packing";
                                        t.percent = 100.0;
                                    }
                                    Err(e) => {
                                        t.status = ExportTaskStatus::Failed;
                                        t.stage = "packing";
                                        t.error = Some(format!("写入目标路径失败: {e}"));
                                    }
                                }
                            }
                            None => {
                                let mut t =
                                    task_for_worker.lock().unwrap_or_else(|g| g.into_inner());
                                t.status = ExportTaskStatus::Completed;
                                t.stage = "packing";
                                t.percent = 100.0;
                                t.zip_path = Some(zip_path);
                            }
                        }
                    }
                    Err(e) => {
                        let mut t = task_for_worker.lock().unwrap_or_else(|g| g.into_inner());
                        t.status = if cancel_flag {
                            ExportTaskStatus::Cancelled
                        } else {
                            ExportTaskStatus::Failed
                        };
                        t.stage = "packing";
                        if !cancel_flag {
                            t.error = Some(e);
                        }
                    }
                }
            });
        });

        task_id
    }

    /// 读取任务快照（不存在返回 None）。
    pub fn get(&self, task_id: &str) -> Option<ExportTaskSnapshot> {
        let map = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        map.get(task_id)
            .map(|t| t.lock().unwrap_or_else(|g| g.into_inner()).snapshot())
    }

    /// 请求取消：置取消标志，build_export_zip 在下个检查点中断。
    pub fn cancel(&self, task_id: &str) -> bool {
        let map = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(t) = map.get(task_id) {
            let guard = t.lock().unwrap_or_else(|g| g.into_inner());
            if guard.status == ExportTaskStatus::Running {
                guard.cancel.store(true, Ordering::Relaxed);
                return true;
            }
        }
        false
    }

    /// 取出产物 zip 字节并清理任务（仅未传 targetPath 的完成态任务）。
    /// 返回 (文件名, 字节)；任务删除后临时文件删除。
    pub fn take_result(&self, task_id: &str) -> Option<(String, Vec<u8>)> {
        let mut map = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        let task = map.remove(task_id)?;
        let mut guard = task.lock().unwrap_or_else(|g| g.into_inner());
        if guard.status != ExportTaskStatus::Completed {
            return None;
        }
        let zip_path = guard.zip_path.take()?;
        let bytes = std::fs::read(&zip_path).ok()?;
        let _ = std::fs::remove_file(&zip_path);
        let ext = format_ext(guard.format);
        Some((format!("{task_id}.{ext}"), bytes))
    }
}

impl Default for ExportTaskManager {
    fn default() -> Self {
        Self::new()
    }
}
