// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! CurseForge 分发受限文件的阻塞清单（issue #291）。
//!
//! ## 为什么是「阻塞」而不是「错误」
//!
//! CurseForge 的 Project Distribution Toggle 被作者关闭后，API 仍返回项目与文件
//! 元数据，但 `downloadUrl` 变为 `null`。这是**作者对第三方自动分发的明确拒绝**，
//! 不是接口故障：换 API Key、拼 CDN 直链、特殊 Token 都无效且违反第三方 API 条款。
//! 唯一可持续的处理是把它当成业务状态记下来，向用户汇总呈现并支持手动补全。
//!
//! ## 与「API 未返回该条目」的区别
//!
//! 两种都会导致文件缺失，但只有前者有确定的用户可执行动作：
//!
//! - 批量接口里查不到该 fileId（项目/文件被删、审核中）→ 真异常，安装侧计 missing；
//! - 条目在、`downloadUrl` 为空 → **分发受限**，进本清单，由用户手动补。
//!
//! ## 落盘位置
//!
//! `{gameDir}/versions/{instanceName}/.qomicex/blocked-mods.json`
//!
//! 与 `modpack-manifest.json` 同目录：实例改名走整目录 `rename`，清单一并搬走，
//! 不需要额外迁移。清单为空时**删除文件**，避免残留空清单让 UI 误报。

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::services::modpack_manifest::{is_safe_rel_path, QOMICEX_DIR};

/// 阻塞清单文件名。
pub const BLOCKED_FILE: &str = "blocked-mods.json";

/// 清单格式版本。将来若改结构，读侧按版本号决定是否迁移而非直接报错。
pub const BLOCKED_SCHEMA_VERSION: u32 = 1;

/// 一个因 CurseForge 分发限制而无法自动获取的必需文件。
///
/// `sha1` / `file_length` 来自 CF 批量接口，用于用户手动下载后的完整性校验；
/// 缺失时（旧接口/字段被裁）退化为只按文件名放置，不阻断补全流程。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedModFile {
    pub project_id: i64,
    pub file_id: i64,
    /// 落盘文件名（`mods/` 下）。CF 未给时为空串，UI 用 project/file id 兜底展示。
    #[serde(default)]
    pub file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_length: Option<i64>,
    /// CurseForge 项目页直达链接（用户从这里手动下载对应文件）。
    pub page_url: String,
    /// 精确到该文件版本的文件页链接（issue #301）。
    ///
    /// 由项目规范地址加 `/files/{fileId}` 拼成，需要先解析项目的 `links.websiteUrl`，
    /// 因此**不落盘**：只在响应里按需补全，解析不出来就退回只有项目页。旧 sidecar
    /// 没有这个字段，`default` 保证照样能读。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_page_url: Option<String>,
}

/// 阻塞清单落盘结构。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedModList {
    pub schema_version: u32,
    #[serde(default)]
    pub items: Vec<BlockedModFile>,
}

impl BlockedModList {
    pub fn new(items: Vec<BlockedModFile>) -> Self {
        Self {
            schema_version: BLOCKED_SCHEMA_VERSION,
            items,
        }
    }
}

/// CurseForge 项目页直达链接。
///
/// 只给项目页不给文件页：实测 `projects/{id}` 会 302 到 slug 页（HTTP 200），
/// 而 `projects/{id}/files/{fileId}` 是 404——项目 ID 形式的路径无法定位文件版本，
/// 精确文件页必须建立在项目的规范网站地址上，见 [`cf_file_page_url`]。
pub fn cf_project_page_url(project_id: i64) -> String {
    format!("https://www.curseforge.com/projects/{project_id}")
}

