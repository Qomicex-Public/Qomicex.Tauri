//! 安装任务跟踪服务（对应源 Services/InstallTracker.cs + InstallState.cs）。
//!
//! ⚠️ 范围说明（本批移植决策）：
//! 源 `InstallTracker.cs` 的 `RunInstallAsync` 是真实下载/安装流水线，高度依赖
//! Qomicex.Core.AOT 的 GameCoreBuilder / Locator / InstallerFactory / HttpClient 以及
//! Qomicex.Downloader 的 DownloadSession。Rust 侧：
//! - `GameCore::installer_factory()` 在 qomicex-core-rust 中为 `pub(crate)`，跨 crate 不可调用，
//!   故加载器真实安装（forge/fabric 安装、optifine 路由、CurseForge/FTB addon 解析、Modrinth 查询）
//!   无法直接复用 core 完成。
//! - 因此本模块忠实移植核心的「任务跟踪 + 状态机推进 + 广播 + 查询 + 取消/暂停/关停」闭环，
//!   并提供 `InstallHandle` 作为调用方（后续 Launch/Modpack 端点）注入真实执行进度的入口
//!   （即源通过闭包 `postInstall`/`resolveAdditionalFiles` 注入的同一形态，此处泛化为 runner 闭包）。
//!
//! 状态语义与源逐字对齐：`Status` 是自由文本（源为 string 而非严格枚举），取值如
//! `"not-started"/"queued"/"installing"/"need_download"/"downloading"/"extracting"/"finishing"`
//! `"completed"/"failed"/"cancelled"`。为便于类型化书写，提供 `InstallStatus` 枚举与其字符串互转，
//! 但对外 DTO `InstallProgress.status` 仍是字符串以保持契约一致。
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use qomicex_core::core::GameCore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallStatus {
    NotStarted,
    Queued,
    Installing,
    NeedDownload,
    Downloading,
    Extracting,
    Finishing,
    Completed,
    Failed,
    Cancelled,
}

impl InstallStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            InstallStatus::NotStarted => "not-started",
            InstallStatus::Queued => "queued",
            InstallStatus::Installing => "installing",
            InstallStatus::NeedDownload => "need_download",
            InstallStatus::Downloading => "downloading",
            InstallStatus::Extracting => "extracting",
            InstallStatus::Finishing => "finishing",
            InstallStatus::Completed => "completed",
            InstallStatus::Failed => "failed",
            InstallStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "queued" => InstallStatus::Queued,
            "installing" => InstallStatus::Installing,
            "need_download" => InstallStatus::NeedDownload,
            "downloading" => InstallStatus::Downloading,
            "extracting" => InstallStatus::Extracting,
            "finishing" => InstallStatus::Finishing,
            "completed" => InstallStatus::Completed,
            "failed" => InstallStatus::Failed,
            "cancelled" => InstallStatus::Cancelled,
            _ => InstallStatus::NotStarted,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            InstallStatus::Completed | InstallStatus::Failed | InstallStatus::Cancelled
        )
    }
}

/// 安装管线分步状态（下载中心卡片渲染步骤列表的数据源）。
///
/// `id` 是稳定标识（如 "fetch-json"/"installer"），文案由前端 i18n 映射；
/// `percent` 仅在 active 步骤有字节级进度时由 download_batch 推进（0-100），
/// 扫描/安装等无字节进度的阶段保持 0，前端不渲染百分比。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallStep {
    pub id: String,
    /// pending | active | done | failed
    pub status: String,
    pub percent: f64,
}

impl InstallStep {
    fn pending(id: &str) -> Self {
        Self {
            id: id.to_string(),
            status: "pending".to_string(),
            percent: 0.0,
        }
    }
}

/// 对外进度 DTO（对应源 `InstallProgressResponse` 记录，字段逐一对齐，camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub instance_id: String,
    pub status: String,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub total_files: i32,
    pub completed_files: i32,
    pub failed_files: i32,
    pub current_file: String,
    /// 当前文件批次下载进度（0-100，按字节；非下载阶段为 0）。
    pub current_file_progress: f64,
    pub speed: f64,
    pub is_paused: bool,
    pub stage: String,
    /// 分步状态；未定义计划的旧任务/其他 kind 为空数组（序列化时省略）。
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub steps: Vec<InstallStep>,
}

