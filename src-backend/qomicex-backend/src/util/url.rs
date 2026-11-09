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
            // URL 可能嵌在 token 中间（JSON 字符串、Markdown 链接等）：
            // 找到第一个 http(s):// 后，前缀原样保留，只脱敏 URL 本体。
            let Some(start) = token.find("https://").or_else(|| token.find("http://")) else {
                return token.to_string();
            };
            let (prefix, rest) = token.split_at(start);
            // URL 到成对的引号/括号/尖括号为止；其余走到 token 尾（再交给
            // `split_trailing_punct` 去掉句末标点）。否则 JSON 里的
            // `...?token=x","next":1}` 会把尾部一起塞进 Url::parse 导致解析失败。
            let end = rest
                .find(['"', '\'', '<', '>', '`', ')', ']', '}'])
                .unwrap_or(rest.len());
            let (url_part, suffix) = rest.split_at(end);
            let (url, trailing) = split_trailing_punct(url_part);
            if url.len() < "http://".len() {
                return token.to_string();
            }
            format!("{prefix}{}{trailing}{suffix}", redact_url(url))
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
            ')' | ']'
                | '}'
                | ','
                | ';'
                | '。'
                | '，'
                | '；'
                | '）'
                | '】'
                | '"'
                | '\''
                | '<'
                | '>'
                | '`'
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
    }
}
