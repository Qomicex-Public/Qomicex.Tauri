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

