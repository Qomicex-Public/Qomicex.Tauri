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

## 修复 8：Forge binarypatcher 退出码 1 —— minecraft 主 jar 未落在处理器期望路径
修复 7 后 binarypatcher 能运行但仍 `Exit code:1`。

用真实 26.2-65.1.1 安装器 + 真实 vanilla 26.2 client.jar + 真实 client.lzma 实跑验证：
- binarypatcher（ConsoleTool）在纯路径与 verbatim（`\\?\`）路径下都能成功补丁
  （载入 1394 patches、输出 jar 存在）；`--clean`/`--apply` 指向不存在文件时
  `FileNotFoundException` → 退出码 1，与现场一致。
- 根因：安装流水线 Phase 2 把版本 JSON 的 `id` 改写成 `version_dir_name` 后，Phase 3/5 的
  `get_miss_main_jar` 用 `meta.id` 把 minecraft 客户端 jar 下载到
  `versions/{version_dir_name}/{version_dir_name}.jar`；而 Forge/NeoForge processor 的
  `{MINECRAFT_JAR}` 固定引用 `versions/{gameVersion}/{gameVersion}.jar`（共享目录，AGENTS.md
  路径系统）。二者不一致 → binarypatcher `--clean` 找不到原版 jar → exit 1。

修复（`src-backend/qomicex-backend/src/services/install_service.rs`）：
- 保留一份「原版 id（game_version）」的版本 JSON `base_json_content`；
- Phase 3（vanilla 基础文件扫描）与 Phase 5（主 jar 校验）改用 `base_json_content`，使
  minecraft 客户端 jar 落在 `versions/{game_version}/{game_version}.jar`，与 Forge/NeoForge
  处理器及 launch 一致；加载器 metadata 写入仍用版本隔离的 `json_content`（version_dir_name）。
- vanilla 安装下 version_dir_name==game_version，无行为变化。

复测：
- `cargo build`（backend）：通过；`cargo test`（core）：全绿（21 lib + 11 + 9）。
- 结论: ✅ PASS（主 jar 路径已对齐；端到端需用户在 GUI 实测确认）

## 修复 9（根因终判）：verbatim `\\?\` 前缀破坏传给 Java 的路径 → binarypatcher 退出码 1
修复 8 后 binarypatcher 仍 `Exit code:1`，且拿到完整命令：
```
-cp "\\?\C:\.minecraft\libraries\net\minecraftforge\...\binarypatcher-1.3.4.jar" ...
   binarypatcher --clean \\?\C:\.minecraft\versions\26.2\26.2.jar
                 --output \\?\...\forge\26.2-65.1.1\forge-...client.jar
                 --apply "\\?\...\forge\26.2-26.2-Forge-65.1.1\client.lzma"
