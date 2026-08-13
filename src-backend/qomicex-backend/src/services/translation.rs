//! 翻译服务（对应 C# Neo `Services/Translation/`：ITranslationService + 三个实现 +
//! TextProtector）。
//!
//! - `MyMemory`：`api.mymemory.translated.net`，免费无需 key，文本超过 480 字符按句
//!   分块、块间延迟 1s（源 Task.Delay(1000)）。
//! - `Google`：`translate.googleapis.com`（client=gtx），翻译后做全角标点修正
//!   （源 FixMarkdownPunctuation）。
//! - `Bing`：Microsoft Translator v3，需要 API key；无 key 直接返回未翻译
//!   （源判空即 null）。
//!
//! 文本保护（TextProtector）：翻译前把 HTML 注释/标签、图片、链接、裸 URL、软换行
//! 替换为占位符，翻译完成后再还原，避免翻译器破坏 Markdown 结构。

use std::collections::HashMap;

use serde_json::Value;

/// 翻译提供商（源：`ITranslationService` + Program.cs 按 settings 分派）。
pub enum TranslationProvider {
    MyMemory,
    Google,
    Bing(Option<String>),
}

/// 文本保护占位符映射（源：TextProtector.Protect / Restore）。
pub fn protect(text: &str) -> (String, HashMap<String, String>) {
    let mut map = HashMap::new();
    let mut index = 0usize;

    let mut result = String::from(text);

    // 1. HTML 注释 `<!-- ... -->`（Singleline：`.*` 跨行）
    let mut next = String::new();
    let mut rest = result.as_str();
    while let Some(start) = rest.find("<!--") {
        next.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail.find("-->").map(|e| e + 3).unwrap_or(tail.len());
        let key = format!("ZMCOM{index:04}");
        index += 1;
        map.insert(key.clone(), tail[..end].to_string());
        next.push_str(&key);
        rest = &tail[end..];
    }
    next.push_str(rest);
    result = next;

    // 2. HTML 标签 `</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?/?>`
    let mut next = String::new();
    let mut rest = result.as_str();
    while let Some(rel) = rest.find('<') {
        let tail = &rest[rel..];
        let rest_of_tag = &tail[1..];
        let first = rest_of_tag.chars().next();
        let is_tag =
            matches!(first, Some(c) if c.is_ascii_alphabetic()) || rest_of_tag.starts_with('/');
        if is_tag {
            let mut end = 1usize;
            for (i, c) in rest_of_tag.char_indices() {
                if c == '>' {
                    end = 1 + i + 1;
                    break;
                }
            }
            let key = format!("ZMTAG{index:04}");
            index += 1;
            map.insert(key.clone(), tail[..end].to_string());
            next.push_str(&tail[..rel]);
            next.push_str(&key);
            rest = &tail[end..];
        } else {
            next.push_str(&tail[..1]);
            rest = &tail[1..];
        }
    }
    next.push_str(rest);
    result = next;

    // 3. 图片 `![alt](url)`
    result = protect_markdown(&result, "![", "ZMIMG", &mut index, &mut map);

    // 4. 链接 `[text](url)`（非图片，前置非 !）
    result = protect_markdown(&result, "[", "ZMLNK", &mut index, &mut map);

    // 5. 裸 URL `https?://[^\s)]+`（已在 map 中的跳过——源 ContainsValue 检查）
    let mut next = String::new();
    let mut rest = result.as_str();
    while let Some((start, end)) = find_url(rest) {
        next.push_str(&rest[..start]);
        let url = &rest[start..end];
        if !map.values().any(|v| v == url) {
            let key = format!("ZMURL{index:04}");
            index += 1;
            map.insert(key.clone(), url.to_string());
            next.push_str(&key);
        } else {
            next.push_str(url);
        }
        rest = &rest[end..];
    }
    next.push_str(rest);
    result = next;

    // 6. 软换行 `  \n`（Markdown 行尾两空格换行）
    let mut next = String::new();
    let mut rest = result.as_str();
    while let Some(rel) = rest.find("  \n") {
        next.push_str(&rest[..rel]);
        let key = format!("ZMBRK{index:04}");
        index += 1;
        map.insert(key.clone(), "  \n".to_string());
        next.push_str(&key);
        rest = &rest[rel + 3..];
    }
    next.push_str(rest);
    result = next;

    (result, map)
}