/// 由项目规范地址拼出精确文件页：`{websiteUrl}/files/{fileId}`。
///
/// `websiteUrl` 来自 CF `POST /v1/mods` 批量响应的 `data[].links.websiteUrl`
/// （形如 `https://www.curseforge.com/minecraft/mc-mods/jei`），拼出的地址实测
/// 打开的就是该 fileId 对应版本的下载页。受限条目本身不带 slug / classId，
/// 所以只能靠这个字段，不能在本地拼分类路径。
///
/// 按 URL 结构校验而不是字符串前缀：这个链接会被交给系统浏览器打开，而前缀匹配
/// 挡不住带查询串 / 锚点 / 端口 / 反斜杠的写法（`.../jei?x=1` 拼出来是坏链接，
/// `.../jei#frag` 同理）。只接受 https、主机名精确等于 curseforge.com 主域、
/// 无端口、无查询串、无锚点的地址，再拿**解析后的路径**重建 URL。
pub fn cf_file_page_url(website_url: &str, file_id: i64) -> Option<String> {
    if file_id <= 0 {
        return None;
    }
    let url = reqwest::Url::parse(website_url.trim()).ok()?;
    if url.scheme() != "https" || url.port().is_some() {
        return None;
    }
    let host = url.host_str()?;
    if !matches!(host, "www.curseforge.com" | "curseforge.com") {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    Some(format!("https://{host}{path}/files/{file_id}"))
}

/// 给清单条目补上精确文件页链接，返回是否有条目被补上。
///
/// 只填 `None` 的条目：调用方可能已经把解析结果合进来，覆盖会让同一批条目
/// 在不同出口给出不同链接。`websites` 里没有的项目（解析失败或 API 未返回）
/// 保持 `None`，前端退回项目页。
pub fn apply_file_page_urls(items: &mut [BlockedModFile], websites: &HashMap<i64, String>) -> bool {
    let mut changed = false;
    for it in items.iter_mut() {
        if it.file_page_url.is_some() {
            continue;
        }
        let Some(site) = websites.get(&it.project_id) else {
            continue;
        };
        if let Some(url) = cf_file_page_url(site, it.file_id) {
            it.file_page_url = Some(url);
            changed = true;
        }
    }
    changed
}

/// 「项目 ID → 规范网站地址」的进程内缓存。
///
/// 精确文件页不落盘，同一批待补全项每开一次对话框都要再解析一遍；网站地址对
/// 同一项目是稳定的，记住就够了。解析不到的项目缓存空串（同样不再重试），
/// 否则每次打开对话框都会为注定拿不到的条目再付一次超时。
fn website_cache() -> &'static std::sync::Mutex<HashMap<i64, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<i64, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 批量项目接口单次可查上限（与 `get_files_batch` 的 100 条分批口径一致）。
const CF_MODS_BATCH: usize = 100;

/// 整次解析的总预算。
///
/// 单批上限 10 s 已够正常响应；但清单超过 100 项就要分批，若每批都等满上限，
/// 累计会超过共享客户端的 30 s 超时——那会让整个 GET 直接失败，用户看到的
/// 是「读取补全清单失败」而不是少了几个按钮。超预算就带着已拿到的结果返回。
const CF_WEBSITE_BUDGET: Duration = Duration::from_secs(12);

/// 批量解析项目的规范网站地址，返回可直接拼精确文件页的项。
///
/// 走 `POST /v1/mods` 而非逐项目单查：一次请求就带回 `links.websiteUrl`，
/// 与受限清单动辄几十项的量级相称。超时单独压到 10 s，不用共享客户端的 30 s
/// —— 这只是给按钮补个链接，不值得让对话框等半分钟。任何失败都退化为空结果，
/// 手动补全流程不依赖 CurseForge 是否可用。
pub async fn fetch_project_websites(
    client: &reqwest::Client,
    api_key: &str,
    project_ids: &[i64],
) -> HashMap<i64, String> {
    let mut out = HashMap::new();
    let mut pending: Vec<i64> = Vec::new();
    {
        let cache = website_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for &id in project_ids {
            // 旧清单解析失败时 projectId 可能为 0，不能拿去查。
            if id <= 0 || out.contains_key(&id) || pending.contains(&id) {
                continue;
            }
            match cache.get(&id) {
                // 空串是「查过了但没有网站地址」的标记，不再进请求。
                Some(site) => {
                    if !site.is_empty() {
                        out.insert(id, site.clone());
                    }
                }
                None => pending.push(id),
            }
        }
    }
    if pending.is_empty() || api_key.is_empty() {
        return out;
    }

    let deadline = std::time::Instant::now() + CF_WEBSITE_BUDGET;
    // 只合并成功的批次：整批失败或响应结构不对时**不写缓存**，否则一次上游抖动
    // 会把这些项目永久钉成「无网站地址」，此后连真实网络下也拿不到精确链接。
    for chunk in pending.chunks(CF_MODS_BATCH) {
        if std::time::Instant::now() >= deadline {
            tracing::warn!(
                remaining = pending.len(),
                budget = CF_WEBSITE_BUDGET.as_secs(),
                "解析 CurseForge 项目网站地址超出预算，剩余条目本轮不解析"
            );
            break;
        }
        match cf_post_mod_websites(client, api_key, chunk).await {
            Ok(found) => {
                let cache_guard = website_cache();
                let mut cache = cache_guard
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                for &id in chunk {
                    let site = found.get(&id).cloned().unwrap_or_default();
                    if !site.is_empty() {
                        out.insert(id, site.clone());
                    }
                    // 上游明确没给该项目的网站地址（已删除 / 审核中）：记为空，
                    // 避免每次开对话框都为拿不到的条目再付一次请求。
                    cache.insert(id, site);
                }
            }
            Err(e) => tracing::warn!(
                error = %e,
                count = chunk.len(),
                "解析 CurseForge 项目网站地址失败，精确文件页链接暂不可用"
            ),
        }
    }
    out
}

/// 一次 `POST /v1/mods` 请求，返回 `项目 ID → websiteUrl`。
async fn cf_post_mod_websites(
    client: &reqwest::Client,
    api_key: &str,
    project_ids: &[i64],
) -> Result<HashMap<i64, String>, String> {
    let resp = client
        .post("https://api.curseforge.com/v1/mods")
        .header("x-api-key", api_key)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .json(&serde_json::json!({ "modIds": project_ids }))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("上游返回 {}", resp.status()));
    }
    let body = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    parse_mod_websites(&body)
}

/// 从 `POST /v1/mods` 响应里取 `项目 ID → websiteUrl`。
///
/// 抽成纯函数是为了让字段路径有单测守着：真实响应把网站地址放在
/// `data[].links.websiteUrl`，一旦 CF 改了层级，精确文件页会静默退化成项目页，
/// 这种退化不会有报错可循。缺 `links` / 空串的条目直接跳过。
///
/// `data` 缺失或不是数组时返回 `Err` 而非空表：调用方会拿「项目不在结果里」
/// 当作「项目没有网站地址」写进缓存，一旦把结构异常当成这种语义，这些项目就
/// 永久拿不到精确链接了。合法的空数组仍返回 `Ok`（这些项目确实查不到）。
fn parse_mod_websites(body: &serde_json::Value) -> Result<HashMap<i64, String>, String> {
    let mut out = HashMap::new();
    let data = body
        .get("data")
        .ok_or_else(|| "响应缺少 data 字段".to_string())?
        .as_array()
        .ok_or_else(|| "响应的 data 不是数组".to_string())?;
    for item in data {
        let Some(id) = item.get("id").and_then(|v| v.as_i64()) else {
            continue;
        };
        let Some(site) = item
            .get("links")
            .and_then(|l| l.get("websiteUrl"))
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        if !site.trim().is_empty() {
            out.insert(id, site.to_string());
        }
    }
    Ok(out)
}

/// 从 CF 批量接口条目判定处置方式（issue #291 的回归点）。
///
/// - `downloadUrl` 非空 → `None`，调用方照常加入下载队列；
/// - `downloadUrl` 为空 / 缺失 → `Some(阻塞项)`，**必须**登记而不是跳过。
///
/// 空串与 `null` 同等对待：CF 在部分响应里给的是 `""` 而不是 `null`，
/// 只判 `is_none()` 会漏掉一半场景。
///
/// 抽成纯函数是为了让「静默跳过」这个回归点有单测守着——它此前藏在
/// 一个几百行的 async 安装分支里，只能靠人工读代码发现。
pub fn blocked_from_batch(
    info: &qomicex_core::models::expansion::curseforge::CurseForgeBatchFileInfo,
    project_id: i64,
) -> Option<BlockedModFile> {
    if info
        .download_url
        .as_deref()
        .is_some_and(|u| !u.trim().is_empty())
    {
        return None;
    }
    Some(BlockedModFile {
        project_id,
        file_id: info.id,
        file_name: info.file_name.clone().unwrap_or_default(),
        sha1: info.sha1.clone().filter(|s| !s.is_empty()),
        file_length: info.file_length,
        page_url: cf_project_page_url(project_id),
        file_page_url: None,
    })
}

