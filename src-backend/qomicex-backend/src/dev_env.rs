//! 开发期 `.env` 加载（issue #159 / PR #170 的 dev 补充）。
//!
//! ## 背景
//!
//! `appsettings.json` 改为构建期生成后不再入库，本地 dev 默认拿不到
//! `CURSEFORGE_API_KEY`，CurseForge 相关功能（模组图标补全、更新检查、资源中心
//! CF 源）**静默降级**。而 `state.rs` 的取值顺序是「运行时环境变量非空优先，
//! 否则回退编译期嵌入值」（`AppState::build`），所以只要在 `AppState::build()`
//! **之前**把 `.env` 里的键注入进程环境，dev 即可恢复完整功能，且**不需要**
//! 触发 `build.rs` 重跑（相比在终端 export 后被固化进 appsettings.json 的写法，
//! 这里不产生编译期副作用，`git clean` 也不会丢失配置）。
//!
//! ## 只在 debug 构建启用
//!
//! 模块与调用点都由 `#[cfg(debug_assertions)]` 限定（见 `main.rs`）：release 的
//! 凭据由 CI/发布流水线在**构建期**经 `CURSEFORGE_API_KEY` 注入并编译进产物，
//! 绝不能再去读用户机器上意外存在的 `.env` —— 那会让发布行为依赖进程工作目录，
//! 并形成一条「放个文件就能改客户端配置」的注入通道。
//!
//! ## 语义（对齐 `build.rs`）
//!
//! - **空值视为未提供**（CI 里未设置的 secret 展开为空串）；
//! - 已存在的**非空**环境变量优先，不被文件覆盖（显式 `export` 的键始终赢）；
//! - 找不到文件是正常情况（绝大多数用户不会有），静默跳过。
//!
//! ## 为什么手写而不是用 `dotenvy`
//!
//! 本环境 `cargo` 无法访问 crates.io（schannel `SEC_E_NO_CREDENTIALS`），
//! `dotenvy` 也不在依赖树与本地 registry 缓存中；引入它会让离线/受限网络下的
//! 构建直接失败。这里实现 `.env` 的**常用子集**（约 40 行、零新增依赖）：
//! `KEY=VALUE`、`#` 注释、空行、可选 `export ` 前缀、可选单/双引号包裹、
//! CRLF 行尾、值内部空格保留。
//!
//! **不支持**（有意从简，需要时请用环境变量）：多行值、变量插值（`$FOO`）、
//! 行内注释（`KEY=VAL # 注释` 会把 `# 注释` 当成值的一部分——CF key 一类的
//! 取值不含 `#`，故不影响；写文件时不要把注释放在值后面）。

use std::path::PathBuf;

/// `.env` 候选文件名，按优先级排列（前者命中即停止）。
const FILE_NAMES: &[&str] = &[".env.local", ".env"];

/// 从工作目录向上回溯的最大层数。
///
/// 从工作目录向上回溯的最大层数（兜底，主路径见 [`candidate_dirs`] 的
/// `CARGO_MANIFEST_DIR` 锚点）。
///
/// `cargo run` 与 `pnpm run dev:backend` / VS Code `launch.json` 的 cwd 是**仓库根**，
/// 而 `.env.local` 在 crate 目录下（CWD 的**后代**）——只需向上回溯并不能到达，
/// 故 crate 目录必须由 `CARGO_MANIFEST_DIR` 单独锚定。此常量覆盖「从更深层目录启动」
/// 这类场景。
const MAX_ANCESTORS: usize = 8;

/// 加载 `.env.local` / `.env`（best-effort，永不失败）。
///
/// 必须在 `AppState::build()` 之前调用（后者读取 `CURSEFORGE_API_KEY` 等）。
pub fn load() {
    let Some((path, pairs)) = find_and_parse() else {
        return;
    };
    let mut applied = 0usize;
    for (key, value) in pairs {
        // 已存在的非空环境变量优先：显式 export 的键不被文件覆盖。
        // 空值视为「未提供」（与 build.rs 一致），允许被文件里的值填补。
        if is_occupied(std::env::var(&key).ok().as_deref()) {
            continue;
        }
        std::env::set_var(&key, &value);
        applied += 1;
    }
    // 只打印路径与键数：**绝不打印值**（可能含密钥），且该处 tracing 尚未初始化
    // （`init_tracing` 在 `AppState::build()` 之后），故直接用 eprintln。
    eprintln!(
        "[dev_env] 已加载 {}（注入 {applied} 个环境变量；已存在者优先）",
        path.display()
    );
}

