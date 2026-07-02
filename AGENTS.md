# Qomicex Launcher

## Path constraint

Source path contains `#` (`D:\C#\Project\qomicex-launcher`), which breaks Vite/Rollup. Working copy is `D:\qomicex-launcher`. **Run all npm commands from the working copy.**

## Architecture

Three-layer Minecraft desktop launcher:

| Layer | Stack | Directory | Port |
|-------|-------|-----------|------|
| Desktop shell | Tauri v2 (Rust) | `src-tauri/` | — |
| Frontend | React 19 + Vite 7 + TS + Tailwind | `src/` | 1420 |
| Backend API | ASP.NET Core (.NET 10) | `src-backend/Qomicex.Launcher.Backend/` | 5000 |

Vite proxies `/api/*` → `http://localhost:5000` (see `vite.config.ts`).

`src-backend/` contains 3 projects: `Qomicex.Launcher.Backend` (main API), `Qomicex.Core` (shared launcher logic), `Qomicex.Downloader` (download library). Backend references both Core and Downloader.

`Qomicex.Avalonia/` is a **separate repo** (own `.git`). Do not assume shared toolchain.

## Commands

```bash
# Backend
cd src-backend/Qomicex.Launcher.Backend && dotnet run

# Frontend dev
npm run dev          # vite on :1420

# Tauri desktop dev (replaces plain vite)
npm run tauri dev

# Build (runs tsc then vite build — type errors fail the build)
npm run build
```

No test framework exists in this repo.

## CI/CD (GitHub Actions)

`.github/workflows/release.yml` — **手动触发** (`workflow_dispatch`)，可选单个或多个目标：

| Job | Runner | 产物 | 打包 |
|-----|--------|------|------|
| `windows-x64` | windows-latest | `qomicex-launcher-windows-x64` | NSIS |
| `linux-x64` | ubuntu-latest | `qomicex-launcher-linux-x64` | AppImage |
| `macos-arm64` | macos-latest | `qomicex-launcher-macos-arm64` | DMG |
| `macos-x64` | macos-13 | `qomicex-launcher-macos-x64` | DMG |

构建成功后自动上传 artifact 并创建 GitHub Release。

**注意：** `Qomicex.Avalonia` 是私有子模块。CI 需要在 repo 设置中添加 `QOMICEX_PAT` secret（一个有子模块访问权限的 GitHub Personal Access Token）。

Tauri v2 → React → ASP.NET Core，后端通过 `include_bytes!` 嵌入 Rust exe，启动时解压到临时目录。持久化数据默认存储在 `Environment.SpecialFolder.LocalApplicationData/qomicex-launcher/`（Linux: `~/.local/share/qomicex-launcher/`，Windows: `%LOCALAPPDATA%/qomicex-launcher/`，macOS: `~/Library/Application Support/qomicex-launcher/`）。设置 `QOMICEX_HOME` 环境变量可覆盖为便携模式（由 Rust 在 spawn 前设置）。

## Import rules (critical)

All local imports **must** include the file extension — Vite path bug:
```ts
import { foo } from './bar.ts'             // correct
import { Baz } from './components/Baz.tsx' // correct
import { x } from './baz'                  // WRONG — Vite will error
```

## Frontend conventions

- Tailwind + shadcn/ui style (`class-variance-authority`, `radix-ui`). Use `cn()` from `src/lib/utils.ts`.
- Dark mode via CSS variables in `src/index.css`, Tailwind `darkMode: "class"`.
- Strict TS: `noUnusedLocals`, `noUnusedParameters`, `strict: true`. Fix all before committing.
- Router: `BrowserRouter` → `MessageBoxProvider` → `Layout.tsx` sidebar → 9 registered routes: `/`, `/instances`, `/instances/:id`, `/downloads`, `/accounts`, `/accounts/:uuid`, `/resource-center`, `/resource-center/:resourceId`, `/settings`.
- **Internal navigation must use `<Link>` not `<a>`** — plain `<a>` causes full page reload, which remounts `Layout.tsx`, resets random background selection, and loses other persistent state. External links (different origin) should use `<a target="_blank">`.
- UI components in `src/components/ui/`: badge, button, card, checkbox, combobox, dialog, input, label, message-box, select, separator, table, textarea, tooltip.
  - **Tooltip** (`tooltip.tsx`) — use instead of native `title` attribute. Always wrap icon-only buttons.
  - **Select** (`select.tsx`) — use `Select`/`SelectOption`/`SelectDivider` instead of native `<select>` or third‑party dropdowns.
  - Import via `'../components/ui/<name>.tsx'` (file extension required).
