# 复测记录：connector 房主身份解析修复 + host_port game_info/game_mods 增强

## 修复 1：房主身份解析（玩家名/UUID/头像）
创建房间选择「已启动实例」（host/port）时，房主无账户信息，显示为 "Player" 或默认 Steve 头像。
Rust 重写后缺失 C# `GameProcessInspector`（端口→PID→Java 启动参数→`--username`/`--uuid`）逻辑，
`host_port` 直接用 `player_name()`（无账号硬编码 "Player"），`host_instance` 恒用 "Player"。

`src-backend/qomicex-backend/src/endpoints/connector.rs`：
- 新增 `GameProcessInfo` / `inspect_game_process`（端口→PID→命令行参数解析 `--username`/`--name`、
  `--uuid`、`--userType`、`--version`）、`find_pid_by_port`、`process_cmd_args`、`get_arg_value`、
  `resolve_host_icon`（默认账号优先，无账号用进程 uuid + userType）
- `host_port` / `host_instance`：房主名/头像改由进程解析，失败回退默认账号/Player
- 删除不再使用的 `player_name_plain`

复测（模拟 Java 进程带 `--username TestSteve`）：host/port 建房 → status 房主 `name: "TestSteve"`、
`gameInfo.gameVersion: "1.20.1"`、头像 base64 非空。✅ PASS

## 增强 2：host_port 建房 game_info / game_mods（--version + --gameDir/-cp）
「已启动实例」建房时也要获取 qml:game_info 与 qml:game_mods：
- `--version` → version_name（版本目录名）
- `--gameDir` → 最终游戏目录（隔离时 `{root}/versions/{version}`，否则 `{root}`）；`-cp` 的
  `libraries` 段兜底推导 `.minecraft` 根
- 读 `{root}/versions/{version_name}/{version_name}.json` → game_info（gameVersion 6 级回退 +
  loader 探测，复用 version.rs 的 `resolve_game_version`/`detect_loaders`）
- 扫描 mods → `{gameDir}/mods`（version_segmented=false），写入 host_mods 缓存（qml:game_mods）
- 版本 JSON 缺失 → 静默降级不阻断建房（用户确认）

`src-backend/qomicex-backend/src/endpoints/connector.rs`：
- `GameProcessInfo` 增加 `game_dir`（--gameDir）、`game_root`（--gameDir 推导，-cp 兜底）
- `derive_game_root_from_game_dir`（剥 `versions/{ver}` 尾段）、`derive_game_root_from_classpath`
- `read_host_game_info`（读版本 JSON → ConnectorGameInfo）
- `scan_host_mods_from_game_dir` / `scan_mods_to_entries`（共享扫描管线）
- `host_port`：进程解析 game_dir/version → 填 game_info + 后台扫 mods；失败回退 --version 原值

`src-backend/qomicex-backend/src/endpoints/version.rs`：
- `resolve_game_version` / `detect_loaders` / `ScannedLoaderEntry` 改 `pub(crate)`（connector 复用）

## 复测记录（增强 2）
- 复测时间: 2026-08-14 16:12 (UTC+8)
- 复测命令/操作:
  1. 场景 A（版本隔离 Forge）：构造 `.minecraft/versions/1.20.1-Forge-47.1.0/`（版本 JSON 含
     inheritsFrom=1.20.1 + fmlloader 库 + mainClass forge bootstrap）+ 2 个假 mod；模拟 Java 进程
     监听 25565，带 `--gameDir {root}/versions/1.20.1-Forge-47.1.0 --version 1.20.1-Forge-47.1.0 -cp ...`
  2. 场景 B（非隔离 Vanilla）：`.minecraft/`（版本 JSON mainClass=vanilla main）+ 1 个假 mod；
     模拟进程监听 25566，`--gameDir {root} --version 1.20.1`
  3. 每场景 `POST /api/connector/host/port` → `GET /api/connector/status`；观察 backend 日志的
     mods 扫描目录与 count
- 实际输出:
  - 场景 A: gameInfo = `{"gameVersion":"1.20.1","loader":"Forge","loaderVersion":"47.1.0"}`；
    房主名 TestSteve；日志 `Fetching mod list: 1.20.1-Forge-47.1.0, dir: ...versions\1.20.1-Forge-47.1.0\mods, count: 2`
    + CurseForge 反查 200
  - 场景 B: gameInfo = `{"gameVersion":"1.20.1","loader":null,"loaderVersion":null}`（Vanilla）；
    房主名 VanillaPlayer；日志 `Fetching mod list: 1.20.1, dir: ...\mods, count: 1`
- 预期输出: game_version 从版本 JSON 解析（inheritsFrom），loader 由 fmlloader/mainClass 探测，
  mods 目录 = `{--gameDir}/mods`（隔离/非隔离均正确）
- 结论: ✅ PASS（两场景均符合预期；解析失败回退路径见代码，未阻断建房）

