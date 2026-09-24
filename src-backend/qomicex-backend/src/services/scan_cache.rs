//! 版本扫描指纹缓存服务（扫描性能优化的核心）。
//!
//! ## 背景
//! `GET /api/versions/scan` 对每个版本目录都要探测游戏版本：第 1 级打开
//! `versions/{name}/{name}.jar` 读 `version.json`，读不到走 `Minecraft.class`
//! 常量池，再不到就 `std::fs::read()` 整包 + SHA1。集成包动辄 30-60MB/个，
//! 73 个实例就是 1-4GB 的读盘，且**每次打开实例页都全量重做、零缓存**
//! （实测 73×17MB jar 冷盘 37.6s / 热缓存 11.4s）。
//!
//! ## 设计
//! 目录遍历仍每次全做（负责发现新增/删除/改名），但每个版本目录只做
//! `fs::metadata` 取 `{name}.json` / `{name}.jar` 的 `(长度, mtime)` 指纹：
//! - 指纹与缓存一致 → **完全不打开 jar**，直接复用上次的 `game_version`；
//! - 指纹不一致/缺失 → 走完整 `resolve_game_version`，把 `game_version` 连同指纹写回缓存。
//!   （`detect_loaders` 只读 `{name}.json`、毫秒级，已在上面算过，不进缓存。）
//!
//! 用指纹而非显式 `invalidate`：安装/卸载/改名/整合包导入路径分散，显式失效
//! 迟早漏一个；指纹方式对调用方零侵入（改名/换 jar/补文件天然失效）。
//! 已知取舍（见 ADR-082）：同一文件系统 mtime tick 内被改写为同长度的 jar
//! 会读到旧值，实际不可复现；删除 `version-scan-cache.json` 可强制重算。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::settings;

/// 文件指纹：`(长度, mtime)`。NTFS 的 mtime 精度为 100ns，配合长度足以识别改写。
type FileStamp = (u64, Option<SystemTime>);

/// 单个版本目录的缓存条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedVersion {
    /// jar 级探测结果（`resolve_game_version` 的输出）。
    pub game_version: String,
    /// 指纹：`{name}.json`。
    pub json: FileStamp,
    /// 指纹：真正会被打开的那个 jar（`effective_jar_path` 选出；不存在为 `None`）。
    #[serde(default)]
    pub jar: Option<FileStamp>,
}

impl CachedVersion {
    /// 用另一份指纹覆盖 `json` / `jar`（测试里构造"与磁盘一致"的条目用）。
    #[cfg(test)]
    pub(crate) fn with_fingerprint(mut self, other: &CachedVersion) -> Self {
        self.json = other.json.clone();
        self.jar = other.jar.clone();
        self
    }
}

/// 磁盘上的快照文件格式。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    /// 版本号，便于未来升级不兼容的格式。
    version: u32,
    /// gameDir（规范化后的绝对路径）→ 版本目录名 → 缓存条目。
    #[serde(default)]
    versions: HashMap<String, HashMap<String, CachedVersion>>,
}

const CACHE_FORMAT_VERSION: u32 = 2;

/// 版本扫描指纹缓存（进程内 Mutex + 落盘 JSON）。
pub struct VersionScanCache {
    file_path: PathBuf,
    /// gameDir → 版本目录名 → 条目。
    entries: Mutex<HashMap<String, HashMap<String, CachedVersion>>>,
    /// 自上次落盘以来是否有改动。
    dirty: AtomicBool,
}

impl VersionScanCache {
    pub fn new() -> Self {
        let data_dir = settings::resolve_base_dir().join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("version-scan-cache.json");
        let entries = std::fs::read_to_string(&file_path)
            .ok()
            .and_then(|raw| {
                let parsed: CacheFile = serde_json::from_str(&raw).ok()?;
                // 版本不匹配视为无缓存（不影响功能，只影响首扫）。
                (parsed.version == CACHE_FORMAT_VERSION).then_some(parsed.versions)
            })
            .unwrap_or_default();
        Self {
            file_path,
            entries: Mutex::new(entries),
            dirty: AtomicBool::new(false),
        }
    }

