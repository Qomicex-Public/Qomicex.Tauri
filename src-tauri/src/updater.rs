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

/// 失败交接文件名（与 .zip/.sig 同处 `{dataDir}/updates/`）。
/// 写入端在 `Qomicex.Updater/src/main.rs` 的 `write_update_error`，两边必须一致。
pub(crate) const ERROR_FILE: &str = "last-update-error.json";

/// 失败交接的占用锁文件名。
const ERROR_CLAIM_FILE: &str = "last-update-error.claim";
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
    if !claim(&updates_dir, CLAIM_FILE) {
        // 没抢到占用：别的实例正在（或刚刚）消费同一份交接
        return None;
    }
    // 抢到占用后本实例独占消费；任何路径返回前都要释放占用
    let notice = consume_notice(&updates_dir);
    release_claim(&updates_dir, CLAIM_FILE);
    notice
}

/// 尝试独占占用交接（claim 文件）。返回 false = 本次不消费。
///
/// `create_new` 保证跨进程/跨线程只有一个创建者成功；另一个拿到
/// `AlreadyExists`。已存在的占用按 claimed_at 判断是否 stale（占用者崩溃
/// 未释放），stale 才清号重试一次——重试仍失败说明有活跃占用者，返回 false。
/// 尝试独占占用指定的 claim 文件。返回 false = 本次不消费。
///
/// `create_new` 保证跨进程/跨线程只有一个创建者成功；另一个拿到
/// `AlreadyExists`。已存在的占用按 claimed_at 判断是否 stale（占用者崩溃
/// 未释放），stale 才清号重试一次——重试仍失败说明有活跃占用者，返回 false。
///
/// 「更新完成」通知与「更新失败」交接各用各的 claim 文件名，抢锁逻辑只这一份。
fn claim(updates_dir: &Path, claim_name: &str) -> bool {
    let claim_path = updates_dir.join(claim_name);
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
/// 读并删除指定交接文件（泛型：完成通知与失败交接共用这套「读后即删」语义）。
fn consume_file<T: serde::de::DeserializeOwned>(updates_dir: &Path, name: &str) -> Option<T> {
    let path = updates_dir.join(name);
    let raw = std::fs::read_to_string(&path).ok()?;
    // 删不掉就不返回：文件还留在盘上，返回它等于下次启动再弹一次。
    if std::fs::remove_file(&path).is_err() {
        return None;
    }
    serde_json::from_str(&raw).ok()
}

/// 读并删除「更新完成」交接文件；version 为空的记录没有可展示内容，丢弃。
fn consume_notice(updates_dir: &Path) -> Option<PendingUpdateNotice> {
    let notice: PendingUpdateNotice = consume_file(updates_dir, NOTICE_FILE)?;
    if notice.version.trim().is_empty() {
        return None;
    }
    Some(notice)
}

/// 释放占用（尽力而为）：正常路径消费完即删；崩溃场景由 stale 回收兜底。
fn release_claim(updates_dir: &Path, claim_name: &str) {
    let _ = std::fs::remove_file(updates_dir.join(claim_name));
}

// ---------------------------------------------------------------------------
// 更新失败的交接（issue #201 的可见性）
// ---------------------------------------------------------------------------
//
// updater 是 detached 进程：它失败退出时旧启动器早已 `app.exit(0)`，屏幕上不会
// 留下任何痕迹——报告者的原话是「等待下载完成后自动重启，并没重启和更新完成」。
// 所以失败必须由 updater 落盘、由新进程读出来告诉用户。

/// updater 落盘的「这次更新没成」记录。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateError {
    /// 机器可读码：ELEVATION_DENIED | UPDATE_INSTALL_FAILED | UPDATE_WAIT_TIMEOUT。
    /// 前端按它取多语言文案；`message` 只当技术细节展示，不进翻译。
    pub(crate) code: String,
    /// 技术细节（OS 报错原文，可能含路径与引号）
    pub(crate) message: String,
    /// 安装策略（dir | appimage | app | system），决定给哪条手动升级命令
    pub(crate) strategy: String,
    /// 本次要更新到的版本（由包文件名反推，可能为空串）
    pub(crate) version: String,
    /// 写入时间（unix 秒），仅诊断用
    pub(crate) occurred_at: u64,
}

/// 消费「更新失败」交接：claim 加锁 → 读并删 → 释放锁。
///
/// 任何异常（dataDir 为空/文件缺失/内容损坏/抢锁失败）都返回 None——提示是附加
/// 体验，不能因为它影响启动。写入端是 `Qomicex.Updater/src/main.rs` 的
/// `write_update_error`，文件名与字段口径两边必须一致。
pub(crate) fn take_update_error(data_dir: &str) -> Option<UpdateError> {
    let dir = data_dir.trim();
    if dir.is_empty() {
        return None;
    }
    let updates_dir = Path::new(dir).join("updates");
    if !claim(&updates_dir, ERROR_CLAIM_FILE) {
        // 没抢到占用：别的实例正在（或刚刚）消费同一份失败交接
        return None;
    }
    let error =
        consume_file::<UpdateError>(&updates_dir, ERROR_FILE).filter(|e| !e.code.trim().is_empty());
    release_claim(&updates_dir, ERROR_CLAIM_FILE);
    error
}