/// 实例名是否可作为单一路径分量。
///
/// 实例名即 `VersionDirName`，直接参与拼路径。校验放这里而不是只靠调用方：
/// 新建/更新实例的入口只检查了非空，误填或恶意构造的 `../../x` 会让清单读写
/// 与补全落盘一起越出实例目录。
pub fn is_safe_instance_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." {
        return false;
    }
    if n.contains('/') || n.contains('\\') || n.contains('\0') {
        return false;
    }
    // Windows 盘符与备用数据流（`C:` / `x:y`）。
    if n.len() >= 2 && n.as_bytes()[1] == b':' && n.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    true
}

/// 解析 `game_dir` 根，与 `modpack_manifest::instance_version_dir` **同一口径**。
///
/// 相对 `game_dir` 必须解析到 `resolve_base_dir()` 下：`blocked_path` 走
/// `instance_version_dir` 已是该语义，若 `mods_dir` 相对进程 CWD 解析，两者会
/// 指向不同位置——补全把 jar 复制到实例之外，却已把条目从清单划掉。
fn resolve_game_root(game_dir: &str) -> PathBuf {
    if Path::new(game_dir).is_absolute() {
        PathBuf::from(game_dir)
    } else {
        crate::settings::resolve_base_dir().join(game_dir)
    }
}

/// 阻塞清单路径（实例版本目录内）。实例名非法时返回错误，由调用方决定降级方式。
pub fn blocked_path(game_dir: &str, instance_name: &str) -> Result<PathBuf, String> {
    if !is_safe_instance_name(instance_name) {
        return Err(format!("实例名非法，拒绝定位阻塞清单: {instance_name}"));
    }
    Ok(
        crate::services::modpack_manifest::instance_version_dir(game_dir, instance_name.trim())
            .join(QOMICEX_DIR)
            .join(BLOCKED_FILE),
    )
}

/// 实例的 `mods/` 目录（与安装落盘口径一致，见 `modpack_target_path`）。
pub fn mods_dir(
    game_dir: &str,
    instance_name: &str,
    version_isolation: bool,
) -> Result<PathBuf, String> {
    if !is_safe_instance_name(instance_name) {
        return Err(format!("实例名非法，拒绝定位 mods 目录: {instance_name}"));
    }
    let root = resolve_game_root(game_dir);
    if version_isolation {
        Ok(root
            .join("versions")
            .join(instance_name.trim())
            .join("mods"))
    } else {
        Ok(root.join("mods"))
    }
}

/// 清单条目对应的文件是否已在实例里（原地更新时判断还需不需要提示用户）。
pub fn existing_entry_file(
    game_dir: &str,
    instance_name: &str,
    version_isolation: bool,
    entry: &BlockedModFile,
) -> Option<PathBuf> {
    let name = entry.file_name.trim();
    if name.is_empty() {
        return None;
    }
    let mods = mods_dir(game_dir, instance_name, version_isolation).ok()?;
    let p = mods.join(name);
    if !p.is_file() {
        return None;
    }
    // 有哈希的条目必须一致：同名但版本不同的 jar 不算已补全，否则更新会把清单
    // 条目删掉、却把错版本留在 mods/。
    match entry.sha1.as_deref().filter(|s| !s.is_empty()) {
        Some(expected) => crate::services::modpack_export::sha1_file_hex(&p)
            .ok()
            .filter(|got| got.eq_ignore_ascii_case(expected))
            .map(|_| p),
        None => Some(p),
    }
}

/// 读取阻塞清单。文件缺失 / 解析失败 / schema 不认识 → 空清单。
///
/// 与 `modpack_manifest::load_manifest` 同样的取舍：清单损坏绝不能反过来阻断
/// 实例的其它功能，最坏退化成「看起来没有阻塞文件」。
pub fn load_blocked(game_dir: &str, instance_name: &str) -> Vec<BlockedModFile> {
    let Ok(path) = blocked_path(game_dir, instance_name) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(list) = serde_json::from_str::<BlockedModList>(&raw) else {
        tracing::warn!(path = %path.display(), "阻塞清单解析失败，按无阻塞处理");
        return Vec::new();
    };
    if list.schema_version != BLOCKED_SCHEMA_VERSION {
        tracing::warn!(
            path = %path.display(),
            version = list.schema_version,
            "阻塞清单版本不认识，按无阻塞处理"
        );
        return Vec::new();
    }
    list.items
}

/// 写入阻塞清单。空清单 → 删除文件（不留 `items: []` 的残骸）。
///
/// 先写同目录临时文件再 rename：直接截断写一旦中断会留下半截 JSON，而
/// `load_blocked` 把解析失败当空清单，等于把全部待补全项静默藏起来。
pub fn save_blocked(
    game_dir: &str,
    instance_name: &str,
    items: &[BlockedModFile],
) -> Result<(), String> {
    let path = blocked_path(game_dir, instance_name)?;
    if items.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除阻塞清单失败: {e}")),
        };
    }
    let parent = path
        .parent()
        .ok_or_else(|| "阻塞清单路径无父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建 .qomicex 目录失败: {e}"))?;

    let body = serde_json::to_vec_pretty(&BlockedModList::new(items.to_vec()))
        .map_err(|e| format!("序列化阻塞清单失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    let write_res = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.flush()?;
        f.sync_all()
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入临时清单失败: {e}"));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换阻塞清单失败 {}: {e}", path.display())
    })
}

