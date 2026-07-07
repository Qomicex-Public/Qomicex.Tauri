# 联机中心 (Connect Center) 设计

## 目标

在启动器新增"联机中心"页面，基于 `Qomicex.Connector`（Scaffolding-MC / EasyTier）实现无公网 IP 的 Minecraft 联机：

- **创建房间**：两种入口——(a) 手动填写已开局域网的 MC 端口；(b) 直接选择实例并启动，游戏起来后自动探测端口。生成房间码分享给好友。
- **加入房间**：填写房间码，加入同一虚拟网络，得到可填入 MC 的服务器地址。

同一时刻只允许"创建"或"加入"其中一种（单会话）。

除标准 SCF 协议外，扩展自定义协议：`qml:player_icons`（玩家头像互传）、`qml:game_info`（游戏版本/Loader 信息）。协议集中在注册表中定义，便于后续手动新增。

## 范围

**本次纳入**：前端页面 + 导航入口；后端完整联机（集成 submodule `Qomicex.Connector` + 端口探测 + 会话管理 + 自定义协议 player_icons/game_info）。

**本次不纳入（后续）**：
- EasyTier 二进制的自动下载/打包。本次假设 `easytier-core` 已在 PATH（或程序目录/CWD）中，`easyTierPath` 传 `null` 自动查找。

## 架构决策

- 后端采用**单例 `ConnectorService` 持有当前会话**（方案 A）。`CreateRoomAsync`/`JoinRoomAsync` 返回长生命周期对象（`ScaffoldingCenter`/`ScaffoldingGuest`），必须常驻。同一时刻仅一个房间或连接，用 `SemaphoreSlim(1,1)` 串行化 host/join/leave。
- **端口探测采用 LAN 组播**：复用现有 `LanGameListenerService` 监听 MC 局域网组播（`[AD]端口[/AD]`）。手填端口入口直接用用户输入；选实例入口在启动游戏后轮询 LAN 组播，探测到端口后建房。
- **playerName/uuid 来源采用 P2：端口 → 进程 → 解析游戏参数**（Host 侧）。Guest 侧此时可能未开游戏，用当前选中账户名。
- **自定义协议集中注册表**：`QmlProtocols` 静态类集中定义键名常量、Host 端 handler 工厂、Guest 端调用封装。新增协议只需在此加一项。

## 自定义协议模型（重要前提）

`Qomicex.Connector` 的自定义协议是**请求/响应，方向固定 Guest → Host**：Host 用 `DelegateProtocol` 注册 handler，Guest 用 `SendAsync<TReq,TResp>` 调用。标准 `c:player_profiles_list` 返回 `{name, machineId, vendor, easytier_id, kind}`——**不含 uuid/头像**，因此头像必须靠自定义协议传输。

### `qml:game_info`（Guest→Host 拉取）
- Host 注册 `DelegateProtocol<GameInfo>("qml:game_info", () => currentGameInfo)`。
- `GameInfo { string GameVersion; string? Loader; string? LoaderVersion; }`。
- 数据来源（**实例优先，手填降级**）：选实例入口用 `GameInstance.GameVersion/Loader/LoaderVersion`；手填端口入口从游戏进程参数 `--version` 推断版本，Loader 尽力解析（拿不到置 `null`）。
- Guest 加入后 `SendAsync<GameInfo>("qml:game_info")` 拿房主游戏信息。

### `qml:player_icons`（双向：Guest 上传 + 拉取汇总）
- 语义：每个 Guest 加入后调用一次，上报自己的 `{machineId, iconBase64}`；Host 合并进头像表并返回**当前完整头像映射** `machineId -> iconBase64`。Host 自己的头像在建房时预置进表。
- Host 注册 `DelegateProtocol<PlayerIconUpload, PlayerIconMap>("qml:player_icons", upload => { merge; return fullMap; })`。
  - `PlayerIconUpload { string MachineId; string IconBase64; }`
  - `PlayerIconMap { Dictionary<string,string> Icons; }`
- Host 侧图标表随会话保存在 `ConnectorService`。
- 头像取值：`--userType=microsoft` 且有 `--uuid` → 正版头像（复用 `SkinService`/账户头像逻辑按 uuid 取），否则离线默认头像；Guest 用当前账户头像。图标以 base64 传输。

## 前端

### 导航与路由
- `src/components/Sidebar.tsx`：`links` 新增 `{ to: '/connect', label: '联机', icon: faNetworkWired }`（从 `@fortawesome/free-solid-svg-icons` 导入）。
- `src/App.tsx`：新增 `import Connect from './pages/Connect.tsx'` 与 `<Route path="/connect" element={<Connect />} />`。

