//! 内存 trace 缓冲 + dump + 日志级别。
//!
//! 对应 C# `Diagnostics/TraceBufferStore.cs`、`Diagnostics/BufferedTraceListener.cs`、
//! `Services/TraceDumpService.cs` 与 `Common/LogLevelManager.cs`。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use crate::settings::resolve_base_dir;

/// 全局 trace 缓冲（AppState::build 时注册；trace_append / TraceWriter 写入）。
pub static TRACE_BUFFER: OnceLock<Arc<TraceBufferStore>> = OnceLock::new();

/// 全局文件日志（AppState::build 时注册；trace_append 双写）。
static FILE_LOG: OnceLock<Arc<FileLog>> = OnceLock::new();

/// 注册全局缓冲（重复注册忽略）。
pub fn init_global_trace(buffer: Arc<TraceBufferStore>) {
    let _ = TRACE_BUFFER.set(buffer);
}

/// 注册全局文件日志（重复注册忽略）。
pub fn init_file_log(log: Arc<FileLog>) {
    let _ = FILE_LOG.set(log);
}

/// 向全局缓冲追加一行（未初始化时静默丢弃），并双写到文件日志。
pub fn trace_append(line: String) {
    if let Some(b) = TRACE_BUFFER.get() {
        b.append(line.clone());
    }
    if let Some(f) = FILE_LOG.get() {
        f.append(line);
    }
}

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

/// 文件日志：trace 行持续追加到 `{BaseDir}/logs/qomicex-backend.log`，
/// 超过 [`MAX_FILE_BYTES`] 自动轮转（重命名旧文件为带时间戳的后缀），
/// 仅保留最近 [`KEEP_FILES`] 份，避免无限增长。崩溃/重启后日志仍在磁盘。
pub struct FileLog {
    dir: PathBuf,
    current: Mutex<Option<File>>,
    current_size: Mutex<u64>,
}

/// 单个日志文件上限（5 MiB）。
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// 保留的轮转文件份数（含当前）。
const KEEP_FILES: usize = 10;
/// 日志文件前缀。
const LOG_PREFIX: &str = "qomicex-backend";

impl FileLog {
    pub fn new() -> Self {
        let dir = resolve_base_dir().join("logs");
        let _ = std::fs::create_dir_all(&dir);
        Self {
            dir,
            current: Mutex::new(None),
            current_size: Mutex::new(0),
        }
    }

    fn log_path(&self) -> PathBuf {
        self.dir.join(format!("{LOG_PREFIX}.log"))
    }

    fn rotated_path(&self) -> PathBuf {
        let now = chrono::Local::now();
        self.dir.join(format!(
            "{LOG_PREFIX}-{}.log",
            now.format("%Y%m%d-%H%M%S-%3f")
        ))
    }

    /// 追加一行（带换行）。必要时轮转当前文件并清理旧文件。
    pub fn append(&self, line: String) {
        let mut file = self.current.lock().unwrap();
        let mut size = self.current_size.lock().unwrap();

        // 打开当前文件（惰性）。
        if file.is_none() {
            match OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.log_path())
            {
                Ok(f) => {
                    if let Ok(meta) = f.metadata() {
                        *size = meta.len();
                    }
                    *file = Some(f);
                }
                Err(_) => return, // 写不了文件则静默（缓冲仍保留）
            }
        }

        // 超过上限 → 轮转。
        if *size >= MAX_FILE_BYTES {
            *file = None;
            *size = 0;
            let rotated = self.rotated_path();
            let _ = std::fs::rename(self.log_path(), rotated);
            if let Ok(f) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.log_path())
            {
                *file = Some(f);
            } else {
                return;
            }
            self.cleanup_old();
        }

        if let Some(f) = file.as_mut() {
            let bytes = line.as_bytes();
            let _ = f.write_all(bytes);
            let _ = f.write_all(b"\n");
            let _ = f.flush();
            *size += bytes.len() as u64 + 1;
        }
    }

    /// 删除超过 KEEP_FILES 的旧轮转文件（按修改时间排序，保留最新）。
    fn cleanup_old(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(LOG_PREFIX) && n.ends_with(".log"))
                    .unwrap_or(false)
            })
            .collect();
        if files.len() <= KEEP_FILES {
            return;
        }
        files.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
        let excess = files.len() - KEEP_FILES;
        for p in files.into_iter().take(excess) {
            let _ = std::fs::remove_file(p);
        }
    }
}

impl Default for FileLog {
    fn default() -> Self {
        Self::new()
    }
}

