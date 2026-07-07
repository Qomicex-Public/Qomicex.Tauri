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

