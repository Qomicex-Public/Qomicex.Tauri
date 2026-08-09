//! 内存 trace 缓冲 + dump + 日志级别。
//!
//! 对应 C# `Diagnostics/TraceBufferStore.cs`、`Diagnostics/BufferedTraceListener.cs`、
//! `Services/TraceDumpService.cs` 与 `Common/LogLevelManager.cs`。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::settings::resolve_base_dir;

/// 环形内存缓冲，保存最近若干条 trace 行（上限约 2000 条）。线程安全。
///
/// 对应 `TraceBufferStore`（内部 `Queue<string>` + `lock`，满时 `Dequeue` 旧条目）。
pub struct TraceBufferStore {
    entries: Mutex<VecDeque<String>>,
    #[allow(dead_code)]
    capacity: usize,
}

impl TraceBufferStore {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
        }
    }

    /// 追加一行（对应 `Add`）。满时淘汰最旧的一行。
    #[allow(dead_code)]
    pub fn append(&self, line: String) {
        let mut entries = self.entries.lock().unwrap();
        if entries.len() == self.capacity {
            entries.pop_front();
        }
        entries.push_back(line);
    }

    /// 返回当前缓冲的快照（按时间序，对应 `Snapshot` 返回拷贝数组）。
    pub fn snapshot(&self) -> Vec<String> {
        self.entries.lock().unwrap().iter().cloned().collect()
    }
}

impl Default for TraceBufferStore {
    fn default() -> Self {
        Self::new(2000)
    }
}

/// 将 trace 缓冲 dump 到磁盘文件。
///
/// 对应 `TraceDumpService`：输出到 `{BaseDir}/logs/backend-trace-{yyyyMMdd-HHmmss-fff}-{guid:N}.log`，
/// 头部含 reason / timestamp，随后为缓冲快照。落盘路径基址为 `resolve_base_dir()/logs`。
pub struct TraceDumpService {
    buffer: std::sync::Arc<TraceBufferStore>,
}

impl TraceDumpService {
    pub fn new(buffer: std::sync::Arc<TraceBufferStore>) -> Self {
        Self { buffer }
    }

    /// Dump 缓冲到日志文件，返回生成的文件路径。
    pub fn dump(&self, reason: &str) -> std::io::Result<PathBuf> {
        let log_dir = resolve_base_dir().join("logs");
        std::fs::create_dir_all(&log_dir)?;
        let now = chrono::Local::now();
        let file_name = format!(
            "backend-trace-{}-{}.log",
            now.format("%Y%m%d-%H%M%S-%3f"),
            uuid::Uuid::new_v4().simple()
        );
        let file_path = log_dir.join(file_name);

        let mut lines = vec![
            format!("Reason: {reason}"),
            format!("Timestamp: {}", now.format("%Y-%m-%d %H:%M:%S%.3f")),
            String::new(),
        ];
        lines.extend(self.buffer.snapshot());
        std::fs::write(&file_path, lines.join("\n"))?;
        Ok(file_path)
    }
}

/// 维护当前日志级别字符串（默认 "info"）。
///
/// 对应 `LogLevelManager`：分量式 SetLevel/GetLevel，默认 Information("info")。
/// C# 中无效输入回退为 Information，这里 `set_level` 保留原字符串语义由调用方使用，
/// 未做归一化；若需对齐 C# 的回退语义，可对未知值置回 "info"。
pub struct LogLevelManager {
    level: Mutex<String>,
}

impl LogLevelManager {
    pub fn new() -> Self {
        Self {
            level: Mutex::new("info".to_string()),
        }
    }

    pub fn set_level(&self, level: String) {
        *self.level.lock().unwrap() = level;
    }

    #[allow(dead_code)]
    pub fn get_level(&self) -> String {
        self.level.lock().unwrap().clone()
    }
}

impl Default for LogLevelManager {
    fn default() -> Self {
        Self::new()
    }
}
