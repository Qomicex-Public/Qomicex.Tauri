# 联机中心 (Connect Center) 设计

## 目标

在启动器新增"联机中心"页面，让用户基于 `Qomicex.Connector`（Scaffolding-MC / EasyTier）实现无公网 IP 的 Minecraft 联机：

- **创建房间**：填写本地已开局域网的 MC 端口，生成房间码分享给好友。
- **加入房间**：填写房间码，加入同一虚拟网络，得到可填入 MC 的服务器地址。

同一时刻只允许"创建"或"加入"其中一种（单会话）。

## 范围

**本次纳入**：前端页面 + 导航入口；后端完整联机（集成 submodule `Qomicex.Connector` + 端口反查进程 + 会话管理）。

**本次不纳入（后续）**：
- EasyTier 二进制的自动下载/打包。本次假设 `easytier-core` 已在 PATH（或程序目录/CWD）中，`easyTierPath` 传 `null` 自动查找。
- Guest 侧独立头像解析（Guest 用当前选中账户头像即可）。

## 架构决策

后端采用**单例 `ConnectorService` 持有当前会话**（方案 A）。`ScaffoldingClient.CreateRoomAsync`/`JoinRoomAsync` 返回长生命周期对象（`ScaffoldingCenter`/`ScaffoldingGuest`），必须在后端常驻。同一时刻仅一个房间或连接，用 `SemaphoreSlim` 串行化 host/join/leave。

`playerName`/头像来源采用**方案 P2：端口 → 进程 → 解析游戏参数**（仅 Host 侧；Guest 侧此时可能未开游戏，用当前选中账户名）。

## 前端

### 导航与路由
- `src/components/Sidebar.tsx`：`links` 新增 `{ to: '/connect', label: '联机', icon: faNetworkWired }`（`faNetworkWired` 从 `@fortawesome/free-solid-svg-icons` 导入）。
- `src/App.tsx`：新增 `import Connect from './pages/Connect.tsx'` 与 `<Route path="/connect" element={<Connect />} />`。

### 页面 `src/pages/Connect.tsx`
- `PageHeader` + 两个 `Card`（带 border）板块：
  - **创建房间**：端口 `Input`（数字）+ "创建房间"按钮。成功后在同板块显示：房间码（复制按钮）、房主玩家信息（`AccountAvatar`，由 `uuid`/`isMicrosoft` 渲染）、玩家列表、"关闭房间"按钮。
  - **加入房间**：房间码 `Input` + "加入房间"按钮。成功后显示：MC 服务器地址 `host:port`（复制按钮）、玩家列表、"退出房间"按钮。
- 前端状态机 `idle | host | guest`。非当前模式的另一板块禁用，避免冲突。
- 进入 `host`/`guest` 后每 ~3s 轮询 `GET /api/connector/status` 刷新玩家列表。
- 错误处理遵循现有约定：`catch (e) { if (e instanceof ApiError) msgError(e.displayMessage) }`。
- 所有本地 import 带文件扩展名；内部导航用 `<Link>`（本页无跳转则不涉及）。

### API 与类型
- `src/api/connector.ts`：`hostRoom(port: number)`、`joinRoom(code: string)`、`getStatus()`、`leave()`。
- `src/types`：新增 `ConnectorStatus`、`ConnectorPlayer` 等类型。

## 后端

### 项目引用
- `src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj` 新增 `ProjectReference` → `..\Qomicex.Connector.Part.Scaffolding\Qomicex.Connector\Qomicex.Connector.csproj`。
- 现有 `RoomCodeController` 及其本地 stub（`ScaffoldingConnector.Core.RoomCode`）保持不动，避免扩大改动。

### `Services/GameProcessInspector.cs`（P2，跨平台）
职责：给定端口，返回 `{ playerName, uuid, isMicrosoft }`。

1. **端口 → PID**
   - Windows：P/Invoke `GetExtendedTcpTable`（`iphlpapi.dll`），找监听该端口的 owning PID。
   - Linux：解析 `/proc/net/tcp` + `/proc/net/tcp6` 找该端口的 socket inode → 扫 `/proc/*/fd` 匹配 `socket:[inode]`。
   - macOS：`lsof -nP -iTCP:{port} -sTCP:LISTEN`。
