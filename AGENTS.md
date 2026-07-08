# Qomicex Launcher

## Stack & Ports

| Layer | Tech | Dir | Port |
|-------|------|-----|------|
| Desktop shell | Tauri v2 (Rust) | `src-tauri/` | — |
| Frontend | React 19 + Vite 7 + TS + Tailwind | `src/` | 1420 |
| Backend API | ASP.NET Core 10 | `src-backend/Qomicex.Launcher.Backend/` | 5000 |

Vite proxies `/api/*` → `http://localhost:5000` (`vite.config.ts`).

`src-backend/` has 5 projects: `Qomicex.Launcher.Backend` (main API), `Qomicex.Downloader` (download lib), `Qomicex.Connector.Part.Scaffolding/` (submodule), `Qomicex.Launcher/` (Windows standalone launcher), plus `Directory.Build.props`. Core lives in `Qomicex.Avalonia/` submodule at `Qomicex.Avalonia/Qomicex.Core/`.

Backend references Core (via `Qomicex.Avalonia/Qomicex.Core/`) and `Qomicex.Connector`.

Submodules (recursive checkout): `Qomicex.Avalonia/`, `src-backend/Qomicex.Connector.Part.Scaffolding/`.

`Qomicex.Avalonia/` is a **separate repo** (own `.git`). Do not assume shared toolchain.

## Commands

```bash
# Backend dev
cd src-backend/Qomicex.Launcher.Backend && dotnet run

# Frontend dev (plain Vite)
npm run dev          # on :1420

# Tauri desktop dev (replaces plain vite)
npm run tauri dev

# Build (tsc then vite build — type errors fail the build)
npm run build

# Local Windows release build
pwsh ./build-release.ps1
```

No test framework. Backend API test script: `bash scripts/test-api-filters.sh`.

## CI/CD

`.github/workflows/release.yml` — manual trigger (`workflow_dispatch`). Select platform (`windows`/`linux`/`macos`/`all`), bundles, and macOS arch.

Requires `QOMICEX_PAT` secret for submodule checkout. Builds publish backend per-RID, embed it into `src-tauri/binaries/`, then build Tauri bundle.

## Import rules (critical)

All local TS/TSX imports **must include file extensions** — Vite path bug:
```ts
import { foo } from './bar.ts'             // correct
import { x } from './baz'                  // WRONG — Vite will error
```

## Frontend conventions

- `cn()` from `src/lib/utils.ts` for Tailwind class merging.
- Dark mode via CSS variables in `src/index.css`, Tailwind `darkMode: "class"`.
- Strict TS: `noUnusedLocals`, `noUnusedParameters`, `strict: true`.
- Router: `BrowserRouter` → `MessageBoxProvider` → `Layout.tsx` → 11 routes: `/`, `/instances`, `/instances/:id`, `/downloads`, `/accounts`, `/accounts/:uuid`, `/resource-center`, `/resource-center/:resourceId`, `/connect`, `/settings`, `/running`. `LaunchProgressDialog` rendered outside routes.
- **Internal nav: `<Link>` not `<a>`** — plain `<a>` reloads the page, resetting persistent state. External links use `<a target="_blank">`.
- UI components: `src/components/ui/{badge,button,card,checkbox,combobox,dialog,input,label,message-box,select,separator,table,textarea,tooltip}.tsx`. Import via `'../components/ui/<name>.tsx'` (extension required).
- **Tooltip**: use instead of native `title`. Always wrap icon-only buttons.
- **Select**: use `Select`/`SelectOption`/`SelectDivider` instead of native `<select>`.
- `LogAnalysis.tsx` exists but is **not registered** in the router.

## Backend conventions

- **20 controllers** in `Controllers/` → `api/<name>` routes. Includes `DiagnosticsController` (`/api/diagnostics/health`, `/api/diagnostics/trace`, `/api/diagnostics/dump`).
- `Program.cs` registers: controllers, CORS (any origin), 5 named `HttpClient`s (Modrinth, CurseForge, FTB, AuthlibInjector, default), `DownloadManager`, `InstanceInstallService`, `LaunchService`, `FtbService`, `ModpackService`, `ResourceDownloadService`, `JavaRuntimeStore`, `JavaDownloadService`, `SkinService`, `McmodService`, `AccountService`, `MsAccount`, `TraceBufferStore`/`TraceDumpService`, `LanGameListenerService`, `ConnectorService`/`GameProcessInspector`/`EasyTierProvider`.
- Embedded resources: `Alex.png`, `mcmod_data.json` (in `.csproj`).
- `appsettings.json` includes a `CurseForge:ApiKey` (set in repo).
- OpenAPI endpoint available in dev mode (`/openapi/v1.json`).

