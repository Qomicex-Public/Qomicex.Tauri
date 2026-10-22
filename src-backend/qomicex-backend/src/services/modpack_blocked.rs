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

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::services::modpack_export::sha1_file_hex;
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
/// 而 `projects/{id}/files/{fileId}` 是 404。用户在项目页的 Files 里按版本号找，
/// 与清单里显示的 `file_id` 对得上。
pub fn cf_project_page_url(project_id: i64) -> String {
    format!("https://www.curseforge.com/projects/{project_id}")
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
    })
}

/// 阻塞清单路径（实例版本目录内）。
pub fn blocked_path(game_dir: &str, instance_name: &str) -> PathBuf {
    crate::services::modpack_manifest::instance_version_dir(game_dir, instance_name)
        .join(QOMICEX_DIR)
        .join(BLOCKED_FILE)
}

/// 实例的 `mods/` 目录（与安装落盘口径一致，见 `modpack_target_path`）。
pub fn mods_dir(game_dir: &str, instance_name: &str, version_isolation: bool) -> PathBuf {
    if version_isolation {
        Path::new(game_dir)
            .join("versions")
            .join(instance_name)
            .join("mods")
    } else {
        Path::new(game_dir).join("mods")
    }
}

/// 读取阻塞清单。文件缺失 / 解析失败 / schema 不认识 → 空清单。
///
/// 与 `modpack_manifest::load_manifest` 同样的取舍：清单损坏绝不能反过来阻断
/// 实例的其它功能，最坏退化成「看起来没有阻塞文件」。
pub fn load_blocked(game_dir: &str, instance_name: &str) -> Vec<BlockedModFile> {
    let path = blocked_path(game_dir, instance_name);
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
pub fn save_blocked(
    game_dir: &str,
    instance_name: &str,
    items: &[BlockedModFile],
) -> std::io::Result<()> {
    let path = blocked_path(game_dir, instance_name);
    if items.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(&BlockedModList::new(items.to_vec()))
            .map_err(std::io::Error::other)?;
        std::fs::write(&path, body)
    }
}

/// 手动补全：校验用户提供的文件，通过后放进 `mods/` 并从清单移除。
///
/// `expected_sha1` 来自清单条目。SHA-1 缺失时只做文件名检查并放行（旧接口降级），
/// 有值时**必须**匹配——版本不一致的 jar 会让整合包在启动阶段崩，而崩在哪里
/// 用户很难归因到「补错了文件」。
///
/// 返回放置后的目标路径，便于调用方区分「补到了哪个文件名」。
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
    let file_name = entry.file_name.trim();
    if file_name.is_empty() {
        return Err("清单条目缺少文件名，无法确定放置位置".to_string());
    }
    if !is_safe_rel_path(file_name) || file_name.contains('/') || file_name.contains('\\') {
        return Err(format!("文件名非法: {file_name}"));
    }

    if let Some(expected) = entry.sha1.as_deref().filter(|s| !s.is_empty()) {
        let got = sha1_file_hex(src).map_err(|e| format!("计算文件校验值失败: {e}"))?;
        if !got.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "文件校验失败：期望 SHA-1 {expected}，实际 {got}。请确认下载的是整合包要求的 {file_name}（fileId {}）",
                entry.file_id
            ));
        }
    }

    let dest = mods_dir(game_dir, instance_name, version_isolation).join(file_name);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 mods 目录失败: {e}"))?;
    }
    std::fs::copy(src, &dest).map_err(|e| format!("写入 {file_name} 失败: {e}"))?;

    // 放进 mods/ 后再从清单移除：先移清单、后复制会留下「清单说补过了但文件没到」
    // 的假成功状态。这里失败只影响下次是否重复提示，不回滚已放置的文件。
    let mut remaining = load_blocked(game_dir, instance_name);
    remaining.retain(|it| it.file_id != entry.file_id);
    if let Err(e) = save_blocked(game_dir, instance_name, &remaining) {
        tracing::warn!(error = %e, "阻塞清单更新失败（文件已放入 mods/）");
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        }
    }

    #[test]
    fn empty_list_removes_sidecar() {
        let root = temp_root("empty");
        let gd = root.to_string_lossy().to_string();
        save_blocked(&gd, "Nast", &[entry(1, "a.jar", None)]).unwrap();
        assert!(blocked_path(&gd, "Nast").is_file());
        save_blocked(&gd, "Nast", &[]).unwrap();
        assert!(
            !blocked_path(&gd, "Nast").is_file(),
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
    fn corrupt_sidecar_degrades_to_empty() {
        let root = temp_root("corrupt");
        let gd = root.to_string_lossy().to_string();
        let path = blocked_path(&gd, "Nast");
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
        assert!(dest.ends_with("mods/mmcr.jar") || dest.ends_with("mods\\mmcr.jar"));
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
            !mods_dir(&gd, "Nast", true).join("mmcr.jar").is_file(),
            "校验失败不能落盘"
        );
        assert_eq!(
            load_blocked(&gd, "Nast").len(),
            1,
            "校验失败必须保留清单条目"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accept_without_sha1_still_places() {
        let root = temp_root("nosha");
        let gd = root.to_string_lossy().to_string();
        let src = root.join("unverified.jar");
        std::fs::write(&src, b"data").unwrap();
        let e = entry(42, "unverified.jar", None);
        save_blocked(&gd, "Nast", std::slice::from_ref(&e)).unwrap();
        let dest = accept_manual_file(&gd, "Nast", false, &src, &e).unwrap();
        assert!(std::fs::read(&dest).unwrap() == b"data");
        assert!(
            load_blocked(&gd, "Nast").is_empty(),
            "无校验值时按文件名放行"
        );
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

    #[test]
    fn mods_dir_follows_isolation() {
        let gd = "C:/games/.minecraft";
        let isolated = mods_dir(gd, "Nast", true);
        assert!(isolated.ends_with(Path::new("versions").join("Nast").join("mods")));
        let shared = mods_dir(gd, "Nast", false);
        assert!(shared.ends_with("mods"));
        assert!(!shared.to_string_lossy().contains("Nast"));
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
}
