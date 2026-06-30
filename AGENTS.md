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

Tauri v2 → React → ASP.NET Core，后端通过 `include_bytes!` 嵌入 Rust exe，启动时解压到 `%TEMP%`。`QOMICEX_HOME` 环境变量指向启动器 exe 所在目录（由 Rust 在 spawn 前设置），后端据此存取持久化数据。

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

## Known issues / next steps

- Frontend does not yet handle the `failed` install stage gracefully.
- `Core.DownloadFileAsync` uses a static `HttpClient`.
- Forge/Fabric/Quilt install paths need end-to-end testing.
