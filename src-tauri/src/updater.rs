//! `run_updater` Tauri command: prepare and spawn Qomicex.Updater, then let
//! the caller exit the app. The updater binary is embedded at build time
//! (release) or resolved from `QOMICEX_UPDATER_PATH` (dev).
//!
//! 更新完成的「交接」：updater 重启后的新进程不带任何参数（`--launch` 只给
//! exe 路径），无从得知自己刚更新完、更看不到 changelog。因此旧进程在
//! `run_updater` 里把一份 `PendingUpdateNotice` 落到更新包同目录，新进程
//! 启动后由 `take_pending_update_notice` 以 `create_new` 占用锁独占消费（只
//! 提示一次；并发启动只有一个实例能占用，不会双弹）。消费端
//! 还须校验 notice.version 与当前运行版本一致——updater 装失败后用户手动开
//! 旧版时不能弹「更新完成」。

use tauri::AppHandle;

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 更新完成交接文件名（与 .zip/.sig 同处 `{dataDir}/updates/`）。
pub(crate) const NOTICE_FILE: &str = "pending-update-notice.json";

/// 交接的占用锁（claim）文件名，与交接文件同目录。
const CLAIM_FILE: &str = "pending-update-notice.claim";

/// 占用的 stale 阈值（秒）：占用者崩溃没来得及释放时，超过该时长后允许重新
/// 竞争，避免一次崩溃永久堵死后续的更新完成提示。
const CLAIM_STALE_AFTER_SECS: u64 = 60;

/// 当前 unix 秒（claim / notice 的时间戳写入用；取不到时钟返回 0）。
fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 「本次启动是刚更新完的」交接记录。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingUpdateNotice {
    /// 更新目标版本（无 v 前缀 semver，与 update plan 口径一致）。
    pub(crate) version: String,
    /// 更新前版本（写入进程的 CARGO_PKG_VERSION）。
    pub(crate) previous_version: String,
    /// 该版本 changelog（markdown 原文，来自 update plan）。
    #[serde(default)]
    pub(crate) changelog: String,
    /// 写入时间（unix 秒），仅诊断用。
    pub(crate) updated_at: u64,
}

/// 交接文件路径：直接落在更新包所在目录（即 `{dataDir}/updates/`）。
fn notice_path(updates_dir: &Path) -> std::path::PathBuf {
    updates_dir.join(NOTICE_FILE)
}

