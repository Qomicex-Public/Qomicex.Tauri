## Task 3 Report

### Scope

- Modified `src-backend/Qomicex.Launcher.Backend/Program.cs` only.
- Kept existing `ILogger` wiring, controllers, and middleware flow unchanged.

### What Changed

- Registered `TraceBufferStore` as a singleton with capacity `2000`.
- Registered `TraceDumpService` as a singleton.
- Resolved both services after `builder.Build()`.
- Added `ConsoleTraceListener` and `BufferedTraceListener` to `Trace.Listeners`.
- Enabled `Trace.AutoFlush = true`.
- Added process-level hooks for:
  - `AppDomain.CurrentDomain.UnhandledException`
  - `TaskScheduler.UnobservedTaskException`
- Emitted startup trace lines:
  - `startup-check`
  - `backend trace listeners registered`

### Failing Test Surrogate

Documented runtime expectation from the brief and verified against the running app:

```text
After startup, Trace.WriteLine("startup-check") appears in the terminal.
If TraceDumpService.Dump("manual") is resolved from DI and called,
the dump file contains startup-check.
```

### Pre-Change Absence Check

- Searched `Program.cs` for `ConsoleTraceListener|UnhandledException|UnobservedTaskException|Trace.Listeners|TraceDumpService`.
- Result: no matches before the edit.

### Verification Performed

1. Build:

```bash
dotnet build "K:\Deskep\Project\Rust\Qomicex.Tauri\.worktrees\backend-trace-buffer\src-backend\Qomicex.Launcher.Backend\Qomicex.Launcher.Backend.csproj" --configuration Debug
```

Result: success, with 5 pre-existing nullable warnings in `Controllers/AccountController.cs` and no errors.

2. Runtime startup verification:

```bash
dotnet run --project "K:\Deskep\Project\Rust\Qomicex.Tauri\.worktrees\backend-trace-buffer\src-backend\Qomicex.Launcher.Backend\Qomicex.Launcher.Backend.csproj"
```

Observed terminal output included:

```text
startup-check
backend trace listeners registered
```

3. Manual dump verification:

- Temporarily inserted `traceDumpService.Dump("manual");` immediately after the startup trace lines.
- Ran the backend once to generate a dump.
- Verified file creation under:
  `src-backend/Qomicex.Launcher.Backend/bin/Debug/net10.0/logs/`
- Verified dump content included:

```text
Reason: manual
...
startup-check
backend trace listeners registered
```

- Removed the temporary manual dump call afterward so final behavior remains unchanged.

### Commit

- Commit message: `feat: wire backend trace listeners`

### Self-Check

- Only `Program.cs` was changed for production code.
- Existing backend service registrations remained intact.
- Existing middleware and controller wiring remained intact.
- No persistent file logger was introduced.
- Crash-dump hooks are best-effort only and swallow their own dump failures, matching the brief's minimal hook pattern.
