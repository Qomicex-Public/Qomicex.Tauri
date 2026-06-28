# Backend trace buffer fix report

## Scope

Fixed only the three requested production-code findings in backend trace buffering and crash dump handling.

## Changes

### 1. BufferedTraceListener line buffering

- `Write()` now appends text into a pending in-memory line instead of pushing a completed entry immediately.
- `WriteLine()` now appends its message to the pending text, emits exactly one formatted record to `TraceBufferStore`, and clears the pending line.
- `WriteLine(null)` and `WriteLine("")` now still finalize any pending text as a completed record.
- Thread safety is preserved with a private lock around the pending line state.
- Scope was kept minimal: no listener fan-out or broader logging redesign.

### 2. TraceDumpService dump file naming

- Dump filenames now use `yyyyMMdd-HHmmss-fff` plus a GUID suffix.
- This avoids same-second overwrite and still keeps plain-text `.log` output and the original dump behavior boundary.

### 3. Program.cs crash hook flush

- Added best-effort `Trace.Flush()` immediately before `TraceDumpService.Dump(...)` in both crash hooks:
  - `AppDomain.CurrentDomain.UnhandledException`
  - `TaskScheduler.UnobservedTaskException`
- Exception swallowing behavior remains unchanged.

## Verification

### 1. Build

Command:

```powershell
dotnet build "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj"
```

Result:

- Build succeeded
- 0 errors
- 5 pre-existing nullable warnings in `Controllers/AccountController.cs` unrelated to this fix

### 2. Minimal runtime verification

Command:

```powershell
dotnet run --project "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj"
```

Observed output before timeout:

- `startup-check`
- `backend trace listeners registered`
- backend started and listened on `http://localhost:5000`

This confirms the modified listener registration path and startup trace writes compile and execute successfully in-process.

### 3. Static behavior verification

- `BufferedTraceListener.WriteLine()` now always routes completed records through `TraceBufferStore.Add(...)` only after merging pending content and the current line payload.
- Because `TraceBufferStore` already serializes its queue operations internally, and pending-line mutation is protected by a listener-local lock, the new buffering logic remains thread-safe without widening scope.
