# 联机中心 (Connect Center) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为启动器新增"联机中心"页面与后端，基于 `Qomicex.Connector`（Scaffolding-MC / EasyTier）实现无公网 IP 的 Minecraft 联机（创建/加入房间、自定义协议传输头像与游戏信息）。

**Architecture:** 后端单例 `ConnectorService` 持有当前会话（`ScaffoldingCenter`/`ScaffoldingGuest`），通过 `ConnectorController`(`api/connector`) 暴露 host/join/status/leave。创建房间支持手填端口或选实例启动后经 `LanGameListenerService` 组播探测端口。自定义协议 `qml:game_info`/`qml:player_icons` 集中在 `QmlProtocols` 注册表。前端新增 `/connect` 路由与页面，轮询 status 刷新玩家列表（头像+名称+vendor）。

**Tech Stack:** ASP.NET Core 10 (C#), React 19 + Vite 7 + TypeScript + Tailwind, `Qomicex.Connector` submodule。

## Global Constraints

- **参考** `src-backend/Qomicex.Connector.Part.Scaffolding/README.md` 的 Host/Guest/自定义协议用法，API 调用必须与该库实际签名一致。
- **无测试框架**（AGENTS.md）。每个任务的"验证"用 `dotnet build`（后端）或 `npm run build`（前端，等价 `tsc && vite build`，类型错误会 fail）代替单元测试，另附手动验证说明。
- **后端错误处理**：controller 内**不写 try/catch**，抛 `ApiException.BadRequest(...)`/`NotFound(...)` 等，其它异常冒泡到 `ErrorHandlingMiddleware`。
- **前端 import 必须带文件扩展名**（Vite bug）：`import { x } from './y.ts'`。
- **内部导航用 `<Link>`**，不用 `<a>`。
- **跨平台**：进程/端口探测按 `OperatingSystem.IsWindows()/IsLinux()/IsMacOS()` 分支，禁止硬编码分隔符/盘符。用 `Path.Combine`。
- **UI 组件**从 `../components/ui/<name>.tsx` 导入；`cn()` 来自 `src/lib/utils.ts`；图标用 `@fortawesome/react-fontawesome`。
- **单会话**：同一时刻只允许一个房间或一个连接。
- **vendor 格式**（verbatim）：`$"Qomicex {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}"`。
- **machineId**：`Convert.ToHexString(SHA256.HashData(UTF8(systemInfoText + CryptHelper.GetMachineCode())))`。
- **EasyTier 二进制假设已在 PATH**，`easyTierPath` 传 `null`。二进制自动下载不在本次范围。

---

## File Structure

**后端（新增）**
- `src-backend/Qomicex.Launcher.Backend/Services/Connector/QmlProtocols.cs` — 自定义协议注册表（键名、DTO、Host handler 工厂、Guest 调用封装）。
- `src-backend/Qomicex.Launcher.Backend/Services/Connector/GameProcessInspector.cs` — 端口→PID→命令行参数解析（跨平台）。
- `src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs` — 单例会话管理。
- `src-backend/Qomicex.Launcher.Backend/Controllers/ConnectorController.cs` — `api/connector` 端点。

**后端（修改）**
- `Qomicex.Launcher.Backend.csproj` — 加 `ProjectReference` 到 submodule。
- `Program.cs` — 注册 DI + 生命周期清理。
- `Middleware/ErrorHandlingMiddleware.cs` — `ScaffoldingException` 映射。
- `Services/LanGameListenerService.cs` — 无需改（复用 `GetGames()`）。

**前端（新增）**
- `src/api/connector.ts` — API 封装。
- `src/pages/Connect.tsx` — 页面。

**前端（修改）**
- `src/types/index.ts` — 新增类型。
- `src/components/Sidebar.tsx` — 导航项。
- `src/App.tsx` — 路由。

---

## Task 1: 后端引用 submodule 项目

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

**Interfaces:**
- Consumes: submodule 项目 `src-backend/Qomicex.Connector.Part.Scaffolding/Qomicex.Connector/Qomicex.Connector.csproj`。
- Produces: 后端可 `using Qomicex.Connector;` 及其子命名空间。

- [ ] **Step 1: 添加 ProjectReference**

在 `Qomicex.Launcher.Backend.csproj` 里已有的 `<ItemGroup>`（含 `Qomicex.Core` 的那个）中追加：

```xml
  <ItemGroup>
    <ProjectReference Include="..\..\Qomicex.Avalonia\Qomicex.Core\Qomicex.Core.csproj" />
    <ProjectReference Include="..\Qomicex.Connector.Part.Scaffolding\Qomicex.Connector\Qomicex.Connector.csproj" />
  </ItemGroup>
```

- [ ] **Step 2: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 编译成功（Build succeeded），无关于 `Qomicex.Connector` 的引用错误。

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
git commit -m "build: reference Qomicex.Connector submodule from backend"
```

---

## Task 2: ScaffoldingException 异常映射

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Middleware/ErrorHandlingMiddleware.cs`

**Interfaces:**
- Consumes: `Qomicex.Connector.RoomCodeInvalidException`、`Qomicex.Connector.ScaffoldingException`（基类，见 `ScaffoldingException.cs`）。
- Produces: 无（仅错误码映射）。

- [ ] **Step 1: 加 using**

在文件顶部 using 区加：

```csharp
using Qomicex.Connector;
```

- [ ] **Step 2: 在 MapException 的 switch 中，`ApiException` 之后插入两条分支**

在 `ApiException api => (...)` 行之后、`ArgumentNullException` 行之前插入：

```csharp
            RoomCodeInvalidException => (400, "ROOM_CODE_INVALID", ex.Message, null),
            ScaffoldingException => (502, "CONNECTOR_ERROR", ex.Message, ex.InnerException?.Message),
```

（`RoomCodeInvalidException` 必须排在 `ScaffoldingException` 之前，因为它是子类。）

- [ ] **Step 3: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。

- [ ] **Step 4: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Middleware/ErrorHandlingMiddleware.cs
git commit -m "feat: map ScaffoldingException to HTTP errors"
```

---

## Task 3: QmlProtocols 自定义协议注册表

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/Connector/QmlProtocols.cs`

**Interfaces:**
- Consumes: `Qomicex.Connector.Protocols.{IProtocol, DelegateProtocol}`、`Qomicex.Connector.Guest.ScaffoldingGuest`（`SendAsync<TResp>`、`SendAsync<TReq,TResp>`）。参考 README 六节。
- Produces:
  - DTO：`GameInfoDto { string GameVersion; string? Loader; string? LoaderVersion; }`
  - DTO：`PlayerIconUpload { string MachineId; string IconBase64; }`
  - DTO：`PlayerIconMap { Dictionary<string,string> Icons; }`
  - `static string[] GuestKeys` = `["qml:game_info", "qml:player_icons"]`
  - `static IProtocol[] BuildHostProtocols(Func<GameInfoDto> getGameInfo, Func<PlayerIconUpload, PlayerIconMap> exchangeIcons)`
  - `static Task<GameInfoDto?> FetchGameInfoAsync(ScaffoldingGuest guest, CancellationToken ct)`
  - `static Task<PlayerIconMap?> ExchangeIconsAsync(ScaffoldingGuest guest, PlayerIconUpload upload, CancellationToken ct)`

- [ ] **Step 1: 创建 QmlProtocols.cs**

```csharp
using Qomicex.Connector.Guest;
using Qomicex.Connector.Protocols;

namespace Qomicex.Launcher.Backend.Services.Connector;

public sealed class GameInfoDto
{
    public string GameVersion { get; set; } = "";
    public string? Loader { get; set; }
    public string? LoaderVersion { get; set; }
}

public sealed class PlayerIconUpload
{
    public string MachineId { get; set; } = "";
    public string IconBase64 { get; set; } = "";
}

public sealed class PlayerIconMap
{
    public Dictionary<string, string> Icons { get; set; } = new();
}

/// <summary>
/// qml 命名空间自定义协议集中注册表。新增协议：在此加键名常量、DTO、
/// BuildHostProtocols 里的一个 DelegateProtocol、GuestKeys 里的键、以及一个 Guest 调用封装。
/// </summary>
public static class QmlProtocols
{
    public const string GameInfoKey = "qml:game_info";
    public const string PlayerIconsKey = "qml:player_icons";

    public static readonly string[] GuestKeys = [GameInfoKey, PlayerIconsKey];

    public static IProtocol[] BuildHostProtocols(
        Func<GameInfoDto> getGameInfo,
        Func<PlayerIconUpload, PlayerIconMap> exchangeIcons)
    {
        return
        [
            new DelegateProtocol<GameInfoDto>(GameInfoKey, getGameInfo),
            new DelegateProtocol<PlayerIconUpload, PlayerIconMap>(PlayerIconsKey, exchangeIcons),
        ];
    }

    public static Task<GameInfoDto?> FetchGameInfoAsync(ScaffoldingGuest guest, CancellationToken ct = default)
        => guest.SendAsync<GameInfoDto>(GameInfoKey, ct);

    public static Task<PlayerIconMap?> ExchangeIconsAsync(ScaffoldingGuest guest, PlayerIconUpload upload, CancellationToken ct = default)
        => guest.SendAsync<PlayerIconUpload, PlayerIconMap>(PlayerIconsKey, upload, ct);
}
```

- [ ] **Step 2: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。若报 `DelegateProtocol<T>` 构造签名不符，核对 `Protocols/IProtocol.cs` 中的重载并调整。

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/Connector/QmlProtocols.cs
git commit -m "feat: add QmlProtocols registry for custom connector protocols"
```

---

## Task 4: GameProcessInspector — 端口反查进程参数（跨平台）

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/Connector/GameProcessInspector.cs`

**Interfaces:**
- Consumes: `System.Management`（已在 csproj 引用，仅 Windows 使用）。
- Produces:
  - `sealed record GameProcessInfo(string PlayerName, string Uuid, bool IsMicrosoft, string? GameVersionArg)`
  - `class GameProcessInspector` 单例，方法 `GameProcessInfo Inspect(int port)`（找不到抛 `Qomicex.Launcher.Backend.Common.ApiException.BadRequest`）。

- [ ] **Step 1: 创建 GameProcessInspector.cs（含端口→PID、PID→cmdline、参数解析）**

```csharp
using System.Diagnostics;
using System.Runtime.InteropServices;
using Qomicex.Launcher.Backend.Common;

namespace Qomicex.Launcher.Backend.Services.Connector;

public sealed record GameProcessInfo(string PlayerName, string Uuid, bool IsMicrosoft, string? GameVersionArg);

public sealed class GameProcessInspector
{
    private readonly ILogger<GameProcessInspector> _logger;

    public GameProcessInspector(ILogger<GameProcessInspector> logger) => _logger = logger;

    public GameProcessInfo Inspect(int port)
    {
        var pid = FindPidByPort(port)
            ?? throw ApiException.BadRequest($"未在端口 {port} 上找到正在运行的 Minecraft 游戏");
        var cmdline = GetCommandLine(pid)
            ?? throw ApiException.BadRequest($"无法读取端口 {port} 对应进程 (PID {pid}) 的启动参数");

        var args = Tokenize(cmdline);
        var name = GetArgValue(args, "--username") ?? GetArgValue(args, "--name")
            ?? throw ApiException.BadRequest("游戏启动参数中未找到玩家名 (--username)");
        var uuid = GetArgValue(args, "--uuid") ?? "";
        var userType = GetArgValue(args, "--userType") ?? "";
        var version = GetArgValue(args, "--version");
        var isMicrosoft = string.Equals(userType, "microsoft", StringComparison.OrdinalIgnoreCase)
                          || string.Equals(userType, "msa", StringComparison.OrdinalIgnoreCase);

        return new GameProcessInfo(name, uuid, isMicrosoft, version);
    }

    private int? FindPidByPort(int port)
    {
        if (OperatingSystem.IsWindows()) return FindPidByPortWindows(port);
        if (OperatingSystem.IsLinux()) return FindPidByPortLinux(port);
        if (OperatingSystem.IsMacOS()) return FindPidByPortMac(port);
        return null;
    }

    // ── Windows: GetExtendedTcpTable ──
    private int? FindPidByPortWindows(int port)
    {
        try
        {
            int bufferSize = 0;
            uint AF_INET = 2;
            GetExtendedTcpTable(IntPtr.Zero, ref bufferSize, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
            var buffer = Marshal.AllocHGlobal(bufferSize);
            try
            {
                if (GetExtendedTcpTable(buffer, ref bufferSize, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) != 0)
                    return null;

                int rowCount = Marshal.ReadInt32(buffer);
                var rowPtr = IntPtr.Add(buffer, 4);
                int rowSize = Marshal.SizeOf<MIB_TCPROW_OWNER_PID>();
                for (int i = 0; i < rowCount; i++)
                {
                    var row = Marshal.PtrToStructure<MIB_TCPROW_OWNER_PID>(IntPtr.Add(rowPtr, i * rowSize));
                    int localPort = ((row.localPort & 0xFF) << 8) | ((row.localPort >> 8) & 0xFF);
                    if (localPort == port) return (int)row.owningPid;
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Windows 端口反查失败"); }
        return null;
    }

    private const int TCP_TABLE_OWNER_PID_ALL = 5;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref int pdwSize, bool bOrder, uint ulAf, int tableClass, uint reserved);

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_TCPROW_OWNER_PID
    {
        public uint state;
        public uint localAddr;
        public uint localPort;
        public uint remoteAddr;
        public uint remotePort;
        public uint owningPid;
    }

    // ── Linux: /proc/net/tcp(6) inode → /proc/*/fd ──
    private int? FindPidByPortLinux(int port)
    {
        try
        {
            var inodes = new HashSet<string>();
            foreach (var path in new[] { "/proc/net/tcp", "/proc/net/tcp6" })
            {
                if (!File.Exists(path)) continue;
                foreach (var line in File.ReadLines(path).Skip(1))
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 10) continue;
                    var local = parts[1];
                    var colon = local.LastIndexOf(':');
                    if (colon < 0) continue;
                    if (int.TryParse(local[(colon + 1)..], System.Globalization.NumberStyles.HexNumber, null, out var p) && p == port)
                        inodes.Add(parts[9]);
                }
            }
            if (inodes.Count == 0) return null;

            foreach (var procDir in Directory.EnumerateDirectories("/proc"))
            {
                var pidName = Path.GetFileName(procDir);
                if (!int.TryParse(pidName, out var pid)) continue;
                var fdDir = Path.Combine(procDir, "fd");
                if (!Directory.Exists(fdDir)) continue;
                try
                {
                    foreach (var fd in Directory.EnumerateFiles(fdDir))
                    {
                        var link = ReadLinkSafe(fd);
                        if (link != null && inodes.Any(ino => link.Contains($"socket:[{ino}]")))
                            return pid;
                    }
                }
                catch { }
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Linux 端口反查失败"); }
        return null;
    }

    private static string? ReadLinkSafe(string path)
    {
        try { return new FileInfo(path).LinkTarget; } catch { return null; }
    }

    // ── macOS: lsof ──
    private int? FindPidByPortMac(int port)
    {
        try
        {
            var output = RunProcess("lsof", $"-nP -iTCP:{port} -sTCP:LISTEN -t");
            var first = output.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            if (int.TryParse(first?.Trim(), out var pid)) return pid;
        }
        catch (Exception ex) { _logger.LogWarning(ex, "macOS 端口反查失败"); }
        return null;
    }

    private string? GetCommandLine(int pid)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                using var searcher = new System.Management.ManagementObjectSearcher(
                    $"SELECT CommandLine FROM Win32_Process WHERE ProcessId={pid}");
                foreach (var o in searcher.Get())
                    return o["CommandLine"]?.ToString();
                return null;
            }
            if (OperatingSystem.IsLinux())
            {
                var path = $"/proc/{pid}/cmdline";
                if (!File.Exists(path)) return null;
                return File.ReadAllText(path).Replace('\0', ' ').Trim();
            }
            if (OperatingSystem.IsMacOS())
                return RunProcess("ps", $"-p {pid} -o command=").Trim();
        }
        catch (Exception ex) { _logger.LogWarning(ex, "读取 PID {Pid} 命令行失败", pid); }
        return null;
    }

    private static string RunProcess(string file, string args)
    {
        using var proc = Process.Start(new ProcessStartInfo(file, args)
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        })!;
        var output = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit(3000);
        return output;
    }

    private static List<string> Tokenize(string cmdline)
    {
        var tokens = new List<string>();
        var current = new System.Text.StringBuilder();
        bool inQuotes = false;
        foreach (var c in cmdline)
        {
            if (c == '"') { inQuotes = !inQuotes; continue; }
            if (c == ' ' && !inQuotes)
            {
                if (current.Length > 0) { tokens.Add(current.ToString()); current.Clear(); }
            }
            else current.Append(c);
        }
        if (current.Length > 0) tokens.Add(current.ToString());
        return tokens;
    }

    private static string? GetArgValue(List<string> args, string key)
    {
        var idx = args.FindIndex(a => a == key);
        if (idx >= 0 && idx + 1 < args.Count) return args[idx + 1];
        return null;
    }
}
```

- [ ] **Step 2: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。若 `ApiException.BadRequest` 签名不符，核对 `Common/ApiError.cs`。

- [ ] **Step 3: 手动验证说明（记录，不阻塞）**

后续联调时：Windows 上启动一个监听已知端口的进程，调 `Inspect(port)` 应返回其 PID 对应命令行的参数。此步无自动化测试。

- [ ] **Step 4: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/Connector/GameProcessInspector.cs
git commit -m "feat: add cross-platform GameProcessInspector for port->args"
```

---

## Task 5: ConnectorService — 会话管理核心

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs`

**Interfaces:**
- Consumes:
  - `Qomicex.Connector.ScaffoldingClient`（`CreateRoomAsync(playerName, machineId, vendor, minecraftPort, customProtocols)`、`JoinRoomAsync(roomCode, playerName, machineId, vendor, customProtocolKeys)`、`CloseAsync()`；见 README 四/五节）。
  - `ScaffoldingCenter`（`.RoomCode.Raw`、`.GetPlayers()`、`event PlayersChanged`、`CloseAsync`）。
  - `ScaffoldingGuest`（`MapMinecraftPortAsync()` → `(string Host, int Port)`、`GetPlayerListAsync()`、`LeaveAsync`）。
  - `Qomicex.Connector.Models.PlayerInfo`（`Name`、`MachineId`、`Vendor`、`Kind`）。
  - `GameProcessInspector.Inspect(port)`、`QmlProtocols.*`。
  - `AccountService.GetDefaultAsync()`（返回 `StoredAccount?`，含 `Name`/`Uuid`/`LoginMethod`/`ServerUrl`）。
  - `LanGameListenerService.GetGames()` → `List<LanGameEntry>`（含 `Port`、`LastSeen`）。
  - `IInstanceRepository.GetById(id)` → `GameInstance?`（含 `GameVersion`/`Loader`/`LoaderVersion`）。
  - `SkinService.GetHeadAvatar(uuid, loginMethod, serverUrl, size)` → `Task<byte[]?>`。
  - `IHttpClientFactory`（不需要）。用 `HttpClient` 触发本地启动 API：改为直接注入 `LaunchService` 无法启动（Launch 逻辑在 controller）。**改为**：`HostByInstanceAsync` 通过本地 `HttpClient` POST `http://localhost:5000/api/instance/{id}/launch`。
- Produces:
  - `enum ConnectorMode { Idle, Host, Guest }`
  - `record ConnectorPlayerDto(string Name, string Vendor, string? IconBase64, string Kind)`
  - `record ConnectorStatusDto(string Mode, string? RoomCode, string? McHost, int? McPort, GameInfoDto? GameInfo, List<ConnectorPlayerDto> Players)`
  - 方法：`Task<string> HostByPortAsync(int port, CancellationToken ct)`（返回 roomCode）、`Task HostByInstanceAsync(string instanceId, CancellationToken ct)`、`Task<(string Host, int Port)> JoinAsync(string code, CancellationToken ct)`、`ConnectorStatusDto GetStatus()`、`Task LeaveAsync(CancellationToken ct)`。

- [ ] **Step 1: 创建 ConnectorService.cs（DTO + 会话字段 + machineId/vendor 计算）**

```csharp
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Qomicex.Connector;
using Qomicex.Connector.Center;
using Qomicex.Connector.Guest;
using Qomicex.Connector.Models;
using Qomicex.Launcher.Backend.Common;
using Qomicex.Core.Modules.Helpers;

namespace Qomicex.Launcher.Backend.Services.Connector;

public enum ConnectorMode { Idle, Host, Guest }

public sealed record ConnectorPlayerDto(string Name, string Vendor, string? IconBase64, string Kind);
public sealed record ConnectorStatusDto(
    string Mode, string? RoomCode, string? McHost, int? McPort,
    GameInfoDto? GameInfo, List<ConnectorPlayerDto> Players);

public sealed class ConnectorService : IDisposable
{
    private readonly ILogger<ConnectorService> _logger;
    private readonly GameProcessInspector _inspector;
    private readonly AccountService _accountService;
    private readonly LanGameListenerService _lanListener;
    private readonly IInstanceRepository _instances;
    private readonly SkinService _skinService;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ScaffoldingClient _client = new(easyTierPath: null);

    private ScaffoldingCenter? _center;
    private ScaffoldingGuest? _guest;
    private GameInfoDto _gameInfo = new();
    private readonly Dictionary<string, string> _iconMap = new();
    private string? _mcHost;
    private int? _mcPort;

    private static string? _cachedVendor;
    private static string? _cachedMachineId;

    public ConnectorService(
        ILogger<ConnectorService> logger,
        GameProcessInspector inspector,
        AccountService accountService,
        LanGameListenerService lanListener,
        IInstanceRepository instances,
        SkinService skinService)
    {
        _logger = logger;
        _inspector = inspector;
        _accountService = accountService;
        _lanListener = lanListener;
        _instances = instances;
        _skinService = skinService;
    }

    private static string MachineId
    {
        get
        {
            if (_cachedMachineId != null) return _cachedMachineId;
            var info = SystemInfoHelper.GetSystemInfo();
            var sysText = $"{info.OSName}|{info.OS}|{info.OSVersion}|{info.Architecture}";
            var combined = sysText + CryptHelper.GetMachineCode();
            _cachedMachineId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(combined)));
            return _cachedMachineId;
        }
    }

    private string Vendor
    {
        get
        {
            if (_cachedVendor != null) return _cachedVendor;
            var launcherVersion = typeof(ConnectorService).Assembly.GetName().Version?.ToString() ?? "0.0.0";
            var etVersion = GetEasyTierVersion();
            _cachedVendor = $"Qomicex {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}";
            return _cachedVendor;
        }
    }

    private string GetEasyTierVersion()
    {
        try
        {
            using var proc = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("easytier-core", "-V")
            {
                RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true
            });
            if (proc == null) return "unknown";
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(3000);
            var token = output.Split(new[] { ' ', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault(t => t.Any(char.IsDigit) && t.Contains('.'));
            return token ?? "unknown";
        }
        catch { return "unknown"; }
    }

    public void Dispose() { _client.Dispose(); _gate.Dispose(); }
}
```

- [ ] **Step 2: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。若 `SystemInfoHelper.GetSystemInfo()` 字段名不符，核对 `Qomicex.Avalonia/Qomicex.Core/Modules/Helpers/SystemInfoHelper.cs` 并调整 `sysText`。

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs
git commit -m "feat: ConnectorService scaffolding (machineId, vendor)"
```

---

## Task 6: ConnectorService — HostByPort / Join / Leave / Status

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs`

**Interfaces:**
- Consumes: 见 Task 5。
- Produces: `HostByPortAsync`、`JoinAsync`、`LeaveAsync`、`GetStatus`、内部 `BuildGameInfoFromArgs`、`GetSelfIconBase64`、`ExchangeIcons`、`MapPlayers`。

- [ ] **Step 1: 在类中加入方法（放在 Dispose 之前）**

```csharp
    public async Task<string> HostByPortAsync(int port, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            var proc = _inspector.Inspect(port);
            _gameInfo = new GameInfoDto { GameVersion = proc.GameVersionArg ?? "unknown" };
            var selfIcon = await GetSelfIconBase64(proc.Uuid, proc.IsMicrosoft);
            _iconMap[MachineId] = selfIcon;

            var protocols = QmlProtocols.BuildHostProtocols(() => _gameInfo, ExchangeIcons);
            _center = await _client.CreateRoomAsync(proc.PlayerName, MachineId, Vendor, port, protocols, ct);
            return _center.RoomCode.Raw;
        }
        finally { _gate.Release(); }
    }

    public async Task<(string Host, int Port)> JoinAsync(string code, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            var account = await _accountService.GetDefaultAsync()
                ?? throw ApiException.BadRequest("请先在账户页选择一个账户再加入房间");

            _guest = await _client.JoinRoomAsync(code, account.Name, MachineId, Vendor, QmlProtocols.GuestKeys, ct);
            var (host, mcPort) = await _guest.MapMinecraftPortAsync(ct);
            _mcHost = host; _mcPort = mcPort;

            _gameInfo = await QmlProtocols.FetchGameInfoAsync(_guest, ct) ?? new GameInfoDto();

            var isMicrosoft = string.Equals(account.LoginMethod, "Microsoft", StringComparison.OrdinalIgnoreCase);
            var icon = await GetSelfIconBase64(account.Uuid, isMicrosoft);
            var map = await QmlProtocols.ExchangeIconsAsync(_guest,
                new PlayerIconUpload { MachineId = MachineId, IconBase64 = icon }, ct);
            if (map?.Icons != null)
                foreach (var kv in map.Icons) _iconMap[kv.Key] = kv.Value;

            return (host, mcPort);
        }
        finally { _gate.Release(); }
    }

    public async Task LeaveAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await _client.CloseAsync(ct);
            _center = null; _guest = null; _mcHost = null; _mcPort = null;
            _gameInfo = new GameInfoDto(); _iconMap.Clear();
        }
        finally { _gate.Release(); }
    }

    public ConnectorStatusDto GetStatus()
    {
        if (_center != null)
            return new ConnectorStatusDto("host", _center.RoomCode.Raw, null, null, _gameInfo,
                MapPlayers(_center.GetPlayers()));
        if (_guest != null)
            return new ConnectorStatusDto("guest", null, _mcHost, _mcPort, _gameInfo,
                MapPlayers(_guest.GetPlayerListAsync().GetAwaiter().GetResult()));
        return new ConnectorStatusDto("idle", null, null, null, null, new());
    }

    private void EnsureIdle()
    {
        if (_center != null || _guest != null)
            throw ApiException.BadRequest("已有进行中的房间或连接，请先退出");
    }

    private PlayerIconMap ExchangeIcons(PlayerIconUpload upload)
    {
        if (!string.IsNullOrEmpty(upload.MachineId) && !string.IsNullOrEmpty(upload.IconBase64))
            _iconMap[upload.MachineId] = upload.IconBase64;
        return new PlayerIconMap { Icons = new Dictionary<string, string>(_iconMap) };
    }

    private async Task<string> GetSelfIconBase64(string uuid, bool isMicrosoft)
    {
        try
        {
            var loginMethod = isMicrosoft ? "Microsoft" : "Offline";
            var bytes = await _skinService.GetHeadAvatar(uuid, loginMethod, null, 64);
            return bytes != null ? Convert.ToBase64String(bytes) : "";
        }
        catch { return ""; }
    }

    private List<ConnectorPlayerDto> MapPlayers(IReadOnlyList<PlayerInfo> players)
        => players.Select(p => new ConnectorPlayerDto(
            p.Name, p.Vendor,
            _iconMap.TryGetValue(p.MachineId, out var icon) ? icon : null,
            p.Kind == PlayerKind.Host ? "host" : "guest")).ToList();
```

- [ ] **Step 2: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。核对 `MapMinecraftPortAsync` 是否需 ct 参数（其签名 `MapMinecraftPortAsync(CancellationToken ct = default)`）与 `SkinService.GetHeadAvatar` 参数顺序。

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs
git commit -m "feat: ConnectorService host-by-port, join, leave, status"
```

---

## Task 7: ConnectorService — HostByInstance（启动实例 + LAN 探测端口）

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs`

**Interfaces:**
- Consumes: `IInstanceRepository.GetById`、`LanGameListenerService.GetGames()`、本地 HTTP `POST /api/instance/{id}/launch`。
- Produces: `Task HostByInstanceAsync(string instanceId, CancellationToken ct)`。

- [ ] **Step 1: 加字段 `System.Net.Http.HttpClient` 并在构造器初始化**

在字段区加：

```csharp
    private readonly HttpClient _localHttp = new() { BaseAddress = new Uri("http://localhost:5000") };
```

在 `Dispose()` 中追加 `_localHttp.Dispose();`。

- [ ] **Step 2: 加 HostByInstanceAsync 方法**

```csharp
    public async Task HostByInstanceAsync(string instanceId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            var instance = _instances.GetById(instanceId)
                ?? throw ApiException.NotFound("实例不存在");

            var knownPorts = _lanListener.GetGames().Select(g => g.Port).ToHashSet();

            var resp = await _localHttp.PostAsync($"/api/instance/{instanceId}/launch", null, ct);
            resp.EnsureSuccessStatusCode();

            var deadline = DateTime.UtcNow.AddMinutes(5);
            int? newPort = null;
            while (DateTime.UtcNow < deadline)
            {
                ct.ThrowIfCancellationRequested();
                var candidate = _lanListener.GetGames()
                    .Where(g => !knownPorts.Contains(g.Port))
                    .OrderByDescending(g => g.LastSeen)
                    .FirstOrDefault();
                if (candidate != null) { newPort = candidate.Port; break; }
                await Task.Delay(2000, ct);
            }

            if (newPort is null)
                throw ApiException.BadRequest("等待游戏开放局域网超时，请在游戏内点击\"对局域网开放\"");

            var proc = _inspector.Inspect(newPort.Value);
            _gameInfo = new GameInfoDto
            {
                GameVersion = instance.GameVersion,
                Loader = instance.Loader,
                LoaderVersion = instance.LoaderVersion,
            };
            var selfIcon = await GetSelfIconBase64(proc.Uuid, proc.IsMicrosoft);
            _iconMap[MachineId] = selfIcon;

            var protocols = QmlProtocols.BuildHostProtocols(() => _gameInfo, ExchangeIcons);
            _center = await _client.CreateRoomAsync(proc.PlayerName, MachineId, Vendor, newPort.Value, protocols, ct);
        }
        finally { _gate.Release(); }
    }
```

- [ ] **Step 3: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。核对 `ApiException.NotFound` 存在（`Common/ApiError.cs`）。

- [ ] **Step 4: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs
git commit -m "feat: ConnectorService host-by-instance with LAN port discovery"
```

---

## Task 8: ConnectorController + DI 注册 + 生命周期清理

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Controllers/ConnectorController.cs`
- Modify: `src-backend/Qomicex.Launcher.Backend/Program.cs`

**Interfaces:**
- Consumes: `ConnectorService`（Task 5-7）。
- Produces: HTTP 端点 `api/connector/{host/port, host/instance, join, status, leave}`。

- [ ] **Step 1: 创建 ConnectorController.cs**

```csharp
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services.Connector;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ConnectorController : ControllerBase
{
    private readonly ConnectorService _connector;

    public ConnectorController(ConnectorService connector) => _connector = connector;

    [HttpPost("host/port")]
    public async Task<IActionResult> HostByPort([FromBody] HostByPortRequest req, CancellationToken ct)
    {
        var roomCode = await _connector.HostByPortAsync(req.Port, ct);
        return Ok(new { roomCode });
    }

    [HttpPost("host/instance")]
    public async Task<IActionResult> HostByInstance([FromBody] HostByInstanceRequest req, CancellationToken ct)
    {
        await _connector.HostByInstanceAsync(req.InstanceId, ct);
        return Ok(new { status = "hosting" });
    }

    [HttpPost("join")]
    public async Task<IActionResult> Join([FromBody] JoinRequest req, CancellationToken ct)
    {
        var (host, port) = await _connector.JoinAsync(req.Code, ct);
        return Ok(new { mcHost = host, mcPort = port });
    }

    [HttpGet("status")]
    public IActionResult Status() => Ok(_connector.GetStatus());

    [HttpPost("leave")]
    public async Task<IActionResult> Leave(CancellationToken ct)
    {
        await _connector.LeaveAsync(ct);
        return Ok(new { status = "idle" });
    }
}

public class HostByPortRequest { public int Port { get; set; } }
public class HostByInstanceRequest { public string InstanceId { get; set; } = ""; }
public class JoinRequest { public string Code { get; set; } = ""; }
```

- [ ] **Step 2: Program.cs 注册 DI**

在 `builder.Services.AddSingleton<LanGameListenerService>();` 之后追加：

```csharp
builder.Services.AddSingleton<Qomicex.Launcher.Backend.Services.Connector.GameProcessInspector>();
builder.Services.AddSingleton<Qomicex.Launcher.Backend.Services.Connector.ConnectorService>();
```

- [ ] **Step 3: Program.cs 生命周期清理**

在 `app.Lifetime.ApplicationStopping.Register(() => lanService.Stop());` 之后追加：

```csharp
var connectorService = app.Services.GetRequiredService<Qomicex.Launcher.Backend.Services.Connector.ConnectorService>();
app.Lifetime.ApplicationStopping.Register(() => { try { connectorService.LeaveAsync().GetAwaiter().GetResult(); } catch { } });
```

- [ ] **Step 4: 验证 build + 运行**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。

手动：`cd src-backend/Qomicex.Launcher.Backend && dotnet run`，另开终端 `curl http://localhost:5000/api/connector/status`，应返回 `{"mode":"idle",...}`。

- [ ] **Step 5: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/ConnectorController.cs src-backend/Qomicex.Launcher.Backend/Program.cs
git commit -m "feat: add ConnectorController and register ConnectorService"
```

---

## Task 9: 前端类型与 API 封装

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/api/connector.ts`

**Interfaces:**
- Consumes: `get`/`post` from `./client.ts`。
- Produces: 类型 `ConnectorPlayer`、`ConnectorGameInfo`、`ConnectorStatus`；函数 `hostByPort`、`hostByInstance`、`joinRoom`、`getStatus`、`leave`。

- [ ] **Step 1: types/index.ts 追加类型**

在 `RoomCodeResponse` 定义之后追加：

```typescript
export interface ConnectorPlayer {
  name: string
  vendor: string
  iconBase64: string | null
  kind: 'host' | 'guest'
}

export interface ConnectorGameInfo {
  gameVersion: string
  loader: string | null
  loaderVersion: string | null
}

export interface ConnectorStatus {
  mode: 'idle' | 'host' | 'guest'
  roomCode: string | null
  mcHost: string | null
  mcPort: number | null
  gameInfo: ConnectorGameInfo | null
  players: ConnectorPlayer[]
}
```

- [ ] **Step 2: 创建 src/api/connector.ts**

```typescript
import { get, post } from './client.ts'
import type { ConnectorStatus } from '../types/index.ts'

export function hostByPort(port: number): Promise<{ roomCode: string }> {
  return post('/connector/host/port', { port })
}

export function hostByInstance(instanceId: string): Promise<{ status: string }> {
  return post('/connector/host/instance', { instanceId })
}

export function joinRoom(code: string): Promise<{ mcHost: string; mcPort: number }> {
  return post('/connector/join', { code })
}

export function getStatus(): Promise<ConnectorStatus> {
  return get<ConnectorStatus>('/connector/status')
}

export function leave(): Promise<{ status: string }> {
  return post('/connector/leave')
}
```

- [ ] **Step 3: 验证 build**

Run: `npm run build`
Expected: 编译通过（tsc 无类型错误，vite build 成功）。

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/api/connector.ts
git commit -m "feat: add connector types and API client"
```

---

## Task 10: 导航项与路由

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Create (占位): `src/pages/Connect.tsx`

**Interfaces:**
- Consumes: `Connect` 页面组件。
- Produces: `/connect` 路由与侧栏入口。

- [ ] **Step 1: 创建 Connect.tsx 占位（便于路由先通过编译）**

```tsx
import { PageHeader } from '../components/PageHeader.tsx'

export default function Connect() {
  return (
    <div className="space-y-6">
      <PageHeader title="联机" subtitle="创建或加入联机房间" />
    </div>
  )
}
```

- [ ] **Step 2: Sidebar.tsx 加导航项**

修改 import 行加入 `faNetworkWired`：

```tsx
import { faHouse, faCube, faDownload, faUser, faGear, faCompass, faNetworkWired } from '@fortawesome/free-solid-svg-icons'
```

在 `links` 数组中 `resource-center` 之后追加：

```tsx
  { to: '/connect', label: '联机', icon: faNetworkWired },
```

- [ ] **Step 3: App.tsx 加路由**

加 import：

```tsx
import Connect from './pages/Connect.tsx'
```

在 `<Route path="/resource-center/:resourceId" ... />` 之后追加：

```tsx
            <Route path="/connect" element={<Connect />} />
```

- [ ] **Step 4: 验证 build**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx src/pages/Connect.tsx
git commit -m "feat: add connect nav item, route, placeholder page"
```

---

## Task 11: Connect 页面 — 完整 UI

**Files:**
- Modify: `src/pages/Connect.tsx`

**Interfaces:**
- Consumes: `src/api/connector.ts`、`ConnectorStatus`、`getInstances`（`../api/instance.ts`）、UI 组件、`useMessageBox`、`ApiError`。
- Produces: 完整联机页面。

- [ ] **Step 1: 实现 Connect.tsx**

```tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCopy, faSpinner, faDoorOpen, faRightToBracket, faPlay } from '@fortawesome/free-solid-svg-icons'
import { PageHeader } from '../components/PageHeader.tsx'
import { Card } from '../components/ui/card.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { ApiError } from '../api/client.ts'
import * as connectorApi from '../api/connector.ts'
import { getInstances } from '../api/instance.ts'
import type { ConnectorStatus, ConnectorPlayer, GameInstance } from '../types/index.ts'

function fmtErr(e: unknown): string {
  if (e instanceof ApiError) return e.displayMessage
  if (e instanceof Error) return e.message
  return String(e)
}

function PlayerRow({ p }: { p: ConnectorPlayer }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2">
      {p.iconBase64 ? (
        <img src={`data:image/png;base64,${p.iconBase64}`} alt={p.name} className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 font-bold text-primary">
          {p.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {p.name}
          {p.kind === 'host' && <span className="ml-2 text-xs text-primary">房主</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{p.vendor}</div>
      </div>
    </div>
  )
}

export default function Connect() {
  const { error: msgError } = useMessageBox()
  const [status, setStatus] = useState<ConnectorStatus>({
    mode: 'idle', roomCode: null, mcHost: null, mcPort: null, gameInfo: null, players: [],
  })
  const [port, setPort] = useState('')
  const [code, setCode] = useState('')
  const [instances, setInstances] = useState<GameInstance[]>([])
  const [selectedInstance, setSelectedInstance] = useState('')
  const [hostMode, setHostMode] = useState<'port' | 'instance'>('port')
  const [busy, setBusy] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshStatus = useCallback(async () => {
    try { setStatus(await connectorApi.getStatus()) } catch { /* ignore poll errors */ }
  }, [])

  useEffect(() => {
    refreshStatus()
    getInstances().then(setInstances).catch(() => {})
  }, [refreshStatus])

  useEffect(() => {
    if (status.mode !== 'idle') {
      pollTimer.current = setInterval(refreshStatus, 3000)
      return () => { if (pollTimer.current) clearInterval(pollTimer.current) }
    }
  }, [status.mode, refreshStatus])

  const handleHostPort = async () => {
    const p = parseInt(port, 10)
    if (!p || p < 1 || p > 65535) { msgError('请输入有效端口 (1-65535)'); return }
    setBusy(true)
    try { await connectorApi.hostByPort(p); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleHostInstance = async () => {
    if (!selectedInstance) { msgError('请选择一个实例'); return }
    setBusy(true)
    try { await connectorApi.hostByInstance(selectedInstance); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleJoin = async () => {
    if (!code.trim()) { msgError('请输入房间码'); return }
    setBusy(true)
    try { await connectorApi.joinRoom(code.trim()); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleLeave = async () => {
    setBusy(true)
    try { await connectorApi.leave(); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const copy = (text: string) => navigator.clipboard.writeText(text)

  const isHost = status.mode === 'host'
  const isGuest = status.mode === 'guest'
  const idle = status.mode === 'idle'

  return (
    <div className="space-y-6">
      <PageHeader title="联机" subtitle="创建或加入联机房间" />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 创建房间 */}
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">创建房间</h2>

          {!isGuest && !isHost && (
            <>
              <div className="flex gap-2">
                <Button variant={hostMode === 'port' ? 'default' : 'outline'} size="sm" onClick={() => setHostMode('port')}>手填端口</Button>
                <Button variant={hostMode === 'instance' ? 'default' : 'outline'} size="sm" onClick={() => setHostMode('instance')}>选择实例</Button>
              </div>

              {hostMode === 'port' ? (
                <div className="space-y-2">
                  <Label>MC 局域网端口</Label>
                  <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="例如 25565" />
                  <Button onClick={handleHostPort} disabled={busy} className="w-full">
                    {busy ? <FontAwesomeIcon icon={faSpinner} spin /> : '创建房间'}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>选择实例</Label>
                  <Select value={selectedInstance} onChange={setSelectedInstance}>
                    <SelectOption value="">请选择...</SelectOption>
                    {instances.map((i) => <SelectOption key={i.id} value={i.id}>{i.name}</SelectOption>)}
                  </Select>
                  <Button onClick={handleHostInstance} disabled={busy} className="w-full">
                    <FontAwesomeIcon icon={faPlay} className="mr-2" />
                    启动并创建房间
                  </Button>
                  <p className="text-xs text-muted-foreground">启动后请在游戏内点击"对局域网开放"，将自动探测端口。</p>
                </div>
              )}
            </>
          )}

          {isHost && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">房间码</span>
                <code className="rounded bg-muted px-2 py-1 text-sm">{status.roomCode}</code>
                <Button size="sm" variant="ghost" onClick={() => status.roomCode && copy(status.roomCode)}>
                  <FontAwesomeIcon icon={faCopy} />
                </Button>
              </div>
              <PlayerList players={status.players} />
              <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
                <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />关闭房间
              </Button>
            </div>
          )}
        </Card>

        {/* 加入房间 */}
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">加入房间</h2>

          {!isHost && !isGuest && (
            <div className="space-y-2">
              <Label>房间码</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="U/XXXX-XXXX-XXXX-XXXX" />
              <Button onClick={handleJoin} disabled={busy} className="w-full">
                <FontAwesomeIcon icon={faRightToBracket} className="mr-2" />
                {busy ? <FontAwesomeIcon icon={faSpinner} spin /> : '加入房间'}
              </Button>
            </div>
          )}

          {isGuest && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">服务器地址</span>
                <code className="rounded bg-muted px-2 py-1 text-sm">{status.mcHost}:{status.mcPort}</code>
                <Button size="sm" variant="ghost" onClick={() => copy(`${status.mcHost}:${status.mcPort}`)}>
                  <FontAwesomeIcon icon={faCopy} />
                </Button>
              </div>
              {status.gameInfo && (
                <p className="text-xs text-muted-foreground">
                  房主版本：{status.gameInfo.gameVersion}
                  {status.gameInfo.loader ? ` · ${status.gameInfo.loader} ${status.gameInfo.loaderVersion ?? ''}` : ''}
                </p>
              )}
              <PlayerList players={status.players} />
              <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
                <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />退出房间
              </Button>
            </div>
          )}

          {idle === false && !isHost && !isGuest && null}
        </Card>
      </div>
    </div>
  )
}

function PlayerList({ players }: { players: ConnectorPlayer[] }) {
  if (players.length === 0) return <p className="text-sm text-muted-foreground">暂无玩家</p>
  return (
    <div className="space-y-2">
      <Label>玩家列表 ({players.length})</Label>
      {players.map((p, i) => <PlayerRow key={p.name + i} p={p} />)}
    </div>
  )
}
```

- [ ] **Step 2: 核对 UI 组件 props**

用 `read` 打开 `src/components/ui/card.tsx`、`button.tsx`、`select.tsx`，确认：
- `Card` 是否接受 `className`（是）。
- `Button` 的 `variant` 是否有 `default/outline/ghost/destructive`、`size` 是否有 `sm`。
- `Select` 的 props 是 `value` + `onChange:(v:string)=>void` 还是别的；`SelectOption` 的 props。
若与上面代码不符，按实际签名调整（例如 `onChange` 可能传事件对象）。

- [ ] **Step 3: 验证 build**

Run: `npm run build`
Expected: 编译通过（tsc 严格模式无 unused/类型错误）。修正 `PlayerRow`/`PlayerList` 定义顺序等 lint 问题。

- [ ] **Step 4: Commit**

```bash
git add src/pages/Connect.tsx
git commit -m "feat: implement Connect page UI (host/join panels, player list)"
```

---

## Task 12: 端到端手动联调（记录，不含自动化测试）

**Files:** 无（验证任务）

- [ ] **Step 1: 启动后端与前端**

Run: 终端1 `cd src-backend/Qomicex.Launcher.Backend && dotnet run`；终端2 `npm run dev`。
前提：`easytier-core` 在 PATH。

- [ ] **Step 2: 验证 idle 状态**

打开 `/connect`，页面显示两个板块。`GET /api/connector/status` 返回 `mode: idle`。

- [ ] **Step 3: 验证创建房间（手填端口）**

在一台已开 MC 局域网的机器上填端口 → 点"创建房间" → 出现房间码，玩家列表含房主（头像+名称+vendor）。

- [ ] **Step 4: 验证加入房间**

另一设备/账户填房间码 → 加入 → 显示 `host:port` 与房主游戏版本，双方玩家列表可见彼此头像与 vendor。

- [ ] **Step 5: 验证退出**

点"关闭房间"/"退出房间" → 回到 idle；后端 EasyTier 进程被清理。

- [ ] **Step 6: 记录问题**

将联调中发现的偏差记入 issue 或后续任务，不在本计划内修复未预见的库行为差异。

---

## Self-Review 记录

- **Spec 覆盖**：导航/路由(Task 10)、双板块 UI(Task 11)、创建-手填端口(Task 6)、创建-选实例+LAN探测(Task 7)、加入(Task 6)、单会话(EnsureIdle)、vendor 格式(Task 5)、machineId(Task 5)、P2 端口反查(Task 4)、qml:game_info/player_icons(Task 3/6/7)、玩家列表含 vendor(Task 6 MapPlayers + Task 11 PlayerRow)、异常映射(Task 2)、DI+生命周期(Task 8)、submodule 引用(Task 1)。全部有对应任务。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`ConnectorStatusDto`/`ConnectorPlayerDto` 的 camelCase JSON 序列化对应前端 `ConnectorStatus`/`ConnectorPlayer`（ASP.NET 默认 camelCase）。`GameInfoDto` ↔ 前端 `ConnectorGameInfo`（字段名一致）。
- **风险点（需实现时核对，已在步骤中标注）**：`DelegateProtocol<T>` 构造签名、`SystemInfoHelper.GetSystemInfo()` 字段名、`SkinService.GetHeadAvatar` 参数、UI 组件 `Select`/`Button` props。这些在对应任务的验证步骤中要求核对真实签名后调整。
