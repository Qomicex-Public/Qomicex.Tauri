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

