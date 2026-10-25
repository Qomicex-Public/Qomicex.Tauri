// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 插件常驻进程管理服务（issue #295 服务端管理插件催生的插件生态能力）。
//!
//! 与 `execCommand`（一次性 shell，≤120s、无句柄、无流式）互补：本服务面向
//! "插件拉起并长期管理一个外部进程" 的场景（如 Minecraft 服务端）——
//!
//! - [`PluginProcessService::spawn`] 拉起进程（piped stdin/stdout/stderr），
//!   后台任务逐行转发输出进环形日志缓冲（带单调递增 seq，供游标增量拉取）；
//! - [`PluginProcessService::write_stdin`] 向进程标准输入写字符串（服务端控制台命令）；
//! - [`PluginProcessService::logs`] 按 `after` 游标取增量行 —— 轮询式而非 SSE，
//!   在 dev（HTTP）与 release（qomicex:// QIPC）两种传输下行为一致；
//! - 退出状态由 waiter 任务写入 [`ProcState`]，进程退出后句柄保留 10 分钟供
//!   插件收尾日志，之后自动回收。
//!
//! 安全边界：所有操作都按 `plugin_id` 归属校验 —— 插件只能管理自己拉起的进程；
//! kill 复用 `/launch/{pid}/kill` 的进程树终止逻辑，由端点层调用。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as AsyncMutex;

/// 每个插件同时管理的进程数上限（防滥用；服务端管理场景远用不到）。
const MAX_PROCESSES_PER_PLUGIN: usize = 32;
/// 环形日志缓冲行数。
const LOG_RING_CAPACITY: usize = 2000;
/// 进程退出后句柄保留时长（插件拉取收尾日志），超时自动从注册表移除。
const EXITED_RETENTION: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq)]
pub enum ProcState {
    Running,
    /// 进程已退出（code 为 None 时表示被信号终止/无法获取）。
    Exited(Option<i32>),
}

impl ProcState {
    pub fn alive(&self) -> bool {
        matches!(self, ProcState::Running)
    }