/// 旧进程退出前调用：写交接文件。失败只记日志、不返回 Err——更新本身已经
/// 在跑（updater 已 spawn），不能因为一条提示写不进去就中断更新。
pub(crate) fn write_pending_notice(updates_dir: &Path, version: &str, changelog: &str) {
    let notice = PendingUpdateNotice {
        version: version.to_string(),
        previous_version: env!("CARGO_PKG_VERSION").to_string(),
        changelog: changelog.to_string(),
        updated_at: now_unix_secs(),
    };
    let path = notice_path(updates_dir);
    // 先写临时文件再 rename：新进程若读到写了一半的文件，parse 失败只会
    // 当作无交接（take 返回 None），不会弹出错导弹窗。rename 在 Windows
    // （MOVEFILE_REPLACE_EXISTING）与 Unix 上都会原子覆盖已存在的目标——
    // 旧通知未消费时再次更新，新通知直接胜出，不会读到过期数据。
    let tmp = path.with_extension("json.tmp");
    let json = match serde_json::to_vec_pretty(&notice) {
        Ok(j) => j,
        Err(e) => {
            tauri_log!("updater", "notice serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&tmp, &json) {
        tauri_log!("updater", "notice write failed: {} err={e}", tmp.display());
        return;
    }
    if std::fs::rename(&tmp, &path).is_err() {
        // 兜底：rename 直接覆盖失败（目标被占用等边角）时，先删旧通知再 rename
        // 一次，确保新通知仍能落位。仍失败则清掉 tmp 保留旧通知——写入失败只是
        // 丢一次弹窗，不能中断更新流程本身。
        let _ = std::fs::remove_file(&path);
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tauri_log!(
                "updater",
                "notice replace failed: {} err={e}",
                path.display()
            );
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// 新进程启动后调用：**独占消费**交接文件（只提示一次）。
///
/// 并发/失败语义（对应评审两条评论）：
/// - 占用用 `create_new`（Windows `CREATE_NEW` / Unix `O_EXCL`）——std 里
///   唯一跨平台原子且互斥的原语，两个实例并发启动只有一个能占用成功。
///   Windows 上 `rename` 不能用作占用：实测两个进程并发 rename 同一来源
///   （即使目标名不同）可以双双返回 Ok（rust std 在 Windows 的 rename 非
///   原子），先读后删/先 rename 再读都会双弹。
/// - 读得到但删不掉交接文件时不返回通知（`.ok()?` 显式处理）：绝不让仍留在
///   盘上的通知被返回，否则后续每次启动都会重复弹窗。
/// - 占用文件带 claimed_at 时间戳：上次占用者崩溃没释放时，超过
///   `CLAIM_STALE_AFTER_SECS` 视为 stale 重新竞争，避免一次崩溃永久堵死。
///
/// 任何异常（路径为空/文件缺失/内容损坏/占用失败）都返回 None——交接提示是
/// 尽力而为的附加体验，不能影响启动。
pub(crate) fn take_pending_notice(data_dir: &str) -> Option<PendingUpdateNotice> {
    let dir = data_dir.trim();
    if dir.is_empty() {
        return None;
    }
    let updates_dir = Path::new(dir).join("updates");
    if !claim_notice(&updates_dir) {
        // 没抢到占用：别的实例正在（或刚刚）消费同一份交接
        return None;
    }
    // 抢到占用后本实例独占消费；任何路径返回前都要释放占用
    let notice = consume_notice(&updates_dir);
    release_claim(&updates_dir);
    notice
}

/// 尝试独占占用交接（claim 文件）。返回 false = 本次不消费。
///
/// `create_new` 保证跨进程/跨线程只有一个创建者成功；另一个拿到
/// `AlreadyExists`。已存在的占用按 claimed_at 判断是否 stale（占用者崩溃
/// 未释放），stale 才清号重试一次——重试仍失败说明有活跃占用者，返回 false。
fn claim_notice(updates_dir: &Path) -> bool {
    let claim_path = updates_dir.join(CLAIM_FILE);
    let open_claim = || {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&claim_path)
    };
    let mut file = match open_claim() {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if !claim_is_stale(&claim_path) {
                return false;
            }
            let _ = std::fs::remove_file(&claim_path);
            match open_claim() {
                Ok(f) => f,
                // 重试仍已被占：别的实例刚抢到，落败
                Err(_) => return false,
            }
        }
        // 占用文件都建不了（只读目录等）：放弃本次提示，不影响启动
        Err(_) => return false,
    };
    let _ = writeln!(file, "{}", now_unix_secs());
    true
}

/// claim 是否 stale。读不到或内容损坏一律按 stale 处理——最终是否占用由
/// `create_new` 原子裁决，这里只决定「是否值得再竞争一次」。
fn claim_is_stale(claim_path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(claim_path) else {
        return true;
    };
    match raw.trim().parse::<u64>() {
        Ok(at) => now_unix_secs().saturating_sub(at) > CLAIM_STALE_AFTER_SECS,
        Err(_) => true,
    }
}

/// 读并删除交接文件。删除失败返回 None：文件还留在盘上，不能返回它。
fn consume_notice(updates_dir: &Path) -> Option<PendingUpdateNotice> {
    let path = notice_path(updates_dir);
    let raw = std::fs::read_to_string(&path).ok()?;
    if std::fs::remove_file(&path).is_err() {
        return None;
    }
    let notice: PendingUpdateNotice = serde_json::from_str(&raw).ok()?;
    if notice.version.trim().is_empty() {
        return None;
    }
    Some(notice)
}

/// 释放占用（尽力而为）：正常路径消费完即删；崩溃场景由 stale 回收兜底。
fn release_claim(updates_dir: &Path) {
    let _ = std::fs::remove_file(updates_dir.join(CLAIM_FILE));
}

#[cfg(all(not(debug_assertions), windows))]
const UPDATER_BIN: &[u8] = include_bytes!("../binaries/updater.exe");
#[cfg(all(not(debug_assertions), unix))]
const UPDATER_BIN: &[u8] = include_bytes!("../binaries/updater");

#[cfg(debug_assertions)]
const UPDATER_BIN: &[u8] = &[];

#[cfg(windows)]
const UPDATER_EXE: &str = "qomicex-updater.exe";
#[cfg(unix)]
const UPDATER_EXE: &str = "qomicex-updater";

pub(crate) fn extract_updater(updates_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let _ = std::fs::create_dir_all(updates_dir);
    let path = updates_dir.join(UPDATER_EXE);

    let bytes: &[u8] = if UPDATER_BIN.is_empty() {
        // Dev override wins over sibling-repo builds: explicit selection must
        // not be silently shadowed by a stale local build.
        if let Ok(p) = std::env::var("QOMICEX_UPDATER_PATH") {
            let p = std::path::PathBuf::from(p);
            if p.exists() {
                // 统一落位：复制到 updates 目录，诊断时 exe 与包/日志同处。
                if std::fs::copy(&p, &path).is_ok() {
                    return Some(path);
                }
                return Some(p);
            }
        }
        // Dev fallback: local updater build from the sibling repository.
        let dev = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Qomicex.Updater/target/release/"
        ))
        .join(UPDATER_EXE);
        if dev.exists() {
            if std::fs::copy(&dev, &path).is_ok() {
                return Some(path);
            }
            return Some(dev);
        }
        let dev_dbg = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Qomicex.Updater/target/debug/"
        ))
        .join(UPDATER_EXE);
        if dev_dbg.exists() {
            if std::fs::copy(&dev_dbg, &path).is_ok() {
                return Some(path);
            }
            return Some(dev_dbg);
        }
        tauri_log!(
            "updater",
            "updater binary not embedded and not found (set QOMICEX_UPDATER_PATH)"
        );
        return None;
    } else {
        UPDATER_BIN
    };

    match std::fs::write(&path, bytes) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
            }
            Some(path)
        }
        Err(e) => {
            tauri_log!("updater", "write updater to {} failed: {e}", path.display());
            None
        }
    }
}