### 页面 `src/pages/Connect.tsx`
- `PageHeader` + 两个 `Card`（带 border）板块：
  - **创建房间**：两种模式切换——
    - 手填端口：端口 `Input`（数字）+ "创建房间"。
    - 选实例：实例 `Select`（列出已有实例）+ "启动并创建房间"。点击后触发实例启动，进入"等待游戏开放局域网..."状态，LAN 探测到端口后自动建房。
    - 成功后显示：房间码（复制）、玩家列表、"关闭房间"。
  - **加入房间**：房间码 `Input` + "加入房间"。成功后显示：MC 服务器地址 `host:port`（复制）、房主游戏信息（来自 game_info）、玩家列表、"退出房间"。
- **玩家列表项**：头像（`AccountAvatar` 或 base64 图标）+ `playerName` + `vendor`（次要文字）。
- 前端状态机：`idle | starting-instance | waiting-port | host | guest`。非当前模式的另一板块禁用。
- 进入 `host`/`guest` 后每 ~3s 轮询 `GET /api/connector/status` 刷新玩家列表与头像。
- 错误处理：`catch (e) { if (e instanceof ApiError) msgError(e.displayMessage) }`。
- 本地 import 带扩展名；内部导航用 `<Link>`。

### API 与类型
- `src/api/connector.ts`：
  - `hostByPort(port: number)` → `{ roomCode }`
  - `hostByInstance(instanceId: string)` → 触发启动+探测建房（返回受理，前端轮询 status 直到 `host`）
  - `joinRoom(code: string)` → `{ mcHost, mcPort }`
  - `getStatus()` → `ConnectorStatus`
  - `leave()`
- `src/types`：新增 `ConnectorStatus`、`ConnectorPlayer`（含 `name/vendor/iconBase64?/kind`）、`ConnectorGameInfo`。

## 后端

### 项目引用
- `Qomicex.Launcher.Backend.csproj` 新增 `ProjectReference` → `..\Qomicex.Connector.Part.Scaffolding\Qomicex.Connector\Qomicex.Connector.csproj`。
- 现有 `RoomCodeController` 及本地 stub 保持不动。

### `Services/GameProcessInspector.cs`（P2，跨平台）
职责：给定端口，返回 `{ playerName, uuid, isMicrosoft, gameVersionArg }`。

1. **端口 → PID**
   - Windows：P/Invoke `GetExtendedTcpTable`（`iphlpapi.dll`）。
   - Linux：解析 `/proc/net/tcp`+`/proc/net/tcp6` 找端口 socket inode → 扫 `/proc/*/fd` 匹配 `socket:[inode]`。
   - macOS：`lsof -nP -iTCP:{port} -sTCP:LISTEN`。
2. **PID → 命令行**
   - Windows：WMI `SELECT CommandLine FROM Win32_Process WHERE ProcessId={pid}`（`System.Management` 已引用）。
   - Linux：读 `/proc/{pid}/cmdline`（`\0` 分隔）。
   - macOS：`ps -p {pid} -o command=`。
3. **解析参数**：`--name`→playerName、`--uuid`、`--userType`（`microsoft`→isMicrosoft）、`--version`→gameVersionArg。
4. 找不到 → `ApiException.BadRequest("未在端口 {port} 上找到正在运行的 Minecraft 游戏")`。
5. 平台判定用 `OperatingSystem.IsWindows()/IsLinux()/IsMacOS()`。

### `Services/Connector/QmlProtocols.cs`（自定义协议注册表）
- 集中定义：键名常量（`GameInfo = "qml:game_info"`、`PlayerIcons = "qml:player_icons"`）、DTO（`GameInfo`、`PlayerIconUpload`、`PlayerIconMap`）、Host 端 `BuildHostProtocols(...)` 返回 `IProtocol[]`、Guest 端调用封装（`FetchGameInfoAsync(guest)`、`ExchangeIconsAsync(guest, upload)`）、以及供 Guest `customProtocolKeys` 使用的键列表。
- 新增协议：在此文件加常量 + DTO + 一个 `DelegateProtocol` + 调用封装即可。

