# 插件调试 harness（Playwright + Tauri mock 注入 + 热重载）

> 生成时间：2026-08-25
> 状态：PHASE1 任务⑥ 已实现（不启动 Tauri / 不启动 Rust 后端，纯浏览器调试插件）

## 这是什么

插件开发者**无需启动 Tauri、无需启动 Rust 后端**即可在纯浏览器（Chromium）里调试插件逻辑：

- 启动 Vite dev(:1420) + 注入 Tauri mock（复用 `前端浏览器调试-Playwright-Tauri-mock注入.md` 的写法）
- 打开插件页 `http://127.0.0.1:1420/plugins/p/{pluginId}`
- 本地 Node stub（:5100）模拟后端 `/api/plugins/*` 等接口，返回可控假数据
- fs.watch 监听插件源码 → 自动重建 → 整页 reload 重新挂载插件 iframe

## 快速开始

```bash
# 前置：插件依赖已装好、plugin-ui 已构建（与 dev 一致）
pnpm --filter @qomicex/plugin-ui build   # 若尚未构建
# hello-plugin 已有 node_modules 可直接跑

# 跑 hello-plugin 调试（headless）
pnpm run harness -- hello-plugin

# 有头模式（看得见浏览器，配合 DevTools 断点）
pnpm run harness -- hello-plugin --headed
```

> 注意：`pnpm run harness -- hello-plugin` 的 `--` 是 pnpm 参数转发；也可以直接
> `node scripts/harness/run.mjs hello-plugin`。

Playwright 未安装时会提示安装：