/// 任务句柄（runner 与调用方读写进度的入口，对应源 `InstallState`）。
#[derive(Clone)]
pub struct InstallHandle(Arc<InstallState>);

impl InstallHandle {
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    pub fn is_paused(&self) -> bool {
        self.0.paused.load(Ordering::SeqCst)
    }

    pub fn set_status(&self, status: InstallStatus) {
        self.update(|f| f.set_status(status));
    }

    pub fn set_stage(&self, stage: &str) {
        self.update(|f| f.stage = stage.to_string());
    }

    /// 定义分步计划（幂等：仅当尚未定义时生效）。
    ///
    /// 整合包管线先定义外层计划，内部嵌套的 `run_install_pipeline` 再次调用时
    /// 不会覆盖外层计划；嵌套管线的 `begin_step` 因 id 不在外层计划中而为 no-op。
    pub fn define_steps(&self, ids: &[&str]) {
        self.update(|f| {
            if f.steps.is_empty() && !ids.is_empty() {
                f.steps = ids.iter().map(|id| InstallStep::pending(id)).collect();
            }
        });
    }

    /// 推进步骤：`id` 之前的全部置 done(100%)，`id` 置 active。
    /// `id` 不在计划中（嵌套管线的内部阶段）时不做任何事。
    pub fn begin_step(&self, id: &str) {
        self.update(|f| f.begin_step(id));
    }

    pub fn set_progress(&self, progress: f64) {
        self.update(|f| f.progress = progress);
    }

    pub fn set_current_file(&self, file: &str) {
        self.update(|f| f.current_file = file.to_string());
    }

    pub fn set_error(&self, error: impl Into<String>) {
        self.update(|f| f.error = Some(error.into()));
    }

    /// 批量更新（加锁改快照，再整体广播一次）。
    pub fn update(&self, f: impl FnOnce(&mut ProgressField)) {
        {
            let mut guard = self.0.inner.lock().unwrap_or_else(|p| p.into_inner());
            f(&mut guard);
        }
        self.broadcast();
    }

    pub fn snapshot(&self) -> InstallProgress {
        let guard = self.0.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.to_progress(&self.0.instance_id, self.0.paused.load(Ordering::SeqCst))
    }

    pub fn kind(&self) -> String {
        self.0.kind.clone()
    }

    fn broadcast(&self) {
        let snap = self.snapshot();
        let _ = self.0.tx.send(snap);
    }
}

/// 可写进度字段（`update` 闭包的自变量）。
pub struct ProgressField {
    pub status: String,
    pub progress: f64,
    pub error: Option<String>,
    pub stage: String,
    pub current_file: String,
    pub total_files: i32,
    pub completed_files: i32,
    pub failed_files: i32,
    pub current_file_progress: f64,
    pub speed: f64,
    pub steps: Vec<InstallStep>,
}

impl ProgressField {
    fn to_progress(&self, instance_id: &str, is_paused: bool) -> InstallProgress {
        InstallProgress {
            instance_id: instance_id.to_string(),
            status: self.status.clone(),
            progress: self.progress,
            error: self.error.clone(),
            total_files: self.total_files,
            completed_files: self.completed_files,
            failed_files: self.failed_files,
            current_file: self.current_file.clone(),
            current_file_progress: self.current_file_progress,
            speed: self.speed,
            is_paused,
            stage: self.stage.clone(),
            steps: self.steps.clone(),
        }
    }

    pub fn set_status(&mut self, status: InstallStatus) {
        self.status = status.as_str().to_string();
    }

    /// 推进步骤（见 `InstallHandle::begin_step`）。
    pub fn begin_step(&mut self, id: &str) {
        let Some(idx) = self.steps.iter().position(|s| s.id == id) else {
            return;
        };
        for step in self.steps.iter_mut().take(idx) {
            if step.status != "failed" {
                step.status = "done".to_string();
                step.percent = 100.0;
            }
        }
        if let Some(step) = self.steps.get_mut(idx) {
            step.status = "active".to_string();
        }
    }