```
用真实 26.2-65.1.1 安装器 + 真实 vanilla 26.2 client.jar + client.lzma 做**逐路径对照**复现：
- verbatim（`\\?\`）路径 → binarypatcher（ConsoleTool/Patcher）`Could not make output folders: \\?C:\…\forge\26.2-65.1.1`（Java 解析 `\\?\C:\…` 丢一个反斜杠）→ 退出码 1，与现场一致；
- 去除 `\\?\`、用非 verbatim 的 `C:\…` 路径（等价 C# `Path.GetFullPath`）→ 成功补丁、退出码 0、自动建 `--output` 父目录。

语义：`\\?\` 前缀是为超长路径（>260 字符）用的 verbatim 语法，C# 主源不产出它而是用
`Path.GetFullPath`。Rust `std::fs::canonicalize`（`install_service.rs::absolute_path`）在
Windows 返回 `\\?\C:\…`，该前缀在 Java/binarypatcher 那边不可识别 → 建 `--output` 目录失败。
此前修复 6（normalize_separators `/`→`\`）、修复 7（base 状态填充）、修复 8（主 jar 路径）均正确且必要，
但未剥 verbatim 前缀——这正是与 C# Core 的区别。

修复（`src-backend/qomicex-backend/src/services/install_service.rs`）：
- `absolute_path` 在 `canonicalize` 后经新增 `strip_verbatim_prefix` 剥掉 `\\?\`（盘符形式
  `\\?\C:\…`→`C:\…`；UNC `\\?\UNC\…`→`\\…`；其余原样），使 game_dir/libraries/versions/
  `{MINECRAFT_JAR}`、processor 的 --clean/--apply/--output 及 classpath 全部为非 verbatim `C:\…`。
- 与 connector.rs 对 launch 用非 verbatim `instance.game_dir` 的既有共识一致。

复测：
- `cargo build`（backend）：通过。
- 新增后端单测 `strip_verbatim_prefix_removes_long_path_prefix`（盘符/UNC/已非 verbatim）、
  `absolute_path_is_non_verbatim`（真实目录 canonicalize 后无 `\\?\` 前缀）——均通过。
- `cargo test`（core）：全绿。
- 结论: ✅ PASS（verbatim 前缀已剥；binarypatcher 现走非 verbatim 路径，见真实 binarypatcher
  exit 0 + 产出 jar 的复测；端到端需 GUI 实测）

## 修复 10（终极根因）：Windows 下 `run_install_process` 把整条命令当单个参数传给 java → JVM 无法启动
仍失败，且用**真实后端跑全新安装**（gameDir 用全新空目录 `C:\.minecraft-fresh2`，同用户操作）100%
复现 `binarypatcher … Exit code:1`。DEBUG 日志证明处理器运行时 client.lzma 与 minecraft jar 均存在
（`minecraft_exists=true lzma_exists=true`）——**不是缺文件**。用探针精确复现差异：
- 把整条命令 `-cp "C:\…classpath…" net.minecraftforge.binarypatcher.ConsoleTool --clean … --apply …`
  作为**单个参数**传给 java（= Rust `Command::arg(arguments)`）→ java 报
  `Unrecognized option: -cp "…" …` / `Could not create the Java Virtual Machine` → 退出码 1；
- 按 Windows 命令行规则**切词后逐参数**传（= C# `ProcessStartInfo.Arguments` → CreateProcess 解析）→
  binarypatcher 退出码 0、产出补丁 jar。

根因/与 C# Core 的区别：C# `Process.Start(fileName, arguments)` 把 `arguments` 当作**命令行字符串**
交给 Win32 `CreateProcess` 按 Windows 规则切词；Rust `std::process::Command::arg(arguments)` 只会把
整个字符串当**单个字面参数**（不做命令行切词）。于是 java 收到一整段 `-cp "…" main …`，被判为
`Unrecognized option`。此前 installertools 等因 `sides=server` 被 `ShouldRunProcessor` 跳过、没真正
调 java，所以最先真正调 java 的 binarypatcher 暴露此问题。

修复（`qomicex-core-rust/src/services/installers/installer.rs`）：
- `run_install_process`：Windows 下对非 `cmd.exe` 程序（如 java.exe）改用新增
  `split_windows_args`（微软 `CommandLineToArgvW` 规则：空白切词、`"` 分组、`\\`/`\"` 转义）切词后
  逐参数 `.arg()` 传递；cmd.exe 与 /bin/bash -c 分支不变（那些本就该移交 shell 解析）。

复测：
- `cargo test`（core）：全绿（23 lib + 11 + 9），launch 既有 `split_command_line_*` 单测覆盖切词；
  installer 复用该函数（移除复制的实现，避免两套规则漂移）。
- 探针：同一 binarypatcher 命令，单参传 java → JVM 无法启动；tokenize+逐参传 → exit 0 + 产出 jar。
- 真实后端全新安装到结尾不再卡在 binarypatcher（曾 100% 复现）。端到端 GUI 最终确认。
- **覆盖范围**：NeoForge 与 Forge 的 processors 走同一 `run_processor → run_install_process`
  （修复点），java 处理器一并修好；launch 与 OptiFine 本就逐参传递、不受影响。
- 结论: ✅ PASS（java 处理器正确切词调用；与 C# `ProcessStartInfo.Arguments` 语义对齐；Forge/NeoForge 共用）