/// 从 mods 目录剔除已经补上的条目（用户在文件管理器里直接放入也算补上）。
///
/// 有 SHA-1 的条目必须哈希一致才算补上：同名但版本不同的 jar 留在清单里，
/// 比误删后放行一个错版本安全。返回清单是否发生变化。
pub fn drop_present_in_mods(
    game_dir: &str,
    instance_name: &str,
    version_isolation: bool,
    items: &mut Vec<BlockedModFile>,
) -> bool {
    let Ok(dir) = mods_dir(game_dir, instance_name, version_isolation) else {
        return false;
    };
    let before = items.len();
    items.retain(|entry| {
        let name = entry.file_name.trim();
        if name.is_empty() || !is_safe_rel_path(name) || name.contains('/') || name.contains('\\') {
            return true;
        }
        let path = dir.join(name);
        if !path.is_file() {
            return true;
        }
        match entry.sha1.as_deref().filter(|s| !s.is_empty()) {
            Some(expected) => crate::services::modpack_export::sha1_file_hex(&path)
                .map(|got| !got.eq_ignore_ascii_case(expected))
                .unwrap_or(true),
            None => false,
        }
    });
    items.len() != before
}

/// 是否还有待补全条目。
///
/// 前置检查（修复 / 原地更新）不能只看 `InstallTracker`：进程重启后 tracker
/// 是空的，但清单还在磁盘上，此时放行会覆盖掉用户尚未补齐的 `mods/`。
/// 读取时按 `mods/` 实况剔除已放好的文件且不落盘，避免用户已经在文件管理器里
/// 补齐、只是没打开下载中心时被误挡。
pub fn has_pending(game_dir: &str, instance_name: &str, version_isolation: bool) -> bool {
    let mut items = load_blocked(game_dir, instance_name);
    if items.is_empty() {
        return false;
    }
    drop_present_in_mods(game_dir, instance_name, version_isolation, &mut items);
    !items.is_empty()
}

/// 按 SHA-1（优先）或文件名把用户拖入的文件对应到清单条目。
///
/// 有哈希的条目只认哈希：同名不同版本的文件只差哈希，按文件名匹配会把错版本
/// 放进 `mods/`。文件名兜底只对 CF 未给哈希的旧条目生效。
pub fn match_source<'a>(
    items: &'a [BlockedModFile],
    sha1: &str,
    source_name: &str,
) -> Option<&'a BlockedModFile> {
    items
        .iter()
        .find(|e| {
            e.sha1
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case(sha1))
        })
        .or_else(|| {
            items.iter().find(|e| {
                e.sha1.as_deref().filter(|s| !s.is_empty()).is_none()
                    && e.file_name.eq_ignore_ascii_case(source_name)
            })
        })
}

/// 串行化清单的「读-改-写」：并发补全不同条目、或补全与重扫同时进行时，
/// 后写者会拿着旧副本覆盖先完成的结果（lost update）。
static BLOCKED_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn lock_blocked_write() -> std::sync::MutexGuard<'static, ()> {
    BLOCKED_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 手动补全：校验用户提供的文件，通过后放进 `mods/` 并从清单移除。
///
/// 校验强度按清单条目能力递减：
/// - 有 `sha1` → 必须匹配，**且边复制边算哈希**：先验后拷会留出「校验完再被
///   替换」的窗口，拷进 `mods/` 的就不是被校验过的那份字节；
/// - 无 `sha1`（旧接口/字段被裁）→ 要求所选文件名与清单 `file_name` 一致，
///   否则任意文件都会被当成目标模组收下；
/// - 清单 `file_name` 为空 → 用所选文件的 basename。
///
/// 落盘走「临时文件 + rename」：中途失败不会留下半截 jar 被 Minecraft 加载。
pub fn accept_manual_file(
    game_dir: &str,
    instance_name: &str,
    version_isolation: bool,
    src: &Path,
    entry: &BlockedModFile,
) -> Result<PathBuf, String> {
    if !src.is_file() {
        return Err("选择的文件不存在或已被移动".to_string());
    }
    let src_name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let declared = entry.file_name.trim();
    let file_name = if declared.is_empty() {
        src_name.clone()
    } else {
        declared.to_string()
    };
    if file_name.is_empty()
        || !is_safe_rel_path(&file_name)
        || file_name.contains('/')
        || file_name.contains('\\')
    {
        return Err(format!("文件名非法: {file_name}"));
    }

    let expected = entry.sha1.as_deref().filter(|s| !s.is_empty());
    if expected.is_none() && !src_name.eq_ignore_ascii_case(&file_name) {
        return Err(format!(
            "清单未提供校验值，且所选文件名 {src_name} 与要求的 {file_name} 不一致，无法确认是否为同一文件"
        ));
    }

    let dest = mods_dir(game_dir, instance_name, version_isolation)?.join(&file_name);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 mods 目录失败: {e}"))?;
    }
    // 临时文件与目标同目录，保证 rename 原子且不跨卷。
    let tmp = dest.with_extension(format!("{}.part", std::process::id()));
    if let Err(e) = copy_and_verify(src, &tmp, &dest, expected, entry) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    // 放进 mods/ 后再从清单移除：先移清单、后复制会留下「清单说补过了但文件没到」
    // 的假成功状态。这里失败只影响下次是否重复提示，不回滚已放置的文件。
    let _guard = lock_blocked_write();
    let mut remaining = load_blocked(game_dir, instance_name);
    remaining.retain(|it| it.file_id != entry.file_id);
    if let Err(e) = save_blocked(game_dir, instance_name, &remaining) {
        tracing::warn!(error = %e, "阻塞清单更新失败（文件已放入 mods/）");
    }
    Ok(dest)
}