```bash
pnpm add -D playwright
pnpm exec playwright install chromium
```

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│ Node 脚本 scripts/harness/run.mjs（主控）                      │
│  · 起 stub（子进程） → 起 Vite dev（若未在跑）                  │
│  · Playwright 开 Chromium，addInitScript 注入 Tauri mock       │
│  · page.route 把 127.0.0.1:5000/api/** → 转发到 stub :5100     │
│  · fs.watch 插件 src → rebuild → page.reload                   │
└──────────────────────────────────────────────────────────────┘
```

前端 `src/api/client.ts` 的 `API_BASE` 硬编码为 `http://127.0.0.1:5000/api`，所以浏览器请求直连 :5000。run.mjs 用 `page.route` 把这些请求转发到 stub :5100，避免与真实 Rust 后端抢端口——**stub 不监听 5000**，你本机跑着后端也不冲突。

## 组件

| 文件 | 职责 |
|---|---|
| `scripts/harness/run.mjs` | 主控：起服务、注入 mock、路由转发、热重载 |
| `scripts/harness/stub.mjs` | 纯 node:http mock server（:5100），模拟后端接口 + 服务插件静态文件 |

## Stub 接口一览（可配置假数据）

`GET /api/health`、`/api/ping` → 健康检查（SplashScreen 轮询通过）
`GET /api/plugins` → 插件列表（`state: active`，自动扫描 `plugins-dev/{id}/manifest.json`）
`GET /api/plugins/{id}/files/{path}` → **服务插件 dist 静态文件**（路径限定在插件目录内，防越界）
`GET/POST /api/plugins/settings/{id}` → 内存读写配置（支持 `{key,value}`）
`GET/POST /api/plugins/cache/{id}` → 缓存假数据
`POST /api/plugins/proxy` → 固定假响应（`stream:true` 时返回 SSE 模拟流式）
`GET/POST /api/plugins/download/*` → 假下载任务
`GET /api/systeminfo`、`POST /api/system/open-url` → 假系统信息/打开 URL
`POST /api/modpack/install-direct` → 假整合包安装
`POST /api/plugins/shell/{id}` → 假命令执行（stdout 假数据）
`POST /api/plugins/files/{id}/read|write|delete|authorize` → 假文件读写
`GET /api/plugins/wasm`、`POST /api/plugins/wasm/{id}/invoke` → WASM 列表空 / 400
`POST /api/plugins/upload` → 400 `HARNESS_READONLY`（**harness 禁止真实上传**）

### 自定义 mock 数据

```bash
# 写一个 mock 配置 JSON，然后：
pnpm run harness -- hello-plugin --mock mock-hello.json
```

```json
{
  "settings": { "greeting": "自定义假配置", "foo": 1 },
  "systemInfo": { "os": "Linux", "arch": "x86_64" },
  "execCommand": { "exitCode": 0, "stdout": "mock echo 输出", "stderr": "" }
}
```

支持覆盖的键：`settings`、`systemInfo`、`proxyResponse`、`modpackInstall`、`downloadStart`、`downloadProgress`、`fileRead`、`execCommand`、`wasmList`、`pluginStates`（`{ "插件id": "active" }`）。

## 断点调试

1. `pnpm run harness -- hello-plugin --headed`（有头模式）
2. 浏览器里 F12 / Ctrl+Shift+I 打开 DevTools
3. 插件渲染在 iframe 内（沙箱 `sandbox="allow-scripts"`，opaque origin）——在 DevTools 的元素面板选中 iframe 后，**Console 上下文下拉里切换到该 iframe 的 document**，即可直接调 `__PLUGIN_API__.call('getSettings')` 验证桥与 stub 返回值。
4. Sources 面板给 `src/plugins/sandbox.ts` 的 `handleApiCall` 打断点，可单步跟踪 `__PLUGIN_API__` postMessage → `executePluginMethod` → `createPluginBridge` 全链路。

Playwright Inspector（录制/步进，可选）：

```bash
pnpm exec playwright codegen http://127.0.0.1:1420/plugins/p/hello-plugin
```

> 注意：codegen 不会注入 Tauri mock，纯看页面渲染 / 走 UI 交互可用；要验证桥 API 请走 harness。

## 热重载

- 监听 `plugins-dev/{pluginId}/` 下的 `src/`、`index.html`、`theme.css`、`overlay.html`、`vite.config.ts`
- 变更 → 400ms 防抖 → 在插件目录执行构建命令（默认 `pnpm run build`，可用 `--build-cmd` 覆盖）→ 构建成功 → `page.reload()` 整页刷新重新挂载插件
- 构建失败不刷新页面，stderr 输出到终端，方便你边改边看

```bash
pnpm run harness -- hello-plugin --build-cmd "pnpm run build"
```

## 限制与注意事项

- **Chromium ≠ WebView2**：渲染/复合行为可能有差异（如 backdrop-filter），Web 调试结论需在真实 Tauri/WebView2 复核。
- **harness 是只读沙箱**：stub 对真实写数据 / 启动实例 / 真实下载全部返回假数据或 400；不要在插件里触发真实业务动作。
- **退出清理**：Ctrl+C 后 run.mjs 会 kill 自己 spawn 的 stub 和 Vite；如果你自己先起了 Vite(:1420)（`pnpm run dev`），harness 直接复用、退出时**不会**杀掉你那个进程。
- **iframe 沙箱**：`sandbox="allow-scripts"` 无 `allow-same-origin`，iframe 内同步 `while(true)` 仍可能阻塞共享渲染进程（与真实 WebView2 一致）。
- 插件依赖 `@qomicex/plugin-ui`，插件构建需要其 `dist/` 已生成（`pnpm --filter @qomicex/plugin-ui build`）。

## 参考位置

- Tauri mock 注入法：`docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md`
- 插件桥实现：`src/plugins/plugin-api.ts`、`src/plugins/sandbox.ts`
- 插件加载：`src/plugins/plugin-loader.tsx`、`src/pages/PluginPage.tsx`
- 后端真实接口参考：`src-backend/qomicex-backend/src/endpoints/plugin.rs`

## 修订记录

| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-25 | v1.0 | 初版创建（PHASE1 任务⑥） | AI Agent |
