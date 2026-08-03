# Qomicex Launcher

## Stack & Ports

| Layer | Tech | Dir | Port |
|-------|------|-----|------|
| Desktop shell | Tauri v2 (Rust) | `src-tauri/` | — |
| Frontend | React 19 + Vite 7 + TS + Tailwind | `src/` | 1420 |
| Backend API | ASP.NET Core 10 (NativeAOT) | `src-backend/Qomicex.Launcher.Backend.Neo/` | 5000 |

Vite proxies `/api/*` → `http://localhost:5000` (`vite.config.ts`).

`src-backend/` has 4 projects: `Qomicex.Launcher.Backend.Neo` (main API, NativeAOT), `Qomicex.Core.AOT/` (submodule), `Qomicex.Downloader` (download lib), `Qomicex.Connector.Part.Scaffolding/` (submodule).

Backend references Core (via `Qomicex.Core.AOT/`) and `Qomicex.Connector`.

Submodules (recursive checkout): `src-backend/Qomicex.Core.AOT/`, `src-backend/Qomicex.Connector.Part.Scaffolding/`.

Legacy code (pre-Neo) is preserved on the `legacy` branch.

## Commands

```bash
# Backend dev
cd src-backend/Qomicex.Launcher.Backend.Neo && dotnet run

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

## Conventional Commits

All commits must follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Types: `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style`, `test`.
- `BREAKING CHANGE:` in footer or `!` after type/scope for breaking changes.
- Scope: component/area (e.g. `ui`, `backend`, `release.yml`).
- Description: imperative, lowercase, no period.

## CI/CD

`.github/workflows/release.yml` — `workflow_dispatch` (填版本各部分，自动构造标准版本号) 或 `release: [published]` (从 tag 解析版本)。版本格式: `v<major>.<minor>.<patch>-<type><序数>.<补丁/构建>`，其中 release/beta 用人工输入的序数，alpha 自动取当天日期+当日构建序号。

构建时可选择: 平台、打包格式、架构、是否启用许可证验证 (`-p:LicenseRequired=true`)，是否标记 GitHub Pre-release。

requires `QOMICEX_PAT` secret for submodule checkout. Builds publish backend per-RID, embed it into `src-tauri/binaries/`, then build Tauri bundle.

CI 使用 **pnpm**（非 npm）：`pnpm install --frozen-lockfile` 后必须 `pnpm --filter @qomicex/plugin-ui build`（workspace 包需先构建 `dist/`）。`actions/setup-node` 配 `cache: pnpm`，之前需 `pnpm/action-setup@v4`。

Mac 的 Create DMG 步骤必须给 `hdiutil create` 传显式 `-size`（按 `du -sm "$STAGING"` ×1.3 + 64MiB 计算）：`-srcfolder` 自动估算会偏小，嵌入 NativeAOT 后端后镜像内复制到一半报 `No space left on device`（宿主盘其实有空间）。UDZO 压缩会回收多余空间，不影响最终 DMG 大小。

`release-cnb` job 用官方 **CNB CLI**：`npm install -g @cnbcool/cnb-cli`（命令 `cnb`）。**不存在 `git-cnb`**（GitHub 无此仓库）。创建 release：`cnb releases post-release --repo <org>/<repo> --tag-name ... --name ... [--prerelease] --body-file ...`（`--verbose` 输出完整 JSON，用 jq 取 `.data.id`）；资产上传是两段式：`cnb releases post-release-asset-upload-url`（取 `.data.upload_url`/`.data.verify_url`）→ `curl -X PUT --upload-file` → `cnb releases post-release-asset-upload-confirmation`（token/path 从 verify_url 最后两段提取）。CNB 需要 `repo-release:rw` 权限。

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

- **20 endpoint modules** in `Endpoints/` → `api/<name>` routes. Includes `DiagnosticsController` (`/api/diagnostics/health`, `/api/diagnostics/trace`, `/api/diagnostics/dump`).
- `Program.cs` registers: CORS (any origin), 5 named `HttpClient`s (Modrinth, CurseForge, FTB, AuthlibInjector, default), `DownloadManager`, `InstanceInstallService`, `LaunchService`, `FtbService`, `ModpackService`, `ResourceDownloadService`, `JavaRuntimeStore`, `JavaDownloadService`, `SkinService`, `McmodService`, `AccountService`, `MsAccount`, `TraceBufferStore`/`TraceDumpService`, `LanGameListenerService`, `ConnectorService`/`GameProcessInspector`/`EasyTierProvider`.
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
- Qomicex.Core.AOT: check `ContainsKey(osName)` before accessing `obj["natives"]`. Detect `aarch64`/`ARM64` before falling to `x86`.

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

## Plugin system

- **Manifest**: `src/plugins/types.ts` / `src-backend/.../Models/PluginManifest.cs` — `PluginManifest`, `PluginContributes`, `PluginMenuItem`.
- **Activation**: `activatePlugin()` in `src/plugins/plugin-loader.tsx:9` — calls `renderInline()`, registers sidebar slots, loads theme CSS.
- **Inline rendering**: `sandbox.ts:113` `renderInline()` — fetches `dist/index.html`, strips `<html>/<head>/<body>`, sets `container.innerHTML` with bridge script appended.
- **Plugin page**: `src/pages/PluginPage.tsx` — mounts at `/plugins/p/:pluginId`. Switches plugins by clearing `containerRef.innerHTML` before appending new container. Scripts activate once (`data-scripts-activated` flag).
- **Overlay system**: `PluginOverlayManager.tsx` — overlays are iframes with `sandbox="allow-scripts"`. Created via `createPluginBridge().createOverlay()`. Global `window.__pluginOverlayStore` exposes store methods.
- **Sidebar action**: `menuItems[].action: "overlay"` + `contributes.overlay.file` → sidebar button calls `createOverlay` directly, no page navigation (`plugin-loader.tsx:76` `OverlaySidebarButton`).
- **Plugin packages**: `.qplugin` = `.zip` with `manifest.json` at root. Upload via `POST /api/plugins/upload`. States persisted to `{BaseDir}/plugin-states.json`.
- **Dev plugins**: placed in `plugins-dev/` directory during development.
- **Plugin build (Vite + React)**: Plugins using Vite/React/Tailwind scaffold follow example-toolkit pattern: `package.json` with `@qomicex/plugin-ui` + `@qomicex/plugin-ui/tailwind-preset`, `tsc && vite build` for build, `bash scripts/build.sh` for `.qplugin` packaging. Multi-page builds supported via `rollupOptions.input`.
- **Plugin API bridge**: `window.__PLUGIN_API__` (inline) / `parent.postMessage` (iframe) — methods: `getSettings`, `setSettings`, `callBackend`, `navigate`, `showToast`, `proxyFetchStream`, `registerMethod`, `callPlugin`, `readFile`, `writeFile`, `execCommand`, `overlay.*`, `download.*`（`download.addTask|progress|cancel|list`，权限 `download:manage`，复用 `DownloadSessionManager` 使任务进入下载中心；`download.registerInstall`，权限 `instance:write`，仅在前端下载中心登记安装任务）、`modpack.install`（权限 `instance:write`，一键安装整合包，走 `POST /api/modpack/install-direct`，复用 `ModpackService`+`InstallTracker` 与前端整合包页同管线）。`proxyFetch` 走 `POST /api/plugins/proxy`（`stream: true` 时后端转发 SSE 流式响应，前端经 `proxyFetchStream(req, { onChunk, onError })` 消费）。文件读写走授权制（`/api/plugins/files/{id}/read|write|delete|authorize`，未授权返回 403 `FS_AUTHORIZATION_REQUIRED`，前端 `window.confirm` 弹窗授权后重试；`deleteFile` 权限 `filesystem:write`）；shell 执行走 `/api/plugins/shell/{id}`（win: powershell，linux/mac: /bin/sh，超时默认 15s 范围 1-120s）。
- **Plugin dependencies**: manifest `dependencies: [{id, version?, optional?}]`，安装时检查必装前置（缺失拒装 `PLUGIN_MISSING_DEPENDENCY`），激活时检查前置已启用（缺失则禁用）。`registerMethod`/`callPlugin` 提供插件间方法调用，主窗口 `__pluginRegistry` 统一中转（`src/plugins/plugin-registry.ts`），激活顺序由 `sortByDependencies` 拓扑排序保证。
- **Layers 渲染**: manifest `layers` 含 `l2` → iframe 沙箱（`createSandbox`，srcdoc + postMessage 桥，脚本自动执行）；不含 `l2` → 内联渲染（需进入 `/plugins/p/:id` 页面脚本才执行）。纯 `["l3"]` 的 installed 插件不自动激活。
- **L3 WASM 网关**: `src-tauri/src/plugin_gateway/`（wasmtime 核心模块）—— `loader.rs` 扫描 `plugins/{id}/plugin.wasm`（需 manifest layers 含 l3），注入 host 函数（`qomicex` 模块：`log`/`http_fetch`/`instance_list`/`db_set`/`db_get`/`get_plugin_id`），插件导出 `on_load`/`on_unload`/`get_manifest`。`server.rs` 提供 `GET /plugins`、`GET /plugins/{id}/info`、`POST /plugins/{id}/invoke`、`GET /health`，端口写入 `plugins/.gateway_port`。路径与后端一致（`config::base_dir`，QOMICEX_HOME 优先）。后端经 `PluginGatewayClient` 代理暴露 `/api/plugins/wasm`、`/api/plugins/wasm/{id}`、`/api/plugins/wasm/{id}/invoke`，前端 API `callWasm`/`listWasmPlugins`（权限 `wasm:execute`）。

## Tauri details

- Backend binary is embedded via `include_bytes!` in release builds (`lib.rs:7-9`), extracted to temp dir on startup. In dev, backend runs separately.
- Linux: window decorations enabled by default (`lib.rs:86-88`).
- Capability permissions: `core:default`, window controls, `opener:default`, `opener:allow-open-path`, `opener:allow-reveal-item-in-dir`, `dialog:default`, `updater:default`.
- Backend child process state managed via `BackendChild` Tauri state, cleaned up on exit.