/// 新一轮更新开始前丢掉上一次的失败交接（`run_updater` 调用）。
///
/// 只删数据文件、不动 claim 锁：并发消费由 claim 的 stale 超时自己回收。
fn clear_update_error(updates_dir: &Path) {
    if let Err(e) = std::fs::remove_file(updates_dir.join(ERROR_FILE)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tauri_log!("updater", "clear stale update error failed: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// 自动更新：静默下载 → 待安装 → 下次启动自动装完
// ---------------------------------------------------------------------------
//
// 目标行为（默认开启，设置页可关回原弹窗行为）：
//   发现更新 → 后台自动下载 → 落「待安装」记录 → 弹可点击的 Toast
//   → 用户点 Toast 立即重启安装；不点则**下次启动自动安装完**。
//
// 与 `pending-update-notice`（更新**完成**后的交接）方向相反：这里是更新
// **开始前**的交接。两者共用 `{dataDir}/updates/` 目录但文件名不同，互不干扰。
//
// 为什么要落盘（而不是只活在内存/localStorage）：
//   - 「下次打开自动装完」跨越进程生命周期，必须持久化；
//   - 落盘位置与 .zip/.sig 同目录，dataDir 改了记录跟着走，不会出现
//     「记录在 localStorage 而包在旧 dataDir」的错配；
//   - 记录里存 package_path，取用时校验包仍存在，被清理工具删掉即作废重下。
//
// 多实例安全：壳侧启用了 tauri-plugin-single-instance（见 lib.rs），同一份
// 记录不会被两个进程并发消费；写入仍是「先写 .tmp 再 rename」的原子覆盖，
// 与 `write_pending_notice` 同语义，读到半个文件只会被当成无记录。

/// 待安装自动更新的记录文件名（与 .zip/.sig 同处 `{dataDir}/updates/`）。
pub(crate) const AUTO_INSTALL_FILE: &str = "update-auto-install.json";

/// 自动安装的最大尝试次数。每次 `take` 都算一次尝试，且尝试数在 spawn updater
/// **之前**落盘（因此「spawn 后进程崩溃」同样计入）。超过后作废该版本并回退
/// 手动弹窗，避免「启动 → 安装失败 → 重启 → 再失败」的无限循环。
const MAX_AUTO_INSTALL_ATTEMPTS: u32 = 3;

/// 「已下载完成、等待安装」的自动更新记录。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingUpdateInstall {
    /// 目标版本（无 v 前缀 semver，与 update plan 口径一致）。
    pub(crate) version: String,
    /// 已下载的更新包绝对路径（取用时校验是否仍存在）。
    pub(crate) package_path: String,
    /// minisign 签名（armor / base64 包裹文本，原文透传给 run_updater）。
    pub(crate) signature: String,
    /// 该版本 changelog（markdown 原文），Toast 与弹窗展示用。
    #[serde(default)]
    pub(crate) changelog: String,
    /// 已尝试安装次数。
    #[serde(default)]
    pub(crate) attempts: u32,
    /// 该包所属发布列车（release | beta | alpha），即落盘时 update plan 的 channel。
    ///
    /// 用途：**跨列车不得自动安装**（ADR-081）。用户可能在完成下载后又把设置里的
    /// 通道切到别的列车；此时这份包已不属于用户当前想要的列车，无人值守地装上它
    /// 就是一次静默的跨列车更新。前端在自动安装/恢复提示前用当前有效通道比对，
    /// 不一致就丢弃该记录（改走正常的检查→弹窗流程）。
    ///
    /// `None` = 旧版记录没带通道（升级兼容）：前端视为「无法判定」而不拦，
    /// 否则老记录会永远装不上。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) channel: Option<String>,
}

/// 自动更新记录文件的整体内容（含「已作废版本」的抑制标记）。
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AutoInstallFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<PendingUpdateInstall>,
    /// 因重试超限而作废的版本：不再自动下载安装，改回弹窗让用户主动决定。
    /// 只抑制这一个版本号，新版本来临时自动流程照常。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    abandoned_version: Option<String>,
}

/// 供前端在**决定是否自动下载前**查询的只读状态。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoInstallStateView {
    /// 是否已有下载完成、等待安装的记录。
    pub(crate) has_pending: bool,
    /// 上次自动安装失败作废的版本（前端据此跳过自动流程、回退弹窗）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) abandoned_version: Option<String>,
    /// 待安装记录本身（**只读 peek，不推进 attempts**）。
    ///
    /// 给前端在「本次启动不立刻安装」（例如有实例在跑，推迟到下次）时把提示恢复出来用：
    /// 否则那个已下好的包在本会话里完全不可见，用户既不能点、也不知道它已就绪。
    /// 计数只在 [`take_auto_install`] 里推进，peek 不影响重试上限。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pending: Option<PendingUpdateInstall>,
}

/// `take_pending_update_install` 的结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutoInstallTake {
    /// ready（可安装）/ installed（新进程已是该版本，记录已清）/ missing
    /// （更新包已不在，记录已作废待重下）/ abandoned（重试超限，回退弹窗）/
    /// unpersisted（尝试计数写不进盘，拒绝无人值守安装、回退弹窗）/ none（无记录）。
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) install: Option<PendingUpdateInstall>,
}

/// 版本号归一化比较：忽略 `v` 前缀与首尾空白（与前端 take_notice 的守卫同口径）。
fn same_version(a: &str, b: &str) -> bool {
    let norm = |v: &str| v.trim().trim_start_matches(['v', 'V']).to_string();
    !a.trim().is_empty() && norm(a) == norm(b)
}

// ---------------------------------------------------------------------------
// 版本比较：**数值感知**，不能直接用 semver 的 Ord
// ---------------------------------------------------------------------------
//
// 为什么不能用 `semver::Version`：semver 规范对 pre-release 标识符按 **ASCII
// 字典序**逐字符比较（数字标识符之间才比数值），于是 `beta9` > `beta10`——因为
// `'9' > '1'`。实测确认：
//
//     semver::Version::parse("0.1.0-beta9.0") < parse("0.1.0-beta10.0")  ==  false
//
// 我们的版本号把**发布序数直接拼进类型名**（`beta10.0`），整体是一个标识符
// `beta10`，不满足 semver 的「纯数字标识符」条件，所以吃不到数值比较规则。
// 用 semver 判「谁更新」会把 beta10 当成比 beta9 旧 → 误判为降级 → 自动安装被
// 静默跳过。
//
// 本仓库后端 `services/update_channel.rs::is_train_upgrade` 早已为此实现了数值
// 解析（其测试 `ordinals_are_numeric_not_lexicographic` 专门锁住这个坑）。
// `src-tauri` 不依赖后端 crate（壳与后端是两个独立可执行体），因此这里**移植同一
// 套解析语义**（`parse_train_version` / `first_number_run` 的行为逐条对齐），
// 而不是引入 `semver` 的 Ord。
//
// 语义对齐要点（改这里必须同步改后端，反之亦然）：
// - 剥 `v` 前缀（只剥小写，与后端 `strip_v` 一致）
// - 核心段取前三段数字；pre-release 首段是「类型名 + 序数」，第二段是 legacy
//   构建号（`alpha260719.build3`）
// - 序数取该段**第一串连续数字**（不要求段首）
// - **跨列车不可比**（各自计数，`release1` 与 `beta31` 分属不同列车）

/// 发布列车（与后端 `Train` 对齐；本处只需区分"是否同一列车"）。
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
enum Train {
    Release,
    Beta,
    Alpha,
    Dev,
    Unknown,
}

/// 解析后的版本：核心三段 + 列车 + 两个序数段。
///
/// **刻意不 derive `Ord`**：比较由 [`is_train_upgrade`] 显式做（先判同列车，再比
/// 五元组），因为 `train` 不是"越大越新"的语义——`Train` 自身没有全序。
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
struct TrainVersion {
    major: u64,
    minor: u64,
    patch: u64,
    suffix1: u64,
    suffix2: u64,
    train: Train,
}

/// 取一段中**第一串连续数字**的数值；无数字返回 0（对齐后端 `first_number_run`）。
fn first_number_run(seg: &str) -> u64 {
    let mut digits = String::new();
    for c in seg.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse().unwrap_or(0)
}

/// 核心段是否全为数字（容忍空段，如 `1..2`）。
fn core_is_numeric(core: &str) -> bool {
    core.split('.')
        .all(|s| s.is_empty() || s.chars().all(|c| c.is_ascii_digit()))
}

/// 解析 pre-release 首段（`beta31` / `release1` / `alpha20260823`）为
/// 「列车 + 序数」。类型名后必须为空或紧跟数字（`beta-x` 不合法 → Unknown）。
fn parse_type_segment(seg: &str) -> (Train, u64) {
    let lower = seg.to_ascii_lowercase();
    for (name, train) in [
        ("release", Train::Release),
        ("beta", Train::Beta),
        ("alpha", Train::Alpha),
    ] {
        if let Some(rest) = lower.strip_prefix(name) {
            if rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_digit()) {
                return (train, first_number_run(rest));
            }
        }
    }
    (Train::Unknown, 0)
}

