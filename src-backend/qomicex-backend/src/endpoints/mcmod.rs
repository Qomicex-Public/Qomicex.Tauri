//! Mcmod endpoints (source: Endpoints/McmodEndpoints.cs + Services/McmodService.cs).
//!
//! Mounted under `/api/mcmod`. Provides offline Chinese-name lookup for mods
//! using an embedded (or runtime-overridden) mcmod.cn dump. The service is a
//! private module struct (self-contained slice), lazily built at first request
//! via a process-level OnceLock.
//!
//! NOTE: unlike the task description, the C# source does NOT perform any remote
//! mcmod.cn search over HTTP. The exposed routes are offline-only:
//!   - `/mcmod/lookup`  : single English->Chinese name lookup
//!   - `/mcmod/batch`   : bulk English->Chinese name backfill
//! Consequently `state.http_client` is not exercised by these handlers.

use std::collections::HashMap;
use std::sync::OnceLock;

use axum::extract::Query;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiResult;
use crate::state::SharedState;

/// Embedded mcmod.cn data dump (same file the C# backend embeds).
/// Path resolved relative to this source file:
/// `src-backend/qomicex-backend/src/endpoints/` -> `src-backend/Qomicex.Launcher.Backend.Neo/Resources/`.
const EMBEDDED_MCMOD_JSON: &str =
    include_str!("../../../Qomicex.Launcher.Backend.Neo/Resources/mcmod_data.json");

/// Runtime override path: `{BaseDir}/QML/mcmod_data.json` (checked first).
const RUNTIME_OVERRIDE_REL: &str = "QML/mcmod_data.json";

struct ReverseEntry {
    aliases: Vec<String>,
    search_term: String,
    id: i32,
}

/// Immutable offline index built once from the mcmod.cn dump.
struct McmodData {
    /// Normalized English key -> (Chinese name, mcmod.cn id).
    forward: HashMap<String, (String, i32)>,
    /// Chinese alias candidates for reverse (Chinese -> English slug) resolution.
    reverse: Vec<ReverseEntry>,
}

impl McmodData {
    fn load() -> Self {
        let mut data = McmodData {
            forward: HashMap::new(),
            reverse: Vec::new(),
        };

        let json = runtime_override().unwrap_or_else(|| EMBEDDED_MCMOD_JSON.to_string());
        let Ok(root) = serde_json::from_str::<Value>(&json) else {
            return data;
        };
        let Some(mods) = root.get("mods").filter(|v| v.is_array()) else {
            return data;
        };
        for entry in mods.as_array().expect("mods is array") {
            index_entry(&mut data, entry);
        }
        data
    }

    fn lookup(&self, en_name: &str) -> Option<String> {
        let key = normalize_en(en_name);
        if key.is_empty() {
            return None;
        }
        self.forward.get(&key).map(|(cn, _id)| cn.clone())
    }

    /// Reverse resolution of a Chinese keyword to an English slug term.
    /// Kept for parity with McmodService.ResolveChineseSearch; not wired to any
    /// route in the source.
    #[allow(dead_code)]
    fn resolve_chinese_search(&self, keyword: &str) -> Option<&str> {
        let keyword = keyword.trim();
        if keyword.is_empty() || !contains_chinese(keyword) {
            return None;
        }
        let query: String = keyword.chars().filter(|c| !c.is_whitespace()).collect();
        if query.is_empty() {
            return None;
        }

        let mut best: Option<&ReverseEntry> = None;
        let mut best_score = 0usize;
        let mut best_alias_len = usize::MAX;

        for entry in &self.reverse {
            for alias in &entry.aliases {
                let score: usize = if alias == &query {
                    1000
                } else if alias.contains(query.as_str()) || query.contains(alias.as_str()) {
                    let a_len = alias.chars().count();
                    let q_len = query.chars().count();
                    a_len.min(q_len) * 100 / a_len.max(q_len)
                } else {
                    continue;
                };

                if score < 50 {
                    continue;
                }

                let alias_len = alias.chars().count();
                let better = score > best_score
                    || (score == best_score && alias_len < best_alias_len)
                    || (score == best_score
                        && alias_len == best_alias_len
                        && best.is_some()
                        && entry.id < best.as_ref().expect("best already bound").id);
                if better {
                    best = Some(entry);
                    best_score = score;
                    best_alias_len = alias_len;
                }
            }
        }

        best.map(|e| e.search_term.as_str())
    }
}

