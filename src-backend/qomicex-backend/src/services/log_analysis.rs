//! Minecraft 日志/崩溃报告分析引擎（移植自 C# `Qomicex.Core.Modules.Helpers.LogAnalysis`）。
//!
//! 职责：
//! - 加载内嵌 `Resources/error-patterns.json` 模式库（44 种模式）。
//! - 对日志逐行 + 跨行（`(?s)` 前缀的正则）匹配错误模式，填充解决方案模板变量。
//! - 解析崩溃报告头部（版本 / 加载器 / Mod 列表 / 堆栈 / 摘录）。
//! - 去重并按严重级别排序。
//!
//! 无任何 async / 网络依赖，纯 CPU 同步引擎。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;
use serde::Serialize;

const ERROR_PATTERNS_JSON: &str = include_str!("../../Resources/error-patterns.json");

// ---------------------------------------------------------------------------
// 输出模型（与前端 `src/types/index.ts` 的 camelCase 结构逐字段对齐）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedSolution {
    pub title: String,
    pub description: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedIssue {
    pub name: String,
    pub pattern_id: String,
    pub category: String,
    pub severity: String,
    pub line_number: i32,
    pub matched_text: String,
    pub captured_groups: HashMap<String, String>,
    pub solutions: Vec<SuggestedSolution>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogAnalysisResult {
    pub is_success: bool,
    pub minecraft_version: Option<String>,
    pub mod_loader: Option<String>,
    pub loaded_mods: Vec<String>,
    pub stack_trace: Option<String>,
    pub raw_log_excerpt: Option<String>,
    pub issues: Vec<DetectedIssue>,
    pub error_message: Option<String>,
}

// ---------------------------------------------------------------------------
// 模式库数据结构（error-patterns.json）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PatternFile {
    patterns: Vec<PatternDef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatternDef {
    id: String,
    category: String,
    severity: String,
    i18n: HashMap<String, I18nInfo>,
    regex_patterns: Vec<String>,
    solutions: Vec<SolutionDef>,
}

#[derive(Debug, Deserialize)]
struct I18nInfo {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolutionDef {
    description: String,
    action_type: String,
    #[serde(default)]
    parameters: HashMap<String, serde_json::Value>,
}

/// 编译后的模式：单行正则逐行匹配；`(?s)` 前缀的跨行正则整体匹配。
struct CompiledPattern {
    id: String,
    category: String,
    severity: String,
    zh_name: String,
    line_regexes: Vec<Regex>,
    doc_regexes: Vec<Regex>,
    solutions: Vec<SolutionDef>,
}

fn load_patterns() -> &'static Vec<CompiledPattern> {
    static PATTERNS: OnceLock<Vec<CompiledPattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let file: PatternFile =
            serde_json::from_str(ERROR_PATTERNS_JSON).expect("内嵌 error-patterns.json 必须可解析");
        file.patterns
            .into_iter()
            .map(|p| {
                let (line_regexes, doc_regexes) = p.regex_patterns.into_iter().fold(
                    (Vec::new(), Vec::new()),
                    |(mut line, mut doc), raw| {
                        // 编译失败的模式跳过（不该发生，但避免拖垮整个引擎）
                        let re = Regex::new(&raw).unwrap_or_else(|e| {
                            tracing::warn!("错误模式正则编译失败 {:?}: {e}", p.id);
                            return Regex::new("a^").unwrap();
                        });
                        if raw.starts_with("(?s)") {
                            doc.push(re);
                        } else {
                            line.push(re);
                        }
                        (line, doc)
                    },
                );
                let zh_name = p
                    .i18n
                    .get("zh")
                    .map(|i| i.name.clone())
                    .or_else(|| p.i18n.get("en").map(|i| i.name.clone()))
                    .unwrap_or_else(|| p.id.clone());
                CompiledPattern {
                    id: p.id,
                    category: p.category,
                    severity: p.severity,
                    zh_name,
                    line_regexes,
                    doc_regexes,
                    solutions: p.solutions,
                }
            })
            .collect()
    })
}

// ---------------------------------------------------------------------------
// 分析入口
// ---------------------------------------------------------------------------

