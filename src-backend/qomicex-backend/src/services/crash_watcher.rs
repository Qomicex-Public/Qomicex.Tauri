//! 游戏进程退出监控 + 崩溃诊断收集。
//!
//! 对应 C# `InstanceController` 启动任务中的 `WaitForExit` 段：进程退出后收集
//! crash-reports / hs_err / latest.log / 游戏输出缓冲，按退出码判定
//! `crashed`(code != 0) 或 `completed`，写入 LaunchTracker 终态并结算游玩时长，
//! 供前端轮询触发崩溃弹窗与 `/loganalysis/analyze-crash` 分析。
//!
//! 接管约定：收到退出事件后先 `remove_state` 声明接管（用户主动停止时 states
//! 已被 `stop` 清空，此处自然忽略），再异步收集诊断，最后写终态。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use qomicex_core::services::launch::process::subscribe_game_exit;

use crate::services::game_log::GameLogService;
use crate::services::instance::InstanceService;
use crate::services::launch_tracker::{LaunchProgress, LaunchTracker};

/// 收集诊断时的上下文（版本隔离决定 crash-reports 目录层级）。
struct CollectCtx {
    game_dir: String,
    version_name: String,
    version_isolation: bool,
    /// 本次启动成功时刻：仅收集该时刻之后修改的文件，排除历史会话报告。
    cutoff: DateTime<Utc>,
}

pub struct CrashWatcher;

