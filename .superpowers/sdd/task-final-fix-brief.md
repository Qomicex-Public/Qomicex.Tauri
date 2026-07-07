# Final-Review Fix Wave

Fix the following findings from the whole-branch review of the Connect Center feature. Backend: `src-backend/Qomicex.Launcher.Backend/`. Frontend: `src/`.

Working directory: K:\Deskep\Project\Rust\Qomicex.Tauri

## Constraints (unchanged from the project)
- No test framework (AGENTS.md). Verify backend with `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`, frontend with `npm run build` (strict tsc — no unused locals/params). Both MUST pass.
- Backend controllers: no try/catch (exceptions bubble to middleware).
- Frontend: ALL local imports need `.ts`/`.tsx` extensions; `<Link>` not `<a>`.
- No code comments beyond what's necessary; match existing style.
- Keep `_iconMap` access under `_iconLock` (existing invariant — do not regress).

---

## Fix 1 (Important): vendor uses AssemblyVersion instead of InformationalVersion

File: `src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs`, `Vendor` getter (~line 78).

Currently: `var launcherVersion = typeof(ConnectorService).Assembly.GetName().Version?.ToString() ?? "0.0.0";`
This returns AssemblyVersion (e.g. `0.1.1.0` or `1.0.0.0`), but the spec mandates InformationalVersion.

Change to read `AssemblyInformationalVersionAttribute`:
```csharp
var launcherVersion = typeof(ConnectorService).Assembly
    .GetCustomAttribute<System.Reflection.AssemblyInformationalVersionAttribute>()?.InformationalVersion
    ?? typeof(ConnectorService).Assembly.GetName().Version?.ToString()
    ?? "0.0.0";
```
Note: InformationalVersion may include a git-hash suffix like `0.1.1+abc1234`; strip anything after a `+` so vendor stays clean: take `launcherVersion.Split('+')[0]`.
Add `using System.Reflection;` if not present (the file may already reference `System.Reflection` fully-qualified — use whichever keeps it compiling).

The vendor format string MUST remain exactly: `$"Qomicex {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}"`.

---

## Fix 2 (Important): instance-host flow blocks the session for up to 5 min with no cancel/progress

Currently `HostByInstanceAsync` (ConnectorService.cs:121-165) holds `_gate` across a launch + up-to-5-minute LAN poll, and `GetStatus` only knows `idle/host/guest`, so the frontend shows a frozen spinner with no abort.

### Backend changes (ConnectorService.cs)

1. Add fields (near `_center`/`_guest`):
```csharp
    private volatile bool _starting;
    private volatile string? _startError;
    private CancellationTokenSource? _startCts;
```

2. Update `EnsureIdle()` to also reject when starting:
```csharp
    private void EnsureIdle()
    {
        if (_center != null || _guest != null || _starting)
            throw ApiException.BadRequest("已有进行中的房间或连接，请先退出");
    }
```

3. Rewrite `HostByInstanceAsync` so it validates + launches quickly under the gate, then runs the poll+create in a background task WITHOUT holding the gate during the wait:
```csharp
    public async Task HostByInstanceAsync(string instanceId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            var instance = _instances.GetById(instanceId)
                ?? throw ApiException.NotFound("实例不存在");

            _startError = null;
            _starting = true;
            _startCts = new CancellationTokenSource();
            var token = _startCts.Token;
            _ = Task.Run(() => RunHostByInstanceAsync(instance, token));
        }
        finally { _gate.Release(); }
    }

    private async Task RunHostByInstanceAsync(Models.GameInstance instance, CancellationToken ct)
    {
        try
        {
            var knownPorts = _lanListener.GetGames().Select(g => g.Port).ToHashSet();

            using var resp = await _localHttp.PostAsync($"/api/instance/{instance.Id}/launch", null, ct);
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
            {
                _startError = "等待游戏开放局域网超时，请在游戏内点击\"对局域网开放\"";
                return;
            }

            var proc = _inspector.Inspect(newPort.Value);
            var gameInfo = new GameInfoDto
            {
                GameVersion = instance.GameVersion,
                Loader = instance.Loader,
                LoaderVersion = instance.LoaderVersion,
            };
            var selfIcon = await GetSelfIconBase64(proc.Uuid, proc.IsMicrosoft);

            await _gate.WaitAsync(ct);
            try
            {
                _gameInfo = gameInfo;
                lock (_iconLock) _iconMap[MachineId] = selfIcon;
                var protocols = QmlProtocols.BuildHostProtocols(() => _gameInfo, ExchangeIcons);
                _center = await _client.CreateRoomAsync(proc.PlayerName, MachineId, Vendor, newPort.Value, protocols, ct);
            }
            finally { _gate.Release(); }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "选实例开房失败");
            _startError = ex is ApiException api ? api.Message : "开房失败: " + ex.Message;
        }
        finally
        {
            _starting = false;
        }
    }
```
Notes:
- `instance.Id` — confirm `GameInstance` has an `Id` property (read `src-backend/Qomicex.Launcher.Backend/Models/GameInstance.cs`); the controller passed `instanceId` and the repo looked it up, so `instance.Id` should equal it. If `GameInstance` has no `Id`, capture the `instanceId` string into the closure instead.
- `Models.GameInstance` — use the correct namespace/type name as returned by `_instances.GetById(...)`. Match the existing usage in the file.
- This uses `_logger` (resolves the dead-`_logger` minor).