2. **PID → 命令行**
   - Windows：WMI `SELECT CommandLine FROM Win32_Process WHERE ProcessId={pid}`（`System.Management` 已引用）。
   - Linux：读 `/proc/{pid}/cmdline`（`\0` 分隔）。
   - macOS：`ps -p {pid} -o command=`。
3. **解析参数**：从命令行提取 `--name`（→`playerName`）、`--uuid`、`--userType`（`microsoft` → `isMicrosoft = true`）。
4. 找不到进程/参数 → `ApiException.BadRequest("未在端口 {port} 上找到正在运行的 Minecraft 游戏")`。
5. 平台判定用 `OperatingSystem.IsWindows()/IsLinux()/IsMacOS()`。

### `Services/ConnectorService.cs`（单例）
- 持有 `ScaffoldingClient` + 当前 `ScaffoldingCenter?` / `ScaffoldingGuest?`；`SemaphoreSlim(1,1)` 串行化。
- **machineId**：`Convert.ToHexString(SHA256.HashData(UTF8(systemInfoText + CryptHelper.GetMachineCode())))`。`systemInfoText` 由 `SystemInfoHelper.GetSystemInfo()` 拼接得到；`CryptHelper.GetMachineCode()` 已返回硬件指纹十六进制。
- **vendor**：`$"Qomicex {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}"`。
  - `launcherVersion`：后端程序集 `InformationalVersion`（复用现有 `AssemblyMetadataAttribute` 机制）。
  - `etVersion`：调用 `easytier-core -V` 解析版本号；失败 → `unknown`；结果缓存。
- **HostAsync(port)**：`GameProcessInspector` 解析出 `playerName/uuid/isMicrosoft` → `CreateRoomAsync(playerName, machineId, vendor, port)`；缓存 host 玩家展示信息。返回 `roomCode`。
- **JoinAsync(code)**：`playerName` 取 `AccountService` 当前选中账户名（无账户 → `ApiException.BadRequest`）→ `JoinRoomAsync(code, playerName, machineId, vendor)` → `MapMinecraftPortAsync()` 得 `mcHost/mcPort`。
- **GetStatus()**：`{ mode: 'idle'|'host'|'guest', roomCode?, mcHost?, mcPort?, hostPlayer?, players[] }`；`players` 来自 `center.PlayersChanged` 缓存或 `guest.GetPlayerListAsync()`。
- **LeaveAsync()**：`CloseAsync` 清理 EasyTier 进程树，回到 idle。

### `Controllers/ConnectorController.cs`（`api/connector`）
- `POST /host` `{ port }` → `{ roomCode }`。
- `POST /join` `{ code }` → `{ mcHost, mcPort }`。
- `GET /status` → `ConnectorStatus`。
- `POST /leave` → 204/OK。
- controller 内**不写 try/catch**，异常冒泡到中间件。

### DI 与生命周期
- `Program.cs`：`builder.Services.AddSingleton<ConnectorService>()`（及 `GameProcessInspector`）。
- `app.Lifetime.ApplicationStopping` 注册 `ConnectorService.LeaveAsync()` 清理进程。

### 异常映射
- `Middleware/ErrorHandlingMiddleware.MapException`：
  - `RoomCodeInvalidException` → 400。
  - 其它 `ScaffoldingException`（`EasyTierStartException`/`EasyTierTimeoutException`/`CenterNotFoundException`/`CenterConnectionException`/`ProtocolException`/`HeartbeatTimeoutException`）→ 502。

## 跨平台注意
- 进程反查全部按 `IsWindows/IsLinux/IsMacOS` 分支，禁止硬编码路径分隔符/盘符。
- `easytier-core -V` 通过 `ProcessStartInfo` 调用；找不到可执行文件时库抛 `EasyTierStartException`，映射为 502。

## 数据流

**创建房间**：前端填端口 → `POST /host` → `ConnectorService` 反查进程取 playerName/uuid → `CreateRoomAsync` 启动 EasyTier + TCP 中心 → 返回房间码 → 前端展示 + 轮询 status。

**加入房间**：前端填房间码 → `POST /join` → 取当前账户名 → `JoinRoomAsync` 加入网络、发现中心 → `MapMinecraftPortAsync` 得地址 → 返回 host:port → 前端展示 + 轮询 status。

**退出**：`POST /leave` → `CloseAsync` 停止心跳/TCP、清理本实例 EasyTier 进程树。