/// Install root / strategy inputs per platform.
///
/// - windows: `dir`  — NSIS currentUser layout, exe sits in the install root
/// - linux  : `appimage` when $APPIMAGE is set, else `system` (deb/rpm → /)
/// - macos  : `app`  — bundle root derived from Contents/MacOS/<exe>
fn detect_strategy() -> (String, Vec<(&'static str, String)>) {
    if cfg!(windows) {
        let dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        return ("dir".into(), vec![("install-dir", dir)]);
    }
    if cfg!(target_os = "macos") {
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|p| {
                // <bundle>.app/Contents/MacOS/exe → <bundle>.app
                p.ancestors().nth(3).map(|p| p.to_path_buf())
            })
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        return ("app".into(), vec![("app-bundle", bundle)]);
    }
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        return ("appimage".into(), vec![("appimage", appimage)]);
    }
    ("system".into(), vec![])
}

fn launch_target() -> String {
    if cfg!(target_os = "linux") {
        if let Ok(appimage) = std::env::var("APPIMAGE") {
            return appimage;
        }
    }
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Spawn the updater detached; the frontend closes the app right after.
///
/// `package_path`: downloaded update zip; `signature`: minisign armor text.
#[tauri::command]
pub fn run_updater(
    app: AppHandle,
    package_path: String,
    signature: String,
    version: String,
    // update plan 里的 changelog（markdown 原文）。随交接文件落盘，供新进程的
    // 「更新完成」弹窗二次展示。旧前端不传时为 None，交接文件里 changelog 为空。
    changelog: Option<String>,
) -> Result<(), String> {
    // 每步实际求值都落日志（非模板），app.exit 前强制 flush——这是
    // detached updater 的唯一前置观测面。
    macro_rules! step {
        ($($arg:tt)*) => {{
            tauri_log!("updater", $($arg)*);
            crate::logger::flush_log();
        }};
    }

    let package = std::path::PathBuf::from(&package_path);
    let updates_dir = package
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or("UPDATE_PACKAGE_NOT_FOUND")?;

    step!("stage1 extract: package={package_path}");
    let updater = extract_updater(&updates_dir).ok_or("UPDATER_BINARY_MISSING")?;
    step!("stage1 extract ok: updater={}", updater.display());
    if !package.exists() {
        step!("stage1 abort: package missing");
        return Err("UPDATE_PACKAGE_NOT_FOUND".into());
    }

    // 信任边界：version 来自更新计划响应，未校验前不进文件名（防路径穿越
    // 把签名写到预期临时目录之外）。签名无效时 updater 的 minisign 校验
    // 会拒绝包本体——这里只挡文件系统副作用。
    let parsed = semver::Version::parse(version.trim().trim_start_matches('v')).map_err(|e| {
        step!("stage2 semver reject: version={version} err={e}");
        "INVALID_VERSION".to_string()
    })?;
    step!("stage2 semver ok: version={parsed}");

    let sig_path = updates_dir.join(format!("qomicex-update-{parsed}.sig"));
    match std::fs::write(&sig_path, &signature) {
        Ok(()) => step!(
            "stage3 sig written: {} ({} bytes)",
            sig_path.display(),
            signature.len()
        ),
        Err(e) => {
            step!("stage3 sig write failed: {} err={e}", sig_path.display());
            return Err(format!("SIG_WRITE_FAILED: {e}"));
        }
    }

    let (strategy, mut extra) = detect_strategy();
    extra.push(("launch", launch_target()));
    step!(
        "stage4 strategy={strategy} extras={:?}",
        extra
            .iter()
            .map(|(f, v)| format!("--{f}={v}"))
            .collect::<Vec<_>>()
    );

    let log_path = updates_dir.parent().unwrap_or(&updates_dir).join("log");
    let _ = std::fs::create_dir_all(&log_path);
    let log_file = log_path.join(format!("qomicex-updater-{}.log", std::process::id()));

    let mut cmd = std::process::Command::new(&updater);
    cmd.arg("--package")
        .arg(&package)
        .arg("--signature")
        .arg(&sig_path)
        .arg("--strategy")
        .arg(&strategy)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .arg("--log")
        .arg(&log_file);
    for (flag, value) in extra {
        cmd.arg(format!("--{flag}")).arg(value);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008 | 0x00000200 | 0x08000000); // DETACHED | NEW_GROUP | NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // 记录实际求值的完整命令行（argv 形式，非拼接字符串，无歧义）。
    let argv: Vec<String> = std::iter::once(updater.to_string_lossy().into_owned())
        .chain(
            cmd.get_args()
                .map(|a| {
                    let a = a.to_string_lossy();
                    if a.contains(' ') {
                        format!("\"{a}\"")
                    } else {
                        a.into_owned()
                    }
                })
                .collect::<Vec<_>>(),
        )
        .collect();
    step!("stage5 cmd: {}", argv.join(" "));

    if let Err(e) = cmd.spawn() {
        step!("stage5 spawn failed: {e}");
        return Err(format!("UPDATER_SPAWN_FAILED: {e}"));
    }
    step!("stage6 exiting: sleep 300ms then app.exit(0), RunEvent::Exit kills embedded backend");

    // 更新交接文件：updater 已成功 spawn（上面失败路径已提前 return），更新
    // 必将发生。新进程重启后由 take_pending_update_notice 读取并弹「更新完成」
    // 对话框。写失败只记日志——不能因此中断已在进行中的更新。
    write_pending_notice(
        &updates_dir,
        &parsed.to_string(),
        changelog.as_deref().unwrap_or(""),
    );
    step!(
        "stage6 notice written: {}",
        notice_path(&updates_dir).display()
    );

    // Give the OS a beat to start the child, then close: RunEvent::Exit kills
    // the backend, the updater waits for our pid before touching files.
    std::thread::sleep(std::time::Duration::from_millis(300));
    crate::logger::flush_log();
    app.exit(0);
    Ok(())
}

/// 新进程启动后读取并删除「更新完成」交接文件（见模块文档）。
///
/// `data_dir` 即后端 settings 的 dataDir（前端 `getSettings().dataDir`）——
/// 与 `run_updater` 写入时使用的 `{dataDir}/updates/` 同一目录。前端在版本
/// 守卫通过（notice.version === 当前运行版本）后才展示，防误报。
#[tauri::command]
pub fn take_pending_update_notice(data_dir: String) -> Option<PendingUpdateNotice> {
    take_pending_notice(&data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_data_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qomicex-updater-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn notice_roundtrip_and_take_once() {
        let data_dir = temp_data_dir("roundtrip");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();

        write_pending_notice(&updates_dir, "0.1.0-beta32.0", "# 更新\n- 修复了链接");

        let notice = take_pending_notice(&data_dir.to_string_lossy()).expect("take");
        assert_eq!(notice.version, "0.1.0-beta32.0");
        assert_eq!(notice.previous_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(notice.changelog, "# 更新\n- 修复了链接");
        assert!(notice.updated_at > 0);
        // take-once：第二次读取已无交接
        assert!(take_pending_notice(&data_dir.to_string_lossy()).is_none());
        assert!(!notice_path(&updates_dir).exists());

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn concurrent_take_consumes_notice_exactly_once() {
        let data_dir = temp_data_dir("concurrent");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();
        write_pending_notice(&updates_dir, "0.1.0-beta33.0", "- 并发回归");

        // create_new 占用锁互斥：两个线程同时 take，恰好一个读走通知（输家 AlreadyExists）
        let dir_str = data_dir.to_string_lossy().to_string();
        let got = std::thread::scope(|s| {
            let a = s.spawn(|| take_pending_notice(&dir_str).is_some());
            let b = s.spawn(|| take_pending_notice(&dir_str).is_some());
            (a.join().unwrap(), b.join().unwrap())
        });
        assert!(
            got.0 ^ got.1,
            "exactly one of two concurrent takes may consume the notice, got {got:?}"
        );
        // 通知已从原路径消失，不会在后续启动重复弹出
        assert!(!notice_path(&updates_dir).exists());

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn fresh_claim_blocks_but_stale_claim_is_reclaimed() {
        let data_dir = temp_data_dir("claim");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();
        write_pending_notice(&updates_dir, "0.1.0-beta34.0", "- 占用回归");
        let claim_path = updates_dir.join(CLAIM_FILE);

        // 新鲜占用：别的实例正在消费 → 直接放弃，通知与占用都原样保留
        std::fs::write(&claim_path, now_unix_secs().to_string()).unwrap();
        assert!(take_pending_notice(&data_dir.to_string_lossy()).is_none());
        assert!(notice_path(&updates_dir).exists());
        assert!(claim_path.exists());

        // stale 占用（超过阈值）：清号重试，正常消费
        std::fs::write(
            &claim_path,
            (now_unix_secs() - CLAIM_STALE_AFTER_SECS - 1).to_string(),
        )
        .unwrap();
        let notice = take_pending_notice(&data_dir.to_string_lossy()).expect("take");
        assert_eq!(notice.version, "0.1.0-beta34.0");
        // 消费后通知与占用都不残留（占用必释放，否则 stale 之前的启动全被堵死）
        assert!(!notice_path(&updates_dir).exists());
        assert!(!claim_path.exists());

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn corrupt_claim_content_is_treated_as_stale() {
        let data_dir = temp_data_dir("claim-corrupt");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();
        write_pending_notice(&updates_dir, "0.1.0-beta35.0", "");
        std::fs::write(updates_dir.join(CLAIM_FILE), "garbage").unwrap();

        let notice = take_pending_notice(&data_dir.to_string_lossy()).expect("take");
        assert_eq!(notice.version, "0.1.0-beta35.0");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn take_missing_or_invalid_is_none() {
        let data_dir = temp_data_dir("missing");
        // 无交接文件
        assert!(take_pending_notice(&data_dir.to_string_lossy()).is_none());
        // 空 dataDir（前端设置未加载完时）：不相对路径拼
        assert!(take_pending_notice("").is_none());
        assert!(take_pending_notice("   ").is_none());
        // 损坏文件：消费掉并返回 None（下次启动不再重复解析）
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();
        std::fs::write(notice_path(&updates_dir), "not json").unwrap();
        assert!(take_pending_notice(&data_dir.to_string_lossy()).is_none());
        assert!(!notice_path(&updates_dir).exists());
        // 占用后原路径无通知、已占用副本也已删除：目录里不留任何残留
        let leftovers: Vec<_> = std::fs::read_dir(&updates_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert!(
            leftovers.is_empty(),
            "corrupt notice must leave no residue, got {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn write_uses_atomic_rename_and_leaves_no_tmp() {
        let data_dir = temp_data_dir("atomic");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();

        write_pending_notice(&updates_dir, "1.2.3", "");

        let path = notice_path(&updates_dir);
        assert!(path.exists());
        // .tmp 已被 rename 消费（with_extension 替换而非追加，无残留文件）
        let leftovers: Vec<_> = std::fs::read_dir(&updates_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(NOTICE_FILE)]);

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn write_replaces_stale_notice_without_residue() {
        let data_dir = temp_data_dir("replace");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();

        // 上一轮更新的通知没被消费掉，就又发起了新一轮更新
        write_pending_notice(&updates_dir, "1.2.3", "旧通知");
        write_pending_notice(&updates_dir, "1.2.4", "新通知");

        // 新通知必须胜出：否则重启后会读到过期版本，被版本守卫静默丢弃，用户看不到弹窗
        let notice = take_pending_notice(&data_dir.to_string_lossy()).expect("take");
        assert_eq!(notice.version, "1.2.4");
        assert_eq!(notice.changelog, "新通知");
        // 覆盖写入不产生 .tmp 残留
        let leftovers: Vec<_> = std::fs::read_dir(&updates_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert!(
            leftovers.is_empty(),
            "replace write must leave no residue, got {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