/// Build the forward + reverse index for a single `mods[]` entry.
fn index_entry(data: &mut McmodData, entry: &Value) {
    let id = entry
        .get("id")
        .and_then(Value::as_i64)
        .unwrap_or(0) as i32;
    let cn_name = entry
        .get("cn")
        .and_then(|c| c.get("name"))
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let mut slugs: Vec<String> = Vec::new();
    if let Some(arr) = entry.get("slug").and_then(Value::as_array) {
        for slug in arr {
            for key in ["both", "cf", "mr"] {
                if let Some(val) = slug.get(key).and_then(Value::as_str) {
                    let trimmed = val.trim();
                    if !trimmed.is_empty() {
                        slugs.push(trimmed.to_string());
                    }
                }
            }
        }
    }

    let mut english_keys: Vec<String> = Vec::new();
    for slug in &slugs {
        add_key(&mut english_keys, slug);
    }
    if let Some(cn) = &cn_name {
        for parenthesized in paren_contents(cn) {
            add_key(&mut english_keys, &parenthesized);
        }
    }

    if let Some(cn) = &cn_name {
        if !cn.is_empty() {
            for key in english_keys {
                data.forward.entry(key).or_insert_with(|| (cn.clone(), id));
            }
        }
    }

    let Some(search_term) = first_slug_term(&slugs) else {
        return;
    };

    let aliases = chinese_aliases(cn_name.as_deref());
    if aliases.is_empty() {
        return;
    }

    data.reverse.push(ReverseEntry {
        aliases,
        search_term,
        id,
    });
}

fn add_key(keys: &mut Vec<String>, raw: &str) {
    let k = normalize_en(raw);
    if !k.is_empty() && !keys.contains(&k) {
        keys.push(k);
    }
}

/// Content of every `( ... )` group (no nesting), matching C# ParenRegex.
fn paren_contents(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut rest = s;
    while let Some(open) = rest.find('(') {
        let after_open = &rest[open + 1..];
        match after_open.find(')') {
            Some(close) => {
                result.push(after_open[..close].to_string());
                rest = &after_open[close + 1..];
            }
            None => break,
        }
    }
    result
}

/// Remove every ` (content)` (no nesting) plus its leading whitespace,
/// matching C# StripParenRegex.Replace.
fn strip_parens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('(') {
        let prefix = &rest[..open];
        let after_open = &rest[open + 1..];
        match after_open.find(')') {
            Some(close) => {
                out.push_str(prefix.trim_end());
                rest = &after_open[close + 1..];
            }
            None => {
                out.push_str(prefix);
                out.push('(');
                rest = after_open;
            }
        }
    }
    out.push_str(rest);
    out
}

fn chinese_aliases(cn_name: Option<&str>) -> Vec<String> {
    let mut result = Vec::new();
    let Some(cn) = cn_name else {
        return result;
    };
    if cn.is_empty() {
        return result;
    }
    let stripped = strip_parens(cn);
    for part in stripped.split('/') {
        let alias = part.trim();
        if !alias.is_empty() && contains_chinese(alias) {
            result.push(alias.to_string());
        }
    }
    result
}

fn first_slug_term(slugs: &[String]) -> Option<String> {
    let term = slugs.first()?.replace('-', " ");
    let trimmed = term.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Keep only alphanumeric chars, lowercased (matches C# char.IsLetterOrDigit +
/// char.ToLowerInvariant). `char::to_lowercase` may expand an odd char into
/// multiple code points, which is a minor divergence for CJK input.
fn normalize_en(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
        }
    }
    out
}

fn contains_chinese(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// Runtime override file (checked before the embedded dump), matching
/// TryLoadRuntimeOverride. Returns None if absent or unreadable.
fn runtime_override() -> Option<String> {
    let path = crate::settings::resolve_base_dir().join(RUNTIME_OVERRIDE_REL);
    std::fs::read_to_string(&path).ok()
}

/// Process-level single init of the offline index.
static MCMOD_DATA: OnceLock<McmodData> = OnceLock::new();

fn mcmod_data() -> &'static McmodData {
    MCMOD_DATA.get_or_init(McmodData::load)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/mcmod/lookup", get(lookup))
        .route("/mcmod/batch", post(batch))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn lookup(Query(q): Query<LookupQuery>) -> ApiResult<Json<CnNameResponse>> {
    let cn = mcmod_data().lookup(q.name.trim());
    Ok(Json(CnNameResponse { cn_name: cn }))
}

async fn batch(Json(names): Json<Vec<String>>) -> ApiResult<Json<HashMap<String, String>>> {
    if names.is_empty() {
        return Ok(Json(HashMap::new()));
    }
    let data = mcmod_data();
    let mut out = HashMap::with_capacity(names.len());
    for name in names {
        out.insert(name.clone(), data.lookup(name.trim()).unwrap_or_default());
    }
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LookupQuery {
    name: String,
}

/// Matches C# `CnNameResponse`; `cnName` stays `null` when unresolved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CnNameResponse {
    cn_name: Option<String>,
}