/// 解析启动器版本号；无法解析（空串 / 核心段非数字）返回 `None`。
fn parse_train_version(raw: &str) -> Option<TrainVersion> {
    let v = raw.trim().trim_start_matches('v');
    if v.is_empty() {
        return None;
    }
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    if !core_is_numeric(core) {
        return None;
    }
    let mut nums = core
        .split('.')
        .filter(|s| !s.is_empty())
        .map(first_number_run);
    let major = nums.next()?;
    let minor = nums.next().unwrap_or(0);
    let patch = nums.next().unwrap_or(0);

    let Some(pre) = pre else {
        // 无 pre-release 后缀 = 本地开发构建，不属于任何已发布列车。
        return Some(TrainVersion {
            major,
            minor,
            patch,
            train: Train::Dev,
            suffix1: 0,
            suffix2: 0,
        });
    };
    let mut segs = pre.split('.');
    let (train, suffix1) = parse_type_segment(segs.next().unwrap_or(""));
    let suffix2 = segs.next().map(first_number_run).unwrap_or(0);
    Some(TrainVersion {
        major,
        minor,
        patch,
        train,
        suffix1,
        suffix2,
    })
}

/// 同列车内 `candidate` 是否比 `current` 新（数值感知，`beta10.0 > beta9.0`）。
///
/// **跨列车一律 false**：各列车序数独立计数（`beta31` 与 `release1` 不可比）。
fn is_train_upgrade(current: &str, candidate: &str) -> bool {
    let (Some(cur), Some(cand)) = (parse_train_version(current), parse_train_version(candidate))
    else {
        return false;
    };
    if cur.train != cand.train {
        return false;
    }
    (
        cand.major,
        cand.minor,
        cand.patch,
        cand.suffix1,
        cand.suffix2,
    ) > (cur.major, cur.minor, cur.patch, cur.suffix1, cur.suffix2)
}

/// `staged` 是否**旧于** `current`（为真 = 该记录已被运行中的版本取代，不该再装）。
///
/// 这是自动安装链路的**防降级守卫**：用户手动点过「立即更新」装上更新的版本后，
/// 磁盘上可能还留着上一轮自动下载的旧包记录；照常安装就是一次静默降级。
///
/// 判定用 [`is_train_upgrade`]（数值感知）而不是 semver 的 Ord —— 后者会把
/// `beta10` 当成比 `beta9` 旧（见上方模块注释），导致本守卫误判成"记录更新"而
/// 放行一次降级。**跨列车返回 false**（无法裁决，保守放行），无法解析同样 false：
/// 宁可放行（走原有安装路径），也不要因为判不出来就悄悄吞掉用户已下好的更新。
/// 同一版本不算 old（那由 [`same_version`] 先处理）。
fn is_older_than(staged: &str, current: &str) -> bool {
    // staged < current：即"反过来看，current 比 staged 新"。
    is_train_upgrade(staged, current)
}

fn auto_install_path(updates_dir: &Path) -> std::path::PathBuf {
    updates_dir.join(AUTO_INSTALL_FILE)
}

