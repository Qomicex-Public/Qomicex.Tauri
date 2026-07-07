# Final-Review Fix Report — Connect Center

## Fix 1 (Important): vendor uses InformationalVersion
- `ConnectorService.cs` `Vendor` getter now reads `AssemblyInformationalVersionAttribute.InformationalVersion`, falls back to `AssemblyName.Version` then `"0.0.0"`, and strips any `+git-hash` suffix via `.Split('+')[0]`.
- Added `using System.Reflection;`.
- Vendor format string unchanged: `$"Qomicex {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}"`.

## Fix 2 (Important): non-blocking instance-host flow with starting/error state
Backend (`ConnectorService.cs`):
- Added fields `_starting`, `_startError`, `_startCts`.
- `EnsureIdle()` now also rejects when `_starting`.
- `HostByInstanceAsync` validates + sets starting flags under the gate, then backgrounds `RunHostByInstanceAsync` via `Task.Run` (gate released immediately).
- New `RunHostByInstanceAsync(Models.GameInstance, CancellationToken)` runs launch + up-to-5-min LAN poll without holding the gate, re-acquires the gate only for the create-room step, records `_startError` on timeout/failure (uses `_logger`), clears `_starting` in finally.
- `LeaveAsync` cancels `_startCts` and clears `_starting`/`_startError`.
- `ConnectorStatusDto` gained a trailing `string? Error` field; all constructions updated. `GetStatus` returns a new `"starting"` mode and surfaces `_startError` (also in idle branch).
- `Dispose()` disposes `_startCts`.

Frontend:
- `src/types/index.ts`: `ConnectorStatus.mode` widened to include `'starting'`; added `error: string | null`.
- `src/pages/Connect.tsx`: default state includes `error: null`; added `isStarting`; 创建房间 card shows spinner + "正在启动游戏，请在游戏内点击\"对局域网开放\"…" and 取消 button (calls `handleLeave`) during starting, hides host controls; shows red error text when `status.error` is set in idle; 加入房间 card hidden during starting. Polling already covers `starting` (`!== 'idle'`).

## Fix 3 (Minor): removed dead `enum ConnectorMode`.

## Build results
- Backend: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj` — 0 errors (9 pre-existing warnings).
- Frontend: `npm run build` — passed (tsc strict + vite build succeeded).

## Deviations
None.