4. `LeaveAsync` must cancel a pending start and clear the starting flags. Update it to:
```csharp
    public async Task LeaveAsync(CancellationToken ct = default)
    {
        _startCts?.Cancel();
        await _gate.WaitAsync(ct);
        try
        {
            await _client.CloseAsync(ct);
            _center = null; _guest = null; _mcHost = null; _mcPort = null;
            _gameInfo = new GameInfoDto();
            _starting = false; _startError = null;
            lock (_iconLock) _iconMap.Clear();
        }
        finally { _gate.Release(); }
    }
```

5. `GetStatus` must report the starting state and surface `_startError`. Extend `ConnectorStatusDto` with a nullable error field and add a `starting` mode. Change the record to:
```csharp
public sealed record ConnectorStatusDto(
    string Mode, string? RoomCode, string? McHost, int? McPort,
    GameInfoDto? GameInfo, List<ConnectorPlayerDto> Players, string? Error);
```
Update all `new ConnectorStatusDto(...)` constructions to pass the error argument (null except where relevant). New `GetStatus`:
```csharp
    public ConnectorStatusDto GetStatus()
    {
        var center = _center;
        var guest = _guest;
        Dictionary<string, string> icons;
        lock (_iconLock) icons = new Dictionary<string, string>(_iconMap);
        if (center != null)
            return new ConnectorStatusDto("host", center.RoomCode.Raw, null, null, _gameInfo,
                MapPlayers(center.GetPlayers(), icons), null);
        if (guest != null)
            return new ConnectorStatusDto("guest", null, _mcHost, _mcPort, _gameInfo,
                MapPlayers(guest.GetPlayerListAsync().GetAwaiter().GetResult(), icons), null);
        if (_starting)
            return new ConnectorStatusDto("starting", null, null, null, null, new(), _startError);
        return new ConnectorStatusDto("idle", null, null, null, null, new(), _startError);
    }
```
(Keep returning `_startError` in the idle branch too, so a failed start surfaces the message once the user is back to idle. That's acceptable.)

6. `Dispose()` — also dispose `_startCts`:
```csharp
    public void Dispose() { _startCts?.Dispose(); _client.Dispose(); _gate.Dispose(); _localHttp.Dispose(); }
```

### Frontend changes (src/pages/Connect.tsx and src/types/index.ts)

1. `src/types/index.ts`: add `error` field to `ConnectorStatus` and widen `mode`:
```typescript
export interface ConnectorStatus {
  mode: 'idle' | 'starting' | 'host' | 'guest'
  roomCode: string | null
  mcHost: string | null
  mcPort: number | null
  gameInfo: ConnectorGameInfo | null
  players: ConnectorPlayer[]
  error: string | null
}
```

2. `src/pages/Connect.tsx`:
   - The initial `useState<ConnectorStatus>` default object must include `error: null` (and `mode: 'idle'`).
   - The polling effect currently starts polling only when `status.mode !== 'idle'`. Keep that — `'starting'` is `!== 'idle'` so polling covers it. Good.
   - Add a `starting` UI state. When `status.mode === 'starting'`, in the 创建房间 card show a spinner + text like `正在启动游戏，请在游戏内点击"对局域网开放"…` and a `取消` button that calls `handleLeave` (which calls `leave()` → backend cancels). Hide the two host-mode controls during `starting`.
   - When `status.error` is set and mode is `idle`, show the error text in the 创建房间 card (e.g. a small red `<p>`), so a failed/timed-out start is visible.
   - Ensure the "select instance" button handler (`handleHostInstance`) no longer blocks on a long request: `hostByInstance` now returns quickly (backend backgrounds the work). After calling it, `await refreshStatus()` so the UI flips to `starting`. Keep the try/catch/`busy` pattern.
   - Strict TS: no unused vars. If you add helpers, ensure they're used.

---

## Fix 3 (Minor cleanup): remove dead `enum ConnectorMode`

File: ConnectorService.cs line 13 — `public enum ConnectorMode { Idle, Host, Guest }` is never used (DTOs use string literals). Remove it.

---

## Steps
1. Apply Fix 1 (vendor), Fix 3 (remove enum) — small edits.
2. Apply Fix 2 backend (fields, HostByInstanceAsync split, RunHostByInstanceAsync, LeaveAsync, GetStatus, DTO error field, Dispose). Read `Models/GameInstance.cs` to confirm `Id`/`GameVersion`/`Loader`/`LoaderVersion`.
3. Build backend: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj` → 0 errors.
4. Apply Fix 2 frontend (types + Connect.tsx).
5. Build frontend: `npm run build` → passes.
6. Commit everything in ONE commit: `git add -A && git commit -m "fix: background instance-host flow with starting state, use InformationalVersion for vendor, remove dead enum"`
7. Append a fix section to `.superpowers/sdd/task-final-fix-report.md` describing exactly what changed and both build results.

## Report back (under 15 lines):
- Status: DONE | BLOCKED
- Commit (short SHA + subject)
- Backend build result, frontend build result (one line each)
- Any deviations from this brief and why
- Report file path
