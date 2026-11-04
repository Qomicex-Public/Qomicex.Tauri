// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 日志用 URL 脱敏。
//!
//! 下载源常带签名/令牌（CurseForge、对象存储、临时直链），完整 URL 落盘会把
//! 凭据写进日志。这里只保留 scheme/host/path，userinfo 与 query 统一替换为
//! `***`；错误链里夹带的 URL 也做同样处理。

/// 脱敏单个绝对 URL。解析失败时原样返回（可能是相对路径/非 URL 文本）。
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return raw.to_string();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("***");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("***"));
    }
    if url.query().is_some() {
        url.set_query(Some("redacted"));
    }
    url.to_string()
}

/// 对一段文本里出现的 http(s) URL 逐个脱敏；保留原有空白与标点。
pub fn redact_urls_in_text(text: &str) -> String {
    text.split_whitespace()
        .map(|token| {
            let (url, suffix) = split_trailing_punct(token);
            if url.starts_with("http://") || url.starts_with("https://") {
                format!("{}{suffix}", redact_url(url))
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 把 `url)` / `url,` / `url。` 里的尾部标点拆出来，避免 `Url::parse` 失败。
fn split_trailing_punct(token: &str) -> (&str, &str) {
    let mut end = token.len();
    for (idx, ch) in token.char_indices().rev() {
        if matches!(
            ch,
            ')' | ']' | '}' | ',' | ';' | '。' | '，' | '；' | '）' | '】'
        ) {
            end = idx;
        } else {
            break;
        }
    }
    token.split_at(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_userinfo_and_query() {
        let got = redact_url("https://user:pass@example.com/a.jar?token=secret&x=1");
        assert!(!got.contains("user"));
        assert!(!got.contains("pass"));
        assert!(!got.contains("secret"));
        assert!(got.contains("example.com/a.jar"));
    }

    #[test]
    fn redacts_urls_inside_error_text() {
        let got = redact_urls_in_text(
            "download failed: https://cdn.example.com/a.jar?sig=abc, retry later",
        );
        assert!(!got.contains("sig=abc"));
        assert!(got.contains("cdn.example.com/a.jar"));
        assert!(got.contains("retry later"));
    }
}