- `src/pages/LogAnalysis.tsx` exists but is **not registered** in the router.

## Backend conventions

- `Program.cs` registers: controllers, CORS (any origin), 4 named `HttpClient`s (Modrinth, CurseForge, FTB, default), `DownloadManager`, `InstanceInstallService`, `FtbService`, `ResourceDownloadService`, `JavaRuntimeStore`, `JavaDownloadService`, `SkinService`, `McmodService`, `AccountService`, `MsAccount`, `TraceBufferStore`/`TraceDumpService`.
- Controllers in `Controllers/` map to `api/<name>` routes. 16 controllers total (Account, Instance, InstanceFiles, Java, JavaDownload, Launcher, Loaders, LogAnalysis, Mcmod, ResourceDownload, Resources, RoomCode, Settings, Skin, SystemInfo, Versions).
- Embedded resources: `error-patterns.json`, `java_launch_wrapper-1.4.4.jar`.
- `appsettings.json` `CurseForge:ApiKey` is empty by default.

## Downloader / Install architecture

```
InstallTask  (Services/InstallTask.cs)
  ├── Own DownloadManager → creates DownloadTasks per stage
  ├── Core.DownloadFileAsync (single-file multi-threaded range download)
  ├── Stages: json → libraries → assets → mainjar → loader JAR → install loader → loader libs → addons
  ├── Events: OnStateChanged (stage, progress, currentFile, totals, speed)
  └── Controls: StartAsync, Pause, Resume, Cancel
```

- `InstanceInstallService` manages a `Dictionary<string, InstallTask>`.
- `InstallModLoader` rethrows — forge failures surface as `failed` state.
- Loader installers live in `Modules/Helpers/Installers/`.

## Error handling

**Backend** — all unhandled exceptions are caught by `Middleware/ErrorHandlingMiddleware.cs` and returned as:
```json
{ "code": "ERROR_CODE", "message": "...", "detail": "...", "traceId": "...", "timestamp": "...", "status": 500 }
```
- Do NOT add try/catch in controllers just to return errors — let exceptions bubble to the middleware.
- For expected business errors, throw `ApiException`: `throw ApiException.BadRequest("...")`, `throw ApiException.NotFound("...")`, etc. (`Common/ApiError.cs`)
- Exception → HTTP status mapping in `ErrorHandlingMiddleware.MapException`: `ApiException` → its own StatusCode, `ArgumentNullException` → 400, `FileNotFoundException` → 404, `HttpRequestException` → 502, `TaskCanceledException` → 499, `JsonException` → 400, default → 500. Add new mappings there, not in controllers.
- Errors are logged via `ILogger` (visible in `dotnet run` console output).

**Frontend** — `src/api/client.ts` exports `ApiError` class. All API errors throw `ApiError` with `.code`, `.status`, `.detail`, `.traceId`, `.displayMessage`.
```ts
import { ApiError } from '../api/client.ts'
try {
  await someApiCall()
} catch (e) {
  if (e instanceof ApiError) showToast(e.displayMessage)
}
```

## Cross-platform rules (C#, Rust, TS)

The launcher ships on **Windows, Linux, macOS**. Never assume Windows.

### Backend / Core (C#)

- **No hardcoded drive letters or path separators** — use `Path.Combine(...)` and `Environment.GetFolderPath(SpecialFolder.ProgramFiles)` (not `@"C:\..."`).
- **No hardcoded exe names** — `Process.Start("explorer.exe", ...)` → `Process.Start(new ProcessStartInfo(path) { UseShellExecute = true })`.
- **Platform guards** — use `OperatingSystem.IsWindows()` / `IsLinux()` / `IsMacOS()` over deprecated `PlatformID.Win32NT`.
- **UNC/Windows-only path logic** (e.g. `StartsWith("\\\\")`) must be wrapped in `OperatingSystem.IsWindows()`.
- **Shell default** — `/bin/bash` is not guaranteed; fallback to `/bin/sh`.
- **Native library embedding** — `dotnet publish` must include `-p:IncludeNativeLibrariesForSelfExtract=true` (SkiaSharp etc.).
- **Data directory** — never write to `AppContext.BaseDirectory`; use `LocalApplicationData` + app name, with `QOMICEX_HOME` env var override for portable mode.

### Qomicex.Core (submodule, cross-target)

