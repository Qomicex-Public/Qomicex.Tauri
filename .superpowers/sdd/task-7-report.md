# Task 7 Report: ConnectorService — HostByInstance

## What I implemented
Added to `Services/Connector/ConnectorService.cs`:
- New field `private readonly HttpClient _localHttp = new() { BaseAddress = new Uri("http://localhost:5000") };` in the field region (after `_client`).
- New method `HostByInstanceAsync(string instanceId, CancellationToken ct = default)` inserted before `JoinAsync`. It launches the instance via `POST /api/instance/{id}/launch` on the local backend, snapshots known LAN ports, polls `LanGameListenerService.GetGames()` every 2s (5-min deadline) for a NEW port ordered by `LastSeen`, inspects that port, builds `GameInfoDto` from the instance's `GameVersion`/`Loader`/`LoaderVersion`, sets the self icon, and creates the room.
- `Dispose()` now also disposes `_localHttp`.

## _iconLock adjustment
The brief's code had a bare `_iconMap[MachineId] = selfIcon;`. Per the Task 6 invariant (all `_iconMap` writes guarded by `lock (_iconLock)`), I changed it to:
```csharp
lock (_iconLock) _iconMap[MachineId] = selfIcon;
```

## Other deviations
None. All brief code used verbatim except the icon-lock adjustment.

## Signature verification
- `ApiException.NotFound(string)` / `BadRequest(string)` — exist (`Common/ApiError.cs:65,69`).
- `IInstanceRepository.GetById(string)` → `GameInstance?` (`Services/IInstanceRepository.cs:8`).
- `GameInstance.GameVersion` (string), `.Loader` (string?), `.LoaderVersion` (string?) (`Models/GameInstance.cs:7-9`).
- `LanGameEntry.Port` (int), `.LastSeen` (DateTime) (`Services/LanGameListenerService.cs:11,18`); `GetGames()` → `List<LanGameEntry>`.
- `GameProcessInfo(string PlayerName, string Uuid, bool IsMicrosoft, string? GameVersionArg)` (`Services/Connector/GameProcessInspector.cs:7`).
- `GameInfoDto` has GameVersion/Loader/LoaderVersion (`QmlProtocols.cs:6-11`).
- `HttpClient`/`Uri` available via `ImplicitUsings=enable`.

## Build result
`dotnet build ...Qomicex.Launcher.Backend.csproj`: **Build succeeded, 0 errors, 9 warnings** — none originate from ConnectorService (verified by filtering warnings; all 9 are pre-existing).

## Files changed
- `src-backend/Qomicex.Launcher.Backend/Services/Connector/ConnectorService.cs` (+48 / -1)

## Self-review findings
- Gate released in `finally { _gate.Release(); }` ✓
- `_iconMap` write wrapped in `lock (_iconLock)` ✓
- `_localHttp` disposed in `Dispose()` ✓
- `EnsureIdle()` called inside the gate; not-found → `ApiException.NotFound`; LAN timeout → `ApiException.BadRequest` ✓
- No code comments added ✓

## Concerns
- `_localHttp` hardcodes `http://localhost:5000`, matching the brief and the AGENTS.md backend port. Fine for the in-process launch call.
