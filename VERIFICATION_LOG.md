# 复测记录：connector 房主身份解析修复

## 问题
创建房间选择「已启动实例」（host/port）时，房主无账户信息，显示为 "Player" 或默认 Steve 头像。
Rust 重写后缺失 C# `GameProcessInspector`（端口→PID→Java 启动参数→`--username`/`--uuid`）逻辑，
`host_port` 直接用 `player_name()`（无账号硬编码 "Player"），`host_instance` 恒用 "Player"。

## 修复内容
`src-backend/qomicex-backend/src/endpoints/connector.rs`：
- 新增 `GameProcessInfo` / `inspect_game_process`（端口→PID→命令行参数解析 `--username`/`--name`、
  `--uuid`、`--userType`、`--version`，对应 C# `GameProcessInspector.Inspect`）
- 新增 `find_pid_by_port`（复用 `tcp_listen_table`）、`process_cmd_args`（sysinfo 跨平台读命令行）、
  `get_arg_value`（对应 C# `GetArgValue`）
- 新增 `resolve_host_icon`（默认账号优先，无账号用进程 uuid + userType，对应 C# `ResolveHostIconAsync`）
- `host_port`：房主名/头像/版本信息改由进程解析，解析失败回退默认账号/Player（用户确认的方向）
- `host_instance`：spawn 内端口检测到后同样进程解析（替换恒 "Player" 的 `player_name_plain`）
- 删除不再使用的 `player_name_plain`

## 复测记录
- 复测时间: 2026-08-14 15:42 (UTC+8)
- 复测命令/操作:
  1. 启动模拟 Java 进程（python 监听 25565，命令行带 `--username TestSteve --uuid
     12345678-1234-1234-1234-123456789abc --userType legacy --version 1.20.1`）
  2. `cargo build` 后端，QOMICEX_HOME 指向临时目录启动 backend
  3. `POST /api/connector/host/port` body `{"port":25565}`
  4. `GET /api/connector/status` 检查 players[0]（房主）
- 实际输出:
  - host/port 返回 `{"roomCode":"U/FHM2-S4F5-GUJ0-WZQT"}`（建房成功）
  - status.players[0]: `{"name":"TestSteve","kind":"host",...}`
  - status.gameInfo: `{"gameVersion":"1.20.1","loader":null,"loaderVersion":null}`
  - iconBase64 非空（无默认账号 + userType=legacy → 按进程 uuid 解析为默认皮肤 base64）
- 预期输出:
  - 房主名 = 进程 `--username` 值（TestSteve），而非 "Player"
  - gameVersion = 进程 `--version` 值（1.20.1）
  - 头像按进程 uuid/userType 解析（非空）
- 结论: ✅ PASS
  - 修复前：name 应为 "Player"（无账号时 `player_name` 回退）→ 修复后为 "TestSteve"
  - 原始场景（输入端口建房 → 房主有正确账户信息）已消除