## Error handling

**Backend**: unhandled exceptions → `Middleware/ErrorHandlingMiddleware.cs` → returns:
```json
{ "code": "ERROR_CODE", "message": "...", "detail": "...", "traceId": "...", "timestamp": "...", "status": 500 }
```
- Do NOT add try/catch in controllers. Let exceptions bubble.
- For expected errors, throw `ApiException`: `ApiException.BadRequest(...)`, `ApiException.NotFound(...)`, etc. (`Common/ApiError.cs`).
- Exception→HTTP mapping in `ErrorHandlingMiddleware.MapException`: `ApiException`→its code, `ArgumentNullException`→400, `FileNotFoundException`→404, `HttpRequestException`→502, `TaskCanceledException`→499, `JsonException`→400, default→500.

**Frontend**: `src/api/client.ts` exports `ApiError` with `.code`, `.status`, `.detail`, `.traceId`, `.displayMessage`.
```ts
import { ApiError } from '../api/client.ts'
try { ... } catch (e) { if (e instanceof ApiError) showToast(e.displayMessage) }
```

## Cross-platform rules

The launcher ships on **Windows, Linux, macOS**. Never assume Windows.

### C# (Backend / Core)
- Use `Path.Combine(...)`, never hardcoded drive letters or `\\` separators.
- Use `Process.Start(new ProcessStartInfo(path) { UseShellExecute = true })`, not `explorer.exe`.
- Platform guards: `OperatingSystem.IsWindows()` / `IsLinux()` / `IsMacOS()` (not `PlatformID.Win32NT`).
- `RuntimeInformation.OSDescription` may not contain `"Linux"` on some distros — prefer `OperatingSystem.IsLinux()`.
- Shell: `/bin/sh` fallback (not `/bin/bash`).
- `dotnet publish` needs `-p:IncludeNativeLibrariesForSelfExtract=true` (SkiaSharp).
- Data dir: `LocalApplicationData` + app name, with `QOMICEX_HOME` env override for portable mode. Never write to `AppContext.BaseDirectory`.
- Qomicex.Core: check `ContainsKey(osName)` before accessing `obj["natives"]`. Detect `aarch64`/`ARM64` before falling to `x86`.

### Frontend (TS)
- Normalize backend paths: `.replace(/\\/g, '/')`.
- File picker filters: `['exe']` on Windows, `['*']` elsewhere.
- `file://` URI on Unix: `'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '')`.

### Rust (Tauri)
- `cfg(unix)` not `cfg(not(windows))`.
- Set `0o755` permissions after `std::fs::write` for binaries.
- Use `#[cfg(windows)]` / `#[cfg(unix)]` for binary file names.

## Path system & version isolation (critical)

**GameDir** = `.minecraft` root. **VersionDir** = `GameDir/versions/{VersionDirName}/` (JSON, jar, libraries).

- `VersionDirName` = `{GameVersion}-{Loader}-{LoaderVersion}` (e.g. `1.20.1-Forge-47.1.0`) — used only for VersionDir.
- `GameVersion` = pure version (e.g. `1.20.1`).
- `inst.Name` = folder name, synced to `VersionDirName` on install. Use `inst.Name` for **all** version-isolated path construction.

Version-isolated dirs (`mods`, `saves`, `resourcepacks`, `shaderpacks`, `screenshots`, `datapacks`, `crash-reports`, `servers.dat`) go under `GameDir/versions/{inst.Name}/` when isolation is enabled. Shared dirs (`versions`, `assets`, `libraries`, `logs`, `temp`) stay at GameDir root.

**Always resolve `inst.GameDir` (not VersionDir) as the base** for path construction. Core library constructors (`Mods`, `Saves`, etc.) take `(gameDirectory, version, versionSegmented, apiKey)` — `gameDirectory` must be the GameDir root, `version` must be `inst.Name`.

## Tauri details

- Backend binary is embedded via `include_bytes!` in release builds (`lib.rs:7-9`), extracted to temp dir on startup. In dev, backend runs separately.
- Linux: window decorations enabled by default (`lib.rs:86-88`).
- Capability permissions: `core:default`, window controls, `opener:default`, `opener:allow-open-path`, `opener:allow-reveal-item-in-dir`, `dialog:default`, `updater:default`.
- Backend child process state managed via `BackendChild` Tauri state, cleaned up on exit.