## 修复 3：调试页实时日志 ANSI 转义码乱码
设置→调试页的实时日志（`/diagnostics/trace`）显示"全是错误符号"（如 `\u001b[2m`、`\u001b[32m`）。

根因：tracing-subscriber 的 `ansi` feature 被 **easytier→kcp-sys→nu-ansi-term** 传递启用
（`cfg!(feature = "ansi")` 编译期全局求值），backend `init_tracing()` 的 `fmt()` 默认
`is_ansi = true` → 所有 tracing 事件（含 easytier_core 日志）被包上 ANSI 颜色/样式码写入
TraceWriter → trace 缓冲 → 前端把 ESC 序列渲染为错误符号。并非编码（GBK/UTF-8）问题，
前端 `res.text()` 与 TraceWriter 本身均无编码缺陷。

`src-backend/qomicex-backend/src/main.rs`：`init_tracing()` 增加 `.with_ansi(false)`，
强制禁用 ANSI（即使 feature 已启用）。

复测（模拟 Java 进程监听 25565 → host/port 建房触发 easytier 实例启动，共 462 条 trace）：
- 修复前样本：`\u001b[2m2026-08-14T10:47:53.404172Z\u001b[0m \u001b[32m INFO\u001b[0m \u001b[1mdo_handshake_as_client\u001b[1m{...}`
- 修复后：462 条 trace 中 **0 条含 ANSI ESC**，363 条 easytier_core 日志干净可读
  （`2026-08-14T11:02:11.061585Z  INFO qomicex_connector::easytier::manager: 启动 EasyTier 实例: ...`），
  中文正常。
- 结论: ✅ PASS

## 修复 4：guest 对未协商协议不再发包（其他启动器兼容）
房主用其他启动器（`c:protocols` 只返回标准协议，不含 qml: 扩展）时，guest 端仍对
`qml:player_icons` / `qml:game_info` / `qml:game_mods` / `qml:player_leave` 持续发包
（status 每 2s 轮询两次），浪费带宽并产生错误日志。

根因：`ScaffoldingGuest::send_json` / `send_json_req` 不检查 `c:protocols` 协商结果
（`negotiated`），调用方（connector.rs 6 处 qml: 调用点）也不检查。

修复（qomicex-connector-rust，库层检查，用户指定方案）：
- `error.rs`：新增 `ScaffoldingError::ProtocolNotNegotiated(String)`
- `scaffolding_guest.rs`：`send_json`/`send_json_req` 开头调用新增的 `ensure_negotiated(key)`
  —— key 不在协商结果中则**不发包**，直接返回 `ProtocolNotNegotiated`（兼容模式降级）；
  新增 5 个单元测试（3 个 ensure_negotiated + 2 个 send_json 短路验证）
- backend 调用点无需改动：现有 `match Err` / `let _ =` 已安静降级，标准协议走 `send` 不受影响

复测：
- `cargo test -p qomicex-connector`：**42 passed**（原 37 + 新 5），含
  `ensure_negotiated_rejects_unnegotiated_key`（房主仅标准协议时 4 个 qml: 协议全拒、
  标准协议仍可用）与 `send_json_short_circuits_unnegotiated_key`（未协商 key 不触达 TCP）
- `cargo build`（backend）：通过
- 结论: ✅ PASS（未协商的 qml: 协议在发送前短路，不再发包；标准协议不受影响）

## 修复 5：联机 vendor 的 Qomicex Launcher 版本恒为 1.0.0
房主/房客玩家列表的 vendor 显示 `Qomicex Launcher 1.0.0(...)`，与前端 `__APP_VERSION__`
（package.json 0.1.1）不一致且发布后不跟随版本号。

根因：`state.rs` 的 `APP_VERSION` 硬编码 `"1.0.0"`；`release.yml` 的
`scripts/bump-version.mjs` 只更新 package.json / src-tauri/Cargo.toml / tauri.conf.json，
**不更新 src-backend/qomicex-backend/Cargo.toml**，后端无编译期版本注入。

修复（用户确认方案：CARGO_PKG_VERSION + 同步 bump）：
- `state.rs`：`APP_VERSION` 改用 `env!("CARGO_PKG_VERSION")`（编译期注入，对齐 C#
  `AssemblyInformationalVersion`）；开发期 = backend Cargo.toml version（0.1.0）
- `scripts/bump-version.mjs`：增加同步更新 `src-backend/qomicex-backend/Cargo.toml`，
  release.yml 构建 backend 前调用，使发布包 vendor 版本与 package.json 一致

复测：
- `cargo build`（backend）：通过
- 建房后 status 房主 vendor = `Qomicex Launcher 0.1.0(Qomicex Connector 2.0) /
  Easytier v2.6.4 for QML`（非 1.0.0）✅
- `node scripts/bump-version.mjs 9.9.9-test` 干跑：4 处版本文件全部同步更新
  （package.json / src-tauri/Cargo.toml / tauri.conf.json / backend Cargo.toml），
  干跑后已 git checkout 恢复原值
- 结论: ✅ PASS
