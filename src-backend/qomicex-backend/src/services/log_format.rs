// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 全进程日志行的唯一格式：`<RFC3339 UTC 毫秒> <LEVEL> [<service>] startup_id=<id> <message>`。
//!
//! 三条来源共用同一套字段：
//! - `tracing` 事件（本 crate 与 connector 经 `LogTracer` 桥接的 `log`）→ 本模块的
//!   [`UnifiedFormat`] 直接写行；
//! - downloader 事件、前端上报、插件、子进程 stdout/stderr → [`format_line`] 生成行；
//! - 两者最终都进 [`crate::services::trace::trace_append`] 落缓冲 + 落盘。
//!
//! 以前后端是 `2026-10-06T12:18:12Z INFO ...`、downloader 是 `[downloader:Info] ...`、
//! 前端是 `[frontend:warn] ...`，三种形状混在一个文件里无法排序聚合；且没有任何字段
//! 标记「哪一次启动」，多天日志只能靠 PID 猜。字段含义见
//! `docs/junsi-dev-docs/8-部署运维/日志格式与字段字典.md`。

use std::borrow::Cow;
use std::fmt;
use std::sync::OnceLock;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::format::{FormatEvent, FormatFields, Writer};
use tracing_subscriber::fmt::FmtContext;
use tracing_subscriber::registry::LookupSpan;

const TIME_FORMAT: &str = "%Y-%m-%dT%H:%M:%S%.3fZ";

/// 本次进程启动的标识（8 位十六进制）。首次调用时生成，进程内恒定。
pub fn startup_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string()[..8].to_string())
}

/// 统一时间戳：ISO8601 UTC 毫秒（本地时间由日志查看器按需转换）。
pub fn timestamp() -> String {
    chrono::Utc::now().format(TIME_FORMAT).to_string()
}

/// 把一条非 tracing 日志（downloader / 前端 / 插件 / 子进程输出）格式化成统一行。
///
/// `level` 用 `tracing` 的级别词汇（`ERROR`/`WARN`/`INFO`/`DEBUG`），子进程原始输出
/// 这类无级别来源用 `LOG`。
pub fn format_line(service: &str, level: &str, message: &str) -> String {
    format!(
        "{} {:<5} [{}] startup_id={} {}",
        timestamp(),
        level.to_ascii_uppercase(),
        service,
        startup_id(),
        sanitize(message)
    )
}

/// 该行是否已带统一前缀（避免 [`crate::services::trace::trace_append`] 二次加前缀）。
pub fn is_formatted(line: &str) -> bool {
    let b = line.as_bytes();
    b.len() >= 24
        && b[4] == b'-'
        && b[10] == b'T'
        && b[19] == b'.'
        && b[23] == b'Z'
        && line.contains("startup_id=")
}

/// 字段名白名单之外还有一层兜底：这些键的值一律不出现在日志里。
const SENSITIVE_FIELDS: [&str; 12] = [
    "password",
    "passwd",
    "token",
    "access_token",
    "refresh_token",
    "authorization",
    "secret",
    "client_secret",
    "api_key",
    "apikey",
    "cookie",
    "session",
];

fn is_sensitive(name: &str) -> bool {
    SENSITIVE_FIELDS
        .iter()
        .any(|s| name.eq_ignore_ascii_case(s))
}

/// 转义控制字符：日志里带 `\x1b` 的消息可以伪造终端输出（远程数据/插件输出会进来）。
fn sanitize(s: &str) -> Cow<'_, str> {
    if !s.bytes().any(|b| b < 0x20 && b != b'\t') && !s.contains('\u{7f}') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push('\t'),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{{{:x}}}", c as u32));
            }
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

/// 自定义 `Debug` 包装：让 `{:?}` 输出也过一遍 [`sanitize`]。
struct Escaped<'a>(&'a dyn fmt::Debug);

impl fmt::Debug for Escaped<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&sanitize(&format!("{:?}", self.0)))
    }
}

/// tracing 事件的格式化器：只写 `[backend]`，级别与 startup_id 由本模块统一给出。
pub struct UnifiedFormat;

impl<S, N> FormatEvent<S, N> for UnifiedFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        write!(
            writer,
            "{} {:<5} [backend] startup_id={} ",
            timestamp(),
            event.metadata().level(),
            startup_id()
        )?;
        {
            let mut visitor = FieldWriter {
                writer: &mut writer,
                result: Ok(()),
            };
            event.record(&mut visitor);
            visitor.result?;
        }
        writeln!(writer)
    }
}

