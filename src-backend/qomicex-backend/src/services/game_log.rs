//! 实时游戏日志服务。
//!
//! 订阅核心子模块（qomicex-core-rust）的游戏输出总线（`subscribe_game_log`，
//! 见 launch/process.rs），把每行输出按 PID 归属到对应实例，缓冲最近若干行，
//! 并提供 broadcast 通道供 SSE 实时推送。核心库本身不保留任何状态，归属逻辑
//! 完全在此服务内完成。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Local;
use qomicex_core::services::launch::process::GameLogLine;
use serde::Serialize;
use tokio::sync::broadcast;

/// 缓冲中的一行日志（含展示时间戳）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLogEntry {
    /// 本地时间 HH:MM:SS。
    pub timestamp: String,
    /// "out" = stdout，"err" = stderr。
    pub stream: String,
    /// 去行尾换行后的文本。
    pub text: String,
}

/// 每个实例的日志缓冲 + 实时广播。
struct InstanceLogs {
    lines: Vec<GameLogEntry>,
    tx: broadcast::Sender<GameLogEntry>,
}

/// 实时游戏日志服务。
pub struct GameLogService {
    /// instance_id -> 缓冲/广播。
    buffers: Mutex<HashMap<String, InstanceLogs>>,
    /// 游戏进程 PID -> instance_id。
    by_pid: Mutex<HashMap<i32, String>>,
}

/// 每个实例缓冲的最大行数（超出丢弃最旧，避免长时运行内存无限增长）。
const MAX_LINES: usize = 5000;
/// 实时广播通道容量。
const CHANNEL_CAP: usize = 256;

impl GameLogService {
    pub fn new() -> Self {
        Self {
            buffers: Mutex::new(HashMap::new()),
            by_pid: Mutex::new(HashMap::new()),
        }
    }

    /// 启动消费任务：订阅核心游戏输出总线并把逐行输出转发到对应实例。
    pub fn spawn(svc: &Arc<Self>) {
        let svc = Arc::clone(svc);
        tokio::spawn(async move {
            let mut rx = qomicex_core::services::launch::process::subscribe_game_log();
            loop {
                match rx.recv().await {
                    Ok(line) => svc.forward(line),
                    // 消费者过慢丢弃旧数据：跳过续读即可。
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// 记录游戏进程 PID 归属到某实例（启动成功后调用），并确保缓冲存在。
    pub fn register(&self, instance_id: &str, pid: i32) {
        self.by_pid
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(pid, instance_id.to_string());
        // 仅确保缓冲存在（subscribe 也会按需创建，这里保持幂等）。
        let mut guard = self.buffers.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .entry(instance_id.to_string())
            .or_insert_with(|| InstanceLogs {
                lines: Vec::new(),
                tx: broadcast::channel(CHANNEL_CAP).0,
            });
    }

    /// 订阅某实例的实时日志；缓冲不存在时按需创建（启动早期也可订阅）。
    pub fn subscribe(&self, instance_id: &str) -> broadcast::Receiver<GameLogEntry> {
        let mut guard = self.buffers.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(logs) = guard.get(instance_id) {
            return logs.tx.subscribe();
        }
        let (tx, rx) = broadcast::channel(CHANNEL_CAP);
        guard.insert(
            instance_id.to_string(),
            InstanceLogs {
                lines: Vec::new(),
                tx,
            },
        );
        rx
    }

    /// 返回某实例已缓冲的全部历史行（供日志窗口/页面初始回显）。
    pub fn history(&self, instance_id: &str) -> Vec<GameLogEntry> {
        self.buffers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(instance_id)
            .map(|l| l.lines.clone())
            .unwrap_or_default()
    }

    /// 释放一个实例的日志状态（停止/取消时调用，避免僵留）。
    pub fn remove(&self, instance_id: &str) {
        let mut guard = self.buffers.lock().unwrap_or_else(|p| p.into_inner());
        guard.remove(instance_id);
    }

    /// 消费核心总线的一行输出：按 PID 归属到实例后写入缓冲并广播。
    fn forward(&self, line: GameLogLine) {
        let instance_id = {
            let guard = self.by_pid.lock().unwrap_or_else(|p| p.into_inner());
            guard.get(&line.pid).cloned()
        };
        let Some(instance_id) = instance_id else {
            return; // 尚无归属（PID 未知时启动初期的若干行），丢弃。
        };
        let entry = GameLogEntry {
            timestamp: Local::now().format("%H:%M:%S").to_string(),
            stream: if line.is_stdout { "out" } else { "err" }.to_string(),
            text: line.text,
        };
        let mut guard = self.buffers.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(logs) = guard.get_mut(&instance_id) {
            logs.lines.push(entry.clone());
            if logs.lines.len() > MAX_LINES {
                logs.lines.remove(0);
            }
            let _ = logs.tx.send(entry);
        }
    }
}

impl Default for GameLogService {
    fn default() -> Self {
        Self::new()
    }
}