impl CrashWatcher {
    /// 启动全局退出事件消费任务（AppState 构造时调用一次）。
    pub fn spawn(
        tracker: &Arc<LaunchTracker>,
        instances: &Arc<InstanceService>,
        game_log: &Arc<GameLogService>,
    ) {
        let tracker = Arc::clone(tracker);
        let instances = Arc::clone(instances);
        let game_log = Arc::clone(game_log);
        tokio::spawn(async move {
            let mut rx = subscribe_game_exit();
            loop {
                match rx.recv().await {
                    Ok(ev) => handle_exit(&tracker, &instances, &game_log, ev.pid, ev.code).await,
                    // 消费者过慢：被丢弃的退出事件不会再有补发，扫描全部运行
                    // 中状态做一次对账，避免实例永久卡在 running。
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        reconcile(&tracker, &instances).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

/// 广播 Lagged 兜底：扫描全部运行中状态，死亡进程按正常退出结算。
///
/// 拿不到真实退出码，保守记 `completed` 不误报崩溃；真崩溃的证据仍在磁盘
/// crash-reports/latest.log 中，可经导出诊断或日志分析获取。
async fn reconcile(tracker: &LaunchTracker, instances: &InstanceService) {
    for (instance_id, ps) in tracker.running_states() {
        if crate::services::launch_tracker::process_alive(ps.process_id) {
            continue;
        }
        tracker.remove_state(&instance_id);
        let accepted = tracker.set_progress_if_running(
            &instance_id,
            LaunchProgress {
                stage: "completed".to_string(),
                message: "游戏已退出".to_string(),
                progress: 100.0,
                is_running: false,
                process_id: Some(ps.process_id),
                exit_code: None,
                ..Default::default()
            },
        );
        if accepted {
            settle_play_time(instances, &instance_id, ps.started_at);
            tracing::warn!(
                instance = %instance_id,
                pid = ps.process_id,
                "crash-watcher: lagged events reconciled as completed"
            );
        }
    }
}

/// 处理一次进程退出事件：定位实例 → 收集诊断 → 写终态 → 结算时长。
async fn handle_exit(
    tracker: &LaunchTracker,
    instances: &InstanceService,
    game_log: &GameLogService,
    pid: i32,
    code: i32,
) {
    tracing::info!(pid, code, "crash-watcher: game process exited");

    // stop/kill 场景 states 已清空，find_by_pid 为 None → 忽略（不算崩溃）。
    // 例外：事件可能先于 launch 流程的 track() 到达（进程秒退），短暂重试一次。
    let located = match tracker.find_by_pid(pid) {
        Some(found) => Some(found),
        None => {
            tokio::time::sleep(Duration::from_millis(300)).await;
            tracker.find_by_pid(pid)
        }
    };
    let Some((instance_id, ps)) = located else {
        return;
    };
    // 声明接管：查询路径发现 running + 进程死亡 + state 缺失时会等待终态而非兜底 completed。
    tracker.remove_state(&instance_id);

    let Some(inst) = instances.get_by_id(&instance_id) else {
        return;
    };

    // 游戏输出缓冲在进入阻塞任务前取出（尾部若干行，替代 C# 的 stderr/stdout 重定向文件）。
    let output_tail = tail_text(
        &game_log
            .history(&instance_id)
            .into_iter()
            .map(|l| l.text)
            .collect::<Vec<_>>(),
        300,
    );
    // 取完即释放日志状态（PID 归属 + 缓冲）：防 OS 复用 PID 后输出串扰旧实例，
    // 也避免跨启动累积过期缓冲。
    game_log.release(&instance_id);

    let ctx = CollectCtx {
        version_isolation: inst
            .version_isolation
            .unwrap_or_else(crate::settings::get_global_version_isolation),
        game_dir: inst.game_dir.clone(),
        version_name: inst.name.clone(),
        cutoff: ps.started_at,
    };
    let diagnostics =
        tokio::task::spawn_blocking(move || collect_diagnostics(&ctx, output_tail.as_deref()))
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("crash-watcher: 诊断收集任务失败: {e}");
                None
            });

    let crashed = code != 0;
    let (stage, message) = if crashed {
        (
            "crashed".to_string(),
            format!("游戏异常退出 (代码: {code})"),
        )
    } else {
        ("completed".to_string(), "游戏已退出".to_string())
    };
    let has_report = diagnostics.is_some();
    // 条件写入：期间用户 stop/cancel 已清掉进度时拒绝（避免已取消流程被复活成
    // 崩溃弹窗），此时也不结算时长。
    let accepted = tracker.set_progress_if_running(
        &instance_id,
        LaunchProgress {
            stage,
            message,
            progress: 100.0,
            is_running: false,
            process_id: Some(pid),
            exit_code: Some(code),
            crash_report: diagnostics,
            ..Default::default()
        },
    );
    if !accepted {
        tracing::info!(instance = %instance_id, pid, "crash-watcher: progress gone (stopped), skip");
        return;
    }

    settle_play_time(instances, &instance_id, ps.started_at);
    tracing::info!(
        instance = %instance_id,
        code,
        crashed,
        has_report,
        "crash-watcher: exit settled"
    );
}

/// 结算游玩时长（对应 C# WaitForExit 后的 PlayTime 累加）；兜底路径复用。
pub fn settle_play_time(instances: &InstanceService, instance_id: &str, started_at: DateTime<Utc>) {
    let elapsed = (Utc::now() - started_at).num_minutes().max(1);
    if let Some(mut updated) = instances.get_by_id(instance_id) {
        updated.play_time += elapsed as i64;
        updated.last_played = Some(Utc::now().to_rfc3339());
        instances.update(instance_id, updated);
    }
}

/// 收集崩溃诊断文本（多段拼接，段间空行分隔；无任何证据返回 None）。
///
/// 段序对齐 C# 版：crash-reports → hs_err → latest.log/debug.log → 游戏输出缓冲。
fn collect_diagnostics(ctx: &CollectCtx, output_tail: Option<&str>) -> Option<String> {
    let mut sections: Vec<String> = Vec::new();

    // 1. Minecraft crash-reports 最新文件（head 300 + tail 700）
    if let Some(report) = collect_latest_crash_report(ctx) {
        sections.push(report);
    }

    // 2. JVM hs_err 崩溃日志（game_dir 向上遍历，最多 3 个；head 200 + tail 100）
    for entry in collect_hs_err_logs(ctx) {
        sections.push(entry);
    }

    // 3. Minecraft latest.log / debug.log（尾部 200 行）
    let logs_dir = Path::new(&ctx.game_dir).join("logs");
    for name in ["latest.log", "debug.log"] {
        let path = logs_dir.join(name);
        if let Some(entry) = read_recent_lines(&path, 200, name, ctx.cutoff) {
            sections.push(entry);
        }
    }

    // 4. 游戏输出缓冲尾部
    if let Some(out) = output_tail.filter(|s| !s.trim().is_empty()) {
        sections.push(format!("=== 游戏输出 ===\n{out}"));
    }

    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n\n"))
    }
}

/// crash-reports 目录：隔离启用时位于 versions/{name}/ 下，否则在 GameDir 根。
fn collect_latest_crash_report(ctx: &CollectCtx) -> Option<String> {
    let base = Path::new(&ctx.game_dir);
    let dir = if ctx.version_isolation {
        base.join("versions")
            .join(&ctx.version_name)
            .join("crash-reports")
    } else {
        base.join("crash-reports")
    };
    let latest = latest_matching_file(&dir, "*.txt", ctx.cutoff)?;
    read_recent_head_tail(&latest, 300, 700, "Minecraft Crash Report", ctx.cutoff)
}

/// JVM hs_err_pid*.log：从 game_dir 逐级向上查找，取最近修改的最多 3 个（cutoff 过滤）。
fn collect_hs_err_logs(ctx: &CollectCtx) -> Vec<String> {
    let mut entries = Vec::new();
    for dir in ancestors_of(&ctx.game_dir) {
        let mut recent: Vec<PathBuf> = list_matching(&dir, "hs_err_pid*.log")
            .into_iter()
            .filter(|p| modified_after(p, ctx.cutoff))
            .collect();
        sort_by_mtime_desc(&mut recent);
        for f in recent.into_iter().take(3) {
            if let Some(entry) = read_recent_head_tail(&f, 200, 100, &file_name(&f), ctx.cutoff) {
                entries.push(entry);
            }
        }
        if !entries.is_empty() {
            break;
        }
    }
    entries
}

// =====================================================================
// 文件系统辅助
// =====================================================================

/// game_dir 及其祖先目录链（含自身，止于根）。
fn ancestors_of(game_dir: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut cur = Some(PathBuf::from(game_dir));
    while let Some(d) = cur {
        dirs.push(d.clone());
        cur = d.parent().map(Path::to_path_buf);
    }
    dirs
}

/// 简单通配符匹配："hs_err_pid*.log"、"*.txt"、精确名。
fn name_matches(file_name: &str, pattern: &str) -> bool {
    match pattern.split_once('*') {
        Some((prefix, suffix)) => file_name.starts_with(prefix) && file_name.ends_with(suffix),
        None => file_name == pattern,
    }
}

fn list_matching(dir: &Path, pattern: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map_or(false, |n| name_matches(n, pattern))
        })
        .collect()
}

fn latest_matching_file(
    dir: &Path,
    suffix_wildcard: &str,
    cutoff: DateTime<Utc>,
) -> Option<PathBuf> {
    let mut files: Vec<PathBuf> = list_matching(dir, suffix_wildcard)
        .into_iter()
        .filter(|p| modified_after(p, cutoff))
        .collect();
    sort_by_mtime_desc(&mut files);
    files.into_iter().next()
}

fn modified_after(path: &Path, cutoff: DateTime<Utc>) -> bool {
    path.metadata()
        .and_then(|m| m.modified())
        .map(|t| DateTime::<Utc>::from(t) > cutoff)
        .unwrap_or(false)
}

fn sort_by_mtime_desc(files: &mut [PathBuf]) {
    files.sort_by(|a, b| mtime(b).cmp(&mtime(a)));
}

fn mtime(path: &Path) -> Option<std::time::SystemTime> {
    path.metadata().and_then(|m| m.modified()).ok()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string()
}

// =====================================================================
// 行截断读取辅助
// =====================================================================

/// 尾部 N 行 + cutoff 过滤的完整段文本；文件不存在/过旧/读取失败返回 None。
fn read_recent_lines(
    path: &Path,
    max_lines: usize,
    label: &str,
    cutoff: DateTime<Utc>,
) -> Option<String> {
    if !modified_after(path, cutoff) {
        return None;
    }
    let lines = tail_lines(path, max_lines).ok()?;
    if lines.is_empty() {
        return None;
    }
    Some(format!("=== {label} ===\n{}", lines.join("\n")))
}

/// 尾部 max_tail 行 + 头部 head 行 + 中间省略提示（对齐 C# ReadRecentFileHeadTail）。
/// crash-report/hs_err 均为中小文件，直接整体读取；超 16MB 的异常大文件退化为只读尾部。
fn read_recent_head_tail(
    path: &Path,
    head: usize,
    tail: usize,
    label: &str,
    cutoff: DateTime<Utc>,
) -> Option<String> {
    if !modified_after(path, cutoff) {
        return None;
    }
    const MAX_DIRECT_READ: u64 = 16 * 1024 * 1024;
    let lines = match path.metadata().map(|m| m.len()) {
        Ok(size) if size <= MAX_DIRECT_READ => {
            let text = std::fs::read_to_string(path).ok()?;
            let mut lines: Vec<&str> = text.lines().collect();
            if lines.last().map_or(false, |l| l.is_empty()) {
                lines.pop();
            }
            lines.into_iter().map(String::from).collect()
        }
        _ => tail_lines(path, tail).ok()?,
    };
    if lines.len() <= head + tail {
        return Some(format!("=== {label} ===\n{}", lines.join("\n")));
    }
    let mut parts: Vec<String> = lines[..head].to_vec();
    parts.push(format!(
        "... (中间省略 {} 行) ...",
        lines.len() - head - tail
    ));
    parts.extend(lines[lines.len() - tail..].iter().cloned());
    Some(format!("=== {label} ===\n{}", parts.join("\n")))
}

/// 从内存行列表取尾部 N 行拼接。
fn tail_text(lines: &[String], n: usize) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let take = lines.len().saturating_sub(n);
    Some(lines[take..].join("\n"))
}