/// 读自动更新记录。文件缺失/损坏/半写一律按「无记录」处理——这条链路是
/// 附加体验，不能因为一个坏 JSON 影响启动。
fn read_auto_install(updates_dir: &Path) -> AutoInstallFile {
    std::fs::read_to_string(auto_install_path(updates_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 写自动更新记录：先写 .tmp 再 rename 原子覆盖（同 `write_pending_notice`）。
/// 内容为空（无 pending 也无 abandoned）时删除文件，不在 updates 目录留残渣。
fn write_auto_install(updates_dir: &Path, state: &AutoInstallFile) -> Result<(), String> {
    let path = auto_install_path(updates_dir);
    if state.pending.is_none() && state.abandoned_version.is_none() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if let Err(e) = std::fs::create_dir_all(updates_dir) {
        return Err(format!("AUTO_INSTALL_DIR_FAILED: {e}"));
    }
    let json = serde_json::to_vec_pretty(state).map_err(|e| format!("AUTO_INSTALL_ENCODE: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("AUTO_INSTALL_WRITE: {e}"))?;
    if std::fs::rename(&tmp, &path).is_err() {
        // 兜底：目标被占用等边角下先删再 rename 一次（rename 覆盖语义见 notice 注释）。
        let _ = std::fs::remove_file(&path);
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("AUTO_INSTALL_REPLACE: {e}"));
        }
    }
    Ok(())
}

/// `updates_dir` 解析：空 dataDir 视为不可用（设置未加载完时前端会传空串）。
fn updates_dir_of(data_dir: &str) -> Option<std::path::PathBuf> {
    let dir = data_dir.trim();
    if dir.is_empty() {
        return None;
    }
    Some(Path::new(dir).join("updates"))
}

/// 自动下载完成后调用：落「待安装」记录。
///
/// 失败返回 Err（前端只记 warn，不弹错）：记录写不进去只意味着丢掉「下次启动
/// 自动装完」这一附加能力，本次会话内仍可直接安装。
pub(crate) fn stage_auto_install(
    data_dir: &str,
    package_path: &str,
    signature: &str,
    version: &str,
    changelog: Option<&str>,
    channel: Option<&str>,
) -> Result<(), String> {
    let updates_dir = updates_dir_of(data_dir).ok_or("AUTO_INSTALL_NO_DATA_DIR")?;
    if version.trim().is_empty() {
        return Err("AUTO_INSTALL_NO_VERSION".into());
    }
    if signature.trim().is_empty() {
        return Err("AUTO_INSTALL_NO_SIGNATURE".into());
    }
    if package_path.trim().is_empty() || !Path::new(package_path).exists() {
        return Err("AUTO_INSTALL_PACKAGE_MISSING".into());
    }
    let state = AutoInstallFile {
        pending: Some(PendingUpdateInstall {
            version: version.trim().to_string(),
            package_path: package_path.to_string(),
            signature: signature.to_string(),
            changelog: changelog.unwrap_or("").to_string(),
            attempts: 0,
            // 空串按「未提供」处理，避免写出 Some("") 让前端拿去比对通道。
            channel: channel
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
        }),
        // 新记录落位时清掉旧的抑制标记：用户/前端已为本版本重新走自动流程。
        abandoned_version: None,
    };
    write_auto_install(&updates_dir, &state)
}

/// 只读查询：是否有待安装记录 / 哪个版本被作废 / 记录本身。
///
/// **不推进 attempts、不作废任何东西**——纯粹的 peek，供前端恢复提示用。
pub(crate) fn auto_install_state(data_dir: &str) -> AutoInstallStateView {
    let Some(updates_dir) = updates_dir_of(data_dir) else {
        return AutoInstallStateView {
            has_pending: false,
            abandoned_version: None,
            pending: None,
        };
    };
    let state = read_auto_install(&updates_dir);
    let pending = state.pending.filter(|p| {
        // 包已不在的记录不给前端展示：点了也装不了，前端会因此显示一条无法兑现的
        // 提示。真正的作废留到 `take_auto_install` 时做（那里才写盘）。
        Path::new(&p.package_path).exists()
    });
    AutoInstallStateView {
        has_pending: pending.is_some(),
        abandoned_version: state.abandoned_version,
        pending,
    }
}

/// 独占消费待安装记录（读后写回：attempts 递增 / 清记录 / 记抑制版本）。
///
/// `current_version` 是当前运行版本：记录里的目标版本与它一致说明**上次更新
/// 已经装成**（新进程首次启动），此时静默清记录并返回 `installed`，绝不重复
/// 安装——这是自动流程的收敛点，缺了它会在每次启动重复触发 updater。
pub(crate) fn take_auto_install(data_dir: &str, current_version: &str) -> AutoInstallTake {
    let none = |status: &str| AutoInstallTake {
        status: status.to_string(),
        version: None,
        install: None,
    };
    let Some(updates_dir) = updates_dir_of(data_dir) else {
        return none("none");
    };
    let mut state = read_auto_install(&updates_dir);
    let Some(mut pending) = state.pending.take() else {
        return none("none");
    };
    let version = pending.version.clone();

    // ① 已经装成（当前版本 == 记录版本）→ 清记录，不重复安装。
    if same_version(&pending.version, current_version) {
        if let Err(e) = write_auto_install(&updates_dir, &state) {
            tauri_log!("updater", "auto install clear failed: {e}");
        }
        return AutoInstallTake {
            status: "installed".into(),
            version: Some(version),
            install: None,
        };
    }

    // ①′ 记录版本**旧于**当前运行版本 → 用户已通过别的途径（手动点「立即更新」、
    //     重新安装）升到了更新的版本。照常安装就是一次**静默降级**，必须清记录跳过。
    //     返回 installed 而非抛弃：语义上「这个更新已经不需要了」，与 ① 同一收敛点，
    //     前端不会据此去弹「更新失败」。
    if is_older_than(&pending.version, current_version) {
        tauri_log!(
            "updater",
            "auto install skipped: staged {version} is older than running {current_version}"
        );
        if let Err(e) = write_auto_install(&updates_dir, &state) {
            tauri_log!("updater", "auto install clear failed: {e}");
        }
        return AutoInstallTake {
            status: "installed".into(),
            version: Some(version),
            install: None,
        };
    }

    // ② 更新包已不在（临时目录被清理 / 用户手删）→ 作废记录（可重新下载），
    //    不计入抑制：这是可恢复情况，下次发现更新会重新下载。
    if !Path::new(&pending.package_path).exists() {
        tauri_log!(
            "updater",
            "auto install package missing: {} — 记录作废待重下",
            pending.package_path
        );
        if let Err(e) = write_auto_install(&updates_dir, &state) {
            tauri_log!("updater", "auto install clear failed: {e}");
        }
        return AutoInstallTake {
            status: "missing".into(),
            version: Some(version),
            install: None,
        };
    }

    // ③ 重试超限 → 作废该版本并回退弹窗，避免无限「启动→失败」循环。
    if pending.attempts >= MAX_AUTO_INSTALL_ATTEMPTS {
        tauri_log!(
            "updater",
            "auto install abandoned after {} attempts: {version}",
            pending.attempts
        );
        state.abandoned_version = Some(version.clone());
        if let Err(e) = write_auto_install(&updates_dir, &state) {
            tauri_log!("updater", "auto install abandon write failed: {e}");
        }
        return AutoInstallTake {
            status: "abandoned".into(),
            version: Some(version),
            install: None,
        };
    }

    // ④ 正常路径：先递增并落盘 attempts，再交给调用方 spawn updater——
    //    顺序颠倒会让「spawn 后崩溃」不计入重试，重试上限形同虚设。
    //
    //    **落盘失败则不放行无人值守安装**（安全审查指出）：计数存不下去时，重试
    //    上限就不再是可靠的失败遏制边界——每次启动都会读到那个没被递增过的旧计数，
    //    于是一个始终失败的包会被无限次自动重装、永远到不了「作废 + 回退弹窗」。
    //    此时返回 `unpersisted`：本次不装，记录原样留在盘上，用户仍可通过更新
    //    对话框手动安装（保留显式的手动恢复路径）。这条路径只影响启动时的无人值守
    //    安装——用户点 Toast 的那条路走 `installStaged`，不经过这里。
    pending.attempts += 1;
    state.pending = Some(pending.clone());
    if let Err(e) = write_auto_install(&updates_dir, &state) {
        tauri_log!(
            "updater",
            "auto install attempt persist failed ({e}) — 拒绝无人值守安装，回退手动弹窗"
        );
        return AutoInstallTake {
            status: "unpersisted".into(),
            version: Some(version),
            install: None,
        };
    }
    AutoInstallTake {
        status: "ready".into(),
        version: Some(version),
        install: Some(pending),
    }
}

/// 清除待安装记录与抑制标记。用户点「下次再说」/手动安装成功/已作废提示过后调用，
/// 让后续版本重新回到自动流程。
pub(crate) fn clear_auto_install(data_dir: &str) {
    let Some(updates_dir) = updates_dir_of(data_dir) else {
        return;
    };
    if let Err(e) = write_auto_install(&updates_dir, &AutoInstallFile::default()) {
        tauri_log!("updater", "auto install clear failed: {e}");
    }
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
    // 新一轮更新已经开始：清掉上一次的失败交接。否则下次启动会弹出一条属于
    // 更早那次尝试的「更新未完成」——updater 这次成功时根本不会再写它。
    clear_update_error(&updates_dir);

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

/// 新进程启动后读取并删除「更新失败」交接文件（见 [`take_update_error`]）。
///
/// 与 `take_pending_update_notice` 同样是**独占消费**（只提示一次），但**不做版本
/// 守卫**：失败交接描述的正是「版本没前进」，拿当前运行版本去比对会把它自己过滤掉。
#[tauri::command]
pub fn take_pending_update_error(data_dir: String) -> Option<UpdateError> {
    take_update_error(&data_dir)
}

/// 只读查询自动更新状态（是否有待安装记录 / 哪个版本已作废）。
#[tauri::command]
pub fn update_auto_install_state(data_dir: String) -> AutoInstallStateView {
    auto_install_state(&data_dir)
}

/// 自动下载完成后落「待安装」记录（见 [`stage_auto_install`]）。
#[tauri::command]
pub fn stage_pending_update_install(
    data_dir: String,
    package_path: String,
    signature: String,
    version: String,
    changelog: Option<String>,
    channel: Option<String>,
) -> Result<(), String> {
    stage_auto_install(
        &data_dir,
        &package_path,
        &signature,
        &version,
        changelog.as_deref(),
        channel.as_deref(),
    )
}

/// 消费待安装记录（读后按结果写回）。`installed` 表示目标版本已在运行，无需安装。
#[tauri::command]
pub fn take_pending_update_install(data_dir: String) -> AutoInstallTake {
    take_auto_install(&data_dir, env!("CARGO_PKG_VERSION"))
}

/// 清除待安装记录与作废标记（用户选择稍后 / 手动安装后 / 已作废提示过后）。
#[tauri::command]
pub fn clear_pending_update_install(data_dir: String) {
    clear_auto_install(&data_dir)
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

    // -- 自动安装（静默下载 → 待安装 → 下次启动自动装完）------------------

    /// 造一个存在的「更新包」文件，供 stage 的存在性校验通过。
    fn fake_package(updates_dir: &Path) -> std::path::PathBuf {
        std::fs::create_dir_all(updates_dir).unwrap();
        let pkg = updates_dir.join("qomicex-update-9.9.9.zip");
        std::fs::write(&pkg, b"zip").unwrap();
        pkg
    }

    /// stage → take 正常路径：记录里带包路径/签名/changelog，attempts 从 0 增到 1。
    #[test]
    fn auto_install_stage_then_take_is_ready_and_counts_attempt() {
        let data_dir = temp_data_dir("auto-ready");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();

        stage_auto_install(
            &dir,
            &pkg.to_string_lossy(),
            "RWTsig",
            "9.9.9",
            Some("# 更新"),
            Some("beta"),
        )
        .expect("stage");
        assert!(auto_install_state(&dir).has_pending);

        let taken = take_auto_install(&dir, "1.0.0");
        assert_eq!(taken.status, "ready");
        assert_eq!(taken.version.as_deref(), Some("9.9.9"));
        let install = taken.install.expect("ready 必须带 install");
        assert_eq!(install.package_path, pkg.to_string_lossy());
        assert_eq!(install.signature, "RWTsig");
        assert_eq!(install.changelog, "# 更新");
        // 尝试次数在交给调用方**之前**就已落盘（spawn 后崩溃也要计入重试）
        assert_eq!(install.attempts, 1, "take 后 attempts 应为 1");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 收敛点：当前版本 == 记录版本（上次更新已装成）→ installed 且清记录，绝不重复安装。
    #[test]
    fn auto_install_is_consumed_when_target_version_is_running() {
        let data_dir = temp_data_dir("auto-installed");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();

        let taken = take_auto_install(&dir, "9.9.9");
        assert_eq!(taken.status, "installed");
        assert!(taken.install.is_none(), "已装成不得再触发一次安装");
        assert!(!auto_install_state(&dir).has_pending, "记录必须被清掉");
        // 再取一次已是 none，不会在后续启动重复触发
        assert_eq!(take_auto_install(&dir, "9.9.9").status, "none");

        // 归一化比较：带 v 前缀 / 空白同样识别为已装成
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "v9.9.9", None, None).unwrap();
        assert_eq!(take_auto_install(&dir, " 9.9.9 ").status, "installed");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 更新包被清理工具/用户删掉 → missing 并作废记录（可重下），且不写抑制标记。
    #[test]
    fn auto_install_missing_package_is_dropped_not_suppressed() {
        let data_dir = temp_data_dir("auto-missing");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();
        std::fs::remove_file(&pkg).unwrap();

        let taken = take_auto_install(&dir, "1.0.0");
        assert_eq!(taken.status, "missing");
        assert!(taken.install.is_none());
        let state = auto_install_state(&dir);
        assert!(!state.has_pending);
        assert!(
            state.abandoned_version.is_none(),
            "包缺失是可恢复情况，不该抑制该版本的自动流程"
        );

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 重试上限：第 3 次后第 4 次直接作废并记 abandonedVersion（回退弹窗）。
    #[test]
    fn auto_install_abandons_after_max_attempts() {
        let data_dir = temp_data_dir("auto-abandon");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();

        // 模拟「每次尝试都失败」：take 会递增 attempts，且因版本不匹配不会走 installed 分支
        for expected in 1..=MAX_AUTO_INSTALL_ATTEMPTS {
            let taken = take_auto_install(&dir, "1.0.0");
            assert_eq!(taken.status, "ready", "第 {expected} 次仍应放行");
            assert_eq!(taken.install.unwrap().attempts, expected);
        }

        let taken = take_auto_install(&dir, "1.0.0");
        assert_eq!(taken.status, "abandoned");
        assert!(taken.install.is_none());
        let state = auto_install_state(&dir);
        assert!(!state.has_pending);
        assert_eq!(state.abandoned_version.as_deref(), Some("9.9.9"));
        // 作废后仍持续返回 abandoned（前端据此跳过自动流程），不会退回 ready
        assert_eq!(take_auto_install(&dir, "1.0.0").status, "none");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// clear 同时清掉 pending 与抑制标记，并删除记录文件（不留 .tmp 残渣）。
    #[test]
    fn auto_install_clear_resets_pending_and_suppression() {
        let data_dir = temp_data_dir("auto-clear");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();

        clear_auto_install(&dir);
        let state = auto_install_state(&dir);
        assert!(!state.has_pending);
        assert!(state.abandoned_version.is_none());
        assert!(
            !auto_install_path(&updates_dir).exists(),
            "清空后不留记录文件"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&updates_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(
            leftovers,
            vec![std::ffi::OsString::from("qomicex-update-9.9.9.zip")],
            "只应剩更新包本体"
        );

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// stage 拒绝不完整输入（空版本/空签名/包不存在）——宁可不记，也不留下装不了的记录。
    #[test]
    fn auto_install_stage_rejects_incomplete_input() {
        let data_dir = temp_data_dir("auto-reject");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        let p = pkg.to_string_lossy().to_string();

        assert!(stage_auto_install("", &p, "sig", "9.9.9", None, None).is_err());
        assert!(stage_auto_install(&dir, &p, "sig", "  ", None, None).is_err());
        assert!(stage_auto_install(&dir, &p, "  ", "9.9.9", None, None).is_err());
        assert!(stage_auto_install(&dir, "", "sig", "9.9.9", None, None).is_err());
        assert!(
            stage_auto_install(&dir, "C:/nope/none.zip", "sig", "9.9.9", None, None).is_err(),
            "包不存在时必须拒绝"
        );
        assert!(!auto_install_state(&dir).has_pending);

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 空 dataDir（设置未加载完）→ 全部操作安全退化，不相对路径拼。
    #[test]
    fn auto_install_empty_data_dir_is_inert() {
        assert!(!auto_install_state("").has_pending);
        assert!(!auto_install_state("   ").has_pending);
        assert_eq!(take_auto_install("", "1.0.0").status, "none");
        // clear 不 panic 即通过
        clear_auto_install("");
    }

    /// 损坏的记录文件按「无记录」处理，且不会让启动失败。
    #[test]
    fn auto_install_corrupt_file_is_treated_as_absent() {
        let data_dir = temp_data_dir("auto-corrupt");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();
        std::fs::write(auto_install_path(&updates_dir), "{ not json").unwrap();
        let dir = data_dir.to_string_lossy().to_string();

        let state = auto_install_state(&dir);
        assert!(!state.has_pending);
        assert!(state.abandoned_version.is_none());
        assert_eq!(take_auto_install(&dir, "1.0.0").status, "none");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 重新 stage 会清掉旧的抑制标记（用户主动重走自动流程时不该被旧作废挡死）。
    #[test]
    fn auto_install_restage_clears_abandoned_marker() {
        let data_dir = temp_data_dir("auto-restage");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();
        for _ in 0..=MAX_AUTO_INSTALL_ATTEMPTS {
            take_auto_install(&dir, "1.0.0");
        }
        assert_eq!(
            auto_install_state(&dir).abandoned_version.as_deref(),
            Some("9.9.9")
        );

        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "10.0.0", None, None).unwrap();
        let state = auto_install_state(&dir);
        assert!(state.has_pending);
        assert!(state.abandoned_version.is_none());

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 防降级守卫：磁盘上留着旧版本的待安装记录、而当前运行版本更新（用户手动点过
    /// 「立即更新」）时，必须清记录跳过，**不能**照常安装把用户降级回去。
    #[test]
    fn auto_install_never_downgrades_a_newer_running_version() {
        let data_dir = temp_data_dir("auto-downgrade");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "1.0.0", None, None).unwrap();

        // 当前跑的是 2.0.0（比记录里的 1.0.0 新）→ 跳过并清记录
        let taken = take_auto_install(&dir, "2.0.0");
        assert_eq!(taken.status, "installed");
        assert!(taken.install.is_none(), "旧记录不得触发一次降级安装");
        assert!(!auto_install_state(&dir).has_pending);

        // 记录仍比当前新（1.0.0 → 当前 0.9.0）时照常放行
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "1.0.0", None, None).unwrap();
        assert_eq!(take_auto_install(&dir, "0.9.0").status, "ready");

        // 版本号无法解析时保守放行（不因解析失败吞掉已下载好的更新）
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// `is_older_than` 的边界：无法解析 / 同版本 / 带 v 前缀都不算「更旧」。
    #[test]
    fn is_older_than_only_true_for_parsable_strictly_lower() {
        assert!(is_older_than("1.0.0", "2.0.0"));
        assert!(is_older_than("v0.1.0-beta23.0", "0.1.0-beta31.0"));
        assert!(!is_older_than("2.0.0", "1.0.0"));
        assert!(
            !is_older_than("1.0.0", "1.0.0"),
            "同版本由 same_version 处理"
        );
        assert!(
            !is_older_than("not-a-version", "1.0.0"),
            "解析失败必须保守放行"
        );
        assert!(!is_older_than("1.0.0", "not-a-version"));
    }

    /// **序数必须按数值比较，不能走 semver 的 Ord**（CodeRabbit review 抓到的真
    /// bug）：semver 对 `beta10` 这种「类型名+序数」整体是一个标识符，按 ASCII
    /// 字典序逐字符比 → `beta9 > beta10`。
    ///
    /// 实测（semver 1.x）：`parse("0.1.0-beta9.0") < parse("0.1.0-beta10.0")` 为
    /// **false**。若用 semver 的 Ord，beta10 会被判成比 beta9 旧，`is_older_than`
    /// 于是把"磁盘上 beta10 待安装、当前跑 beta9"误判为「记录更旧、该丢弃」，自动
    /// 安装被静默跳过。
    ///
    /// 两个方向都要锁：本仓库后端 `update_channel.rs` 的
    /// `ordinals_are_numeric_not_lexicographic` 是同一约定的既有护栏。
    #[test]
    fn version_order_is_numeric_not_lexicographic() {
        // 9 → 10 是升级（字典序会判反）
        assert!(
            is_older_than("0.1.0-beta9.0", "0.1.0-beta10.0"),
            "beta9 早于 beta10，应判定为更旧"
        );
        assert!(
            !is_older_than("0.1.0-beta10.0", "0.1.0-beta9.0"),
            "beta10 不早于 beta9（字典序会误判为更旧）"
        );
        // 同列车更大的序数：自动安装必须放行
        assert!(is_older_than("0.1.0-beta31.0", "0.1.0-beta32.0"));
        assert!(!is_older_than("0.1.0-beta32.0", "0.1.0-beta31.0"));
        // alpha 日期序数（legacy 形态的第二段构建号同样数值比较）
        assert!(is_older_than(
            "0.1.0-alpha20260822.9",
            "0.1.0-alpha20260822.10"
        ));
        assert!(is_older_than(
            "0.1.0-alpha260719.build1",
            "0.1.0-alpha260719.build2"
        ));
        // 核心段数值比较
        assert!(is_older_than("0.1.0-beta1.0", "0.2.0-beta1.0"));
        assert!(is_older_than("0.1.0-release1.0", "0.1.1-release1.0"));
    }

    /// 跨列车**不可比**：各列车序数独立计数，返回 false（保守放行，不误判降级）。
    #[test]
    fn cross_train_versions_are_never_ordered() {
        assert!(!is_older_than("0.1.0-beta31.0", "0.1.0-release1.0"));
        assert!(!is_older_than("0.1.0-release1.0", "0.1.0-beta31.0"));
        assert!(!is_older_than("0.1.0-alpha20260823.0", "0.1.0-beta31.0"));
        // dev 构建（裸 X.Y.Z）不属任何列车
        assert!(!is_older_than("0.1.0", "0.1.0-release1.0"));
    }

    /// 解析语义必须与后端 `parse_train_version` 逐条对齐：
    /// 只剥小写 `v`、`beta-x` 之类非法类型段 → Unknown（跨列车 → 不比）。
    #[test]
    fn version_parsing_matches_backend_conventions() {
        assert_eq!(
            parse_train_version("0.1.0-beta31.0").unwrap().train,
            Train::Beta
        );
        assert_eq!(
            parse_train_version("v0.1.0-release1.0").unwrap().train,
            Train::Release
        );
        assert_eq!(parse_train_version("0.1.0").unwrap().train, Train::Dev);
        // 大写 V 不剥 → 核心段 `V0.1.0` 非数字 → 解析失败（与后端同结论）
        assert!(parse_train_version("V0.1.0-beta1.0").is_none());
        // `beta-x` 不算合法序数段 → Unknown
        assert_eq!(
            parse_train_version("0.1.0-beta-x").unwrap().train,
            Train::Unknown
        );
        // 序数取该段第一串连续数字（不要求段首）
        assert_eq!(
            parse_train_version("0.1.0-beta12-hotfix").unwrap().suffix1,
            12
        );
        assert_eq!(first_number_run("build3"), 3);
        assert_eq!(first_number_run("nodigits"), 0);
    }

    /// peek（`auto_install_state`）必须**不推进 attempts**：前端每次渲染/每次启动
    /// 都可能调它，若它计数，重试上限会被查询次数白白吃掉。
    #[test]
    fn auto_install_state_peek_does_not_consume_attempts() {
        let data_dir = temp_data_dir("auto-peek");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();

        for _ in 0..10 {
            let view = auto_install_state(&dir);
            assert!(view.has_pending);
            assert_eq!(view.pending.expect("peek 应带出记录").attempts, 0);
        }
        // 反复 peek 后首次 take 的 attempts 仍是 1（额度没被 peek 吃掉）
        assert_eq!(
            take_auto_install(&dir, "1.0.0").install.unwrap().attempts,
            1
        );

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// peek 不展示包已缺失的记录：那条提示点了也装不了。
    #[test]
    fn auto_install_state_peek_hides_missing_package() {
        let data_dir = temp_data_dir("auto-peek-missing");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();
        std::fs::remove_file(&pkg).unwrap();

        let view = auto_install_state(&dir);
        assert!(!view.has_pending);
        assert!(view.pending.is_none());
        // 记录仍在盘上：真正作废留给 take_auto_install（那里才写盘）
        assert!(auto_install_path(&updates_dir).exists());

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 端到端（跨两次进程启动）走一遍需求主路径：
    ///
    ///   会话 A：下载完成 → stage（记录落盘，弹 Toast）
    ///   用户不点 Toast，关掉启动器（记录留在磁盘上）
    ///   会话 B：启动 → take → ready（本次就会装上）
    ///   会话 C：装成后的新版本启动 → take → installed + 记录清除（不再重复装）
    #[test]
    fn auto_install_survives_restart_and_converges_after_install() {
        let data_dir = temp_data_dir("auto-lifecycle");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        let pkg_path = pkg.to_string_lossy().to_string();

        // 会话 A：静默下载完成，落盘待安装记录
        stage_auto_install(
            &dir,
            &pkg_path,
            "sig-A",
            "0.1.0-beta32.0",
            Some("- 修了点东西"),
            Some("beta"),
        )
        .expect("stage");
        let a = auto_install_state(&dir);
        assert!(a.has_pending, "会话 A 应能看到待安装提示");
        assert_eq!(a.pending.as_ref().unwrap().version, "0.1.0-beta32.0");
        assert_eq!(
            a.pending.as_ref().unwrap().channel.as_deref(),
            Some("beta"),
            "通道必须随记录落盘，供前端判定跨列车（ADR-081）"
        );

        // 会话 B：进程重启，旧版本仍在跑 → 消费记录并安装
        let b = take_auto_install(&dir, "0.1.0-beta31.0");
        assert_eq!(b.status, "ready");
        let install = b.install.expect("应给出可安装的记录");
        assert_eq!(install.version, "0.1.0-beta32.0");
        assert_eq!(install.signature, "sig-A");
        assert_eq!(install.changelog, "- 修了点东西");
        assert_eq!(install.attempts, 1, "会话 B 记一次尝试");
        // 记录此刻仍留在盘上（等待会话 C 的版本守卫收敛）——包也还在
        assert!(auto_install_state(&dir).has_pending);
        assert!(pkg.exists(), "安装前包不得被删");

        // 会话 C：updater 装成，beta32 进程启动 → 收敛并清记录
        let c = take_auto_install(&dir, "0.1.0-beta32.0");
        assert_eq!(c.status, "installed");
        assert!(c.install.is_none(), "已装成不得再安装一次");
        assert!(!auto_install_state(&dir).has_pending, "记录必须清除");
        assert!(
            !auto_install_path(&updates_dir).exists(),
            "收敛后 updates 目录不留记录文件"
        );
        // 再启动一次仍是 none：不会每次启动都触发 updater
        assert_eq!(take_auto_install(&dir, "0.1.0-beta32.0").status, "none");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 端到端异常路径：下载好了但连续 3 次都没装成（包在、版本一直没变）→
    /// 第 4 次作废并记 abandonedVersion，前端据此回退弹窗，不再无限重试。
    #[test]
    fn auto_install_failure_lifecycle_ends_in_dialog_fallback() {
        let data_dir = temp_data_dir("auto-fail-lifecycle");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(
            &dir,
            &pkg.to_string_lossy(),
            "sig",
            "0.1.0-beta32.0",
            None,
            None,
        )
        .unwrap();

        // 三次启动三次尝试（版本始终停在 beta31 → 每次都 ready）
        for n in 1..=MAX_AUTO_INSTALL_ATTEMPTS {
            let t = take_auto_install(&dir, "0.1.0-beta31.0");
            assert_eq!(t.status, "ready", "第 {n} 次仍应放行");
        }
        // 第四次：作废并抑制该版本
        assert_eq!(
            take_auto_install(&dir, "0.1.0-beta31.0").status,
            "abandoned"
        );
        let state = auto_install_state(&dir);
        assert_eq!(
            state.abandoned_version.as_deref(),
            Some("0.1.0-beta32.0"),
            "前端据此跳过自动流程、回退弹窗"
        );
        assert!(!state.has_pending);

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 通道必须随记录落盘并可读回：前端据此判定跨列车、拒绝无人值守安装（ADR-081）。
    #[test]
    fn staged_channel_round_trips_and_absent_channel_stays_none() {
        let data_dir = temp_data_dir("auto-channel");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();

        // 显式通道
        stage_auto_install(
            &dir,
            &pkg.to_string_lossy(),
            "sig",
            "9.9.9",
            None,
            Some("beta"),
        )
        .unwrap();
        assert_eq!(
            auto_install_state(&dir).pending.unwrap().channel.as_deref(),
            Some("beta")
        );

        // 空串/空白按「未提供」处理，不写出 Some("")（否则前端会拿它去比对通道）
        stage_auto_install(
            &dir,
            &pkg.to_string_lossy(),
            "sig",
            "9.9.9",
            None,
            Some("  "),
        )
        .unwrap();
        assert_eq!(auto_install_state(&dir).pending.unwrap().channel, None);

        // 完全不传（旧调用方/升级兼容）同样是 None：前端视为「无法判定」而不拦
        stage_auto_install(&dir, &pkg.to_string_lossy(), "sig", "9.9.9", None, None).unwrap();
        assert_eq!(auto_install_state(&dir).pending.unwrap().channel, None);

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 尝试计数**写不进盘**时必须拒绝无人值守安装（安全审查的可靠性发现）。
    ///
    /// 否则重试上限不再是可靠的失败遏制边界：计数永远是旧的，一个始终失败的包会被
    /// 每次启动无限重装、永远到不了「作废 + 回退弹窗」。
    ///
    /// 注入方式：把写入用的 **.tmp 路径**造成目录 → `std::fs::write(tmp)` 必失败，
    /// 而记录本身仍是可正常读出的文件（记录可读、写入失败，正是要模拟的场景）。
    /// 不能把记录路径本身造成目录：那样 `read_auto_install` 读不出内容，会被当成
    /// 「无记录」（none），根本走不到这条分支。
    #[test]
    fn take_refuses_unattended_install_when_attempt_cannot_be_persisted() {
        let data_dir = temp_data_dir("auto-unpersisted");
        let updates_dir = data_dir.join("updates");
        let pkg = fake_package(&updates_dir);
        let dir = data_dir.to_string_lossy().to_string();
        stage_auto_install(
            &dir,
            &pkg.to_string_lossy(),
            "sig",
            "9.9.9",
            None,
            Some("beta"),
        )
        .unwrap();
        // 记录必须仍可读出（前置条件）
        assert!(auto_install_state(&dir).has_pending);

        // 让写入失败：占用 .tmp 路径
        let tmp = auto_install_path(&updates_dir).with_extension("json.tmp");
        std::fs::create_dir(&tmp).unwrap();

        let taken = take_auto_install(&dir, "1.0.0");
        assert_eq!(
            taken.status, "unpersisted",
            "计数存不下去时必须拒绝无人值守安装，而不是照常返回 ready"
        );
        assert!(taken.install.is_none(), "不得给出可安装记录");
        assert_eq!(taken.version.as_deref(), Some("9.9.9"));

        // 排障后（.tmp 路径恢复可用）正常路径依旧工作：记录未被破坏
        std::fs::remove_dir(&tmp).unwrap();
        let after = take_auto_install(&dir, "1.0.0");
        assert_eq!(after.status, "ready", "注入解除后应恢复正常");
        assert_eq!(
            after.install.unwrap().attempts,
            1,
            "计数从未写成功过，故仍是首次尝试"
        );

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 旧版记录（JSON 里没有 channel 字段）必须仍能反序列化——升级兼容。
    #[test]
    fn legacy_record_without_channel_deserializes() {
        let data_dir = temp_data_dir("auto-legacy-channel");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();
        let pkg = fake_package(&updates_dir);
        // 手写一份「旧版」记录：无 channel 键
        let legacy = format!(
            r#"{{"pending":{{"version":"9.9.9","packagePath":"{}","signature":"sig","changelog":"","attempts":0}}}}"#,
            pkg.to_string_lossy().replace('\\', "\\\\")
        );
        std::fs::write(auto_install_path(&updates_dir), legacy).unwrap();
        let dir = data_dir.to_string_lossy().to_string();

        let view = auto_install_state(&dir);
        assert!(view.has_pending, "旧记录必须仍被识别");
        assert_eq!(view.pending.unwrap().channel, None);

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // ------------------------------------------------ 更新失败交接（#201）

    /// updater 侧 `write_update_error` 的**真实输出**（单行、无空格、message 里
    /// 带转义引号）。壳侧结构体必须能解析它——这是跨仓库契约，改一边就得红。
    const UPDATER_WIRE_FIXTURE: &str = r#"{"code":"ELEVATION_DENIED","message":"pkexec 退出 127：\"x\" \\ y","strategy":"system","version":"0.1.2-beta1.0","occurredAt":1791259159}"#;

    fn write_error_file(updates_dir: &Path, body: &str) {
        std::fs::create_dir_all(updates_dir).unwrap();
        std::fs::write(updates_dir.join(ERROR_FILE), body).unwrap();
    }

    #[test]
    fn update_error_parses_the_updater_wire_format() {
        let data_dir = temp_data_dir("err-wire");
        let updates_dir = data_dir.join("updates");
        write_error_file(&updates_dir, UPDATER_WIRE_FIXTURE);

        let err = take_update_error(&data_dir.to_string_lossy()).expect("应能解析 updater 的输出");
        assert_eq!(err.code, "ELEVATION_DENIED");
        // message 里的 \" 与 \\ 必须还原成 " 和 \，否则用户看到的细节是坏的
        assert_eq!(err.message, "pkexec 退出 127：\"x\" \\ y");
        assert_eq!(err.strategy, "system");
        assert_eq!(err.version, "0.1.2-beta1.0");
        assert_eq!(err.occurred_at, 1791259159);
        // 读后即删
        assert!(!updates_dir.join(ERROR_FILE).exists());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn update_error_take_is_once_only() {
        let data_dir = temp_data_dir("err-once");
        write_error_file(&data_dir.join("updates"), UPDATER_WIRE_FIXTURE);
        let dir = data_dir.to_string_lossy().to_string();

        assert!(take_update_error(&dir).is_some());
        assert!(
            take_update_error(&dir).is_none(),
            "同一条失败只能提示一次，否则每次启动都弹"
        );
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn update_error_and_notice_are_independent() {
        // 装失败后紧接着又成功一次的场景里，两个交接各有自己的 claim，
        // 不能互相挡住（否则「更新完成」或「更新未完成」有一条永远弹不出来）。
        let data_dir = temp_data_dir("err-vs-notice");
        let updates_dir = data_dir.join("updates");
        std::fs::create_dir_all(&updates_dir).unwrap();
        write_pending_notice(&updates_dir, "0.2.0", "- 修好了链接");
        write_error_file(&updates_dir, UPDATER_WIRE_FIXTURE);
        let dir = data_dir.to_string_lossy().to_string();

        let notice = take_pending_notice(&dir).expect("完成交接应可读");
        assert_eq!(notice.version, "0.2.0");
        let err = take_update_error(&dir).expect("失败交接不该被完成交接的锁挡住");
        assert_eq!(err.code, "ELEVATION_DENIED");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn concurrent_update_error_take_consumes_exactly_once() {
        let data_dir = temp_data_dir("err-concurrent");
        write_error_file(&data_dir.join("updates"), UPDATER_WIRE_FIXTURE);
        let dir = data_dir.to_string_lossy().to_string();
        let got = std::thread::scope(|s| {
            let a = s.spawn(|| take_update_error(&dir).is_some());
            let b = s.spawn(|| take_update_error(&dir).is_some());
            (a.join().unwrap(), b.join().unwrap())
        });
        assert!(
            got.0 ^ got.1,
            "两个实例并发消费只能有一个拿到，实得 {got:?}"
        );
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn update_error_rejects_missing_code_and_absent_file() {
        // 缺 code 的记录没法映射文案，丢弃；但文件已被 consume_file 删掉，
        // 不会留下每次启动都解析一遍的残渣。
        let data_dir = temp_data_dir("err-no-code");
        let updates_dir = data_dir.join("updates");
        write_error_file(
            &updates_dir,
            r#"{"code":"","message":"x","strategy":"system","version":"","occurredAt":1}"#,
        );
        assert!(take_update_error(&data_dir.to_string_lossy()).is_none());
        assert!(!updates_dir.join(ERROR_FILE).exists());
        // 没有文件时静默 None（正常启动的最常见路径）
        assert!(take_update_error(&data_dir.to_string_lossy()).is_none());
        assert!(take_update_error("").is_none(), "dataDir 未加载完时短路");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn clear_update_error_drops_the_previous_attempt_record() {
        // run_updater 在新一轮更新开始时调用它：否则下次启动会弹一条属于
        // 更早那次尝试的「更新未完成」。缺文件也不能报错（NotFound 是常态）。
        let data_dir = temp_data_dir("err-clear");
        let updates_dir = data_dir.join("updates");
        write_error_file(&updates_dir, UPDATER_WIRE_FIXTURE);
        clear_update_error(&updates_dir);
        assert!(take_update_error(&data_dir.to_string_lossy()).is_none());
        clear_update_error(&updates_dir); // 再清一次不应 panic / 不应留下残渣
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