/// 分析日志/崩溃报告文本，返回可序列化的结果。
pub fn analyze_content(content: &str) -> LogAnalysisResult {
    if content.trim().is_empty() {
        return LogAnalysisResult {
            is_success: false,
            minecraft_version: None,
            mod_loader: None,
            loaded_mods: Vec::new(),
            stack_trace: None,
            raw_log_excerpt: None,
            issues: Vec::new(),
            error_message: Some("日志内容为空，无法分析".to_string()),
        };
    }

    let lines: Vec<&str> = content.lines().collect();

    let mut issues: Vec<DetectedIssue> = Vec::new();
    for pattern in load_patterns() {
        // 1) 单行模式：逐行扫描，一行可命中多个正则（按顺序取首个命中）
        for (idx, line) in lines.iter().enumerate() {
            if let Some(re) = pattern.line_regexes.iter().find(|re| re.is_match(line)) {
                issues.push(build_issue(pattern, re, line, idx));
                break; // 同一行只记一次，避免泛化模式刷屏
            }
        }
        // 2) 跨行模式（`(?s)`）：整体文本找首个命中
        if let Some(re) = pattern.doc_regexes.iter().find(|re| re.is_match(content)) {
            let line_no = content[..re.find(content).unwrap().start()].lines().count();
            issues.push(build_issue(pattern, re, content, line_no));
        }
    }

    let issues = dedup_and_sort(issues);

    LogAnalysisResult {
        is_success: true,
        minecraft_version: parse_version(&lines),
        mod_loader: parse_mod_loader(&lines),
        loaded_mods: parse_mods(&lines),
        stack_trace: parse_stack_trace(&lines),
        raw_log_excerpt: parse_excerpt(&lines),
        issues,
        error_message: None,
    }
}

