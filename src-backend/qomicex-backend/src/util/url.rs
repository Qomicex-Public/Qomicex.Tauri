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
        .map(redact_token)
        .collect::<Vec<_>>()
        .join(" ")
}

/// 处理一个 token：可能含多个 URL，也可能被 JSON 引号/Markdown 括号包裹。
fn redact_token(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    let mut rest = token;
    loop {
        let Some(start) = earliest_scheme(rest) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let candidate_and_after = &rest[start..];
        // 引号/尖括号/反引号不会出现在合法 URL 里，是安全的结束标记。
        let quote_end = candidate_and_after
            .find(['"', '\'', '<', '>', '`'])
            .unwrap_or(candidate_and_after.len());
        let (candidate, after) = candidate_and_after.split_at(quote_end);
        let end = trimmed_end(candidate);
        let (url, trailing) = candidate.split_at(end);
        out.push_str(&redact_url(url));
        out.push_str(trailing);
        rest = after;
        if rest.is_empty() {
            break;
        }
    }
    out
}

/// 同一 token 内最早出现的 `http://` / `https://` 位置。
fn earliest_scheme(text: &str) -> Option<usize> {
    match (text.find("https://"), text.find("http://")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// 去掉 URL 尾部的句末标点，以及**不配对**的右括号（Markdown `](url)` 的 `)`）；
/// 配对的括号属于路径（`a(1).zip`），必须保留，否则 query 会漏出。
fn trimmed_end(token: &str) -> usize {
    let mut end = token.len();
    while let Some(ch) = token[..end].chars().next_back() {
        let trim = match ch {
            ',' | ';' | '。' | '，' | '；' | '、' => true,
            ')' => !has_unclosed(token[..end].chars(), '(', ')'),
            ']' => !has_unclosed(token[..end].chars(), '[', ']'),
            '}' => !has_unclosed(token[..end].chars(), '{', '}'),
            _ => false,
        };
        if !trim {
            break;
        }
        end -= ch.len_utf8();
    }
    end
}

/// 扫到当前位置（含当前字符）时，`open` 是否仍有未闭合的。
fn has_unclosed(chars: impl Iterator<Item = char>, open: char, close: char) -> bool {
    let mut depth = 0i32;
    for ch in chars {
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
        }
    }
    depth > 0
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

    /// JSON 字符串 / Markdown 链接里 URL 前面带 `{"url":"`、`(` 等前缀时也要脱敏。
    #[test]
    fn redacts_urls_wrapped_in_quotes_and_markdown() {
        let json = r#"{"url":"https://user:pass@example.com/a.jar?token=abc","ok":true}"#;
        let got = redact_urls_in_text(json);
        assert!(!got.contains("user"), "实际: {got}");
        assert!(!got.contains("pass"), "实际: {got}");
        assert!(!got.contains("token=abc"), "实际: {got}");
        assert!(got.contains("example.com/a.jar"), "实际: {got}");
        assert!(got.contains(r#""ok":true"#), "非 URL 文本必须保留: {got}");

        let md = "[下载](https://u:p@cdn.example.com/x.zip?sig=1)";
        let got = redact_urls_in_text(md);
        assert!(!got.contains("u:p"), "实际: {got}");
        assert!(!got.contains("sig=1"), "实际: {got}");
        assert!(got.starts_with("[下载]("), "前缀必须保留: {got}");
        assert!(got.ends_with(')'), "后缀必须保留: {got}");

        // URL 自带成对括号时不能被提前截断（否则 query 里的 token 会漏出来）。
        let paren = "see https://cdn.example.com/a(1).zip?token=abc, retry";
        let got = redact_urls_in_text(paren);
        assert!(!got.contains("token=abc"), "实际: {got}");
        assert!(got.contains("a(1).zip"), "实际: {got}");
        assert!(got.contains("retry"), "实际: {got}");

        // 只有协议、后面紧跟终止符时不能被吞掉。
        assert_eq!(redact_urls_in_text("(http://)"), "(http://)");
        assert_eq!(redact_urls_in_text("\"https://\""), "\"https://\"");
    }

    /// 同一个紧凑 token 里的多个 URL 都要脱敏（JSON 日志里很常见）。
    #[test]
    fn redacts_every_url_in_one_token() {
        let json = r#"{"a":"https://u:p@x/a?t=1","b":"http://v:q@y/b?sig=2"}"#;
        let got = redact_urls_in_text(json);
        assert!(!got.contains("u:p"), "实际: {got}");
        assert!(!got.contains("t=1"), "实际: {got}");
        assert!(!got.contains("v:q"), "实际: {got}");
        assert!(!got.contains("sig=2"), "实际: {got}");
        assert!(got.contains("x/a"), "实际: {got}");
        assert!(got.contains("y/b"), "实际: {got}");
    }

    /// 路径里的未配对 `)` 不能截断 URL，否则后面的 query 会原样落日志。
    #[test]
    fn keeps_unbalanced_paren_in_path_and_redacts_query() {
        let got = redact_urls_in_text("https://cdn.example.com/a).zip?token=secret");
        assert!(!got.contains("token=secret"), "实际: {got}");
        assert!(got.contains("a).zip"), "实际: {got}");
    }
}