/// 该键是否已被**非空**环境变量占用（占用则不从文件覆盖）。
///
/// 空串/纯空白视为「未提供」——与 `build.rs` 的处理一致：CI 里未设置的 secret
/// 会展开为空串，不应视为有效配置，否则文件里的值永远填不进去。
fn is_occupied(existing: Option<&str>) -> bool {
    existing.map(|v| !v.trim().is_empty()).unwrap_or(false)
}

/// 按候选目录 × 候选文件名查找首个可读文件并解析。
///
/// 文件**不存在**是正常情况（绝大多数用户不会有 `.env.local`），静默跳过；
/// 但其它读取错误必须告警：典型是 Windows 记事本把 `.env.local` 存成 GBK，
/// `read_to_string` 返回 `InvalidData`。若一并静默，本模块要解决的
/// 「凭据缺失却毫无提示」问题会以另一种形式复现（实测该错误类型**不是**
/// `NotFound`，故不能用「有错就忽略」概括）。
fn find_and_parse() -> Option<(PathBuf, Vec<(String, String)>)> {
    find_and_parse_in(&candidate_dirs(), &|msg| eprintln!("{msg}"))
}

/// [`find_and_parse`] 的实现体。
///
/// - `dirs`：显式候选目录，便于单测注入临时目录。
/// - `warn`：读取失败时的告警出口（生产传 `eprintln!`，测试可收集以断言
///   「非 NotFound 错误确实**可见**」——静默正是评审 finding #2 的实质）。
fn find_and_parse_in(
    dirs: &[PathBuf],
    warn: &dyn Fn(&str),
) -> Option<(PathBuf, Vec<(String, String)>)> {
    for dir in dirs {
        for name in FILE_NAMES {
            let path = dir.join(name);
            match std::fs::read_to_string(&path) {
                Ok(content) => return Some((path, parse(&content))),
                // 文件不存在是正常情况（绝大多数用户没有 .env.local），静默。
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                // 其它错误**必须可见**：典型是记事本把文件存成 GBK →
                // `InvalidData`。若静默，「文件在、键也在、功能却不生效」
                // 的静默降级会复现。只打印路径与错误，**不打印文件内容**。
                Err(e) => warn(&format!(
                    "[dev_env] 读取 {} 失败（已跳过）：{e}",
                    path.display()
                )),
            }
        }
    }
    None
}

/// 候选目录：**crate 目录** + 工作目录及其向上若干级祖先 + 可执行文件所在目录。
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |d: PathBuf| {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    };

    // `CARGO_MANIFEST_DIR` = crate 根（`src-backend/qomicex-backend`），编译期固化，
    // 与运行时的 CWD 无关。这是**主路径**：`.vscode/launch.json` 的「启动 Rust 后端」
    // 与 `pnpm run dev:backend` 都是从仓库根 `cargo run`，CWD 为仓库根，而 `.env.local`
    // 在 crate 目录下——它是 CWD 的**后代**，靠向上回溯永远找不到。
    // 该模块只在 debug 构建存在，故即便路径指向构建机也无影响。
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        push(PathBuf::from(manifest));
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(MAX_ANCESTORS) {
            push(ancestor.to_path_buf());
        }
    }
    // 直接运行 target/debug/qomicex-backend.exe 时，工作目录可能已不在仓库内，
    // 此时 exe 同目录的 .env 是最后一个可安置的位置。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push(parent.to_path_buf());
        }
    }
    dirs
}