/// 还原占位符（源：Restore —— 逐项 Replace）。
pub fn restore(text: &str, map: &HashMap<String, String>) -> String {
    let mut result = String::from(text);
    for (key, value) in map {
        result = result.replace(key, value);
    }
    result
}

/// Markdown 图片/链接占位（源 ImageRegex / LinkRegex）：
/// `[text](url)` 模式，前缀为 `![`（图片）或 `[`（链接，前一个字符非 !）。
fn protect_markdown(
    text: &str,
    prefix: &str,
    key_prefix: &str,
    index: &mut usize,
    map: &mut HashMap<String, String>,
) -> String {
    let mut next = String::new();
    let mut rest = text;
    let mut search_from = 0usize;
    while let Some(rel) = rest[search_from..].find(prefix) {
        let abs = search_from + rel;
        if prefix == "[" && abs > 0 && &rest[abs - 1..abs] == "!" {
            // 链接正则 `(?<!!)\[` —— 图片已被保护，跳过已占位的 `![...]`
            let end = rest[abs..]
                .find(']')
                .map(|e| abs + e + 1)
                .unwrap_or(rest.len());
            search_from = end;
            continue;
        }
        let head = &rest[abs..];
        let Some(close_idx) = head.find(']') else {
            break;
        };
        if head[close_idx..].starts_with("](") {
            let Some(paren_end) = head[close_idx + 2..].find(')') else {
                search_from = abs + close_idx + 1;
                continue;
            };
            let end = close_idx + 2 + paren_end + 1;
            let key = format!("{key_prefix}{index:04}");
            *index += 1;
            map.insert(key.clone(), head[..end].to_string());
            next.push_str(&rest[..abs]);
            next.push_str(&key);
            rest = &head[end..];
            search_from = 0;
        } else {
            search_from = abs + 1;
        }
    }
    next.push_str(rest);
    next
}

/// 在 `s` 中找下一个 `http(s)://` 直到空白或 `)` 的位置。
fn find_url(s: &str) -> Option<(usize, usize)> {
    let start = s.find("http://").or_else(|| s.find("https://"))?;
    let rest = &s[start..];
    let end = rest
        .find(|c| c == ' ' || c == '\n' || c == '\t' || c == ')')
        .unwrap_or(rest.len());
    Some((start, start + end))
}

/// 翻译入口（源：TranslateAsync + provider 分派）。
pub async fn translate(
    http: &reqwest::Client,
    provider: &TranslationProvider,
    text: &str,
) -> Option<String> {
    match provider {
        TranslationProvider::Google => google_translate(http, text).await,
        TranslationProvider::Bing(key) => bing_translate(http, key.as_deref(), text).await,
        TranslationProvider::MyMemory => mymemory_translate(http, text, 480).await,
    }
}

/// MyMemory 免费翻译（源：MyMemoryTranslationService）。
///
/// `langpair=en|zh-CN`；每块最长 `max_chunk` 字符（源 MaxChunkLength=480），按
/// `.` `!` `?` `\n` 切句（源 SplitText），块间 sleep 1s（源 Task.Delay(1000)）。
async fn mymemory_translate(
    http: &reqwest::Client,
    text: &str,
    max_chunk: usize,
) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    if text.len() <= max_chunk {
        return mymemory_chunk(http, text).await;
    }
    let chunks = split_text(text, max_chunk);
    let mut results = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if let Some(t) = mymemory_chunk(http, chunk).await {
            results.push(t);
        }
    }
    if results.is_empty() {
        None
    } else {
        Some(results.join("\n\n"))
    }
}

