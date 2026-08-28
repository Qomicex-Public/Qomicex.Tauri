# Qomicex Launcher

## Stack & Ports

| Layer | Tech | Dir | Port |
|-------|------|-----|------|
| Desktop shell | Tauri v2 (Rust) | `src-tauri/` | — |
| Frontend | React 19 + Vite 7 + TS + Tailwind | `src/` | 1420 |
| Backend API | Rust (axum + tokio) | `src-backend/qomicex-backend/` | 5000 |
| UI component lib | workspace package `@qomicex/plugin-ui` | `packages/plugin-ui/` | — |

Vite proxies `/api/*` → `http://localhost:5000` and `/announcements-proxy` → `https://api.qomicex.top` (`vite.config.ts`). The frontend client also calls `http://localhost:5000/api` directly (`src/api/client.ts` `API_BASE`), so the proxy is a fallback, not the primary path.

Backend binds `127.0.0.1:5000` by default; `QOMICEX_PORT` env overrides the port (`main.rs`).

`src-backend/` has 1 tracked project: `qomicex-backend` (Rust backend, rewrite of the removed C# `Qomicex.Launcher.Backend.Neo`). The `Qomicex.Launcher.Backend.Neo/` directory still exists locally but is **gitignored leftover runtime data** (no source; contains an NTFS-reserved-named artifact that can't be removed via Win32) — do not treat it as code.

External Rust crates are git submodules at the repo root: `qomicex-core-rust/` (core lib), `qomicex-downloader-rust/` (downloader) and `qomicex-connector-rust/` (联机/SCF 协议, 依赖 EasyTier4QML fork).

`qomicex-tauri-i18n/` 也是 repo root 的 submodule：前端 i18n 多语言资源仓库（`src/zh-CN/` + `src/en/` TS 模块 + 类型）。启动器 `src/i18n/` 仅保留 Provider/错误映射/类型 re-export，全部语言资源经 `../../qomicex-tauri-i18n/src/index.ts` 导入。**编辑翻译必须改 submodule 内文件**（并在 i18n 仓库单独提交推送），不要在 `src/i18n/` 下建 zh-CN/en 目录。改完 submodule 需 `git submodule update --remote` 拉取最新。

Submodules (recursive checkout): `qomicex-core-rust/`, `qomicex-downloader-rust/`, `qomicex-connector-rust/`, `qomicex-tauri-i18n/`.

Legacy code (pre-Neo / pre-Rust) is preserved on the `legacy` branch.

## Package manager (critical)

The repo is **pnpm-managed**: `pnpm-lock.yaml` + `@qomicex/plugin-ui: "workspace:*"`. `package-lock.json` is stale and npm does **not** support `workspace:*`. On a fresh checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter @qomicex/plugin-ui build   # dist/ is gitignored; frontend imports resolve to it
```

`@qomicex/plugin-ui` resolves to `packages/plugin-ui/dist/index.js` (`main`/`types` in its package.json). After editing any file in `packages/plugin-ui/src/`, rebuild the package or the launcher will keep using the stale `dist/`. `tailwind.config.js` scans both `packages/plugin-ui/src` and `packages/plugin-ui/dist`.

## 联机（connector）构建注意事项

- 仓库根 `.cargo/config.toml` 提供 `PROTOC` / `VC_LTL` / `YY_THUNKS` 环境变量与 `net.git-fetch-with-cli = true`（easytier 构建必需；路径为本机特定，当前指向 `C:/Users/tmoam/...` WinGet profile，换机器需调整）。
- easytier build.rs 以相对路径 `easytier/third_party/x86_64/` 搜索 `Packet.lib`（按 rustc CWD 解析）→ 已复制到 `src-backend/qomicex-backend/easytier/third_party/x86_64/`，删除会导致 `LNK1181: Packet.lib`。
- CI 用 `.github/actions/setup-connector-build/action.yml` 复合 action 配置这些前置：easytier git 依赖 SSH→HTTPS+PAT 重写（`git config url.insteadOf`）、`arduino/setup-protoc` 装 protoc、Windows 装 7-Zip（easytier build.rs 自动解压 VC-LTL/YY-Thunks）、复制 `Packet.lib`。
- 运行 `qomicex-backend.exe` 需要 `Packet.dll`（npcap，来自 connector-rust `easytier/third_party/<arch>/`）在 exe 同目录；缺失时进程退出 `0xC0000135 (STATUS_DLL_NOT_FOUND)`。release 打包（release.yml / Tauri bundle）必须一并带上。Windows 管理员模式下联机启用 easytier TUN 虚拟网卡（wintun），还需 `wintun.dll`（动态加载，缺失仅 TUN 模式不可用、不崩进程）；非管理员自动回退 no-tun（smoltcp 用户态栈）。开发模式（debug，QOMICEX_LAUNCHER_MANAGED 外手动跑 backend）需自行把 `qomicex-connector-rust/easytier/third_party/x86_64/{Packet,wintun}.dll` 复制到 backend 同目录。
- 联机端点：`src-backend/qomicex-backend/src/endpoints/connector.rs`（11 个 `/connector/*` 端点，含 `kick` 踢人）。EasyTier 为库内嵌（非子进程），`/connector/easytier/*` 恒返回 installed。EasyTier 使用 smoltcp 用户态协议栈，**不支持 127.0.0.1 回环**——本机无法验证 host→join 全链路，需两台真实机器。
- **connector 架构定位（重要）**：`qomicex-connector-rust` 是**符合标准 SCF 协议的联机库**，只提供协议与拓展接口，**不内置业务功能**（踢人/黑名单/审核等一律由调用方实现）。拓展接口：`ScaffoldingCenter::set_player_ping_handler`（`c:player_ping` 裁决钩子，`create_room` 可选参数传入；返回 false → 状态 255 不刷新心跳，入列与否由调用方闭包决定）+ `handle_player_ping`（标准入列）+ 能力方法（`disconnect_machine` / `machine_source_ip` / `easy_tier_nodes` / `disconnect_peer` / `deny_peer` / `allow_peer` / `remove_player` / `get_players`）。改 connector 前先问：这是协议/接口还是业务功能？后者应放 backend。deny 能力底层在 EasyTier4QML fork（rev 9055aef+，控制面黑名单），connector 仅委托。
- 踢人（`/connector/kick`，仅房主）：**实现位于调用方 `src-backend/qomicex-backend/src/services/kick.rs` `KickManager`**（经 connector 拓展接口组合实现，connector 零业务代码）——①解析 guest 的 easytier peer 并 `deny_peer`（**持久物理封禁**：优先已上报 `easytier_id`，否则按 hostname `scaffolding-mc-guest-{machine_id前8位}` 或 SCF TCP 源虚拟 IP 反查 `easy_tier_nodes()`；fork `EasyTier4QML` rev 9055aef+ 的 `CoreInstance::deny_peer` 入控制面黑名单 + 立即断连，对方入站/出站连接在建立处被拒，自动重连/重启也连不上）；②记入已踢黑名单——若 deny 后 guest 仍以其他方式触达 SCF（直连等），re-ping 进入**审核状态机**（防误踢兜底）：`/connector/status` 的 `pendingKickReviews[]` + `POST /connector/kick/review`，`allow` 时 `allow_peer` 解除 deny + 移出黑名单（guest 重新加入），`reject`/`reject_silent` 维持 deny + 黑名单（静默 255）；③`disconnect_machine` 定向断开 Scaffolding TCP；④`remove_player`。**已知限制**：deny 按 easytier 节点 id（默认持久化）；guest 更换 node id/删除数据目录后需重新踢；`allow_peer` 提供解封入口。
- easytier 出站**自动绑定已连接物理网卡 IP**（`qomicex-connector-rust` `util::resolve_bind_ip`，network-interface 枚举：排除虚拟网卡关键词 + 回环 + APIPA，有线优先→无线）——规避 Radmin 等 VPN 虚拟网卡抢默认路由导致的单向劫持（实测：出站从 radmin 网卡发出但无回包 → 中继不可达 → guest join 失败）。建房/加入后可用 `netstat` 验证 easytier 监听绑定物理 IP 而非 0.0.0.0。
- join/host 超时语义：前端 `api/connector.ts` 对 joinRoom/hostByPort 用 120s 长超时（全局默认 15s）；后端 `run_with_connector_timeout` 包 75s 整体超时（协作取消 + close_all 清理 + mode 复位 Idle），返回 `CONNECTOR_JOIN_TIMEOUT`/`CONNECTOR_HOST_TIMEOUT`。

## Commands

```bash
# Backend dev
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
# with license verification enabled
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml --features license-required

# Frontend dev (plain Vite, after plugin-ui build)
pnpm run dev          # on :1420

# Tauri desktop dev (replaces plain vite)
pnpm run tauri dev

# Build (tsc then vite build — type errors fail the build)
pnpm run build
```

No test framework. Backend API test script: `bash scripts/test-api-filters.sh` (and a `test-api-filters.ps1` twin) against `http://localhost:5000/api`.

## Rust 测试

- **Rust 格式化（必做）**：修改 `src-backend/qomicex-backend/` 或 `src-tauri/` 下任何 `.rs` 文件后，必须运行
  `cargo fmt --manifest-path src-backend/qomicex-backend/Cargo.toml` 和 `cargo fmt --manifest-path src-tauri/Cargo.toml`。
  CI（`.github/workflows/ci.yml`）会跑 `cargo fmt -- --check`，漏跑会导致 push 失败。
- **Tauri 侧测试**（WASM 网关）：`cd src-tauri && cargo test --lib plugin_gateway`。
  夹具在 `src-tauri/tests/fixtures/`：`dev.test.wasm/`（预编译 `plugin.wasm` + `manifest.json`）
  会被测试自动部署到临时 `QOMICEX_HOME`，无需手工预置。
- **重编 WASM 插件**：`rustup target add wasm32-unknown-unknown` 后
  `cd src-tauri/tests/fixtures/dev-test-wasm-src && cargo build --release --target wasm32-unknown-unknown`，
  把 `target/wasm32-unknown-unknown/release/dev_test_wasm.wasm` 复制为
  `../dev.test.wasm/plugin.wasm`。
- **Rust 后端**（`src-backend/qomicex-backend/`）：少量单元测试（如 `services/kick.rs` 的重连审核状态机，`cargo test` 全量 21 个）；行为验证走 `bash scripts/test-api-filters.sh`。

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

构建时可选择: 平台、打包格式、架构、是否启用许可证验证 (`--features license-required`)，是否标记 GitHub Pre-release。

requires `QOMICEX_PAT` secret for submodule checkout. Builds cargo backend per target triple (`cargo build --target <triple>`，输出到 `src-backend/qomicex-backend/target/<triple>/release/`)，将其嵌入 `src-tauri/binaries/`（release 构建经 `include_bytes!`，Windows 还需复制 `Packet.dll`），再构建 Tauri bundle。无需 .NET SDK。

CI 使用 **pnpm**（非 npm）：`pnpm install --frozen-lockfile` 后必须 `pnpm --filter @qomicex/plugin-ui build`（workspace 包需先构建 `dist/`）。`actions/setup-node` 配 `cache: pnpm`，之前需 `pnpm/action-setup@v4`。

Mac 的 Create DMG 步骤必须给 `hdiutil create` 传显式 `-size`（按 `du -sm "$STAGING"` ×1.3 + 64MiB 计算）：`-srcfolder` 自动估算会偏小，嵌入 Rust 后端后镜像内复制到一半报 `No space left on device`（宿主盘其实有空间）。UDZO 压缩会回收多余空间，不影响最终 DMG 大小。

`.github/workflows/mirror.yml` — 将仓库（含子模块）镜像同步到 CNB（cnb.cool）。纯 git 操作（`git remote add cnb` + `push --mirror`，子模块逐个镜像并改写 `.gitmodules`），不依赖任何 CNB CLI。需要 `QOMICEX_PAT`、`CNB_ACCESS_TOKEN` secret 和 `CNB_REPO` variable。

## Import rules (critical)

All local TS/TSX imports **must include file extensions** — Vite path bug:
```ts
import { foo } from './bar.ts'             // correct
import { x } from './baz'                  // WRONG — Vite will error
```
Exception: directory barrels like `src/components/ui` (its `index.ts`) resolve fine without an extension, but explicit `./components/ui/index.ts` also works.

## Frontend conventions

- `cn()` from `@qomicex/plugin-ui` (re-exported via `src/components/ui/index.ts`) for Tailwind class merging.
- Dark mode via CSS variables in `src/index.css`, Tailwind `darkMode: "class"`.
- Strict TS: `noUnusedLocals`, `noUnusedParameters`, `strict: true`.
- Router: `BrowserRouter` → `MessageBoxProvider` → `Layout.tsx` → 12 routes: `/`, `/instances`, `/instances/:id`, `/downloads`, `/accounts`, `/accounts/:uuid`, `/resource-center`, `/resource-center/:resourceId`, `/connect`, `/settings`, `/running`, `/plugins/p/:pluginId`. `LaunchProgressDialog` rendered outside routes. Frontend also renders `SplashScreen` until the backend `/api/health` poll succeeds.
- **Internal nav: `<Link>` not `<a>`** — plain `<a>` reloads the page, resetting persistent state. External links use `<a target="_blank">`.
- **UI components live in `packages/plugin-ui/src/components/`** (Badge, Button, Card, Checkbox, Combobox, Dialog, Input, Label, MessageBox, Select, Separator, Table, Tabs, Textarea, Tooltip, BatchToolbar). `src/components/ui/` is only a re-export barrel. Import via `'../components/ui'` or `'@qomicex/plugin-ui'`. **After editing a component, rebuild plugin-ui** (its `dist/` is gitignored and the launcher imports resolve there).
- **Tooltip**: use instead of native `title`. Always wrap icon-only buttons.
- **Select**: use `Select`/`SelectOption`/`SelectDivider` instead of native `<select>`.
- **Button icon animations**: Use `MorphActionIcon` (`src/components/MorphActionIcon.tsx`) for action buttons that trigger async operations (clear, delete, refresh, etc.). Pattern: `active` state → busy icon spins → success check flashes → rest icon. Example: download clear button uses `Trash2` (rest) → `RotateCw` (busy) → `Check` (success flash 800ms). Always wrap with `Tooltip` for icon-only buttons.

## 浏览器调试（Playwright Tauri mock 注入）

前端在**纯浏览器**(Vite dev)里不能直接挂载：`src/components/TitleBar.tsx:5` 在模块顶层调用 `getCurrentWindow()`，读取 `window.__TAURI_INTERNALS__.metadata.currentWindow.label`，无 Tauri 外壳时抛异常 → `#root` 一直为空。要在浏览器里跑起前端检查/自动化，须在页面脚本前用 Playwright `addInitScript` 注入一套 Tauri API mock，再 `goto` 到 `http://127.0.0.1:1420/`。完整 mock 写法、挂载等待方法与注意事项见
`docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md`。

要点：
- **前置**：后端在 `:5000`（`SplashScreen` 轮询 `/api/health` 通过才渲染）；`pnpm run dev` 起 Vite(:1420)。已占 5000 时用 `QOMICEX_PORT` 起第二实例。
- **mock 核心**：`window.__TAURI_INTERNALS__` 提供 `metadata.currentWindow.label`、`transformCallback`、`invoke`（`plugin:window|is_*`→false、`plugin:event|listen`→id、其它→undefined）、`event.{listen,once,emit,emitTo}`；补 `__TAURI_EVENT_PLUGIN_INTERNALS__` 等。
- **挂载判断**：`document.querySelector('main')` 存在即已挂载（SplashScreen 阶段无 `main`）；`goto domcontentloaded` 后轮询等待，勿等 `load`。
- **注意**：浏览器(Chromium)≠WebView2 保真，复合/backdrop-filter 行为可能有差异，web 检查结论需在真实 Tauri/WebView2 复核；仅导航只读页面，勿触发写数据/启动实例；用后停 server、删探针。

## Backend conventions

- **23 endpoint modules** in `src-backend/qomicex-backend/src/endpoints/` → `api/<name>` routes, assembled in `app.rs` (`build_router`). `main.rs` loads config (`settings.rs`) then serves.
- **Log analysis** (`endpoints/loganalysis.rs` → `api/loganalysis`): `POST /loganalysis/analyze`（body `{logContent}`，逐行/`(?s)` 跨行模式匹配）和 `POST /loganalysis/analyze-crash/{instanceId}`（读 `LaunchTracker` 内存中的 `crash_report`，无则 400 `NO_CRASH_REPORT`；成功后可选上传 mclo.gs）。模式库在 `Resources/error-patterns.json`（44 种），分析引擎 `services/log_analysis.rs`（去重+按 Critical>Error>Warning>Info 排序）。
- Router: `.nest("/api", ...)` + permissive CORS (`CorsLayer`) + `TraceLayer`; `/api/ping` (in `app.rs`) and `/api/health` (in `system.rs`) liveness probes — the frontend polls `/api/health`. `middleware/not_found.rs` handles 404 (registered before `.layer()` so CORS wraps fallback).
- Data dir resolution (`settings.rs` `resolve_base_dir`): `QOMICEX_HOME` env → `.qomicex-bootstrap` file (content is the path) → `{LocalAppData}/qomicex-launcher`.
- Shared services in `services/` and `state.rs` (`AppState`): reqwest HTTP clients (Modrinth, CurseForge, FTB, etc.), `InstallTracker`, `LaunchTracker`, account/skin services, trace buffer, plugin service. License core only under `--features license-required` (`#[cfg(feature = "license-required")]` in `license_core.rs`).
- Embedded resources: `Resources/Alex.png`, `Resources/mcmod_data.json.gz`（gzip 嵌入，运行时 flate2 解压）, `appsettings.json` (via `include_bytes!` / `include_str!`). 重新生成见 `scripts/build-mcmod-data.mjs`。
- `appsettings.json` includes a `CurseForge:ApiKey` (set in repo).
- No OpenAPI endpoint (C# `/openapi/v1.json` removed in the Rust rewrite).

## Error handling

**Backend**: errors → `ApiError` (`src-backend/qomicex-backend/src/error.rs`, mirrors C# `ApiError`) → returns:
```json
{ "code": "ERROR_CODE", "message": "...", "detail": "...", "traceId": "...", "timestamp": "...", "status": 500 }
```
- Do NOT add ad-hoc result wrapping in handlers. Return `ApiResult<T>` and let `ApiError` propagate.
- For expected errors use constructors: `ApiError::bad_request(...)`, `ApiError::not_found(...)`, `ApiError::forbidden(...)`, `ApiError::upstream(...)`, `ApiError::internal(...)`.
- `From<std::io::Error>` maps `NotFound`→404, `PermissionDenied`→403, else→500 (mirrors C# `MapException`).

**Frontend**: `src/api/client.ts` exports `ApiError` with `.code`, `.status`, `.detail`, `.traceId`, `.displayMessage`.
```ts
import { ApiError } from '../api/client.ts'
try { ... } catch (e) { if (e instanceof ApiError) showToast(e.displayMessage) }
```

## Cross-platform rules

The launcher ships on **Windows, Linux, macOS**. Never assume Windows.

### Rust (Backend / Core)
- Use `std::path::PathBuf`/`Path::join` — never hardcoded drive letters or `\\` separators.
- Platform guards: `#[cfg(windows)]` / `#[cfg(unix)]` (not `cfg(not(windows))`); runtime check with `std::env::consts::OS`.
- Shell: `/bin/sh` on unix, powershell/cmd on Windows (see `services/plugin.rs`).
- Data dir: `dirs` crate (`LocalApplicationData`-equivalent) + app name, with `QOMICEX_HOME` env override for portable mode. Never write relative to the exe dir.
- No .NET — native OS APIs only (winreg on Windows, sysinfo for diagnostics).
- Set `0o755` permissions after `std::fs::write` for binaries.

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

- **Manifest**: `src/plugins/types.ts` / `PluginManifest` in `src-backend/qomicex-backend/src/services/plugin.rs` — `PluginManifest`, `PluginContributes`, `PluginMenuItem`.
- **Activation**: `activatePlugin()` in `src/plugins/plugin-loader.tsx:57` — calls `renderInline()`, registers sidebar slots, loads theme CSS.
- **Inline rendering**: `sandbox.ts:212` `renderInline()` — fetches `dist/index.html`, strips `<html>/<head>/<body>`, sets `container.innerHTML` with bridge script appended.
- **Plugin page**: `src/pages/PluginPage.tsx` — mounts at `/plugins/p/:pluginId`. Switches plugins by clearing `containerRef.innerHTML` before appending new container. Scripts activate once (`data-scripts-activated` flag).
- **Overlay system**: `PluginOverlayManager.tsx` — overlays are iframes with `sandbox="allow-scripts"`. Created via `createPluginBridge().createOverlay()`. Global `window.__pluginOverlayStore` exposes store methods.
- **Sidebar action**: `menuItems[].action: "overlay"` + `contributes.overlay.file` → sidebar button calls `createOverlay` directly, no page navigation (`plugin-loader.tsx:151` `OverlaySidebarButton`).
- **Plugin packages**: `.qplugin` = `.zip` with `manifest.json` at root. Upload via `POST /api/plugins/upload`. States persisted to `{BaseDir}/plugin-states.json`.
- **Dev plugins**: placed in `plugins-dev/` directory during development.
- **Plugin build (Vite + React)**: Plugins using Vite/React/Tailwind scaffold follow example-toolkit pattern: `package.json` with `@qomicex/plugin-ui` + `@qomicex/plugin-ui/tailwind-preset`, `tsc && vite build` for build, the plugin's own `scripts/build.sh` for `.qplugin` packaging. Multi-page builds supported via `rollupOptions.input`.
- **Plugin API bridge**: `window.__PLUGIN_API__` (inline) / `parent.postMessage` (iframe) — methods: `getSettings`, `setSettings`, `callBackend`, `navigate`, `showToast`, `proxyFetchStream`, `registerMethod`, `callPlugin`, `readFile`, `writeFile`, `execCommand`, `overlay.*`, `download.*`（`download.addTask|progress|cancel|list`，权限 `download:manage`，复用 `DownloadSessionManager` 使任务进入下载中心；`download.registerInstall`，权限 `instance:write`，仅在前端下载中心登记安装任务）、`modpack.install`（权限 `instance:write`，一键安装整合包，走 `POST /api/modpack/install-direct`，复用 `ModpackService`+`InstallTracker` 与前端整合包页同管线）。`proxyFetch` 走 `POST /api/plugins/proxy`（`stream: true` 时后端转发 SSE 流式响应，前端经 `proxyFetchStream(req, { onChunk, onError })` 消费）。文件读写走授权制（`/api/plugins/files/{id}/read|write|delete|authorize`，未授权返回 403 `FS_AUTHORIZATION_REQUIRED`，前端 `window.confirm` 弹窗授权后重试；`deleteFile` 权限 `filesystem:write`）；shell 执行走 `/api/plugins/shell/{id}`（win: powershell，linux/mac: /bin/sh，超时默认 15s 范围 1-120s）。
- **Plugin dependencies**: manifest `dependencies: [{id, version?, optional?}]`，安装时检查必装前置（缺失拒装 `PLUGIN_MISSING_DEPENDENCY`），激活时检查前置已启用（缺失则禁用）。`registerMethod`/`callPlugin` 提供插件间方法调用，主窗口 `__pluginRegistry` 统一中转（`src/plugins/plugin-registry.ts`），激活顺序由 `sortByDependencies` 拓扑排序保证。
- **Layers 渲染**: manifest `layers` 含 `l2` → iframe 沙箱（`createSandbox`，srcdoc + postMessage 桥，脚本自动执行）；不含 `l2` → 内联渲染（需进入 `/plugins/p/:id` 页面脚本才执行）。纯 `["l3"]` 的 installed 插件不自动激活。
- **L3 WASM 网关**: `src-tauri/src/plugin_gateway/`（wasmtime 26 核心模块）—— `loader.rs` 扫描 `plugins/{id}/plugin.wasm`（需 manifest layers 含 l3），注入 host 函数（`qomicex` 模块：`log`/`http_fetch`/`instance_list`/`db_set`/`db_get`/`get_plugin_id`），插件导出 `on_load`/`on_unload`/`get_manifest`。`server.rs` 提供 `GET /plugins`、`GET /plugins/{id}/info`、`POST /plugins/{id}/invoke`、`GET /health`，端口写入 `plugins/.gateway_port`。路径与后端一致（`config::base_dir`，QOMICEX_HOME 优先）。后端经 `PluginGatewayClient` 代理暴露 `/api/plugins/wasm`、`/api/plugins/wasm/{id}`、`/api/plugins/wasm/{id}/invoke`，前端 API `callWasm`/`listWasmPlugins`（权限 `wasm:execute`）。

## Tauri details

- Backend binary is embedded via `include_bytes!` in release builds only (`#[cfg(all(windows, not(debug_assertions)))]` → `src-tauri/binaries/backend.exe`, unix → `backend`), extracted to a temp dir on startup. In dev the constant is empty and the backend runs separately. Backend child is killed on exit via `BackendChild` state. Setting `QOMICEX_LAUNCHER_MANAGED` skips spawn.
- **Window decorations**: Windows calls `set_decorations(false)` in setup (`lib.rs:138-141`); Linux/macOS keep the default (decorated).
- Capability permissions: `core:default`, window controls, `opener:default`, `opener:allow-open-path`, `opener:allow-reveal-item-in-dir`, `dialog:default`, `updater:default`.
- CSP in `tauri.conf.json` allows `http://localhost:5000`/`ws://localhost:5000` for the embedded backend; updater endpoints include `https://api.qomicex.top`, localhost:8787, and localhost:5000.