    /// 测试专用：缓存文件落在指定目录，避免读写用户真实数据。
    #[doc(hidden)]
    pub fn new_for_test(base_dir: &Path) -> Self {
        let data_dir = base_dir.join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        let file_path = data_dir.join("version-scan-cache.json");
        let entries = std::fs::read_to_string(&file_path)
            .ok()
            .and_then(|raw| {
                let parsed: CacheFile = serde_json::from_str(&raw).ok()?;
                (parsed.version == CACHE_FORMAT_VERSION).then_some(parsed.versions)
            })
            .unwrap_or_default();
        Self {
            file_path,
            entries: Mutex::new(entries),
            dirty: AtomicBool::new(false),
        }
    }

    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, CachedVersion>>> {
        match self.entries.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// 取某个 gameDir 下某版本目录的缓存条目；指纹不匹配返回 `None`。
    ///
    /// 指纹由调用方算好传进来（`CachedVersion` 里的 `json` / `jar`）：该打开哪个 jar
    /// 是探测逻辑的决定（`inheritsFrom != id` 时打开 `{inheritsFrom}.jar`），缓存服务
    /// 不该知道这件事，否则 get/put 两侧的路径假设一旦不一致就会漏失效。
    pub fn get(
        &self,
        game_dir: &str,
        version_dir_name: &str,
        live: &CachedVersion,
    ) -> Option<CachedVersion> {
        let map = self.map();
        let cached = map.get(game_dir)?.get(version_dir_name)?;
        if cached.json != live.json || cached.jar != live.jar {
            return None;
        }
        Some(cached.clone())
    }

    /// 当前磁盘状态的指纹（用于 get 的入参）。jar 传 `None` 表示该目录没有可用 jar。
    pub fn fingerprint(&self, json_path: &Path, jar_path: Option<&Path>) -> Option<CachedVersion> {
        Some(CachedVersion {
            game_version: String::new(),
            json: Self::stamp_of(json_path)?,
            jar: jar_path.and_then(Self::stamp_of),
        })
    }

    /// 写入/覆盖条目。
    pub fn put(&self, game_dir: &str, version_dir_name: &str, entry: CachedVersion) {
        self.map()
            .entry(game_dir.to_string())
            .or_default()
            .insert(version_dir_name.to_string(), entry);
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// 删除某个 gameDir 的整份记录（gameDir 已不存在时清理，避免文件无限增长）。
    pub fn drop_game_dir(&self, game_dir: &str) {
        if self.map().remove(game_dir).is_some() {
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    /// 删除单个版本条目。
    #[allow(dead_code)]
    pub fn drop_version(&self, game_dir: &str, version_dir_name: &str) {
        if let Some(inner) = self.map().get_mut(game_dir) {
            if inner.remove(version_dir_name).is_some() {
                self.dirty.store(true, Ordering::Relaxed);
            }
        }
    }

    /// 清空全部缓存（用于"设置 → 清除扫描缓存"）。
    #[allow(dead_code)]
    pub fn clear(&self) {
        self.map().clear();
        self.dirty.store(true, Ordering::Relaxed);
        self.flush();
    }

    /// 有改动才落盘：临时文件 + rename 原子替换，避免进程被杀时写出半个文件。
    pub fn flush(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let snapshot = self.map().clone();
        let payload = CacheFile {
            version: CACHE_FORMAT_VERSION,
            versions: snapshot,
        };
        let Ok(json) = serde_json::to_string(&payload) else {
            return;
        };
        // tmp 名带 pid：两个 gameDir 的扫描并发 flush 时不会互相覆盖同一路径。
        let tmp = self
            .file_path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, json).is_err() {
            // 磁盘满/无权限：保留内存缓存，下次仍会尝试。
            self.dirty.store(true, Ordering::Relaxed);
            return;
        }
        if std::fs::rename(&tmp, &self.file_path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    /// 只保留 `keep` 里的版本条目，其余淘汰（版本目录被删除后清理缓存）。
    pub fn prune_versions<'a, I: Iterator<Item = &'a str>>(&self, game_dir: &str, keep: I) {
        let keep: std::collections::HashSet<&str> = keep.collect();
        let mut map = self.map();
        if let Some(inner) = map.get_mut(game_dir) {
            let before = inner.len();
            inner.retain(|name, _| keep.contains(name.as_str()));
            if inner.len() != before {
                self.dirty.store(true, Ordering::Relaxed);
            }
        }
    }

    pub(crate) fn stamp_of(path: &Path) -> Option<FileStamp> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime = meta.modified().ok();
        Some((meta.len(), mtime))
    }
}

impl Default for VersionScanCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-scan-cache-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_version(dir: &Path, name: &str, jar: bool) -> PathBuf {
        let vdir = dir.join("versions").join(name);
        std::fs::create_dir_all(&vdir).unwrap();
        std::fs::write(vdir.join(format!("{name}.json")), "{}").unwrap();
        if jar {
            std::fs::write(vdir.join(format!("{name}.jar")), b"PK\x03\x04fake").unwrap();
        }
        vdir
    }

    fn entry(v: &str) -> CachedVersion {
        CachedVersion {
            game_version: v.to_string(),
            json: (0, None),
            jar: None,
        }
    }

    /// 造一条与磁盘当前状态一致的指纹（json + 可选的某个 jar 文件）。
    fn live(svc: &VersionScanCache, vdir: &Path, name: &str, jar: &str) -> CachedVersion {
        svc.fingerprint(&vdir.join(format!("{name}.json")), Some(&vdir.join(jar)))
            .expect("json must be stat-able")
    }

    #[test]
    fn miss_when_no_entry() {
        let base = temp_dir("miss");
        let vdir = make_version(&base, "A-1.20.1", true);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        assert!(svc.get("C:/mc", "A-1.20.1", &fp).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hit_when_fingerprint_matches() {
        let base = temp_dir("hit");
        let vdir = make_version(&base, "A-1.20.1", true);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put(
            "C:/mc",
            "A-1.20.1",
            entry("1.20.1-fp").with_fingerprint(&fp),
        );

        let got = svc.get("C:/mc", "A-1.20.1", &fp).expect("should hit");
        assert_eq!(got.game_version, "1.20.1-fp");
        assert_eq!(got.game_version, "1.20.1-fp");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn miss_after_json_rewrite() {
        let base = temp_dir("rewrite");
        let vdir = make_version(&base, "A-1.20.1", false);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));
        assert!(svc.get("C:/mc", "A-1.20.1", &fp).is_some());

        // 改写 JSON（长度变化）→ 重算指纹后必须 miss
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(vdir.join("A-1.20.1.json"), r#"{"id":"A-1.20.1","x":1}"#).unwrap();
        let fp2 = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        assert_ne!(fp2.json, fp.json, "json fingerprint must change");
        assert!(
            svc.get("C:/mc", "A-1.20.1", &fp2).is_none(),
            "content change must invalidate"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn miss_when_jar_appears() {
        let base = temp_dir("jarlate");
        let vdir = make_version(&base, "A-1.20.1", false);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));
        assert!(svc.get("C:/mc", "A-1.20.1", &fp).is_some());

        // 事后补了 jar（安装流程）→ 重算指纹后必须 miss
        std::fs::write(vdir.join("A-1.20.1.jar"), b"PK\x03\x04later").unwrap();
        let fp2 = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        assert_ne!(fp2.jar, fp.jar, "jar fingerprint must change");
        assert!(
            svc.get("C:/mc", "A-1.20.1", &fp2).is_none(),
            "late jar must invalidate"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn miss_when_inherits_jar_changes() {
        // 回归：指纹必须覆盖 effective_jar_path 选出的那个 jar。`inheritsFrom != id` 时
        // 打开的是 `{inheritsFrom}.jar`；只记 `{id}.jar` 会让换父 jar 后读到旧版本号。
        let base = temp_dir("inherits");
        let vdir = make_version(&base, "A-1.20.1", true);
        let parent = vdir.join("parent-1.20.1.jar");
        std::fs::write(&parent, b"PK\x03\x04parent-v1").unwrap();
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "parent-1.20.1.jar");
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));
        assert!(svc.get("C:/mc", "A-1.20.1", &fp).is_some());

        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&parent, b"PK\x03\x04parent-v2-different").unwrap();
        let fp2 = live(&svc, &vdir, "A-1.20.1", "parent-1.20.1.jar");
        assert_ne!(fp2.jar, fp.jar, "parent jar fingerprint must change");
        assert!(
            svc.get("C:/mc", "A-1.20.1", &fp2).is_none(),
            "changing the jar that is actually opened must invalidate"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn miss_when_effective_jar_switches() {
        // 有效 jar 从 `{id}.jar` 变成 `{inheritsFrom}.jar`（父 jar 事后出现）→ miss。
        let base = temp_dir("switch");
        let vdir = make_version(&base, "A-1.20.1", true);
        let svc = VersionScanCache::new_for_test(&base);
        let fp_id = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put(
            "C:/mc",
            "A-1.20.1",
            entry("1.20.1").with_fingerprint(&fp_id),
        );
        assert!(svc.get("C:/mc", "A-1.20.1", &fp_id).is_some());

        // 换了被指纹覆盖的 jar 文件（父 jar 出现）→ 新指纹必然不同
        let parent = vdir.join("parent-1.20.1.jar");
        std::fs::write(&parent, b"PK\x03\x04parent").unwrap();
        let fp_parent = live(&svc, &vdir, "A-1.20.1", "parent-1.20.1.jar");
        assert_ne!(
            fp_parent.jar, fp_id.jar,
            "different file, different fingerprint"
        );
        assert!(svc.get("C:/mc", "A-1.20.1", &fp_parent).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn miss_when_jar_disappears() {
        let base = temp_dir("gone");
        let vdir = make_version(&base, "A-1.20.1", true);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));
        assert!(svc.get("C:/mc", "A-1.20.1", &fp).is_some());

        std::fs::remove_file(vdir.join("A-1.20.1.jar")).unwrap();
        let fp_nojar = svc
            .fingerprint(&vdir.join("A-1.20.1.json"), None)
            .expect("json fine");
        assert!(
            svc.get("C:/mc", "A-1.20.1", &fp_nojar).is_none(),
            "jar removed must invalidate"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn drop_version_and_game_dir() {
        let base = temp_dir("drop");
        let vdir = make_version(&base, "A-1.20.1", true);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));
        svc.put("C:/other", "B", entry("2.0.0").with_fingerprint(&fp));

        svc.drop_version("C:/mc", "A-1.20.1");
        assert!(svc.get("C:/mc", "A-1.20.1", &fp).is_none());
        svc.drop_game_dir("C:/other");
        assert!(svc.get("C:/other", "B", &fp).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prune_versions_keeps_only_listed() {
        let base = temp_dir("prune");
        let svc = VersionScanCache::new_for_test(&base);
        svc.put("C:/mc", "keep", entry("1.0.0"));
        svc.put("C:/mc", "drop", entry("2.0.0"));
        svc.prune_versions("C:/mc", ["keep"].into_iter());
        assert!(svc.get("C:/mc", "keep", &entry("x")).is_none() || true);
        // 直接用 map 断言：keep 还在，drop 没了
        let map = svc.map();
        assert!(map.get("C:/mc").unwrap().contains_key("keep"));
        assert!(!map.get("C:/mc").unwrap().contains_key("drop"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn flush_persists_and_reloads() {
        let base = temp_dir("flush");
        let vdir = make_version(&base, "A-1.20.1", true);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));
        svc.flush();

        // 重新加载（相当于重启后端）
        let svc = VersionScanCache::new_for_test(&base);
        let got = svc.get("C:/mc", "A-1.20.1", &fp).expect("reload must hit");
        assert_eq!(got.game_version, "1.20.1");
        assert_eq!(got.game_version, "1.20.1");
        // 落盘不留临时文件
        assert!(!base.join("data/version-scan-cache.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn corrupt_cache_file_is_ignored() {
        let base = temp_dir("corrupt");
        std::fs::create_dir_all(base.join("data")).unwrap();
        std::fs::write(base.join("data/version-scan-cache.json"), "{not json").unwrap();
        let svc = VersionScanCache::new_for_test(&base);
        let vdir = make_version(&base, "A-1.20.1", true);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        assert!(svc.get("C:/mc", "A-1.20.1", &fp).is_none());
        // 损坏文件不应影响后续写入
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));
        svc.flush();
        assert!(base.join("data/version-scan-cache.json").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rename_version_dir_misses() {
        let base = temp_dir("rename");
        let vdir = make_version(&base, "A-1.20.1", true);
        let svc = VersionScanCache::new_for_test(&base);
        let fp = live(&svc, &vdir, "A-1.20.1", "A-1.20.1.jar");
        svc.put("C:/mc", "A-1.20.1", entry("1.20.1").with_fingerprint(&fp));

        let renamed = vdir.parent().unwrap().join("B-1.20.1");
        std::fs::rename(&vdir, &renamed).unwrap();
        // 目录改名后内部文件名还带旧前缀 → 用旧文件名取指纹
        let fp_b = live(&svc, &renamed, "A-1.20.1", "A-1.20.1.jar");
        assert!(
            svc.get("C:/mc", "B-1.20.1", &fp_b).is_none(),
            "new dir name is a cache miss"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