fn build_issue(
    pattern: &CompiledPattern,
    re: &Regex,
    matched: &str,
    line_idx: usize,
) -> DetectedIssue {
    let cap = re.captures(matched);
    let matched_text = cap
        .as_ref()
        .and_then(|c| c.get(0).map(|m| m.as_str().to_string()))
        .unwrap_or_else(|| matched.to_string());
    // 跨行命中时摘录首行即可（展示不刷屏）
    let matched_text = matched_text.lines().next().unwrap_or("").to_string();

    let captured_groups: HashMap<String, String> = cap
        .map(|c| {
            re.capture_names()
                .enumerate()
                .filter_map(|(i, name)| {
                    let name = name?;
                    let m = c.get(i)?;
                    Some((name.to_string(), m.as_str().to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let solutions = pattern
        .solutions
        .iter()
        .map(|s| {
            let mut desc = s.description.clone();
            // 模板变量：优先捕获组，其次参数
            let mut vars: HashMap<String, String> = HashMap::new();
            for (k, v) in &captured_groups {
                vars.insert(k.clone(), v.clone());
            }
            for (k, v) in &s.parameters {
                vars.entry(k.clone()).or_insert_with(|| {
                    v.as_str()
                        .map(String::from)
                        .unwrap_or_else(|| v.to_string())
                });
            }
            for (k, v) in vars {
                desc = desc.replace(&format!("{{{k}}}"), &v);
            }
            let title = truncate(&desc, 30);
            SuggestedSolution {
                title,
                description: desc,
                action: s.action_type.clone(),
            }
        })
        .collect();

    DetectedIssue {
        name: pattern.zh_name.clone(),
        pattern_id: pattern.id.clone(),
        category: pattern.category.clone(),
        severity: pattern.severity.clone(),
        line_number: (line_idx + 1) as i32,
        matched_text,
        captured_groups,
        solutions,
    }
}

fn truncate(s: &str, n: usize) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(n).collect();
    if chars.next().is_some() {
        format!("{head}...")
    } else {
        head
    }
}

// ---------------------------------------------------------------------------
// 去重 + 排序（对齐 C# `DeduplicateAndSortIssues`）
// ---------------------------------------------------------------------------

fn severity_rank(severity: &str) -> i32 {
    match severity {
        "Critical" => 3,
        "Error" => 2,
        "Warning" => 1,
        _ => 0,
    }
}

fn dep_patterns() -> [&'static str; 3] {
    [
        "missing-dependency",
        "fabric-dependency-missing",
        "quilt-mod-resolution",
    ]
}

fn err_patterns() -> [&'static str; 3] {
    ["fabric-error", "quilt-error", "incompatible-mod-set"]
}

fn is_duplicate(existing: &DetectedIssue, candidate: &DetectedIssue) -> bool {
    let same = existing.pattern_id == candidate.pattern_id;

    // 同模式、行号接近（±10）视为同一次问题
    if same && (existing.line_number - candidate.line_number).abs() <= 10 {
        return true;
    }

    // 依赖缺失类：捕获的 modB 相同 → 同一问题
    if dep_patterns().contains(&existing.pattern_id.as_str())
        && dep_patterns().contains(&candidate.pattern_id.as_str())
    {
        let a = existing.captured_groups.get("modB");
        let b = candidate.captured_groups.get("modB");
        if a.is_some() && a == b {
            return true;
        }
    }

    // 加载器错误类：行号接近或同为 FormattedException
    if err_patterns().contains(&existing.pattern_id.as_str())
        && err_patterns().contains(&candidate.pattern_id.as_str())
    {
        if (existing.line_number - candidate.line_number).abs() <= 10 {
            return true;
        }
        if existing.matched_text.contains("FormattedException")
            && candidate.matched_text.contains("FormattedException")
        {
            return true;
        }
    }

    // Mod 版本冲突：冲突双方相同
    if existing.pattern_id == "mod-version-conflict"
        && candidate.pattern_id == "mod-version-conflict"
    {
        let same_pair = |a: &DetectedIssue, b: &DetectedIssue| {
            a.captured_groups.get("modA") == b.captured_groups.get("modA")
                && a.captured_groups.get("modB") == b.captured_groups.get("modB")
        };
        if same_pair(existing, candidate) {
            return true;
        }
    }

    // 重复 Mod：modId 相同
    if existing.pattern_id == "mod-duplicate" && candidate.pattern_id == "mod-duplicate" {
        let a = existing.captured_groups.get("modId");
        let b = candidate.captured_groups.get("modId");
        if a.is_some() && a == b {
            return true;
        }
    }

    // 匹配文本完全相同 + 同模式
    same && existing.matched_text.trim() == candidate.matched_text.trim()
}

fn dedup_and_sort(mut issues: Vec<DetectedIssue>) -> Vec<DetectedIssue> {
    let mut unique: Vec<DetectedIssue> = Vec::new();
    for issue in issues.drain(..) {
        if !unique.iter().any(|e| is_duplicate(e, &issue)) {
            unique.push(issue);
        }
    }
    unique.sort_by(|a, b| {
        severity_rank(&b.severity)
            .cmp(&severity_rank(&a.severity))
            .then(a.line_number.cmp(&b.line_number))
    });
    unique
}

// ---------------------------------------------------------------------------
// 崩溃报告头解析（对齐 C# `CrashReportAnalyzer`）
// ---------------------------------------------------------------------------

fn parse_version(lines: &[&str]) -> Option<String> {
    for line in lines {
        if let Some(v) = line.strip_prefix("Minecraft Version:") {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    // 启动日志格式："Loading Minecraft 1.20.1-Quilt" / "Minecraft version: 1.20.1"
    let re = Regex::new(r"(?i)Loading Minecraft\s+(\d+\.\d+\.?\d*)").unwrap();
    for line in lines {
        if let Some(c) = re.captures(line) {
            return Some(c[1].to_string());
        }
    }
    let re = Regex::new(r"(?i)Minecraft[\s\w]*[:\s]+(\d+\.\d+\.?\d*)").unwrap();
    for line in lines {
        if let Some(c) = re.captures(line) {
            return Some(c[1].to_string());
        }
    }
    None
}

fn parse_mod_loader(lines: &[&str]) -> Option<String> {
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.contains("quilt") {
            let v = Regex::new(r"(?i)Quilt\s+Loader\s+(\d+\.\d+\.?\d*)")
                .unwrap()
                .captures(line)
                .map(|c| c[1].to_string());
            return Some(
                format!("Quilt {}", v.unwrap_or_default())
                    .trim_end()
                    .to_string(),
            );
        }
        if lower.contains("neoforge") {
            return Some("NeoForge".to_string());
        }
        if lower.contains("forge") || lower.contains("fml") || lower.contains("modloader") {
            let v = Regex::new(r"Forge[^\d]*(\d+\.\d+\.\d+)")
                .unwrap()
                .captures(line)
                .map(|c| c[1].to_string());
            return Some(
                format!("Forge {}", v.unwrap_or_default())
                    .trim_end()
                    .to_string(),
            );
        }
        if lower.contains("fabric") && !lower.contains("quilt") {
            let v = Regex::new(r"(?i)Fabric[^\d]*(\d+\.\d+\.\d+)")
                .unwrap()
                .captures(line)
                .map(|c| c[1].to_string());
            return Some(
                format!("Fabric {}", v.unwrap_or_default())
                    .trim_end()
                    .to_string(),
            );
        }
    }
    None
}

fn parse_mods(lines: &[&str]) -> Vec<String> {
    let mut mods = Vec::new();
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if line.contains("-- Loaded Mods --")
            || line.contains("Loaded coremods")
            || line.contains("Loading X mods")
        {
            start = Some(i);
            break;
        }
    }
    let Some(start) = start else {
        return mods;
    };
    let forge = Regex::new(r"^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|").unwrap();
    let fabric = Regex::new(r"^-\s+(\S+)\s+(\S+)").unwrap();
    for line in lines.iter().skip(start + 1).take(200) {
        if line.starts_with("-- ") || line.starts_with("====") {
            break;
        }
        if let Some(c) = forge.captures(line) {
            let id = c[1].trim();
            if !id.is_empty() {
                mods.push(id.to_string());
            }
            continue;
        }
        if let Some(c) = fabric.captures(line) {
            mods.push(c[1].to_string());
        }
    }
    mods
}

fn parse_stack_trace(lines: &[&str]) -> Option<String> {
    let mut stack = Vec::new();
    for line in lines {
        let t = line.trim();
        if t.starts_with("java.lang.")
            || t.starts_with("at ")
            || t.starts_with("Caused by:")
            || t.contains("Exception:")
            || t.contains("Error:")
            || t.contains("Exception in thread")
        {
            stack.push(t.to_string());
            if stack.len() >= 50 {
                break;
            }
        }
    }
    if stack.is_empty() {
        None
    } else {
        Some(stack.join("\n"))
    }
}

fn parse_excerpt(lines: &[&str]) -> Option<String> {
    let excerpt: Vec<&str> = lines
        .iter()
        .take(100)
        .filter(|l| !l.chars().all(|c| c == '-' || c == '=' || c == '#'))
        .copied()
        .collect();
    if excerpt.is_empty() {
        None
    } else {
        Some(excerpt.join("\n"))
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_oom_and_gpu_patterns() {
        let oom = "java.lang.OutOfMemoryError: Java heap space\n\tat net.minecraft...\nLoading Minecraft 1.20.1-Forge";
        let r = analyze_content(oom);
        assert!(r.is_success);
        assert_eq!(r.minecraft_version.as_deref(), Some("1.20.1"));
        assert!(r
            .issues
            .iter()
            .any(|i| i.pattern_id == "out-of-memory-heap"));
        assert_eq!(r.issues[0].severity, "Critical");

        let gpu = "---- Minecraft Crash Report ----\n\nA detailed walkthrough...\n\n-- System Details --\n\nJava VM Version: ...\n\n#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x000...\n#\n# C  [ig9x86-64.dll+0x5a]\n#";
        let r = analyze_content(gpu);
        assert!(r
            .issues
            .iter()
            .any(|i| i.pattern_id == "gpu-intel-access-violation"));
    }

    #[test]
    fn parses_loaded_mods_and_version() {
        let log = "Minecraft Version: 1.19.2\n\n-- Loaded Mods --\n\n| modA | 1.0.0 | moda-1.0.0.jar |\n| modB | 2.0.0 | modb-2.0.0.jar |\n";
        let r = analyze_content(log);
        assert!(r.issues.is_empty());
        assert_eq!(r.loaded_mods, vec!["modA", "modB"]);
    }

    #[test]
    fn dedups_close_duplicate_issues() {
        let log = "\nException in thread \"main\"\nException in thread \"main\"\njava.lang.NoSuchMethodError: x\n";
        let r = analyze_content(log);
        let count = r
            .issues
            .iter()
            .filter(|i| i.pattern_id == "quilt-error")
            .count();
        assert!(count <= 1, "相同模式相邻行应去重，实际 {count}");
    }
}
