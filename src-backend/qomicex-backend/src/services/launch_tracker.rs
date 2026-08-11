//! 启动进程跟踪服务（对应源 Services/LaunchTracker.cs + ProcessState）。
//!
//! 维护三类 map：
//! - `progress`：`instanceId -> LaunchProgressState`（阶段/消息/进度百分比）。
//! - `states`：`instanceId -> ProcessState`（运行中游戏进程的 PID / 启动时间）。
//! - `cancels`：`instanceId -> Arc<AtomicBool>`（取消信号，对应 C# CancellationToken）。
//!
//! 语义与源逐字对齐：`GetProgress` 查进度快照；`GetState` 刷新进程存活状态，
//! 已退出则从 map 摘除并返回（供上层结算游玩时长）；`Stop` 取消 + 杀进程 +
//! 清进度；`CancelAndRemove` 置取消信号并清进度。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;

/// 运行中游戏进程状态（对应源 `ProcessState`）。
#[derive(Debug, Clone)]
pub struct ProcessState {
    pub process_id: i32,
    pub started_at: DateTime<Utc>,
}

impl ProcessState {
    pub fn new(process_id: i32) -> Self {
        Self {
            process_id,
            started_at: Utc::now(),
        }
    }
}

/// 启动进度快照（对应源 `LaunchProgressState` / `LaunchProgressDto`，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProgress {
    pub stage: String,
    pub message: String,
    pub progress: f64,
    pub is_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_report: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    #[serde(default)]
    pub total_files: i32,
    #[serde(default)]
    pub completed_files: i32,
}

impl Default for LaunchProgress {
    fn default() -> Self {
        Self {
            stage: String::new(),
            message: String::new(),
            progress: 0.0,
            is_running: false,
            process_id: None,
            exit_code: None,
            error: None,
            crash_report: None,
            missing_files: None,
            current_file: None,
            total_files: 0,
            completed_files: 0,
        }
    }
}

/// 启动跟踪器（对应源 `LaunchTracker`）。
pub struct LaunchTracker {
    progress: Mutex<HashMap<String, LaunchProgress>>,
    states: Mutex<HashMap<String, ProcessState>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for LaunchTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl LaunchTracker {
    pub fn new() -> Self {
        Self {
            progress: Mutex::new(HashMap::new()),
            states: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// 记录运行中的进程（对应源 `Track`）。
    pub fn track(&self, instance_id: &str, process_id: i32) {
        self.states
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(instance_id.to_string(), ProcessState::new(process_id));
    }

    /// 查询进程状态；已退出则从 map 摘除并返回（对应源 `GetState`）。
    pub fn get_state(&self, instance_id: &str) -> Option<ProcessState> {
        let mut guard = self.states.lock().unwrap_or_else(|p| p.into_inner());
        let state = guard.get(instance_id)?.clone();
        if process_alive(state.process_id) {
            Some(state)
        } else {
            guard.remove(instance_id);
            Some(state)
        }
    }

    /// 停止：取消信号 + 杀进程 + 清进度（对应源 `Stop`）。
    pub fn stop(&self, instance_id: &str) -> Option<ProcessState> {
        self.cancel_and_remove(instance_id);
        let removed = self
            .states
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(instance_id);
        if let Some(state) = &removed {
            kill_process(state.process_id);
        }
        removed
    }

    /// 查询进度快照（对应源 `GetProgress`）。
    pub fn get_progress(&self, instance_id: &str) -> Option<LaunchProgress> {
        self.progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(instance_id)
            .cloned()
    }

    /// 写入进度快照（对应源 `SetProgress`）。
    pub fn set_progress(&self, instance_id: &str, state: LaunchProgress) {
        self.progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(instance_id.to_string(), state);
    }

    /// 获取/创建取消信号（对应源 `GetOrCreateCts`）。
    pub fn get_or_create_cancel(&self, instance_id: &str) -> Arc<AtomicBool> {
        let mut guard = self.cancels.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .entry(instance_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// 置取消信号并清进度（对应源 `CancelAndRemove`）。
    pub fn cancel_and_remove(&self, instance_id: &str) {
        if let Some(flag) = self
            .cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(instance_id)
        {
            flag.store(true, Ordering::SeqCst);
        }
        self.progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(instance_id);
    }
}

/// 判断 PID 对应的进程是否存活（对应源 `ProcessState.Refresh`，sysinfo 实现）。
pub fn process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let mut sys = sysinfo::System::new();
    let syspid = sysinfo::Pid::from_u32(pid as u32);
    sys.refresh_process(syspid);
    sys.process(syspid).is_some()
}

/// 终止进程（对应源 `ProcessState.Kill`，尽力而为）。
pub fn kill_process(pid: i32) {
    if pid <= 0 {
        return;
    }
    let mut sys = sysinfo::System::new();
    let syspid = sysinfo::Pid::from_u32(pid as u32);
    sys.refresh_process(syspid);
    if let Some(p) = sys.process(syspid) {
        let _ = p.kill();
    }
}
