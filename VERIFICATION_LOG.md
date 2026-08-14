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