/// 解析 `.env` 内容为 `(键, 值)` 列表（保持文件顺序）。
///
/// 跳过：空行、`#` 开头的注释行、无 `=` 的行、键为空的行。
fn parse(content: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for raw_line in content.lines() {
        // `str::lines()` 已处理 CRLF 的 \r？不会：它只按 \n 切分并保留 \r。
        // 故需显式去掉行尾 \r，否则 Windows 上写出的 .env 会让值带上 \r。
        let line = raw_line.trim_end_matches('\r').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // 可选 `export ` 前缀（照抄 shell 写法时不至于失效）。
        let line = line
            .strip_prefix("export ")
            .map(str::trim_start)
            .unwrap_or(line);
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        // 空键或含 NUL 的键会让 set_var panic / 无效，直接跳过。
        if key.is_empty() || key.contains('\0') {
            continue;
        }
        // **值**同样必须跳过含 NUL 的：`std::env::set_var` 的值含 NUL 会 panic
        // （实测 Windows 下报 "strings passed to WinAPI cannot contain NULs"）。
        // 本模块的约定是 best-effort、绝不失败——若在此 panic，debug 后端会在
        // `AppState::build()` 之前直接启动失败，比「凭据缺失降级」更糟。
        // 去引号后再判断：`KEY="a\0b"` 这类写法同样要拦。
        let value = unquote(raw_value.trim());
        if value.contains('\0') {
            continue;
        }
        out.push((key.to_string(), value));
    }
    out
}

