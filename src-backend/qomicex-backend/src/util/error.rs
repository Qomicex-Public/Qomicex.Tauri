// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 错误链格式化：把 `Display` 之外的真实原因（DNS/TLS/连接重置/解析位置）
//! 一并带进日志与 ApiError.detail。reqwest 的 Display 通常只有
//! 「error sending request for url (...)」，真正原因在 `source()` 链里。

/// 展开错误链，最多 6 层，用 ` <- ` 连接。
pub fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    let mut depth = 0;
    while let Some(cause) = source {
        if depth >= 5 {
            break;
        }
        out.push_str(" <- ");
        out.push_str(&cause.to_string());
        source = cause.source();
        depth += 1;
    }
    out
}

/// 文件 IO 错误带上路径与错误类型，避免只剩「os error 2」。
pub fn io_context(path: impl std::fmt::Display, err: &std::io::Error) -> String {
    format!(
        "{path}: {} (kind={:?}, os={:?})",
        err,
        err.kind(),
        err.raw_os_error()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Inner;
    impl std::fmt::Display for Inner {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "inner")
        }
    }
    impl std::error::Error for Inner {}

    #[derive(Debug)]
    struct Outer(Inner);
    impl std::fmt::Display for Outer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "outer")
        }
    }
    impl std::error::Error for Outer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn error_chain_includes_sources() {
        assert_eq!(error_chain(&Outer(Inner)), "outer <- inner");
    }

    #[test]
    fn io_context_includes_path_and_kind() {
        let err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let s = io_context("C:/x/y.jar", &err);
        assert!(s.contains("C:/x/y.jar"));
        assert!(s.contains("NotFound"));
    }
}