    pub fn exit_code(&self) -> Option<i32> {
        match self {
            ProcState::Exited(code) => *code,
            ProcState::Running => None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcLogLine {
    pub seq: u64,
    /// "out" | "err"
    pub stream: String,
    pub text: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcSnapshot {
    pub pid: u32,
    pub command: String,
    pub args: Vec<String>,
    pub started_at_ms: u64,
    pub alive: bool,
    pub exit_code: Option<i32>,
    /// 日志缓冲里最旧的 seq（被环形淘汰前的游标下界）。
    pub oldest_seq: u64,
    pub next_seq: u64,
}

struct LogRing {
    next_seq: u64,
    entries: VecDeque<ProcLogLine>,
}

impl LogRing {
    fn new() -> Self {
        Self { next_seq: 0, entries: VecDeque::new() }
    }

    fn push(&mut self, stream: &str, text: String) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.entries.push_back(ProcLogLine { seq, stream: stream.to_string(), text });
        while self.entries.len() > LOG_RING_CAPACITY {
            self.entries.pop_front();
        }
    }

    fn after(&self, seq: u64) -> impl Iterator<Item = &ProcLogLine> {
        self.entries.iter().filter(move |l| l.seq > seq)
    }
}

/// 单个受管进程的共享状态。
struct ProcessHandle {
    plugin_id: String,
    command: String,
    args: Vec<String>,
    started_at_ms: u64,
    state: Mutex<ProcState>,
    logs: Mutex<LogRing>,
    /// 进程还活着时持有 stdin；退出/关闭后置 None（写返回错误）。
    stdin: AsyncMutex<Option<ChildStdin>>,
}

impl ProcessHandle {
    fn snapshot(&self, pid: u32) -> ProcSnapshot {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let logs = self.logs.lock().unwrap_or_else(|p| p.into_inner());
        ProcSnapshot {
            pid,
            command: self.command.clone(),
            args: self.args.clone(),
            started_at_ms: self.started_at_ms,
            alive: state.alive(),
            exit_code: state.exit_code(),
            oldest_seq: logs.entries.front().map(|l| l.seq).unwrap_or(logs.next_seq),
            next_seq: logs.next_seq,
        }
    }
}

#[derive(Default)]
pub struct PluginProcessService {
    procs: Mutex<HashMap<u32, std::sync::Arc<ProcessHandle>>>,
}

pub struct SpawnOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
}

impl PluginProcessService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 拉起常驻进程并注册。返回 PID。
    pub async fn spawn(
        &self,
        plugin_id: &str,
        opts: SpawnOptions,
    ) -> Result<u32, String> {
        if opts.command.trim().is_empty() {
            return Err("command 不能为空".to_string());
        }

        {
            let procs = self.procs.lock().unwrap_or_else(|p| p.into_inner());
            let mine = procs.values().filter(|h| h.plugin_id == plugin_id).count();
            if mine >= MAX_PROCESSES_PER_PLUGIN {
                return Err(format!(
                    "该插件管理的进程数已达上限（{MAX_PROCESSES_PER_PLUGIN}）"
                ));
            }
        }

        let mut cmd = tokio::process::Command::new(&opts.command);
        cmd.args(&opts.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(false);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：与游戏进程/插件 shell 一致，避免弹出控制台窗口
            cmd.creation_flags(0x0800_0000);
        }
        if let Some(cwd) = opts.cwd.as_deref().filter(|s| !s.trim().is_empty()) {
            cmd.current_dir(cwd);
        }
        cmd.envs(&opts.env);

        let mut child: Child = cmd
            .spawn()
            .map_err(|e| format!("无法启动进程 {}: {e}", opts.command))?;
        let pid = child.id().ok_or_else(|| "进程启动后没有 PID".to_string())?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();

        let handle = std::sync::Arc::new(ProcessHandle {
            plugin_id: plugin_id.to_string(),
            command: opts.command,
            args: opts.args,
            started_at_ms: now_ms(),
            state: Mutex::new(ProcState::Running),
            logs: Mutex::new(LogRing::new()),
            stdin: AsyncMutex::new(stdin),
        });

        // stdout/stderr 转发：逐行（容忍非 UTF-8）写入环形缓冲。
        if let Some(stdout) = stdout {
            let h = handle.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut buf = Vec::with_capacity(256);
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let mut line = String::from_utf8_lossy(&buf).into_owned();
                            while line.ends_with('\n') || line.ends_with('\r') {
                                line.pop();
                            }
                            h.logs.lock().unwrap_or_else(|p| p.into_inner()).push("out", line);
                        }
                    }
                }
            });
        }
        if let Some(stderr) = stderr {
            let h = handle.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                loop {
                    let mut buf = Vec::with_capacity(256);
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let mut line = String::from_utf8_lossy(&buf).into_owned();
                            while line.ends_with('\n') || line.ends_with('\r') {
                                line.pop();
                            }
                            h.logs.lock().unwrap_or_else(|p| p.into_inner()).push("err", line);
                        }
                    }
                }
            });
        }

        // waiter：独占 Child，记录退出状态并关闭 stdin。
        // 退出后句柄仍留在注册表里（保留期由 `lazy_gc` 惰性回收），
        // 插件可在收尾窗口内继续拉取日志。
        {
            let h = handle.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                let code = status.ok().and_then(|s| s.code());
                *h.state.lock().unwrap_or_else(|p| p.into_inner()) = ProcState::Exited(code);
                // 退出后关闭 stdin（若仍持有），让后续 write_stdin 立即报错。
                *h.stdin.lock().await = None;
            });
        }

        self.procs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(pid, handle);

        Ok(pid)
    }

    /// 惰性清理：已退出且超过保留期的句柄从注册表移除。
    /// 挂在每次公开操作前调用，避免为回收单独维护定时器与服务引用。
    fn lazy_gc(&self) {
        let mut procs = self.procs.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_ms();
        let stale: Vec<u32> = procs
            .iter()
            .filter(|(_, h)| {
                let state = h.state.lock().unwrap_or_else(|p| p.into_inner());
                !state.alive()
                    && now.saturating_sub(h.started_at_ms) > EXITED_RETENTION.as_millis() as u64 + 60_000
            })
            .map(|(pid, _)| *pid)
            .collect();
        for pid in stale {
            procs.remove(&pid);
        }
    }

    fn get(&self, plugin_id: &str, pid: u32) -> Result<std::sync::Arc<ProcessHandle>, String> {
        let procs = self.procs.lock().unwrap_or_else(|p| p.into_inner());
        let h = procs.get(&pid).ok_or_else(|| format!("进程 {pid} 不存在或已回收"))?;
        if h.plugin_id != plugin_id {
            // 不泄露他人进程的存在性
            return Err(format!("进程 {pid} 不存在或已回收"));
        }
        Ok(h.clone())
    }

    /// 向进程 stdin 写入。`append_newline` 为 true 时补一个 `\n`（交互式命令行需要）。
    pub async fn write_stdin(
        &self,
        plugin_id: &str,
        pid: u32,
        data: &str,
        append_newline: bool,
    ) -> Result<(), String> {
        self.lazy_gc();
        let h = self.get(plugin_id, pid)?;
        let mut guard = h.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(format!("进程 {pid} 的标准输入已关闭（进程可能已退出）"));
        };
        stdin.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
        if append_newline {
            stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        }
        stdin.flush().await.map_err(|e| e.to_string())
    }

    /// 按游标取增量日志。
    ///
    /// 锁序注意：必须先调 `snapshot()`（内部短暂拿 state→logs 两把锁）再单独拿
    /// logs 锁；反过来在持有 logs 锁时调 snapshot 会同线程重入死锁（std Mutex
    /// 不可重入，实测把 current_thread runtime 整个挂死）。
    pub fn logs(&self, plugin_id: &str, pid: u32, after: u64) -> Result<(Vec<ProcLogLine>, ProcSnapshot), String> {
        self.lazy_gc();
        let h = self.get(plugin_id, pid)?;
        let snap = h.snapshot(pid);
        let logs = h.logs.lock().unwrap_or_else(|p| p.into_inner());
        let lines: Vec<ProcLogLine> = logs.after(after).cloned().collect();
        Ok((lines, snap))
    }

    /// 进程快照（含存活状态）。
    pub fn snapshot(&self, plugin_id: &str, pid: u32) -> Result<ProcSnapshot, String> {
        self.lazy_gc();
        let h = self.get(plugin_id, pid)?;
        Ok(h.snapshot(pid))
    }

    /// 某插件的全部受管进程。
    pub fn list(&self, plugin_id: &str) -> Vec<ProcSnapshot> {
        self.lazy_gc();
        let procs = self.procs.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<ProcSnapshot> = procs
            .iter()
            .filter(|(_, h)| h.plugin_id == plugin_id)
            .map(|(pid, h)| h.snapshot(*pid))
            .collect();
        out.sort_by_key(|s| s.started_at_ms);
        out
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