/// 去掉成对的单/双引号（仅当**首尾都是同种引号**时）。
///
/// 不去引号会让 `CURSEFORGE_API_KEY="abc"` 把引号本身当成 key 的一部分
/// （CurseForge 会判 403），这是最常见的写法，必须支持。
fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if first == last && (first == b'"' || first == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 收集为便于断言的有序列表。
    fn pairs(content: &str) -> Vec<(String, String)> {
        parse(content)
    }

    #[test]
    fn parses_basic_assignments_and_skips_noise() {
        let got = pairs(
            "# 注释\n\
             \n\
             CURSEFORGE_API_KEY=abc123\n\
             MICROSOFT_CLIENT_ID=91d14170\n\
             \x20  \n\
             这不是赋值行\n",
        );
        assert_eq!(
            got,
            vec![
                ("CURSEFORGE_API_KEY".to_string(), "abc123".to_string()),
                ("MICROSOFT_CLIENT_ID".to_string(), "91d14170".to_string()),
            ]
        );
    }

    #[test]
    fn strips_quotes_and_export_prefix() {
        // 引号包裹是最常见写法；不剥离会让引号进入 key（CF 判 403）。
        assert_eq!(
            pairs("CURSEFORGE_API_KEY=\"abc123\"\n"),
            vec![("CURSEFORGE_API_KEY".to_string(), "abc123".to_string())]
        );
        assert_eq!(
            pairs("CURSEFORGE_API_KEY='abc123'\n"),
            vec![("CURSEFORGE_API_KEY".to_string(), "abc123".to_string())]
        );
        // 只剥成对同种引号：不配对时原样保留，避免吃掉真实字符。
        assert_eq!(
            pairs("KEY=\"abc\n"),
            vec![("KEY".to_string(), "\"abc".to_string())]
        );
        assert_eq!(
            pairs("KEY='abc\"\n"),
            vec![("KEY".to_string(), "'abc\"".to_string())]
        );
        // export 前缀
        assert_eq!(
            pairs("export KEY=abc\n"),
            vec![("KEY".to_string(), "abc".to_string())]
        );
    }

    #[test]
    fn handles_crlf_and_preserves_inner_spaces() {
        // Windows 上写出的 .env 是 CRLF：值尾不得残留 \r。
        let got = pairs("CURSEFORGE_API_KEY=abc123\r\nNEXT=1\r\n");
        assert_eq!(
            got,
            vec![
                ("CURSEFORGE_API_KEY".to_string(), "abc123".to_string()),
                ("NEXT".to_string(), "1".to_string()),
            ]
        );
        // 值内部空格保留，首尾空白去掉。
        assert_eq!(
            pairs("KEY=  a b c  \n"),
            vec![("KEY".to_string(), "a b c".to_string())]
        );
        // 空值合法（显式清空），键两侧空白去掉。
        assert_eq!(
            pairs("  KEY  =  \n"),
            vec![("KEY".to_string(), String::new())]
        );
    }

    #[test]
    fn rejects_invalid_keys_but_keeps_hash_inside_value() {
        // 空键 / 无 = 的行跳过
        assert!(pairs("=value\n").is_empty());
        assert!(pairs("JUSTAWORD\n").is_empty());
        // 值里的 # 视为值的一部分（不支持行内注释），避免误截断 key 内容
        assert_eq!(
            pairs("KEY=ab#cd\n"),
            vec![("KEY".to_string(), "ab#cd".to_string())]
        );
    }

    /// 候选目录必须覆盖「从 crate 目录启动」与「从仓库根启动」两种常见情形
    /// （`cargo run` 与 VS Code `launch.json` 的 cwd 不同）。
    #[test]
    fn candidate_dirs_include_cwd_ancestors() {
        let dirs = candidate_dirs();
        let cwd = std::env::current_dir().expect("cwd 可用");
        assert!(dirs.contains(&cwd), "应包含当前工作目录");
        if let Some(parent) = cwd.parent() {
            // 仅当 CWD 深度足够时才必然包含（测试通常在 crate 或仓库根下运行）。
            if cwd.ancestors().count() > 1 {
                assert!(dirs.contains(&parent.to_path_buf()), "应包含父目录");
            }
        }
    }

    /// **回归**：`CARGO_MANIFEST_DIR`（crate 目录）必须是**首位**候选。
    ///
    /// 缺陷场景（实测确认）：`.vscode/launch.json` 的「启动 Rust 后端」与
    /// `pnpm run dev:backend` 都在**仓库根**执行 `cargo run`，CWD 为仓库根；
    /// 而 `.env.local` 位于 `src-backend/qomicex-backend/`，是 CWD 的**后代**。
    /// 只向上回溯的实现永远找不到该文件（文件、解析、测试全对，功能却静默失效）。
    /// 锚定 crate 目录后与 CWD 无关。
    #[test]
    fn manifest_dir_is_first_candidate() {
        let manifest =
            option_env!("CARGO_MANIFEST_DIR").expect("debug 构建下 CARGO_MANIFEST_DIR 应存在");
        let dirs = candidate_dirs();
        assert_eq!(
            dirs.first().map(PathBuf::as_path),
            Some(std::path::Path::new(manifest)),
            "crate 目录应为首个候选（先于 CWD 及其祖先）"
        );
    }

    /// 解析出的键值可安全写入进程环境（set_var 对含 '=' 的 key 会 panic，
    /// 解析器已在 `split_once('=')` 处保证这一点）。
    #[test]
    fn parsed_keys_are_settable() {
        for (key, _) in pairs("CURSEFORGE_API_KEY=abc\n") {
            assert!(!key.contains('='), "key 不得含 '='");
        }
    }

    /// 「已存在的非空环境变量优先」的语义：显式 export 的键必须赢过 `.env`。
    ///
    /// 这是回归防线：若改成无条件 `set_var`，开发者显式 `export` 的临时 key
    /// 会被仓库里的 `.env.local` 静默覆盖——排查时极难发现。
    #[test]
    fn occupied_only_when_non_empty() {
        // 未设置 → 未被占用，文件里的值可填入
        assert!(!is_occupied(None));
        // 空串 / 纯空白 → 视为未提供（与 build.rs 一致），文件值可填入
        assert!(!is_occupied(Some("")));
        assert!(!is_occupied(Some("   ")));
        // 非空 → 已占用，文件不得覆盖
        assert!(is_occupied(Some("real-key")));
        assert!(is_occupied(Some("  real-key  ")));
    }

    /// **回归（评审 finding #1）**：含 NUL 的**值**必须被丢弃。
    ///
    /// 实测：`std::env::set_var` 的值含 NUL 会 panic
    /// （`failed to set environment variable: strings passed to WinAPI cannot contain NULs`）。
    /// 旧实现只拦了含 NUL 的**键**，值直通 `set_var` → debug 后端在
    /// `AppState::build()` 之前 panic，启动失败——比「凭据缺失降级」严重得多，
    /// 且违背本模块 best-effort、绝不失败的约定。
    #[test]
    fn skips_values_containing_nul() {
        // 裸 NUL 值被丢弃，同一文件里的合法条目保留
        assert_eq!(
            pairs("BAD=a\0b\nGOOD=ok\n"),
            vec![("GOOD".to_string(), "ok".to_string())]
        );
        // 去引号后再判断：`KEY="a\0b"` 这类写法同样要拦
        assert!(pairs("BAD=\"a\0b\"\n").is_empty());
        // 键含 NUL 依旧被拦（原有行为不得回退）
        assert!(pairs("a\0b=value\n").is_empty());
        // 合法值不受影响
        assert_eq!(
            pairs("CURSEFORGE_API_KEY=abc123\n"),
            vec![("CURSEFORGE_API_KEY".to_string(), "abc123".to_string())]
        );
    }

    /// **回归（评审 finding #2）**：非 UTF-8 的 `.env.local` 不得被**静默**吞掉。
    ///
    /// 实测：Windows 记事本存成 GBK 时 `read_to_string` 返回 `InvalidData`，
    /// **不是** `NotFound`。旧实现 `if let Ok(..)` 把两者一并忽略，于是
    /// 「文件存在、键也在、却完全没生效」且无任何提示——正是本模块要消除的
    /// 那类静默降级。
    ///
    /// **断言的是「是否告警」而非「能否继续搜索」**：后者旧实现也满足
    /// （`Err(_) => {}` 同样继续循环），用它做断言会让测试在回退时仍然通过
    /// ——实测确认过这一点，故改断言有可观测副作用的告警出口。
    #[test]
    fn non_utf8_file_warns_and_does_not_abort_search() {
        let root = std::env::temp_dir().join("qomicex_dev_env_test_nonutf8");
        let _ = std::fs::remove_dir_all(&root);
        let bad_dir = root.join("a");
        let good_dir = root.join("b");
        let empty_dir = root.join("empty");
        std::fs::create_dir_all(&bad_dir).expect("建 a 目录");
        std::fs::create_dir_all(&good_dir).expect("建 b 目录");
        std::fs::create_dir_all(&empty_dir).expect("建 empty 目录");

        // a/.env.local = GBK 内容（0xD6 0xD0 0xCE 0xC4 非合法 UTF-8）
        std::fs::write(
            bad_dir.join(".env.local"),
            [b'#', 0xD6, 0xD0, 0xCE, 0xC4, b'\n'],
        )
        .expect("写 GBK 文件");
        // b/.env.local = 合法 UTF-8
        std::fs::write(good_dir.join(".env.local"), b"CURSEFORGE_API_KEY=from-b\n")
            .expect("写合法文件");

        use std::cell::RefCell;
        let warnings: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let warn = |msg: &str| warnings.borrow_mut().push(msg.to_string());

        // 坏文件在前：不得中断搜索，且必须发出告警。
        let (path, pairs) = find_and_parse_in(&[bad_dir.clone(), good_dir.clone()], &warn)
            .expect("应回退到 b 目录");
        assert_eq!(path, good_dir.join(".env.local"), "应采用 b 目录的文件");
        assert_eq!(
            pairs,
            vec![("CURSEFORGE_API_KEY".to_string(), "from-b".to_string())]
        );
        // 用作用域限制不可变借用，避免与后续 `borrow_mut()` 冲突。
        {
            let ws = warnings.borrow();
            assert_eq!(ws.len(), 1, "非 UTF-8 恰好应告警一次，实际：{ws:?}");
            assert!(
                ws[0].contains(".env.local"),
                "告警应包含路径便于定位：{}",
                ws[0]
            );
        }

        // 只有坏文件 → 返回 None 且已告警（而非 panic / 静默）。
        warnings.borrow_mut().clear();
        assert!(find_and_parse_in(&[bad_dir.clone()], &warn).is_none());
        assert_eq!(warnings.borrow().len(), 1, "坏文件本身应告警一次");

        // 目录里没有该文件 → NotFound 分支，**必须零告警**（常见情形不该刷屏）。
        warnings.borrow_mut().clear();
        assert!(find_and_parse_in(&[empty_dir.clone()], &warn).is_none());
        assert!(
            warnings.borrow().is_empty(),
            "文件不存在属正常情况，不应告警：{:?}",
            warnings.borrow()
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
