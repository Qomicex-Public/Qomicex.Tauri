# Task 4 Report: GameProcessInspector

## What I implemented
Created `src-backend/Qomicex.Launcher.Backend/Services/Connector/GameProcessInspector.cs` per the brief:
- `sealed record GameProcessInfo(string PlayerName, string Uuid, bool IsMicrosoft, string? GameVersionArg)`
- `sealed class GameProcessInspector` with `ILogger<GameProcessInspector>` ctor and `GameProcessInfo Inspect(int port)`.
- Cross-platform port→PID: Windows P/Invoke `GetExtendedTcpTable` (iphlpapi.dll); Linux `/proc/net/tcp(6)` inode → `/proc/*/fd` scan via `FileInfo.LinkTarget`; macOS `lsof`.
- PID→cmdline: Windows WMI (`System.Management`); Linux `/proc/{pid}/cmdline`; macOS `ps`.
- Arg tokenizer + `GetArgValue` extracting `--username`/`--name`, `--uuid`, `--userType`, `--version`.
- Platform guards via `OperatingSystem.IsWindows()/IsLinux()/IsMacOS()`.
- Kept the `// ── ... ──` section markers exactly as in the brief; no other comments added.

## Deviations from brief
1. **Line 62 explicit cast** — brief code `int localPort = ((row.localPort & 0xFF) << 8) | ...` fails compilation with CS0266 (`uint`→`int`) because `row.localPort` is `uint` and the constant `0xFF` promotes the expression to `uint`. Fixed by wrapping in `(int)(...)`. The swap is a 16-bit byte-order swap so the cast is lossless/safe. This is the only change from the brief's literal code.

## ApiException verification
`Common/ApiError.cs` confirms `ApiException.BadRequest(string message, string code = "BAD_REQUEST")` — matches the brief's usage. No adjustment needed.

## Build result
`dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj` → exit code 0, Build succeeded (only pre-existing warnings unrelated to this file).

## Files changed
- Added: `src-backend/Qomicex.Launcher.Backend/Services/Connector/GameProcessInspector.cs`

## Self-review findings
- **P/Invoke struct layout**: `MIB_TCPROW_OWNER_PID` `[StructLayout(LayoutKind.Sequential)]` with 6 `uint` fields matches the Win32 definition; row-by-row read via `Marshal.SizeOf<T>()` and `IntPtr.Add(rowPtr, i*rowSize)` after skipping the 4-byte `dwNumEntries` count. Correct.
- **Byte-order port swap**: local port stored in network byte order in low 16 bits; `((x & 0xFF) << 8) | ((x >> 8) & 0xFF)` correctly swaps the two bytes. Now cast to int.
- **`LinkTarget` usage**: `new FileInfo(fd).LinkTarget` returns the symlink target (e.g. `socket:[12345]`); matched against `socket:[{inode}]`. Correct on .NET for Linux.
- **All platform branches compile**: Linux/macOS branches use standard BCL (`File`, `Directory`, `Process`); Windows-only code paths compile fine on Windows.

## Concerns
- Built on Windows only; Linux `/proc` and macOS `lsof`/`ps` branches compile but were not runtime-executed (expected — no test framework, per AGENTS.md). `FileInfo.LinkTarget` behavior on Linux `/proc/*/fd` is standard but unverified at runtime here.
- `Marshal.PtrToStructure<T>` on a value type is used unchecked; if the buffer were malformed it could throw, but it's wrapped in try/catch that logs and returns null.
