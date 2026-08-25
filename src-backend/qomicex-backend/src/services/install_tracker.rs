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

/// 安装管线分步计划项（define_steps 入参）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InstallStepSpec {
    pub id: &'static str,
    /// 权重（合成总进度用，任意正数；内部按 Σweight 归一化）
    pub weight: f64,
}

/// 安装管线分步状态（下载中心卡片渲染步骤列表的数据源）。
///
/// `id` 是稳定标识（如 "fetch-json"/"installer"），文案由前端 i18n 映射；
/// `percent` 仅在 active 步骤有字节级进度时由 download_batch 推进（0-100），
/// 扫描/安装等无字节进度的阶段保持 0，前端不渲染百分比。
/// 并行管线中多个步骤可同时处于 active 状态。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallStep {
    pub id: String,
    /// pending | active | done | failed
    pub status: String,
    pub percent: f64,
    /// 合成总进度权重
    pub weight: f64,
}

impl InstallStep {
    fn pending(id: &str, weight: f64) -> Self {
        Self {
            id: id.to_string(),
            status: "pending".to_string(),
            percent: 0.0,
            weight,
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

    /// 追加分步计划（可多次调用：嵌套管线把子步骤追加进同一张表）。
    ///
    /// `budget` 为本组步骤的权重预算（顶层传 [`INSTALL_STEP_BUDGET_TOP`] = 100，
    /// 因子 1.0；整合包内层传外层分配的预算如 40 → 实际权重 = 原始权重 × 40/100，
    /// 即内层步骤合计占全局合成进度的 40%）。
    pub fn define_steps(&self, specs: &[InstallStepSpec], budget: f64) {
        let factor = budget / 100.0;
        self.update(|f| {
            for spec in specs {
                f.steps
                    .push(InstallStep::pending(spec.id, spec.weight * factor));
            }
        });
    }

    /// 显式设置某步骤状态（active/done/failed），不影响其他步骤。
    ///
    /// 并行语义下取代旧线性 begin_step（其"前序全 done"会误杀同时活跃的兄弟分支）；
    /// done 时 percent 置 100 并重算合成总进度。
    pub fn mark_step(&self, id: &str, status: &str) {
        self.update(|f| {
            f.mark_step(id, status);
            f.recompute_progress();
        });
    }

    /// 定向更新某步骤的下载百分比并重算合成总进度（download_batch 调用）。
    pub fn set_step_percent(&self, id: &str, percent: f64) {
        self.update(|f| {
            if let Some(step) = f.steps.iter_mut().find(|s| s.id == id) {
                step.percent = percent.clamp(0.0, 100.0);
            }
            f.recompute_progress();
        });
    }

    /// 请求取消（并行分支快速失败时置位，其余分支在轮询点自行退出）。
    pub fn request_cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
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

    /// 显式设置某步骤状态（done 时 percent=100），不影响其他步骤。
    pub fn mark_step(&mut self, id: &str, status: &str) {
        if let Some(step) = self.steps.iter_mut().find(|s| s.id == id) {
            step.status = status.to_string();
            if status == "done" {
                step.percent = 100.0;
            }
        }
    }

    /// 定向更新某步骤百分比并重算合成总进度（update 闭包内使用，避免重锁）。
    pub fn set_step_percent(&mut self, id: &str, percent: f64) {
        if let Some(step) = self.steps.iter_mut().find(|s| s.id == id) {
            step.percent = percent.clamp(0.0, 100.0);
        }
        self.recompute_progress();
    }

    /// 合成总进度：Σ(done?w : active?w×pct/100 : 0) / Σw × 100。
    /// pending/failed 计 0；全部 done 时恰为 100。
    pub fn recompute_progress(&mut self) {
        let total_w: f64 = self.steps.iter().map(|s| s.weight).sum();
        if total_w <= 0.0 {
            return;
        }
        let earned: f64 = self
            .steps
            .iter()
            .map(|s| match s.status.as_str() {
                "done" => s.weight,
                "active" => s.weight * s.percent / 100.0,
                _ => 0.0,
            })
            .sum();
        self.progress = (earned / total_w * 100.0).clamp(0.0, 100.0);
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
        self.recompute_progress();
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

/// 根据取消标志与 runner 结果判定任务终态。
///
/// 并行分支快速失败会 `request_cancel()` 置位取消标志，但此时 `outcome` 携带真实错误
/// （非取消哨兵 `"安装已取消"`）——若仅凭取消标志就判 cancelled，会吞掉真实失败原因。
/// 因此只有「取消标志置位 **且** outcome 为取消哨兵」才视为用户取消。
fn classify_outcome(cancelled: bool, outcome: &InstallOutcome) -> InstallStatus {
    if cancelled && matches!(outcome, Err(m) if m == "安装已取消") {
        InstallStatus::Cancelled
    } else {
        match outcome {
            Ok(()) => InstallStatus::Completed,
            Err(_) => InstallStatus::Failed,
        }
    }
}

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
            // 区分「用户主动取消」与「真实失败」：并行分支快速失败时会 request_cancel
            // 置位让其余分支退出，此时 outcome 携带真实错误——不能因 is_cancelled 被置位
            // 就吞掉真实原因误报为 cancelled。仅当 outcome 为取消哨兵（"安装已取消"）
            // 时才视为用户取消；其余一律按结果报 completed/failed。
            let status = classify_outcome(handle.is_cancelled(), &outcome);
            match status {
                InstallStatus::Cancelled => {
                    handle.update(|f| {
                        f.set_status(InstallStatus::Cancelled);
                        f.error = Some("安装已取消".to_string());
                    });
                    tracing::warn!(instance = %id_owned, kind = %kind_owned, "install: cancelled");
                }
                InstallStatus::Completed => {
                    handle.update(|f| {
                        f.set_status(InstallStatus::Completed);
                        f.stage = InstallStatus::Completed.as_str().to_string();
                        f.progress = 100.0;
                        f.current_file.clear();
                        f.finish_steps(true);
                    });
                    tracing::info!(instance = %id_owned, kind = %kind_owned, "install: completed");
                }
                _ => {
                    let msg = match &outcome {
                        Err(m) => m.clone(),
                        Ok(()) => String::new(),
                    };
                    handle.update(|f| {
                        f.set_status(InstallStatus::Failed);
                        f.error = Some(msg.clone());
                        f.finish_steps(false);
                    });
                    tracing::error!(instance = %id_owned, kind = %kind_owned, error = %msg, "install: failed");
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

    fn spec(id: &'static str, weight: f64) -> InstallStepSpec {
        InstallStepSpec { id, weight }
    }

    #[test]
    fn define_steps_appends_and_scales_weights() {
        let (tx, _rx) = broadcast::channel(8);
        let state = InstallState::new(
            "t".to_string(),
            "install".to_string(),
            InstallStatus::Downloading,
            "",
            tx,
        );
        let handle = InstallHandle(std::sync::Arc::new(state));
        handle.define_steps(&[spec("a", 10.0), spec("b", 30.0)], 100.0);
        // 嵌套管线以预算缩放追加子步骤（40/100 → 因子 0.4）
        handle.define_steps(&[spec("c", 50.0), spec("d", 50.0)], 40.0);
        let snap = handle.snapshot();
        let ids: Vec<&str> = snap.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c", "d"]);
        assert_eq!(snap.steps[0].weight, 10.0);
        assert_eq!(snap.steps[2].weight, 20.0);
        assert_eq!(snap.steps[3].weight, 20.0);
    }

    #[test]
    fn mark_step_supports_parallel_actives_without_clobbering_siblings() {
        let mut f = field();
        f.steps = [spec("a", 25.0), spec("b", 25.0), spec("c", 50.0)]
            .iter()
            .map(|s| InstallStep::pending(s.id, s.weight))
            .collect();
        f.mark_step("a", "active");
        f.mark_step("b", "active");
        // b done 不得影响同时活跃的 a
        f.mark_step("b", "done");
        assert_eq!(f.steps[0].status, "active");
        assert_eq!(f.steps[1].status, "done");
        assert_eq!(f.steps[1].percent, 100.0);
        assert_eq!(f.steps[2].status, "pending");

        // 合成进度：a 活跃 40% + b 完成 = (25×0.4 + 25) / 100 × 100 = 35
        f.set_step_percent("a", 40.0);
        assert!((f.progress - 35.0).abs() < 1e-9, "progress={}", f.progress);
    }

    #[test]
    fn mark_step_unknown_id_is_noop() {
        let mut f = field();
        f.steps = vec![InstallStep::pending("install-game", 100.0)];
        f.mark_step("game-files", "active");
        assert!(f.steps.iter().all(|s| s.status == "pending"));
    }

    #[test]
    fn finish_steps_terminal_states() {
        let mut f = field();
        f.steps = [spec("a", 50.0), spec("b", 50.0)]
            .iter()
            .map(|s| InstallStep::pending(s.id, s.weight))
            .collect();
        f.mark_step("b", "active");
        f.finish_steps(true);
        assert!(f
            .steps
            .iter()
            .all(|s| s.status == "done" && s.percent == 100.0));
        assert!((f.progress - 100.0).abs() < 1e-9);

        let mut f = field();
        f.steps = [spec("a", 50.0), spec("b", 50.0)]
            .iter()
            .map(|s| InstallStep::pending(s.id, s.weight))
            .collect();
        f.mark_step("a", "done");
        f.mark_step("b", "active");
        f.finish_steps(false);
        assert_eq!(f.steps[0].status, "done");
        assert_eq!(f.steps[1].status, "failed");
    }

    #[test]
    fn request_cancel_sets_flag() {
        let (tx, _rx) = broadcast::channel(8);
        let state = InstallState::new(
            "t".to_string(),
            "install".to_string(),
            InstallStatus::Downloading,
            "",
            tx,
        );
        let handle = InstallHandle(std::sync::Arc::new(state));
        assert!(!handle.is_cancelled());
        handle.request_cancel();
        assert!(handle.is_cancelled());
    }

    #[test]
    fn classify_outcome_real_failure_is_failed_not_cancelled() {
        // 回归（issue #59）：并行分支快速失败 request_cancel 置位后，真实错误必须报 failed
        // 并保留真实原因，不得因取消标志误报为 cancelled。修复前此用例 FAILED（误判 Cancelled）。
        let status = classify_outcome(true, &Err("下载文件校验失败".to_string()));
        assert_eq!(status, InstallStatus::Failed);

        // 用户主动取消：取消标志置位且 outcome 为取消哨兵 → cancelled
        let status = classify_outcome(true, &Err("安装已取消".to_string()));
        assert_eq!(status, InstallStatus::Cancelled);

        // 未取消时的常规结果
        assert_eq!(classify_outcome(false, &Ok(())), InstallStatus::Completed);
        assert_eq!(
            classify_outcome(false, &Err("boom".to_string())),
            InstallStatus::Failed
        );
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
            weight: 5.0,
        }];
        let json2 = serde_json::to_value(&p2).unwrap();
        assert_eq!(json2["steps"][0]["id"], "fetch-json");
        assert_eq!(json2["steps"][0]["status"], "active");
        assert_eq!(json2["steps"][0]["percent"], 30.0);
    }
}
