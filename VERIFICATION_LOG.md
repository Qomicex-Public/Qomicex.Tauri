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

## 修复 6：Forge/NeoForge 安装「写出主 jar 失败」os error 123
安装 Forge 1.12.2-14.23.5.2864 等加载器报：
`安装 Forge 失败: download failed: 写出主jar 失败: \?(D:\Test\,minecraftlibraries\net/minecraftforge/...jar`。

根因（已用 Rust 探针复现）：安装流水线 `install_service.rs::absolute_path` 对 `game_dir` 调
`std::fs::canonicalize()`，Windows 上返回 verbatim 路径 `\\?\D:\Test\.minecraft`；各安装器用
`path_combine(game_dir,"libraries") + maven_path` 拼接，而 `maven_to_path` 保留 `/`
（如 `libraries\net/minecraftforge/...jar`）。verbatim（`\\?\`）路径下 `/` 非路径分隔符，
`std::fs::write` / 下载落盘报 **ERROR_INVALID_NAME (os error 123)**。`create_dir_all` 对父目录
尚能通过，故报错恰好落在 write 上。项目已有同类先例：`install_service.rs::normalize_sep`、
`process.rs:475`（verbatim 前缀 `/`→`\`）。

修复（集中式，与既有先例一致），`qomicex-core-rust`：
- `util/file_helper.rs`：新增 `normalize_separators(path)`——Windows 上把 `/` 换成 `\`
  （verbatim 规避），非 Windows 无操作；仅用于本地文件系统路径，不可用于 URL。
- `services/installers/installer.rs::download_file_async`：落盘前归一化 `destination_path`
  （覆盖 Forge/NeoForge/Fabric/Quilt/Cleanroom 等全部经下载的 Maven 库路径）。
- `services/installers/forge/install.rs`：3 处直接写主 jar/库路径
  （install_forge、install_legacy_forge 的 `jar_full_path`、get_miss_forge_libraries 的 `lib_path`）
  统一归一化。
- `services/installers/cleanroom.rs`：核心 Jar 直接写路径归一化。

复测：
- Rust 探针：未归一化 verbatim+`/` 路径 `std::fs::write` → `os error 123`（复现原 bug）；
  normalize 后路径 → write OK、文件存在（os error 123 消除）。
- `cargo build`（core + backend）：通过。
- `cargo test`（core）：全部通过；新增单测
  `normalize_separators_converts_maven_slashes_for_local_paths`（b2_util.rs）验证 Windows 下
  `net/minecraftforge/...` → `net\minecraftforge\...`。
- 结论: ✅ PASS

## 修复 7：Forge Processor（binarypatcher）执行失败 —— `ForgeInstallerBase` 动态状态未填充
修复 6 后主 jar 写入通过，但仍报：
```
无效的Maven坐标格式：libraries\net\minecraftforge\forge\26.2-65.1.1\forge-26.2-65.1.1-client.jar，至少需要3个部分…
Processor执行失败: net.minecraftforge:binarypatcher:1.3.4 原因：… --output libraries\net\… code:1
```

根因：`ForgeInstaller::new()` 把 `ForgeInstallerBase` 的 `game_dir`/`game_version`/`installer_path`/
`main_jar_path` 全部初始化为 `String::new()` 且从不赋值。`install_forge` 用 `self.base.run_processor(...)`
执行 processors；`replace_arguments`/`replace_outputs` 读的是 `self.game_dir`（空）。于是 processor 的
`{PATCHED}`（数据值 `[net.minecraftforge:forge:26.2-65.1.1:client]`）经
`resolve_library_path(self.game_dir="", …)` 解析成**相对路径** `libraries\net\…client.jar`；随后
`resolve_processor_output_path` 把这个相对路径当 Maven 坐标再喂给 `maven_to_path` → 报
「无效的Maven坐标格式」；`--output libraries\net\…` 无盘符 → Java 退出码 1。
（`neoforge/install.rs::install_neoforge` 已正确，见其注释：trait `&self` → 手工复制 base 并写动态
状态。）

修复（镜像 neoforge 先例）：
- `forge/install.rs`：`new()` 里把 `game_dir`/`game_version` 填入 `base`；
  `install_forge` 内手工复制一份 `ForgeInstallerBase`，把本次 `installer_path`/`main_jar_path`
  （原下划线未用参数）写入副本，处理器交由该副本执行（`base.run_processor(…, &base.game_dir, …)`），
  使 `replace_arguments` 读到非空 game_dir / installer_path / main_jar_path。
- `forge_base.rs`：新增 2 个单测——`{PATCHED}` 在非空 game_dir 下解析为绝对库路径；输出键在非空
  game_dir 下为绝对/rooted、不再被当 Maven 坐标重解析（修复前空 game_dir 为相对 `libraries\…`）。

复测：
- `cargo test`（core）：全绿（20 lib + 11 + 9 集成），含新增
  `replace_arguments_with_populated_game_dir_resolves_patched_to_absolute_path`、
  `output_key_resolves_to_absolute_with_populated_game_dir_not_reparsed`。
- `cargo build`（core + backend）：通过。
- 结论: ✅ PASS（processor 路径解析已修复；完整 Forge 安装需联网 + Java 实跑最终确认）