struct FieldWriter<'a, 'b> {
    writer: &'a mut Writer<'b>,
    result: fmt::Result,
}

impl FieldWriter<'_, '_> {
    fn field(&mut self, name: &str, value: &dyn fmt::Debug) {
        self.result = if is_sensitive(name) {
            write!(self.writer, " {name}=[REDACTED]")
        } else {
            write!(self.writer, " {name}={:?}", Escaped(value))
        };
    }
}

impl Visit for FieldWriter<'_, '_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if self.result.is_err() {
            return;
        }
        if field.name() == "message" {
            self.result = self.writer.write_str(&sanitize(value));
        } else if is_sensitive(field.name()) {
            self.result = write!(self.writer, " {}=[REDACTED]", field.name());
        } else if value.is_empty() {
            // 空值一律不输出：`key=` 无法区分「未设置」与「设置为空」。
        } else {
            self.result = write!(self.writer, " {}={}", field.name(), sanitize(value));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if self.result.is_err() {
            return;
        }
        if field.name() == "message" {
            // `format_args!` 的 Debug 就是它自身的文本，不带引号，与默认格式一致。
            self.result = write!(self.writer, "{:?}", Escaped(value));
        } else {
            self.field(field.name(), value);
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    /// 捕获一段时间内所有 tracing 事件的统一格式行（供各模块断言日志内容）。
    pub(crate) fn capture(f: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Buf(Arc<Mutex<Vec<u8>>>);

        impl Write for Buf {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buf {
            type Writer = Buf;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let sink = Buf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(sink.clone())
            .event_format(super::UnifiedFormat)
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        let bytes = sink.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatted_line_is_recognized() {
        let line = format_line("downloader", "warn", "segment split");
        assert!(is_formatted(&line), "{line}");
        assert!(line.contains(" WARN  [downloader] startup_id="), "{line}");
        assert!(line.ends_with(" segment split"), "{line}");
    }

    #[test]
    fn legacy_lines_are_not_formatted() {
        assert!(!is_formatted("[downloader:Info] 探测完成"));
        assert!(!is_formatted("[frontend:warn] updater failed"));
        assert!(!is_formatted("2026-10-06T12:18:12Z  INFO scan"));
    }

    #[test]
    fn timestamp_is_rfc3339_millis_utc() {
        let ts = timestamp();
        assert_eq!(ts.len(), 24, "{ts}");
        assert!(ts.ends_with('Z'), "{ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }

    #[test]
    fn control_chars_cannot_forge_terminal_output() {
        let line = format_line("plugin", "INFO", "a\u{1b}[31mb\r\nc");
        assert!(!line.contains('\u{1b}'));
        assert!(!line.contains('\r'));
        assert!(line.contains(r"a\u{1b}[31mb"));
    }

    #[test]
    fn sensitive_field_names_are_redacted() {
        assert!(is_sensitive("authorization"));
        assert!(is_sensitive("access_token"));
        assert!(is_sensitive("API_KEY"));
        assert!(!is_sensitive("api_key_id"));
        assert!(!is_sensitive("path"));
    }

    /// 格式契约（含 startup_id 注入、空值省略、敏感字段脱敏）：用真实的
    /// fmt subscriber 跑一条事件，断言最终落盘那一行的形状。
    #[test]
    fn tracing_event_uses_the_unified_line_shape() {
        let out = crate::services::log_format::test_support::capture(|| {
            tracing::info!(
                event = "app_ready",
                empty = "",
                token = "secret-value",
                duration_ms = 12u64,
                "启动完成"
            );
        });

        let line = out.trim_end();
        assert!(
            line.contains(" INFO  [backend] startup_id="),
            "缺少统一前缀: {line}"
        );
        assert!(line.contains("启动完成 event=app_ready"), "{line}");
        assert!(line.contains("duration_ms=12"), "{line}");
        assert!(line.contains("token=[REDACTED]"), "{line}");
        assert!(!line.contains("empty="), "空值不应输出: {line}");
        assert!(!line.contains("secret-value"), "{line}");
        assert!(is_formatted(line), "{line}");
    }
}