    /// 将活跃步骤的百分比推进到 `percent`（download_batch 字节插值处调用）。
    pub fn set_active_step_percent(&mut self, percent: f64) {
        for step in self.steps.iter_mut() {
            if step.status == "active" {
                step.percent = percent.clamp(0.0, 100.0);
            }
        }
    }

    /// 任务终态收尾：成功 → 全部 done；失败 → 活跃/未完成步置 failed。
    pub fn finish_steps(&mut self, success: bool) {
        for step in self.steps.iter_mut() {
            if success {
                step.status = "done".to_string();
                step.percent = 100.0;
            } else if step.status == "active" || step.status == "pending" {
                step.status = "failed".to_string();
            }
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

struct InstallState {
    instance_id: String,
    kind: String,
    inner: Mutex<ProgressField>,
    cancelled: AtomicBool,
    paused: AtomicBool,
    tx: broadcast::Sender<InstallProgress>,
}

impl InstallState {
    fn new(
        instance_id: String,
        kind: String,
        initial_status: InstallStatus,
        initial_stage: &str,
        tx: broadcast::Sender<InstallProgress>,
    ) -> Self {
        Self {
            instance_id,
            kind,
            inner: Mutex::new(ProgressField {
                status: initial_status.as_str().to_string(),
                progress: 0.0,
                error: None,
                stage: initial_stage.to_string(),
                current_file: String::new(),
                total_files: 0,
                completed_files: 0,
                failed_files: 0,
                current_file_progress: 0.0,
                speed: 0.0,
                steps: Vec::new(),
            }),
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            tx,
        }
    }
}

/// runner 结果：`Ok(())` 成功 → 置 completed；`Err(msg)` = 失败/取消 → 置 failed。
pub type InstallOutcome = Result<(), String>;

/// 安装任务跟踪器（对应源 `InstallTracker`）。
///
/// 以 `HashMap<instanceId, InstallHandle>` 维护全部任务，持有一个全局
/// `broadcast::Sender<InstallProgress>` 供 SSE/轮询订阅进度变化。
pub struct InstallTracker {
    states: Mutex<HashMap<String, InstallHandle>>,
    tx: broadcast::Sender<InstallProgress>,
    /// 游戏核心（供后续端点经 tracker 复用于真实安装/下载）。
    core: Arc<GameCore>,
}

impl InstallTracker {
    /// 构造（对应源 `InstallTracker(JavaRuntimeStore, DownloadSessionManager, apiKey)`；
    /// Rust 侧现阶段仅接收 GameCore，下载会话/Java 运行时后续注入）。
    pub fn new(core: Arc<GameCore>) -> Self {
        let (tx, _) = broadcast::channel(128);
        Self {
            states: Mutex::new(HashMap::new()),
            tx,
            core,
        }
    }

    pub fn core(&self) -> &Arc<GameCore> {
        &self.core
    }

    /// 注册任务并立即返回（对应源 `Start` 的不阻塞语义）。
    ///
    /// - `kind`：任务类型（"install"/"modpack"/"resource"，对应源 session.Type）。
    /// - `runner`：真实执行闭包，接收 `InstallHandle` 推进进度，返回 `InstallOutcome`。
    pub fn start<F, Fut>(&self, instance_id: String, kind: &str, runner: F)
    where
        F: FnOnce(InstallHandle) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = InstallOutcome> + Send + 'static,
    {
        let handle = InstallHandle(Arc::new(InstallState::new(
            instance_id.clone(),
            kind.to_string(),
            InstallStatus::Queued,
            "queued",
            self.tx.clone(),
        )));
        {
            let mut guard = self.states.lock().unwrap_or_else(|p| p.into_inner());
            guard.insert(instance_id.clone(), handle.clone());
        }
        handle.broadcast();

        let kind_owned = kind.to_string();
        let id_owned = instance_id.clone();

        tokio::spawn(async move {
            let outcome = runner(handle.clone()).await;
            if handle.is_cancelled() {
                handle.update(|f| {
                    f.set_status(InstallStatus::Cancelled);
                    f.error = Some("安装已取消".to_string());
                });
                tracing::warn!(instance = %id_owned, kind = %kind_owned, "install: cancelled");
            } else {
                match outcome {
                    Ok(()) => {
                        handle.update(|f| {
                            f.set_status(InstallStatus::Completed);
                            f.stage = InstallStatus::Completed.as_str().to_string();
                            f.progress = 100.0;
                            f.current_file.clear();
                            f.finish_steps(true);
                        });
                        tracing::info!(instance = %id_owned, kind = %kind_owned, "install: completed");
                    }
                    Err(msg) => {
                        handle.update(|f| {
                            f.set_status(InstallStatus::Failed);
                            f.error = Some(msg.clone());
                            f.finish_steps(false);
                        });
                        tracing::error!(instance = %id_owned, kind = %kind_owned, error = %msg, "install: failed");
                    }
                }
            }
        });
    }

    pub fn start_version_install<F, Fut>(&self, instance_id: String, runner: F)
    where
        F: FnOnce(InstallHandle) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = InstallOutcome> + Send + 'static,
    {
        self.start(instance_id, "install", runner);
    }

    pub fn start_modpack_install<F, Fut>(&self, instance_id: String, runner: F)
    where
        F: FnOnce(InstallHandle) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = InstallOutcome> + Send + 'static,
    {
        self.start(instance_id, "modpack", runner);
    }

    pub fn start_resource_completion<F, Fut>(&self, instance_id: String, runner: F)
    where
        F: FnOnce(InstallHandle) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = InstallOutcome> + Send + 'static,
    {
        self.start(instance_id, "resource", runner);
    }

    /// 新订阅者（接收所有任务进度广播）。
    pub fn subscribe(&self) -> broadcast::Receiver<InstallProgress> {
        self.tx.subscribe()
    }

    /// 后续端点向已注册任务注入/更新进度。
    pub fn update_progress(&self, instance_id: &str, f: impl FnOnce(&mut ProgressField)) -> bool {
        if let Some(h) = self.get_handle(instance_id) {
            h.update(f);
            true
        } else {
            false
        }
    }

    /// 取单个任务进度（对应源 `GetState` → `ToResponse`；可能为终态）。
    pub fn get_state(&self, instance_id: &str) -> Option<InstallProgress> {
        self.get_handle(instance_id).map(|h| h.snapshot())
    }

    /// 列出全部活动任务进度（对应源 `GetAllActiveStates`）。
    ///
    /// ⚠️ 仅剔除 `completed`：failed/cancelled（含 error 消息）仍保留，否则失败任务
    /// 会从 SSE 消失、前端看不到失败原因。
    pub fn get_all_active(&self) -> Vec<InstallProgress> {
        self.clone_handles()
            .into_iter()
            .map(|h| h.snapshot())
            .filter(|p| p.status != "completed")
            .collect()
    }

    /// 列出全部任务（含终态）。
    pub fn get_all(&self) -> Vec<InstallProgress> {
        self.clone_handles()
            .into_iter()
            .map(|h| h.snapshot())
            .collect()
    }

    pub fn get_handle(&self, instance_id: &str) -> Option<InstallHandle> {
        let guard = self.states.lock().unwrap_or_else(|p| p.into_inner());
        guard.get(instance_id).cloned()
    }

    /// 取消（对应源 `Cancel`：置标志；实际取消由 runner 经 `is_cancelled()` 协作）。
    pub fn cancel(&self, instance_id: &str) {
        if let Some(h) = self.get_handle(instance_id) {
            h.0.cancelled.store(true, Ordering::SeqCst);
        }
    }

    /// 暂停（对应源 `Pause`）。
    pub fn pause(&self, instance_id: &str) {
        if let Some(h) = self.get_handle(instance_id) {
            h.0.paused.store(true, Ordering::SeqCst);
            h.broadcast();
        }
    }

    /// 恢复（对应源 `Resume`）。
    pub fn resume(&self, instance_id: &str) {
        if let Some(h) = self.get_handle(instance_id) {
            h.0.paused.store(false, Ordering::SeqCst);
            h.broadcast();
        }
    }

    /// 关停（对应源 `ShutdownAsync`）：取消全部并清空列表。
    pub fn shutdown(&self) {
        for h in self.clone_handles() {
            h.0.cancelled.store(true, Ordering::SeqCst);
        }
        let mut guard = self.states.lock().unwrap_or_else(|p| p.into_inner());
        guard.clear();
    }

    fn clone_handles(&self) -> Vec<InstallHandle> {
        let guard = self.states.lock().unwrap_or_else(|p| p.into_inner());
        guard.values().cloned().collect()
    }
}

impl InstallHandle {
    fn snapshot_terminal(&self) -> bool {
        let guard = self.0.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(guard.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

impl std::fmt::Debug for InstallTracker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstallTracker")
            .field("states", &"<map>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个仅含 ProgressField 的最小环境（绕过 tokio broadcast）。
    fn field() -> ProgressField {
        ProgressField {
            status: "downloading".to_string(),
            progress: 0.0,
            error: None,
            stage: String::new(),
            current_file: String::new(),
            total_files: 0,
            completed_files: 0,
            failed_files: 0,
            current_file_progress: 0.0,
            speed: 0.0,
            steps: Vec::new(),
        }
    }

    #[test]
    fn define_steps_is_idempotent() {
        let (tx, _rx) = broadcast::channel(8);
        let state = InstallState::new(
            "t".to_string(),
            "install".to_string(),
            InstallStatus::Downloading,
            "",
            tx,
        );
        let handle = InstallHandle(std::sync::Arc::new(state));
        handle.define_steps(&["download-modpack"]);
        // 嵌套管线再次定义不得覆盖外层计划
        handle.define_steps(&["fetch-json", "game-files"]);
        let snap = handle.snapshot();
        assert_eq!(snap.steps.len(), 1);
        assert_eq!(snap.steps[0].id, "download-modpack");
    }

    #[test]
    fn begin_step_marks_previous_done_and_self_active() {
        let mut f = field();
        f.steps = ["a", "b", "c"]
            .iter()
            .map(|id| InstallStep::pending(id))
            .collect();
        f.begin_step("b");
        assert_eq!(f.steps[0].status, "done");
        assert_eq!(f.steps[0].percent, 100.0);
        assert_eq!(f.steps[1].status, "active");
        assert_eq!(f.steps[2].status, "pending");

        f.set_active_step_percent(42.0);
        assert_eq!(f.steps[1].percent, 42.0);
        assert_eq!(f.steps[2].percent, 0.0);
    }

    #[test]
    fn begin_step_unknown_id_is_noop() {
        let mut f = field();
        f.steps = vec![InstallStep::pending("install-game")];
        f.begin_step("game-files");
        assert!(f.steps.iter().all(|s| s.status == "pending"));
    }

    #[test]
    fn finish_steps_terminal_states() {
        let mut f = field();
        f.steps = ["a", "b"]
            .iter()
            .map(|id| InstallStep::pending(id))
            .collect();
        f.begin_step("b");
        f.finish_steps(true);
        assert!(f
            .steps
            .iter()
            .all(|s| s.status == "done" && s.percent == 100.0));

        let mut f = field();
        f.steps = ["a", "b"]
            .iter()
            .map(|id| InstallStep::pending(id))
            .collect();
        f.begin_step("b");
        f.finish_steps(false);
        assert_eq!(f.steps[0].status, "done");
        assert_eq!(f.steps[1].status, "failed");
    }

    #[test]
    fn install_progress_serialization_omits_empty_steps() {
        let p = InstallProgress {
            instance_id: "x".to_string(),
            status: "downloading".to_string(),
            progress: 10.0,
            error: None,
            total_files: 0,
            completed_files: 0,
            failed_files: 0,
            current_file: String::new(),
            current_file_progress: 0.0,
            speed: 0.0,
            is_paused: false,
            stage: "queued".to_string(),
            steps: Vec::new(),
        };
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("steps").is_none());

        let mut p2 = p.clone();
        p2.steps = vec![InstallStep {
            id: "fetch-json".to_string(),
            status: "active".to_string(),
            percent: 30.0,
        }];
        let json2 = serde_json::to_value(&p2).unwrap();
        assert_eq!(json2["steps"][0]["id"], "fetch-json");
        assert_eq!(json2["steps"][0]["status"], "active");
        assert_eq!(json2["steps"][0]["percent"], 30.0);
    }
}