/// 流式读取文件尾部 N 行（usize::MAX 表示全部），避免大日志整体载入内存。
fn tail_lines(path: &Path, n: usize) -> std::io::Result<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len() as usize;
    const CHUNK: usize = 8192;
    let mut buf: Vec<u8> = Vec::new();
    let mut pos = len;
    let mut newlines = 0usize;
    while pos > 0 && newlines <= n.saturating_add(1) && buf.len() < len {
        let start = pos.saturating_sub(CHUNK);
        let size = pos - start;
        let mut tmp = vec![0u8; size];
        f.seek(SeekFrom::Start(start as u64))?;
        f.read_exact(&mut tmp)?;
        newlines += tmp.iter().filter(|&&b| b == b'\n').count();
        buf.splice(0..0, tmp);
        pos = start;
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.last().map_or(false, |l| l.is_empty()) {
        lines.pop();
    }
    let take = if lines.len() > n { lines.len() - n } else { 0 };
    Ok(lines
        .split_off(take)
        .into_iter()
        .map(String::from)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// temp_dir 下建唯一子目录，返回 (根目录, cutoff 之前的时间点)。
    fn temp_root(tag: &str) -> (PathBuf, DateTime<Utc>) {
        let root = std::env::temp_dir().join(format!(
            "qomicex-crash-watcher-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        (root, Utc::now() - chrono::Duration::seconds(60))
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn collect_includes_recent_crash_report_and_latest_log() {
        let (root, cutoff) = temp_root("collect");
        // 启动之后写入的崩溃报告 + 游戏日志
        write(
            &root
                .join("versions")
                .join("1.20.1-Forge-47")
                .join("crash-reports")
                .join("crash-a.txt"),
            "---- Minecraft Crash Report ----\nnet.minecraftforge...",
        );
        write(
            &root.join("logs").join("latest.log"),
            "line1\nline2\nException in thread main",
        );
        let ctx = CollectCtx {
            game_dir: root.to_string_lossy().into_owned(),
            version_name: "1.20.1-Forge-47".to_string(),
            version_isolation: true,
            cutoff,
        };
        let result = collect_diagnostics(&ctx, Some("stderr line"));
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("Minecraft Crash Report"));
        assert!(text.contains("net.minecraftforge"));
        assert!(text.contains("=== latest.log ==="));
        assert!(text.contains("=== 游戏输出 ==="));
        assert!(text.contains("stderr line"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collect_skips_stale_files_older_than_cutoff() {
        let (root, _cutoff) = temp_root("stale");
        // cutoff 之后才创建的目录里放"旧"报告不可行——直接用 mtime 断言：
        // 先写文件再回拨系统时间做不到，改为把 cutoff 设在未来验证过滤方向。
        write(
            &root.join("crash-reports").join("crash-old.txt"),
            "old crash",
        );
        let ctx = CollectCtx {
            game_dir: root.to_string_lossy().into_owned(),
            version_name: "inst".to_string(),
            version_isolation: false,
            cutoff: Utc::now() + chrono::Duration::hours(1),
        };
        let result = collect_diagnostics(&ctx, None);
        // 所有文件都早于未来 cutoff → 无诊断证据
        assert!(result.is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn tail_lines_handles_short_file_and_truncation() {
        let (root, _) = temp_root("tail");
        let path = root.join("t.log");
        write(&path, "a\nb\nc");

        let all = tail_lines(&path, 10).unwrap();
        assert_eq!(all, vec!["a", "b", "c"]);

        let last2 = tail_lines(&path, 2).unwrap();
        assert_eq!(last2, vec!["b", "c"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn head_tail_inserts_omission_marker_for_long_file() {
        let (root, cutoff) = temp_root("headtail");
        let path = root.join("big.txt");
        // 1200 行 > head(300)+tail(700)，中间必然有省略段
        let body: String = (0..1200)
            .map(|i| format!("L{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        write(&path, &body);

        let entry = read_recent_head_tail(&path, 300, 700, "R", cutoff).unwrap();
        assert!(entry.starts_with("=== R ==="));
        assert!(entry.contains("L0"));
        assert!(entry.contains("L999"));
        assert!(entry.contains("中间省略"));
        // 短文件不插入省略标记
        let short = root.join("short.txt");
        write(&short, "x\ny");
        let entry2 = read_recent_head_tail(&short, 300, 700, "R", cutoff).unwrap();
        assert!(!entry2.contains("中间省略"));
        assert!(entry2.contains("x"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn handle_exit_writes_crashed_state_and_settles_time() {
        use crate::services::instance::InstanceService;
        use crate::services::launch_tracker::LaunchTracker;

        let tracker = LaunchTracker::new();
        let instances = InstanceService::new();
        let game_log = GameLogService::new();

        // 构造一个运行中实例 + running 进度 + 已注册 PID（假 PID，必然不存活）
        let created = instances.create(crate::services::instance::GameInstance {
            name: "crash-test-inst".to_string(),
            game_version: "1.20.1".to_string(),
            ..Default::default()
        });

        tracker.track(&created.id, -1);
        tracker.set_progress(
            &created.id,
            LaunchProgress {
                stage: "running".to_string(),
                message: "游戏运行中".to_string(),
                progress: 100.0,
                is_running: true,
                process_id: Some(-1),
                ..Default::default()
            },
        );

        handle_exit(&tracker, &instances, &game_log, -1, 134).await;

        let p = tracker.get_progress(&created.id).expect("progress kept");
        assert_eq!(p.stage, "crashed");
        assert_eq!(p.exit_code, Some(134));
        assert!(!p.is_running);
        assert!(p.message.contains("134"));
        assert!(tracker.find_by_pid(-1).is_none());
        // 时长已结算（至少记了 1 分钟）
        let updated = instances.get_by_id(&created.id).unwrap();
        assert!(updated.play_time >= 1);
    }

    /// 用户 stop 清掉进度后，watcher 迟到的退出事件不得复活成崩溃终态/结算时长
    /// （Sourcery review 评论 2 的 stop 竞态回归）。
    #[tokio::test]
    async fn handle_exit_skips_when_progress_cleared_by_stop() {
        use crate::services::instance::InstanceService;
        use crate::services::launch_tracker::LaunchTracker;

        let tracker = LaunchTracker::new();
        let instances = InstanceService::new();
        let game_log = GameLogService::new();

        let created = instances.create(crate::services::instance::GameInstance {
            name: "stop-race-inst".to_string(),
            game_version: "1.20.1".to_string(),
            ..Default::default()
        });
        tracker.track(&created.id, -1);
        tracker.set_progress(
            &created.id,
            LaunchProgress {
                stage: "running".to_string(),
                message: "游戏运行中".to_string(),
                progress: 100.0,
                is_running: true,
                process_id: Some(-1),
                ..Default::default()
            },
        );

        // 模拟 launch_cancel → tracker.stop：清取消位 + 进度 + states
        tracker.stop(&created.id);

        handle_exit(&tracker, &instances, &game_log, -1, 134).await;

        assert!(
            tracker.get_progress(&created.id).is_none(),
            "不得写入崩溃终态"
        );
        let updated = instances.get_by_id(&created.id).unwrap();
        assert_eq!(updated.play_time, 0, "不得结算游玩时长");
    }

    /// set_progress_if_running 仅接受 running 阶段（原子条件语义）。
    #[test]
    fn set_progress_if_running_rejects_non_running() {
        use crate::services::launch_tracker::LaunchTracker;

        let tracker = LaunchTracker::new();
        tracker.set_progress(
            "inst",
            LaunchProgress {
                stage: "failed".to_string(),
                message: "启动失败".to_string(),
                is_running: false,
                ..Default::default()
            },
        );
        let accepted = tracker.set_progress_if_running(
            "inst",
            LaunchProgress {
                stage: "crashed".to_string(),
                ..Default::default()
            },
        );
        assert!(!accepted);
        assert_eq!(tracker.get_progress("inst").unwrap().stage, "failed");

        // 进度不存在同样拒绝
        assert!(!tracker.set_progress_if_running("ghost", LaunchProgress::default()));
    }
}
