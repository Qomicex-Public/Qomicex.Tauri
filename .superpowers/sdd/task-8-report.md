# Task 8 Report: ConnectorController + DI 注册 + 生命周期清理

## What I Implemented
1. **Created `Controllers/ConnectorController.cs`** — `[ApiController]`, `[Route("api/[controller]")]`, constructor-injected `ConnectorService`, NO try/catch (exceptions bubble to `ErrorHandlingMiddleware`). Endpoints:
   - `POST api/connector/host/port` → `HostByPortAsync(req.Port, ct)` → `{ roomCode }`
   - `POST api/connector/host/instance` → `HostByInstanceAsync(req.InstanceId, ct)` → `{ status = "hosting" }`
   - `POST api/connector/join` → `JoinAsync(req.Code, ct)` → `{ mcHost, mcPort }`
   - `GET api/connector/status` → `GetStatus()`
   - `POST api/connector/leave` → `LeaveAsync(ct)` → `{ status = "idle" }`
   - Request DTOs: `HostByPortRequest`, `HostByInstanceRequest`, `JoinRequest`.
2. **`Program.cs` DI registration** — added two `AddSingleton` calls (`GameProcessInspector`, `ConnectorService`) immediately after `AddSingleton<LanGameListenerService>()`.
3. **`Program.cs` lifecycle cleanup** — resolved `ConnectorService` and registered an `ApplicationStopping` hook calling `LeaveAsync().GetAwaiter().GetResult()` (swallowing exceptions), placed right after the existing `lanService.Stop()` registration.

All code copied verbatim from the brief. Verified `ConnectorService` public signatures match the brief (`HostByPortAsync`, `HostByInstanceAsync`, `JoinAsync`, `GetStatus`, `LeaveAsync`).

## Deviations
None.

## Build Result
`dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj` → **Build succeeded, 0 warnings, 0 errors.**

## Runtime Smoke Check
Performed. Started backend via `dotnet run --no-build` in a background job, polled `GET http://localhost:5000/api/connector/status`:
```
{"mode":"idle","roomCode":null,"mcHost":null,"mcPort":null,"gameInfo":null,"players":[]}
```
Matches expected `mode: idle`. Process stopped afterward; port 5000 confirmed free.

## Files Changed
- Created: `src-backend/Qomicex.Launcher.Backend/Controllers/ConnectorController.cs`
- Modified: `src-backend/Qomicex.Launcher.Backend/Program.cs`

## Self-Review
- Controller follows `RoomCodeController` conventions (attributes, DI, no try/catch, request DTO classes in same file). ✔
- Route resolves to `api/connector` via `[controller]` token with class name `ConnectorController`. ✔
- Both new services registered as singletons (ConnectorService holds session state). ✔
- Lifecycle hook mirrors existing `lanService` pattern and swallows shutdown exceptions to avoid blocking graceful stop. ✔
- No extraneous comments added. ✔
- Only the two intended files were staged/committed (other repo dirty files — sdd briefs/reports, package-lock, Cargo.toml — left untouched). ✔

## Concerns
- Git reported LF→CRLF normalization warning on the new controller file (cosmetic, repo autocrlf; no functional impact).
- `ConnectorService` is eagerly resolved at startup for the lifecycle hook, which forces its (and `GameProcessInspector`'s) construction at app boot — same pattern as `LanGameListenerService`, so consistent with existing code.