### `Services/ConnectorService.cs`（单例）
- 持有 `ScaffoldingClient` + 当前 `ScaffoldingCenter?`/`ScaffoldingGuest?`、当前 `GameInfo`、头像表 `Dictionary<string,string>`；`SemaphoreSlim(1,1)` 串行化。
- **machineId**：`Convert.ToHexString(SHA256.HashData(UTF8(systemInfoText + CryptHelper.GetMachineCode())))`；`systemInfoText` 由 `SystemInfoHelper.GetSystemInfo()` 拼接。
- **vendor**：`$"Qomicex {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}"`。`launcherVersion` 取程序集 `InformationalVersion`；`etVersion` 由 `easytier-core -V` 解析，失败→`unknown`，缓存。
- **HostByPortAsync(port)**：`GameProcessInspector` 取 playerName/uuid/isMicrosoft/versionArg → 组 `GameInfo`（版本来自 versionArg，Loader 尽力）→ 预置 Host 头像 → `CreateRoomAsync(playerName, machineId, vendor, port, customProtocols: QmlProtocols.BuildHostProtocols(...))`。返回 roomCode。
- **HostByInstanceAsync(instanceId)**：调用现有实例启动流程（`InstanceController` 的 `Launch` 逻辑，抽取/复用 `LaunchService` + 启动 API）→ 轮询 `LanGameListenerService.GetGames()` 直到出现由本次启动进程持有的端口（用 pid 校验或取最新条目，超时报错）→ `GameInfo` 用 `GameInstance.GameVersion/Loader/LoaderVersion` → 走与 HostByPort 相同的建房路径。此入口为异步流程，前端轮询 status 观察进入 `host`。
- **JoinAsync(code)**：playerName 取当前选中账户名（无账户→`ApiException.BadRequest`）→ `JoinRoomAsync(code, playerName, machineId, vendor, customProtocolKeys: QmlProtocols.GuestKeys)` → `MapMinecraftPortAsync()` 得 mcHost/mcPort → `QmlProtocols.FetchGameInfoAsync` 拿房主 game_info → `QmlProtocols.ExchangeIconsAsync` 上报本机头像并取回头像表。
- **GetStatus()**：`{ mode, roomCode?, mcHost?, mcPort?, gameInfo?, players[] }`；`players` 来自 `center.PlayersChanged` 缓存或 `guest.GetPlayerListAsync()`，每个 player 合并头像表得 `iconBase64`，并带 `vendor`。
- **LeaveAsync()**：`CloseAsync` 清理 EasyTier 进程树，回到 idle。

### `Controllers/ConnectorController.cs`（`api/connector`）
- `POST /host/port` `{ port }` → `{ roomCode }`
- `POST /host/instance` `{ instanceId }` → 受理（202/OK），前端轮询 status
- `POST /join` `{ code }` → `{ mcHost, mcPort }`
- `GET /status` → `ConnectorStatus`
- `POST /leave` → OK
- controller 不写 try/catch。

### DI 与生命周期
- `Program.cs`：注册 `ConnectorService` 单例、`GameProcessInspector`。`ConnectorService` 依赖已注册的 `LanGameListenerService`、`AccountService`。
- `app.Lifetime.ApplicationStopping` 注册 `ConnectorService.LeaveAsync()` 清理进程。

### 异常映射
- `Middleware/ErrorHandlingMiddleware.MapException`：`RoomCodeInvalidException`→400；其它 `ScaffoldingException`（`EasyTierStartException`/`EasyTierTimeoutException`/`CenterNotFoundException`/`CenterConnectionException`/`ProtocolException`/`HeartbeatTimeoutException`）→502。

## 跨平台注意
- 进程反查/端口探测全部按 `IsWindows/IsLinux/IsMacOS` 分支，禁止硬编码分隔符/盘符。
- `easytier-core -V` 通过 `ProcessStartInfo` 调用；找不到时库抛 `EasyTierStartException`→502。

## 数据流

**创建房间（手填端口）**：填端口 → `POST /host/port` → 反查进程取 playerName/uuid/版本 → 建房（注册 qml 协议）→ 返回房间码 → 轮询 status。

**创建房间（选实例）**：选实例 → `POST /host/instance` → 启动游戏 → 轮询 LAN 组播探测端口 → 反查进程补玩家信息 + 实例元数据组 GameInfo → 建房 → status 变 `host`。

**加入房间**：填房间码 → `POST /join` → 取当前账户名 → 加入网络/发现中心 → `MapMinecraftPortAsync` 得地址 → 拉 game_info + 交换 icons → 返回 host:port → 轮询 status。

**退出**：`POST /leave` → `CloseAsync` 停止心跳/TCP、清理本实例 EasyTier 进程树。
