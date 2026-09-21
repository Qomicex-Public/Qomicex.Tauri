//! 更新检测的通道（train）模型。
//!
//! # 为什么需要它
//!
//! 启动器的发布版本号形如 `{major}.{minor}.{patch}-{type}{ordinal}.{build}`：
//!
//! | 版本 | 列车 | 序数 |
//! |---|---|---|
//! | `0.1.0-release1.0` | release（稳定） | 1 |
//! | `0.1.0-beta31.0` | beta | 31 |
//! | `0.1.0-alpha20260823.0` | alpha | 20260823 |
//! | `0.1.0`（无后缀） | dev（本地构建） | — |
//!
//! **每条列车的序数是独立计数器**，跨列车比较序数没有意义：
//! `0.1.0-beta31.0` 与 `0.1.0-release1.0` 的 31 vs 1 不构成"谁更新"，
//! 只能比较两条列车各自的发布时间（beta31 发布于 09/21，release1.0 发布于 09/13
//! → beta31 才是更新的构建）。
//!
//! 旧实现（Web.Backend `utils/version.ts` 的 `TYPE_ORDER` + `getAllowedTypes`）
//! 把 release 一律排在 beta/alpha 之上，并让 beta 通道同时允许 release，
//! 导致三个症状：beta 用户被提示"更新到正式版"（实为降级）、
//! 正式版用户在 beta 通道下永远 204、开发构建被提示更新到正式版。
//!
//! # 本模块职责（与 Web.Backend `isUpdateFor` 语义对齐）
//!
//! 1. [`train_of`]：版本 → 列车。裸 `X.Y.Z` → [`Train::Dev`]（不属任何已发布列车）。
//! 2. [`is_train_upgrade`]：**同列车内**的数值比较（`beta10.0 > beta9.0`）。
//! 3. [`normalize_channel`]：把前端的 `stable` 别名归一为 `release`。
//!
//! 跨列车的新鲜度裁决在服务端（能查 `versions` 表的 `createdAt`），
//! 本模块只做本地不变量校验（见 `endpoints/update.rs` 的守卫）。

/// 发布列车（channel / train）。
///
/// 按"新鲜度"排序 `release < beta < alpha`，但**低新鲜度列车的版本不一定更旧**——
/// 见模块文档。因此本枚举刻意不实现 `Ord`：排序应由发布时间决定，而非枚举值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Train {
    /// 稳定版：`-releaseN.M`
    Release,
    /// 测试版：`-betaN.M`
    Beta,
    /// 开发版：`-alphaN.M`（含 legacy `-alphaYYMMDD.buildN`）
    Alpha,
    /// 本地构建：无 pre-release 后缀的裸 `X.Y.Z`
    Dev,
    /// 无法识别的 pre-release 后缀（如 `-rc1`）。永不参与自动更新。
    Unknown,
}

impl Train {
    /// 上游 `/api/client/*` 约定的 channel 字符串；`Unknown` 无对应 channel。
    pub fn as_str(self) -> Option<&'static str> {
        match self {
            Train::Release => Some("release"),
            Train::Beta => Some("beta"),
            Train::Alpha => Some("alpha"),
            Train::Dev => Some("dev"),
            Train::Unknown => None,
        }
    }
}

/// 解析出的版本：核心三段 + 列车 + 列车内序数（`suffix1`/`suffix2`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrainVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub train: Train,
    /// 列车内主序数：release/beta 为发布序号，alpha 为日期（`YYYYMMDD`）。
    pub suffix1: u64,
    /// 列车内次序数：同日/同序号内的构建号。
    pub suffix2: u64,
}

/// 去掉可选的 `v` 前缀与首尾空白。
fn strip_v(raw: &str) -> &str {
    raw.trim().trim_start_matches('v')
}

/// 取一段中**第一串连续数字**的数值；无数字返回 0。
///
/// 不要求数字在段首：legacy 形态 `alpha260719.build3` 的第二段是
/// `build3`（数字在后），按段首取数字会恒得 0，导致同日构建号无法比较。
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

/// 核心段是否全部为数字（容忍空段，如 `1..2`）。
fn core_is_numeric(core: &str) -> bool {
    core.split('.')
        .all(|s| s.is_empty() || s.chars().all(|c| c.is_ascii_digit()))
}