// =====================================================================
// 实时日志数据流（对应 C# `BufferedTraceListener`）：
// 1) tracing 事件：`TraceWriter` 作为 tracing-subscriber 的 fmt writer，逐行写入缓冲；
// 2) eprintln!/println!（core/downloader 安装器日志等）：进程 stderr 重定向到管道，
//    后台线程读取后写入缓冲并回显原 stderr。启动后两者都进入 `/diagnostics/trace`。
// =====================================================================

/// tracing fmt writer：按行切分写入全局 trace 缓冲。
/// 注意：tracing 事件只进缓冲（不回显终端），避免与 stderr 捕获重复。
#[derive(Clone, Default)]
pub struct TraceWriter {
    pending: Arc<Mutex<String>>,
}

impl Write for TraceWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let s = String::from_utf8_lossy(buf);
        let mut pending = self.pending.lock().unwrap();
        pending.push_str(&s);
        let mut rest = String::new();
        for line in pending.split_inclusive('\n') {
            if line.ends_with('\n') {
                trace_append(line.trim_end_matches(['\n', '\r']).to_string());
            } else {
                rest.push_str(line);
            }
        }
        *pending = rest;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl tracing_subscriber::fmt::MakeWriter<'_> for TraceWriter {
    type Writer = TraceWriter;

    fn make_writer(&self) -> Self::Writer {
        self.clone()
    }
}

/// 启动 stdout+stderr 捕获：重定向进程 stdout/stderr 到管道，后台线程读取写入
/// trace 缓冲，并回显原句柄（保持终端可见）。覆盖 core/downloader 等所有 crate
/// 的 `println!` / `eprintln!` 日志（core 大量用 println! 报安装流程进度）。
/// 必须在全局缓冲注册后调用。
pub fn start_io_capture() {
    #[cfg(windows)]
    {
        capture_handle_windows("stdout", 1);
        capture_handle_windows("stderr", 2);
    }
    #[cfg(unix)]
    {
        capture_handle_unix("stdout", libc::STDOUT_FILENO);
        capture_handle_unix("stderr", libc::STDERR_FILENO);
    }
}

/// 捕获线程公共处理：写缓冲（带来源 tag）+ 回显原句柄。
fn handle_captured(tag: &str, line: String, echo: impl Fn(&[u8])) {
    for part in line.split('\n') {
        let t = part.trim_end_matches('\r');
        if !t.is_empty() {
            trace_append(format!("[{tag}] {t}"));
        }
    }
    echo(line.as_bytes());
}

#[cfg(windows)]
fn capture_handle_windows(tag: &'static str, std_handle: u32) {
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::Console::{GetStdHandle, SetStdHandle};
    use windows_sys::Win32::System::Pipes::CreatePipe;

    unsafe {
        let original = GetStdHandle(std_handle);
        let mut read_handle: HANDLE = 0;
        let mut write_handle: HANDLE = 0;
        if CreatePipe(&mut read_handle, &mut write_handle, std::ptr::null(), 0) == 0 {
            return;
        }
        if SetStdHandle(std_handle, write_handle) == 0 {
            return;
        }
        std::thread::Builder::new()
            .name(format!("{tag}-capture"))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    let mut read: u32 = 0;
                    let ok = ReadFile(
                        read_handle,
                        buf.as_mut_ptr() as *mut _,
                        buf.len() as u32,
                        &mut read,
                        std::ptr::null_mut(),
                    );
                    if ok == 0 || read == 0 {
                        break;
                    }
                    let s = String::from_utf8_lossy(&buf[..read as usize]).into_owned();
                    handle_captured(tag, s, |bytes| {
                        if original != INVALID_HANDLE_VALUE && original != 0 {
                            let mut written: u32 = 0;
                            WriteFile(
                                original,
                                bytes.as_ptr() as *const _,
                                bytes.len() as u32,
                                &mut written,
                                std::ptr::null_mut(),
                            );
                        }
                    });
                }
            })
            .ok();
        // write_handle 保持开放：SetStdHandle 后进程写操作直达管道
    }
}

#[cfg(unix)]
fn capture_handle_unix(tag: &'static str, std_fd: i32) {
    unsafe {
        let mut fds = [0i32; 2];
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        let original = libc::dup(std_fd);
        if original < 0 {
            return;
        }
        libc::dup2(fds[1], std_fd);
        libc::close(fds[1]);
        let read_fd = fds[0];
        std::thread::Builder::new()
            .name(format!("{tag}-capture"))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    let n = libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len());
                    if n <= 0 {
                        break;
                    }
                    let s = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
                    handle_captured(tag, s, |bytes| {
                        if original >= 0 {
                            libc::write(
                                original,
                                bytes.as_ptr() as *const libc::c_void,
                                bytes.len(),
                            );
                        }
                    });
                }
            })
            .ok();
    }
}