- **Path.Combine over string interpolation** — `$"{dir}/versions/{v}.json"` → `Path.Combine(dir, "versions", v, $"{v}.json")`.
- **`obj["natives"]` access** — always check `ContainsKey(osName)` before indexing; the `natives` dict may not contain the current OS.
- **Architecture detection** — check for `"aarch64"` / `"ARM64"` before falling through to `"x86"`.
- **OS-specific search paths** — SDKMAN/JENV/JABBA/ASDF are Linux/macOS-only tools; keep out of `HighPriorityPaths` (Windows).
- **OS detection** — `RuntimeInformation.OSDescription` may not contain `"Linux"` on some distros (e.g. AnduinOS → `"AnduinOS 2.0.0"`). Use `OperatingSystem.IsLinux()` / `IsWindows()` / `IsMacOS()` (available in .NET 5+) before falling back to string matching. `SystemInfoHelper.GetSystemInfo()` now uses this approach.
- **Natives extraction** — `GetNativesInfo` relies on `SystemInfoHelper.OsName` to pick the right classifier key (`"natives-linux"` etc.). If `OsName` is wrong, all natives are silently skipped.

### Frontend (TS)

- **No `\\` path separators** — replace all `path + '\\sub'` with `path + '/sub'`.
- **Normalize paths from backend** — always `.replace(/\\/g, '/')` before passing to dialogs or constructing URLs.
- **File picker filters** — use `['exe']` on Windows, `['*']` on other platforms (Java binary, etc.):
  ```ts
  filters: navigator.platform?.includes('Win')
    ? [{ name: 'Java', extensions: ['exe'] }]
    : [{ name: 'Java', extensions: ['*'] }]
  ```
- **`file://` URI** — strip leading `/` on Unix: `'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '')`.

### Rust (Tauri)

- **`cfg(not(windows))` → `cfg(unix)`** — `not(windows)` is broader than intended.
- **Always `set_permissions` (0o755) on Unix** after writing a binary — `std::fs::write` does not preserve `+x`.
- **No hardcoded extension** — use `#[cfg(windows)]` / `#[cfg(unix)]` for binary file names.

## Version isolation directory resolution

`VersionDirName` is stored at install time in `InstanceController.StartInstall` using the formula `{GameVersion}-{Loader}-{LoaderVersion}` (or just `GameVersion` for vanilla). All path resolvers read the stored value directly — never reconstruct via formula.

**Migration for existing instances** (no `VersionDirName`): scan `versions/` for directories containing `{dir}/{dir}.json`. Exclude the vanilla `{GameVersion}` directory (`string.Equals(name, inst.GameVersion, OrdinalIgnoreCase)`), then:

- 1 candidate → use it as `VersionDirName` (also persists in `GetById`)
- >1 candidates → match by formula `{GameVersion}-{Loader}-{LoaderVersion}` against remaining candidates
- 0 or no match → fallback to base `gameDir`

Three places implement this logic (keep in sync):
- `InstanceFilesController.cs:ResolveGameDir` — read-only resolution
- `InstanceController.cs:GetById` — migration + persist
- `ResourceDownloadController.cs:StartDownload` — read-only resolution

`InstallTask._versionId` uses the same `{GameVersion}-{Loader}-{LoaderVersion}` formula. The vanilla `{GameVersion}/{GameVersion}.json` is always created at `InstallTask.StartAsync()` line 116–118, which is why migration must exclude it.

## Known issues / next steps

- Frontend does not yet handle the `failed` install stage gracefully.
- `Core.DownloadFileAsync` uses a static `HttpClient`.
- Forge/Fabric/Quilt install paths need end-to-end testing.

## Debugging workflow

When debugging any backend-endpoint or filter functionality, run the test script before and after changes:

```bash
# Start backend if not already running
cd src-backend/Qomicex.Launcher.Backend && nohup dotnet run > /tmp/backend.log 2>&1 &
# Wait for it (check with curl localhost:5000/api/diagnostics/health)
bash scripts/test-api-filters.sh
```

The test script (`scripts/test-api-filters.sh`) covers CurseForge local loader filtering, streaming version fetch, and Modrinth empty-loader inclusion. Add new test cases there as functionality grows.

## Testing API filters

`scripts/test-api-filters.sh` — tests the CurseForge/Modrinth version filter fixes interactively. Requires `curl` and `jq`:

```bash
# Start backend first
cd src-backend/Qomicex.Launcher.Backend && dotnet run &
sleep 5
bash scripts/test-api-filters.sh

# Override base URL for non-localhost
BASE=http://10.0.0.5:5000/api/resources bash scripts/test-api-filters.sh
```

Tests local loader filtering on CurseForge (older mods without `modLoaderType` field), the streaming version fetch (`start-fetch` → `fetch-progress` → `fetch-result`), Modrinth empty `Loaders: []` inclusion in version and dependency resolution.