/// 解析 pre-release 首段（`beta31` / `release1` / `alpha20260823`）
/// 为「类型名 + 序数」。无法识别类型名时返回 `(Train::Unknown, 0)`。
fn parse_type_segment(seg: &str) -> (Train, u64) {
    let lower = seg.to_ascii_lowercase();
    for (name, train) in [
        ("release", Train::Release),
        ("beta", Train::Beta),
        ("alpha", Train::Alpha),
    ] {
        if let Some(rest) = lower.strip_prefix(name) {
            // 类型名后必须为空或紧跟数字，否则 `beta-x` 之类不视为合法序数段
            if rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_digit()) {
                return (train, first_number_run(rest));
            }
        }
    }
    (Train::Unknown, 0)
}

/// 解析启动器版本号。`None` 表示完全无法解析（空串 / 核心段非数字）。
pub fn parse_train_version(raw: &str) -> Option<TrainVersion> {
    let v = strip_v(raw);
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

    // 核心段：取前三个数字段（容忍 `1.0.0.1` 之类的四段）。
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
    let first = segs.next().unwrap_or("");
    let (train, suffix1) = parse_type_segment(first);
    // legacy `alpha260719.build3`：第二段是构建号。
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

/// 版本 → 列车。解析失败一律 [`Train::Unknown`]（调用方据此拒绝更新）。
pub fn train_of(raw: &str) -> Train {
    parse_train_version(raw).map_or(Train::Unknown, |v| v.train)
}

/// 同列车内 `candidate` 是否比 `current` 新（数值感知，`beta10.0 > beta9.0`）。
///
/// **跨列车一律 `false`**：跨列车的新鲜度由发布时间决定，本函数无权裁决
/// （服务端持 `versions.createdAt`）。返回值含"同列车且相等/更旧"的 false。
pub fn is_train_upgrade(current: &str, candidate: &str) -> bool {
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

/// 把前端的 channel 字符串归一为上游/内部口径。
///
/// `stable` 是 `release` 的 UI 别名（设置页选项值），必须在此收敛；
/// 其余原样返回（小写）。无法识别的值返回 `None`。
pub fn normalize_channel(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" => None,
        "stable" | "release" => Some("release".to_string()),
        "beta" => Some("beta".to_string()),
        "alpha" => Some("alpha".to_string()),
        "dev" => Some("dev".to_string()),
        _ => None,
    }
}

/// 有效请求通道：显式 query 优先，否则回落到已安装构建所属列车。
///
/// 返回 `None` = 无通道可请求 → 调用方应直接判定"无更新"且不打上游：
/// - dev 构建（裸 `X.Y.Z`）不属于任何已发布列车，不能自动更新到发布版；
/// - 版本号无法识别（`-rc1` 等）同样保守处理。
///
/// 显式选择例外：用户主动在设置里切换通道时，即使当前是 dev 构建也照请求
/// （便于本地联调，语义上等价于"我要订阅这条列车"）。
pub fn effective_channel(explicit: Option<&str>, installed_version: &str) -> Option<String> {
    if let Some(c) = explicit.and_then(normalize_channel) {
        return Some(c);
    }
    match train_of(installed_version) {
        Train::Release | Train::Beta | Train::Alpha => {
            train_of(installed_version).as_str().map(str::to_string)
        }
        Train::Dev | Train::Unknown => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> TrainVersion {
        parse_train_version(s).expect("valid version")
    }

    #[test]
    fn train_detection_covers_all_published_shapes() {
        assert_eq!(train_of("0.1.0-release1.0"), Train::Release);
        assert_eq!(train_of("0.1.0-beta31.0"), Train::Beta);
        assert_eq!(train_of("0.1.0-alpha20260823.0"), Train::Alpha);
        // legacy alpha 日期+build 形态
        assert_eq!(train_of("0.1.0-alpha260719.build3"), Train::Alpha);
        assert_eq!(train_of("v0.1.0-beta10.0"), Train::Beta);
        // 裸版本 = 本地构建
        assert_eq!(train_of("0.1.0"), Train::Dev);
        assert_eq!(train_of("1.2.3"), Train::Dev);
        // 无法识别
        assert_eq!(train_of("0.1.0-rc1"), Train::Unknown);
        assert_eq!(train_of(""), Train::Unknown);
        assert_eq!(train_of("1.0.x"), Train::Unknown);
    }

    #[test]
    fn ordinals_are_numeric_not_lexicographic() {
        // semver 规范的 ASCII 字典序会把 '1' < '9'，导致 beta10 < beta9 的误判。
        assert!(is_train_upgrade("0.1.0-beta9.0", "0.1.0-beta10.0"));
        assert!(!is_train_upgrade("0.1.0-beta10.0", "0.1.0-beta9.0"));
        // alpha 日期序数同样数值比较
        assert!(is_train_upgrade(
            "0.1.0-alpha20260822.9",
            "0.1.0-alpha20260822.10"
        ));
        assert!(is_train_upgrade(
            "0.1.0-alpha260719.build1",
            "0.1.0-alpha260719.build2"
        ));
    }

    #[test]
    fn same_train_core_bump_is_an_upgrade() {
        assert!(is_train_upgrade("0.1.0-beta1.0", "0.2.0-beta1.0"));
        assert!(is_train_upgrade("0.1.0-release1.0", "0.1.1-release1.0"));
        assert!(!is_train_upgrade("0.1.0-release1.0", "0.1.0-release1.0"));
    }

    #[test]
    fn cross_train_never_counts_as_upgrade() {
        // beta31（09/21）比 release1.0（09/13）更新，但序数不可比 → 本地不裁决。
        // 这条正是"beta 用户被提示更新到正式版"与"正式版用户拿不到 beta"的防护。
        assert!(!is_train_upgrade("0.1.0-beta31.0", "0.1.0-release1.0"));
        assert!(!is_train_upgrade("0.1.0-release1.0", "0.1.0-beta31.0"));
        assert!(!is_train_upgrade("0.1.0-alpha20260823.0", "0.1.0-beta31.0"));
        // dev 构建无列车，任何候选都不是"同列车升级"
        assert!(!is_train_upgrade("0.1.0", "0.1.0-release1.0"));
    }

    #[test]
    fn unparseable_versions_are_never_upgrades() {
        assert!(!is_train_upgrade("", "0.1.0-beta1.0"));
        assert!(!is_train_upgrade("0.1.0", ""));
        assert!(!is_train_upgrade("0.1.0-rc1", "0.1.0-beta1.0"));
        assert!(!is_train_upgrade("0.1.0-beta1.0", "0.1.0-rc2"));
    }

    #[test]
    fn normalize_channel_maps_stable_alias() {
        assert_eq!(normalize_channel("stable").as_deref(), Some("release"));
        assert_eq!(normalize_channel("Release").as_deref(), Some("release"));
        assert_eq!(normalize_channel("beta").as_deref(), Some("beta"));
        assert_eq!(normalize_channel("ALPHA").as_deref(), Some("alpha"));
        assert_eq!(normalize_channel(""), None);
        assert_eq!(normalize_channel("nightly"), None);
    }

    #[test]
    fn effective_channel_prefers_explicit_then_installed_train() {
        // 显式选择优先（用户主动切换通道）
        assert_eq!(
            effective_channel(Some("beta"), "0.1.0-release1.0").as_deref(),
            Some("beta")
        );
        assert_eq!(
            effective_channel(Some("stable"), "0.1.0-beta31.0").as_deref(),
            Some("release")
        );
        // 未显式选择 → 跟随已安装构建所属列车
        assert_eq!(
            effective_channel(None, "0.1.0-beta23.0").as_deref(),
            Some("beta")
        );
        assert_eq!(
            effective_channel(None, "0.1.0-release1.0").as_deref(),
            Some("release")
        );
        // dev 构建且无显式选择 → 无通道（不检查更新）
        assert_eq!(effective_channel(None, "0.1.0"), None);
        // 无法识别的版本同样不检查
        assert_eq!(effective_channel(None, "0.1.0-rc1"), None);
    }

    #[test]
    fn parsed_ordinals_match_expected() {
        let b = v("0.1.0-beta31.0");
        assert_eq!((b.major, b.minor, b.patch), (0, 1, 0));
        assert_eq!((b.train, b.suffix1, b.suffix2), (Train::Beta, 31, 0));
        let a = v("0.1.0-alpha20260823.2");
        assert_eq!((a.train, a.suffix1, a.suffix2), (Train::Alpha, 20260823, 2));
        let d = v("0.1.0");
        assert_eq!((d.train, d.suffix1, d.suffix2), (Train::Dev, 0, 0));
    }
}