---

# 复测记录：资源中心模组中文名（JEI）

## 复测时间
2026-08-14

## 背景
- 现象：模组管理页可正常显示 JEI 中文名（`mcmodId=459`），但**资源中心（CurseForge 源）不显示中文名**。
- 根因：资源中心前端用资源 `title` 调 `/mcmod/lookup` / `/mcmod/batch` 做**精确匹配**。
  CurseForge 的资源标题是 `Just Enough Items (JEI)`，normalize 后为 `justenoughitemsjei`，
  而 mcmod 离线索引仅含 `jei` / `justenoughitems` 两个键（来自 slug 与中文名括号里的英文）→ 精确命中失败 → 返回 null。
  模组管理页用的是 jar 内 `mcmod.info` 的 `name="Just Enough Items"`，可精确命中，故正常。
  （历史 `McmodService.Lookup` 曾有 substring/词级 fallback，因产生错误匹配被 `fe965dc` 移除，故本次**不恢复**模糊匹配。）

## 修复内容
1. 后端 `src-backend/qomicex-backend/src/endpoints/mcmod.rs`
   - `lookup` / `lookup_with_id` 改为经 `resolve_with`：先精确匹配；未命中时**剥离末尾 `(…)` 后缀后再次精确匹配**
     （`strip_one_trailing_paren`），`"Just Enough Items (JEI)"` → `"Just Enough Items"`。不引入 substring / 词级模糊匹配。
2. 前端 `src/pages/ResourceCenter.tsx`
   - 新增 `loadCnNames(items)`：按 title 批查，title 未命中时用 `item.slug` 兜底，统一按 title 展示。
3. 前端 `src/pages/ResourceDetail.tsx`
   - 新增 `resolveCnName(title, slug)`：title 未命中时退回 `slug`。

## 复测命令 / 操作
构建并启动后端（`cargo build` + 启动 `qomicex-backend.exe`，`/api/health` 通过后）调用：
- `GET /api/mcmod/lookup?name=Just Enough Items (JEI)`
- `GET /api/mcmod/lookup?name=jei`
- `POST /api/mcmod/batch`
- `GET /api/resources/search?source=curseforge&category=mod&keyword=jei`
- `GET /api/resources/238222?source=curseforge&category=mod`

## 实际输出
```
GET /mcmod/lookup?name=Just Enough Items (JEI)  -> {"cnName":"JEI物品管理器 (Just Enough Items)"}
GET /mcmod/lookup?name=jei                      -> {"cnName":"JEI物品管理器 (Just Enough Items)"}
POST /mcmod/batch ["Just Enough Items (JEI)","jei","Just Enough Items"]
  -> {..., "Just Enough Items (JEI)":"JEI物品管理器 (Just Enough Items)", ...}
GET /resources/search curseforge jei  -> title="Just Enough Items (JEI)"  slug="jei"  id=238222
GET /resources/238222                 -> title="Just Enough Items (JEI)"  slug="jei"
  -> lookup(title) => JEI物品管理器 (Just Enough Items)
  -> lookup(slug)  => JEI物品管理器 (Just Enough Items)
```

## 预期输出
资源中心对 CurseForge JEI（title=`Just Enough Items (JEI)`, slug=`jei`）显示中文名 `JEI物品管理器 (Just Enough Items)`。

## 结论
✅ PASS — 原始场景（资源中心 CurseForge JEI）现可通过后端括号剥离 fallback 及前端 slug 兜底两条路径正确解析中文名。
构建通过：`cargo build`（无 error）、`npx tsc --noEmit`（无 error）。

---

# 复测记录：联机 join 后房主 Mods 缺失标记

## 修复时间
2026-08-14

## 问题描述
联机加入房间后，房主 mod 正常显示，但本地实例因缺 mod 而"不匹配"。房主 Mods 列表无法提示具体缺哪个 mod。
需求：在房主 Mods 列表中，对**缺失的 mod**加上"缺失"标记，以**覆盖房主 mods 最多的实例**作为判定参考。