async fn mymemory_chunk(http: &reqwest::Client, chunk: &str) -> Option<String> {
    let url = format!(
        "https://api.mymemory.translated.net/get?q={}&langpair=en%7Czh-CN",
        urlencode(chunk)
    );
    let body = http.get(&url).send().await.ok()?.text().await.ok()?;
    let doc: Value = serde_json::from_str(&body).ok()?;
    doc.get("responseData")?
        .get("translatedText")?
        .as_str()
        .map(String::from)
}

/// Google 免费翻译（源：GoogleTranslationService）。
/// `client=gtx&sl=en&tl=zh-CN&dt=t`，响应为嵌套数组；翻译后全角标点修正。
async fn google_translate(http: &reqwest::Client, text: &str) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q={}",
        urlencode(text)
    );
    let body = http.get(&url).send().await.ok()?.text().await.ok()?;
    let doc: Value = serde_json::from_str(&body).ok()?;
    let mut result = String::new();
    if let Some(segments) = doc
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_array)
    {
        for seg in segments {
            if let Some(t) = seg
                .as_array()
                .and_then(|s| s.first())
                .and_then(Value::as_str)
            {
                if !t.is_empty() {
                    result.push_str(t);
                }
            }
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(fix_markdown_punctuation(&result))
    }
}

/// Bing 翻译（源：BingTranslationService）。无 key 直接返回 None。
async fn bing_translate(
    http: &reqwest::Client,
    api_key: Option<&str>,
    text: &str,
) -> Option<String> {
    let key = api_key?;
    if key.is_empty() || text.trim().is_empty() {
        return None;
    }
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    let body = format!("[{{\"Text\":\"{escaped}\"}}]");
    let resp = http
        .post("https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans")
        .header("Content-Type", "application/json")
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Ocp-Apim-Subscription-Region", "global")
        .body(body)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let doc: Value = serde_json::from_str(&body).ok()?;
    doc.as_array()?
        .first()?
        .get("translations")?
        .as_array()?
        .first()?
        .get("text")?
        .as_str()
        .map(String::from)
}

/// 源 SplitText：按 `.` `!` `?` `\n` 切句、trim、跳过空句，超长则新开块。
fn split_text(text: &str, max_length: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut sb = String::new();
    for part in text.split(['.', '!', '?', '\n']) {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if sb.len() + trimmed.len() > max_length && !sb.is_empty() {
            chunks.push(sb.trim().to_string());
            sb.clear();
        }
        if !sb.is_empty() {
            sb.push(' ');
        }
        sb.push_str(trimmed);
    }
    if !sb.is_empty() {
        chunks.push(sb.trim().to_string());
    }
    chunks
}

/// 源 FixMarkdownPunctuation：全角标点 → 半角（保 Markdown 语法）。
fn fix_markdown_punctuation(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{ff08}' => '(',
            '\u{ff09}' => ')',
            '\u{ff3b}' => '[',
            '\u{ff3d}' => ']',
            '\u{ff5b}' => '{',
            '\u{ff5d}' => '}',
            '\u{ff03}' => '#',
            '\u{ff01}' => '!',
            '\u{ff0a}' => '*',
            '\u{ff40}' => '`',
            '\u{ff1c}' => '<',
            '\u{ff1e}' => '>',
            '\u{ff0f}' => '/',
            other => other,
        })
        .collect()
}

/// URI 编码（源 Uri.EscapeDataString —— 保留字母数字与 -._~）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 按 settings 的 translation_provider 选择服务（源 Program.cs 注入 + switch）。
pub fn create_provider(provider: &str, bing_api_key: Option<String>) -> TranslationProvider {
    match provider {
        "google" => TranslationProvider::Google,
        "bing" => TranslationProvider::Bing(bing_api_key),
        _ => TranslationProvider::MyMemory,
    }
}