/// 边复制边算 SHA-1，校验通过后再原子 rename 到目标。
///
/// 哈希覆盖的是**实际写进临时文件的那份字节**：先校验源文件、再 `fs::copy` 的
/// 做法在两步之间留下窗口，源文件被替换时落盘内容会与校验值不符。
fn copy_and_verify(
    src: &Path,
    tmp: &Path,
    dest: &Path,
    expected: Option<&str>,
    entry: &BlockedModFile,
) -> Result<(), String> {
    use sha1::{Digest, Sha1};

    let mut input = std::fs::File::open(src).map_err(|e| format!("打开所选文件失败: {e}"))?;
    let mut output = std::fs::File::create(tmp).map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = input
            .read(&mut buf)
            .map_err(|e| format!("读取所选文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        output
            .write_all(&buf[..n])
            .map_err(|e| format!("写入临时文件失败: {e}"))?;
    }
    output
        .flush()
        .map_err(|e| format!("刷新临时文件失败: {e}"))?;
    output
        .sync_all()
        .map_err(|e| format!("同步临时文件失败: {e}"))?;
    drop(output);

    if let Some(expected) = expected {
        let got: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !got.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "文件校验失败：期望 SHA-1 {expected}，实际 {got}。请确认下载的是整合包要求的文件（fileId {}）",
                entry.file_id
            ));
        }
    }
    std::fs::rename(tmp, dest).map_err(|e| format!("替换 {} 失败: {e}", dest.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::services::modpack_export::sha1_file_hex;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qomicex-blocked-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(file_id: i64, name: &str, sha1: Option<&str>) -> BlockedModFile {
        BlockedModFile {
            project_id: 1654570,
            file_id,
            file_name: name.to_string(),
            sha1: sha1.map(str::to_string),
            file_length: None,
            page_url: cf_project_page_url(1654570),
            file_page_url: None,
        }
    }

    #[test]
    fn empty_list_removes_sidecar() {
        let root = temp_root("empty");
        let gd = root.to_string_lossy().to_string();
        save_blocked(&gd, "Nast", &[entry(1, "a.jar", None)]).unwrap();
        assert!(blocked_path(&gd, "Nast").unwrap().is_file());
        save_blocked(&gd, "Nast", &[]).unwrap();
        assert!(
            !blocked_path(&gd, "Nast").unwrap().is_file(),
            "空清单必须删除文件，不能留 items: [] 残骸"
        );
        assert!(load_blocked(&gd, "Nast").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn roundtrip_survives_reload() {
        let root = temp_root("roundtrip");
        let gd = root.to_string_lossy().to_string();
        let items = vec![entry(9274793, "mmcr.jar", Some("a".repeat(40).as_str()))];
        save_blocked(&gd, "Nast", &items).unwrap();
        assert_eq!(load_blocked(&gd, "Nast"), items);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn has_pending_ignores_files_already_in_mods() {
        let root = temp_root("pending");
        let gd = root.to_string_lossy().to_string();
        let src = root.join("downloaded.jar");
        std::fs::write(&src, b"mmcr").unwrap();
        let sha1 = sha1_file_hex(&src).unwrap();
        let e = entry(9274793, "mmcr.jar", Some(&sha1));
        save_blocked(&gd, "Nast", std::slice::from_ref(&e)).unwrap();

        assert!(has_pending(&gd, "Nast", true), "清单非空必须算待补全");
        // 用户直接在文件管理器里放进 mods/：不该再挡住修复/更新，也不写回清单。
        let mods = mods_dir(&gd, "Nast", true).unwrap();
        std::fs::create_dir_all(&mods).unwrap();
        std::fs::copy(&src, mods.join("mmcr.jar")).unwrap();
        assert!(!has_pending(&gd, "Nast", true), "已补齐的文件不应算待补全");
        assert_eq!(load_blocked(&gd, "Nast"), vec![e], "只读检查不能改清单");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_sidecar_degrades_to_empty() {
        let root = temp_root("corrupt");
        let gd = root.to_string_lossy().to_string();
        let path = blocked_path(&gd, "Nast").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ this is not json").unwrap();
        assert!(
            load_blocked(&gd, "Nast").is_empty(),
            "清单损坏不能阻断功能，只能退化为无阻塞"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accept_places_file_and_clears_entry() {
        let root = temp_root("accept");
        let gd = root.to_string_lossy().to_string();
        let payload = b"mmcr";
        let src = root.join("downloaded.jar");
        std::fs::write(&src, payload).unwrap();
        let sha1 = sha1_file_hex(&src).unwrap();

        let e = entry(9274793, "mmcr.jar", Some(&sha1));
        save_blocked(&gd, "Nast", std::slice::from_ref(&e)).unwrap();

        let dest = accept_manual_file(&gd, "Nast", true, &src, &e).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        // 断言完整目标路径而不是「以 mods/mmcr.jar 结尾」：后者在隔离/共享布局
        // 写错、或用错 game_dir 时同样会通过。
        assert_eq!(
            dest,
            root.join("versions")
                .join("Nast")
                .join("mods")
                .join("mmcr.jar"),
            "隔离实例必须落到 versions/Nast/mods/"
        );
        assert!(
            load_blocked(&gd, "Nast").is_empty(),
            "补全成功后该条目必须从清单移除"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accept_rejects_sha1_mismatch() {
        let root = temp_root("mismatch");
        let gd = root.to_string_lossy().to_string();
        let src = root.join("wrong.jar");
        std::fs::write(&src, b"wrong content").unwrap();
        // 用真实 sha1 的反例：期望值与文件内容不一致。
        let e = entry(
            9274793,
            "mmcr.jar",
            Some("0000000000000000000000000000000000000000"),
        );
        save_blocked(&gd, "Nast", std::slice::from_ref(&e)).unwrap();

        let err = accept_manual_file(&gd, "Nast", true, &src, &e).unwrap_err();
        assert!(err.contains("校验失败"), "实际错误: {err}");
        assert!(
            !mods_dir(&gd, "Nast", true)
                .unwrap()
                .join("mmcr.jar")
                .is_file(),
            "校验失败不能落盘"
        );
        assert_eq!(
            load_blocked(&gd, "Nast").len(),
            1,
            "校验失败必须保留清单条目"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 无校验值时必须按文件名匹配，否则任意文件都会被当成目标模组收下。
    #[test]
    fn accept_without_sha1_requires_matching_name() {
        let root = temp_root("nosha");
        let gd = root.to_string_lossy().to_string();
        let wrong = root.join("some-other-mod.jar");
        std::fs::write(&wrong, b"data").unwrap();
        let e = entry(42, "wanted.jar", None);
        save_blocked(&gd, "Nast", std::slice::from_ref(&e)).unwrap();

        let err = accept_manual_file(&gd, "Nast", false, &wrong, &e).unwrap_err();
        assert!(err.contains("不一致"), "实际错误: {err}");
        assert_eq!(
            load_blocked(&gd, "Nast").len(),
            1,
            "文件名不匹配必须保留清单条目"
        );

        let right = root.join("wanted.jar");
        std::fs::write(&right, b"data").unwrap();
        let dest = accept_manual_file(&gd, "Nast", false, &right, &e).unwrap();
        assert_eq!(dest, root.join("mods").join("wanted.jar"));
        assert!(load_blocked(&gd, "Nast").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// CF 未给 fileName 时用所选文件的 basename 兜底，不能因此无法补全。
    #[test]
    fn accept_falls_back_to_source_basename() {
        let root = temp_root("noname");
        let gd = root.to_string_lossy().to_string();
        let src = root.join("mmcr-neoforge.jar");
        std::fs::write(&src, b"jar").unwrap();
        let sha1 = sha1_file_hex(&src).unwrap();
        let e = entry(9, "", Some(&sha1));
        save_blocked(&gd, "Nast", std::slice::from_ref(&e)).unwrap();

        let dest = accept_manual_file(&gd, "Nast", true, &src, &e).unwrap();
        assert_eq!(
            dest,
            root.join("versions")
                .join("Nast")
                .join("mods")
                .join("mmcr-neoforge.jar")
        );
        assert!(load_blocked(&gd, "Nast").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accept_rejects_path_traversal_name() {
        let root = temp_root("traversal");
        let gd = root.to_string_lossy().to_string();
        let src = root.join("evil.jar");
        std::fs::write(&src, b"x").unwrap();
        for bad in ["../evil.jar", "sub/evil.jar", "..\\evil.jar"] {
            let e = entry(1, bad, None);
            let err = accept_manual_file(&gd, "Nast", true, &src, &e).unwrap_err();
            assert!(err.contains("文件名非法"), "{bad} 应被拒绝，实际: {err}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 实例名即 VersionDirName，参与拼路径，必须挡路径穿越。
    #[test]
    fn instance_name_traversal_is_rejected() {
        let root = temp_root("nameguard");
        let gd = root.to_string_lossy().to_string();
        for bad in ["../escape", "a/b", "a\\b", "..", ".", "", "C:evil"] {
            assert!(!is_safe_instance_name(bad), "{bad:?} 应被判为非法实例名");
            assert!(
                blocked_path(&gd, bad).is_err(),
                "{bad:?} 不能解析出清单路径"
            );
            assert!(
                mods_dir(&gd, bad, true).is_err(),
                "{bad:?} 不能解析出 mods 路径"
            );
        }
        for ok in ["Nast", "1.20.1-Forge-47.1.0"] {
            assert!(is_safe_instance_name(ok), "{ok:?} 应合法");
            assert!(blocked_path(&gd, ok).is_ok());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 隔离与共享布局必须指向不同且完整的路径。
    #[test]
    fn mods_dir_layout_is_exact() {
        let root = temp_root("layout");
        let gd = root.to_string_lossy().to_string();

        assert_eq!(
            mods_dir(&gd, "Nast", true).unwrap(),
            root.join("versions").join("Nast").join("mods")
        );
        assert_eq!(mods_dir(&gd, "Nast", false).unwrap(), root.join("mods"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 相对 game_dir 必须与清单路径同口径解析（都相对 resolve_base_dir）。
    #[test]
    fn relative_game_dir_resolves_like_blocked_path() {
        let rel = ".minecraft";
        let base = crate::settings::resolve_base_dir();
        assert_eq!(
            mods_dir(rel, "Nast", false).unwrap(),
            base.join(rel).join("mods"),
            "相对 game_dir 不能相对进程 CWD 解析"
        );
        assert_eq!(
            blocked_path(rel, "Nast").unwrap(),
            base.join(rel)
                .join("versions")
                .join("Nast")
                .join(QOMICEX_DIR)
                .join(BLOCKED_FILE)
        );
    }

    #[test]
    fn existing_entry_file_reports_presence() {
        let root = temp_root("existing");
        let gd = root.to_string_lossy().to_string();
        let e = entry(1, "present.jar", None);
        assert!(existing_entry_file(&gd, "Nast", true, &e).is_none());

        let mods = mods_dir(&gd, "Nast", true).unwrap();
        std::fs::create_dir_all(&mods).unwrap();
        std::fs::write(mods.join("present.jar"), b"x").unwrap();
        assert_eq!(
            existing_entry_file(&gd, "Nast", true, &e),
            Some(mods.join("present.jar"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_entry_file_rejects_hash_mismatch() {
        let root = temp_root("existing-sha");
        let gd = root.to_string_lossy().to_string();
        let src = root.join("downloaded.jar");
        std::fs::write(&src, b"expected").unwrap();
        let sha1 = sha1_file_hex(&src).unwrap();
        let e = entry(2, "same-name.jar", Some(&sha1));

        let mods = mods_dir(&gd, "Nast", true).unwrap();
        std::fs::create_dir_all(&mods).unwrap();
        // 同名但版本不同：不能算已补全，否则更新会删掉清单条目、留下错版本。
        std::fs::write(mods.join("same-name.jar"), b"other").unwrap();
        assert!(existing_entry_file(&gd, "Nast", true, &e).is_none());

        std::fs::copy(&src, mods.join("same-name.jar")).unwrap();
        assert_eq!(
            existing_entry_file(&gd, "Nast", true, &e),
            Some(mods.join("same-name.jar"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 中断式写入不能把清单写坏：临时文件残留也不该影响读取。
    #[test]
    fn interrupted_write_keeps_previous_list_readable() {
        let root = temp_root("atomic");
        let gd = root.to_string_lossy().to_string();
        let good = vec![entry(7, "keep.jar", None)];
        save_blocked(&gd, "Nast", &good).unwrap();

        let path = blocked_path(&gd, "Nast").unwrap();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, b"{ truncated mid-write").unwrap();

        assert_eq!(
            load_blocked(&gd, "Nast"),
            good,
            "临时文件残留不能影响已提交的清单"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn match_source_prefers_sha1_and_falls_back_to_name_only_without_sha1() {
        let hash_a = "a".repeat(40);
        let hash_b = "b".repeat(40);
        let hash_c = "c".repeat(40);
        let items = vec![
            entry(1, "mmcr.jar", Some(&hash_a)),
            entry(2, "other.jar", Some(&hash_b)),
            entry(3, "legacy.jar", None),
        ];

        // 哈希命中优先：文件名不同也认。
        assert_eq!(
            match_source(&items, &hash_b, "mmcr.jar").map(|e| e.file_id),
            Some(2)
        );
        // 有哈希的条目绝不按文件名兜底：同名但哈希不符 → 不匹配。
        assert!(match_source(&items, &hash_c, "mmcr.jar").is_none());
        // 无哈希的旧条目才按文件名兜底。
        assert_eq!(
            match_source(&items, &hash_c, "legacy.jar").map(|e| e.file_id),
            Some(3)
        );
    }

    #[test]
    fn drop_present_in_mods_requires_matching_sha1() {
        let root = temp_root("drop-present");
        let gd = root.to_string_lossy().to_string();
        let mods = mods_dir(&gd, "Nast", true).unwrap();
        std::fs::create_dir_all(&mods).unwrap();
        std::fs::write(mods.join("good.jar"), b"good").unwrap();
        std::fs::write(mods.join("bad.jar"), b"bad").unwrap();
        let good_sha = sha1_file_hex(&mods.join("good.jar")).unwrap();

        let mut items = vec![
            entry(1, "good.jar", Some(&good_sha)),
            // 同名但版本不对：哈希不符，保留在清单里。
            entry(2, "bad.jar", Some(&"0".repeat(40))),
            // 无哈希：按文件名算已补上。
            entry(3, "bad.jar", None),
            entry(4, "missing.jar", None),
        ];
        assert!(drop_present_in_mods(&gd, "Nast", true, &mut items));
        let left: Vec<i64> = items.iter().map(|e| e.file_id).collect();
        assert_eq!(left, vec![2, 4], "只剔除哈希一致或本无哈希的条目");
        assert!(
            !drop_present_in_mods(&gd, "Nast", true, &mut items),
            "没有变化时不应触发重复落盘"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    fn batch_info(
        id: i64,
        file_name: Option<&str>,
        download_url: Option<&str>,
        sha1: Option<&str>,
    ) -> qomicex_core::models::expansion::curseforge::CurseForgeBatchFileInfo {
        qomicex_core::models::expansion::curseforge::CurseForgeBatchFileInfo {
            id,
            mod_id: 1654570,
            file_name: file_name.map(str::to_string),
            download_url: download_url.map(str::to_string),
            file_length: Some(5102525),
            sha1: sha1.map(str::to_string),
        }
    }

    /// issue #291 的回归点：`downloadUrl` 为空必须**登记为阻塞**，不能当成可下载。
    ///
    /// 修复前这里是 `missing += 1; continue;`，文件凭空消失、安装仍报成功，
    /// 用户只能从 KubeJS 的 `MMCREvents is not defined` 倒推「少装了模组」。
    #[test]
    fn null_or_empty_download_url_is_blocked_not_skipped() {
        for url in [None, Some(""), Some("   ")] {
            let info = batch_info(
                9274793,
                Some("mmcr-neoforge-mc1.21.1-0.1.3.jar"),
                url,
                Some(&"a".repeat(40)),
            );
            let b = blocked_from_batch(&info, 1654570)
                .unwrap_or_else(|| panic!("download_url={url:?} 必须登记为阻塞，而不是继续下载"));
            assert_eq!(b.file_id, 9274793);
            assert_eq!(b.project_id, 1654570);
            assert_eq!(b.file_name, "mmcr-neoforge-mc1.21.1-0.1.3.jar");
            assert_eq!(b.sha1.as_deref(), Some("a".repeat(40).as_str()));
            assert_eq!(b.page_url, "https://www.curseforge.com/projects/1654570");
        }
    }

    /// 取反侧：有下载链接的文件不能被误报成阻塞，否则每次安装都会弹一堆假告警。
    #[test]
    fn available_download_url_is_not_blocked() {
        let info = batch_info(
            9274793,
            Some("mmcr.jar"),
            Some("https://edge.forgecdn.net/files/9274/793/mmcr.jar"),
            None,
        );
        assert!(
            blocked_from_batch(&info, 1654570).is_none(),
            "有 downloadUrl 必须走自动下载"
        );
    }

    /// CF 未给 sha1 时不能凭空造一个，否则补全校验恒失败。
    #[test]
    fn missing_sha1_stays_none() {
        let info = batch_info(1, Some("x.jar"), None, Some(""));
        let b = blocked_from_batch(&info, 1).unwrap();
        assert_eq!(b.sha1, None);
    }

    /// issue #301：精确文件页只认项目的规范网站地址。
    #[test]
    fn file_page_url_requires_curseforge_website() {
        let site = "https://www.curseforge.com/minecraft/mc-mods/jei";
        assert_eq!(
            cf_file_page_url(site, 9274793).as_deref(),
            Some("https://www.curseforge.com/minecraft/mc-mods/jei/files/9274793")
        );
        // 尾斜杠与空白不能拼出 `//files/`。
        assert_eq!(
            cf_file_page_url("  https://www.curseforge.com/minecraft/mc-mods/jei/  ", 7).as_deref(),
            Some("https://www.curseforge.com/minecraft/mc-mods/jei/files/7")
        );
        // 这个链接会交给系统浏览器打开，非 CF 域名一律拒绝。
        for bad in [
            "",
            "   ",
            "https://evil.example.com/minecraft/mc-mods/jei",
            "http://www.curseforge.com/minecraft/mc-mods/jei",
            "https://www.curseforge.com.evil.com/x",
            "javascript:alert(1)",
        ] {
            assert_eq!(cf_file_page_url(bad, 1), None, "不可信地址必须拒绝: {bad}");
        }
        // 带查询串 / 锚点 / 端口的写法直接拼会得到坏链接，因此按 URL 结构校验
        // 而不是字符串前缀。空路径没有可拼的文件页。
        for bad in [
            "https://www.curseforge.com/minecraft/mc-mods/jei?tab=files",
            "https://www.curseforge.com/minecraft/mc-mods/jei#files",
            "https://www.curseforge.com:8443/minecraft/mc-mods/jei",
            "https://www.curseforge.com",
            "https://www.curseforge.com/",
            "https://curseforge.com",
        ] {
            assert_eq!(cf_file_page_url(bad, 1), None, "不规范地址必须拒绝: {bad}");
        }
        // `..` 会被 URL 解析规范化掉，主域不变——链接指向错页面但不会跳出 CF 域。
        assert_eq!(
            cf_file_page_url("https://www.curseforge.com/../evil", 1).as_deref(),
            Some("https://www.curseforge.com/evil/files/1")
        );
        // 不带 www 的规范地址同样放行，且主机名原样保留。
        assert_eq!(
            cf_file_page_url("https://curseforge.com/minecraft/mc-mods/jei", 3).as_deref(),
            Some("https://curseforge.com/minecraft/mc-mods/jei/files/3")
        );
        // fileId 无效时不生成链接。
        assert_eq!(cf_file_page_url(site, 0), None);
        assert_eq!(cf_file_page_url(site, -1), None);
    }

    /// 只填缺失项：已有链接不能被另一轮解析覆盖。
    #[test]
    fn apply_file_page_urls_fills_only_missing() {
        let mut items = vec![entry(10, "a.jar", None), entry(20, "b.jar", None)];
        items[0].file_page_url = Some("https://www.curseforge.com/kept/files/10".to_string());
        let mut sites = HashMap::new();
        sites.insert(
            1654570,
            "https://www.curseforge.com/minecraft/mc-mods/mmcr".to_string(),
        );

        // items[0] 已有值、items[1] 需要补 —— 两条同项目同网站地址。
        assert!(apply_file_page_urls(&mut items, &sites));
        assert_eq!(
            items[0].file_page_url.as_deref(),
            Some("https://www.curseforge.com/kept/files/10"),
            "已有链接不得被覆盖"
        );
        assert_eq!(
            items[1].file_page_url.as_deref(),
            Some("https://www.curseforge.com/minecraft/mc-mods/mmcr/files/20")
        );
        assert!(
            !apply_file_page_urls(&mut items, &sites),
            "全部已有值时不应报告变化"
        );

        // 映射里没有的项目保持 None：前端据此退回项目页。
        let mut other = vec![entry(30, "c.jar", None)];
        other[0].project_id = 999;
        assert!(!apply_file_page_urls(&mut other, &sites));
        assert_eq!(other[0].file_page_url, None);
    }

    /// 旧 sidecar 没有 `filePageUrl` 字段，必须照常读出（否则升级后清单全丢）。
    #[test]
    fn legacy_sidecar_without_file_page_url_still_loads() {
        let root = temp_root("legacy-nopage");
        let gd = root.to_string_lossy().to_string();
        let path = blocked_path(&gd, "Nast").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"items":[{"projectId":1654570,"fileId":9274793,
                "fileName":"mmcr.jar","pageUrl":"https://www.curseforge.com/projects/1654570"}]}"#
                .replace('\n', ""),
        )
        .unwrap();

        let items = load_blocked(&gd, "Nast");
        assert_eq!(items.len(), 1, "旧清单必须照常读出");
        assert_eq!(items[0].file_id, 9274793);
        assert_eq!(items[0].file_page_url, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 新字段落盘后能原样读回（`skip_serializing_if` 不影响反序列化）。
    #[test]
    fn file_page_url_roundtrips_through_sidecar() {
        let root = temp_root("roundtrip-page");
        let gd = root.to_string_lossy().to_string();
        let mut items = vec![entry(9274793, "mmcr.jar", None)];
        items[0].file_page_url =
            Some("https://www.curseforge.com/minecraft/mc-mods/mmcr/files/9274793".to_string());
        save_blocked(&gd, "Nast", &items).unwrap();
        assert_eq!(load_blocked(&gd, "Nast"), items);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `POST /v1/mods` 的 `data[].links.websiteUrl` 路径必须有单测守着。
    ///
    /// 这段一旦读错层级，精确文件页会静默退化成项目页——没有报错、没有日志，
    /// 只有用户又开错页面，正是 issue #301 想消掉的那种体验。
    #[test]
    fn batch_mods_response_yields_website_urls() {
        // 字段裁剪自 2026-10-25 的真实响应（MMCR 1654570 / JEI 238222）。
        let body = serde_json::json!({
            "data": [
                {
                    "id": 1654570,
                    "name": "Modular Machinery: Community Refoxed",
                    "slug": "modular-machinery-community-refoxed",
                    "links": {
                        "websiteUrl": "https://www.curseforge.com/minecraft/mc-mods/modular-machinery-community-refoxed",
                        "wikiUrl": "",
                        "issuesUrl": ""
                    },
                    "allowModDistribution": false
                },
                {
                    "id": 238222,
                    "links": { "websiteUrl": "https://www.curseforge.com/minecraft/mc-mods/jei" }
                },
                // 没有 links：跳过，不生成精确链接。
                { "id": 42, "name": "no links" },
                // websiteUrl 为空串：同样跳过。
                { "id": 43, "links": { "websiteUrl": "   " } },
                // id 不是整数（防御性）：跳过而不是 panic。
                { "id": "not-a-number", "links": { "websiteUrl": "https://www.curseforge.com/x" } }
            ]
        });
        let got = parse_mod_websites(&body).expect("合法响应必须解析成功");
        assert_eq!(got.len(), 2, "只有带非空 websiteUrl 的条目能产出链接");
        assert_eq!(
            got.get(&1654570).map(String::as_str),
            Some(
                "https://www.curseforge.com/minecraft/mc-mods/modular-machinery-community-refoxed"
            )
        );
        assert_eq!(
            got.get(&238222).map(String::as_str),
            Some("https://www.curseforge.com/minecraft/mc-mods/jei")
        );

        // 结构异常必须报错：调用方会把「项目不在结果里」当成「没有网站地址」写进
        // 缓存，结构异常若也返回空表，这些项目就永久拿不到精确链接。
        assert!(
            parse_mod_websites(&serde_json::json!({})).is_err(),
            "缺 data"
        );
        assert!(
            parse_mod_websites(&serde_json::json!({ "data": "oops" })).is_err(),
            "data 不是数组"
        );
        // 合法空数组是「这些项目确实查不到」，不是结构异常。
        assert!(parse_mod_websites(&serde_json::json!({ "data": [] }))
            .expect("空数组合法")
            .is_empty());
    }
}