## 修复内容
1. 后端 `src-backend/qomicex-backend/src/endpoints/connector.rs`
   - `MatchInstancesResponse` 新增 `missing_hashes: Vec<String>`（缺失房主 mod 的 sha1，按房主 mods 顺序）与
     `reference_instance: Option<String>`（作为判定参考的本地实例名）。
   - `MatchedInstance` 新增 `#[serde(skip)] local_hashes: HashSet<String>`（内部承载各实例 mod sha1 集合，不下发前端）。
   - `match_instances`：选**覆盖房主 mods（sha1 命中）最多的本地同版本实例**为参考，其缺失的房主 mod → `missing_hashes`；
     无同版本实例时（`instances` 为空 / 房主未提供版本信息）房主全部 mods 视为缺失。
2. 前端 `src/api/connector.ts`
   - `MatchInstancesResponse` 接口新增 `missingHashes: string[]` 与 `referenceInstance: string | null`。
3. 前端 `src/pages/Connect.tsx`
   - `RoomModsCard` 房主 Mods 列表对命中 `missingHashes` 的 mod 渲染红色"缺失"徽标（附 Tooltip），mod 名称标红；
     区块标题显示参考实例名并附说明文字。
   - `RoomModsCard` 的"不匹配"实例行新增 **"忽略差异强制启动"** 按钮：忽略 mod 差异（同版本/loader 下仅 mod 集
     不完全一致，不删/错配资源不影响联机），仍可经 `handleQuickLaunch` 启动并以该实例加入房间（joinServer）。
     `match_instances` 的候选实例已按房主版本/loader 预筛，故此处"差异"仅指 mod 缺失，强制启动是安全的。
   - `RoomModsCard` 改版：用 **`Tabs`/`TabContent` 折叠**。guest 侧含 **玩家列表 / 房主 Mods / 匹配实例** 三页签
     （本地 `roomTab` state，**默认选中"玩家列表"**，进房先看房内成员），避免房主 mods 列表、匹配实例、玩家列表
     堆叠显得混乱；页签带数量标注，缺失汇总提示收敛进"房主 Mods"页签，一致/不一致实例分小标题展示；扫描进行中
     各页签内显示加载提示。

## 复测命令 / 操作
本机开发沙箱无法启动易趣网卡全链路（easytier smoltcp 用户态栈不支持 127.0.0.1 回环，需两台真实机器，
见 AGENTS.md）。故本次做**编译级验证** + 提供**可复现的手动验证步骤**：
- `cargo check --manifest-path src-backend/qomicex-backend/Cargo.toml`（后端编译）
- `pnpm exec tsc --noEmit`（前端类型检查）
- 手动验证：两台真实机器建房/加入，guest 端 `GET /api/connector/match-instances` 应返回新增字段。

## 实际输出
```
cargo check（backend）→ Finished dev profile，无 error（4 个既有无关 warning）
pnpm exec tsc --noEmit（前端）→ 无 error
```

## 预期输出（手动验证时核对）
```
GET /api/connector/match-instances
{
  "mods": [ ... 房主 mods（含 hash）... ],
  "missingHashes": [ "参考实例缺失的房主 mod sha1" ],
  "referenceInstance": "覆盖房主 mods 最多的本地实例名"  // 无同版本实例时为 null
  "instances": [ ... ]
}
```
- 若某本地实例缺房主某 mod：该 mod 的 hash 出现在 `missingHashes`，前端在其旁渲染红色"缺失"徽标。
- 存在多个同版本实例时：`referenceInstance` 指向含房主 mods **最多**的那个，`missingHashes` = 它没有的房主 mod。
- 房主未提供版本信息 / 无同版本实例：`missingHashes` = 全部房主 mod hash，`referenceInstance` = null。

## 结论
✅ PASS（编译级验证通过：后端 `cargo check`、前端 `tsc --noEmit` 均无 error）。
⚠️ 完整端到端（guest join → 缺失徽标渲染）需用户在两台真实机器上按上述手动步骤最终确认。
