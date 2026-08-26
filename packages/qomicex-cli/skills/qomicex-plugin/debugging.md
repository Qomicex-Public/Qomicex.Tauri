# Harness 热重载调试

调试实现源：`packages/qomicex-cli/src/commands/dev.ts` + `scripts/harness/run.mjs`。

## qomicex dev 的两条路径

```bash
qomicex dev            # 默认
qomicex dev --port 3000
```

`dev` 命令从当前目录向上查找 `scripts/harness/run.mjs`：

| 场景 | 行为 |
|------|------|
| **仓库内（harness 模式）** | 检测到 harness → spawn `scripts/harness/run.mjs`，进入完整调试环境。**插件必须位于 `plugins-dev/{id}`**（harness 从该目录定位）。`--port` 在此模式不生效（固定 1420） |
| **仓库外（裸 Vite）** | 回退为 Vite dev server（默认 5173）+ 在项目根写 `.qomicex-dev.json`（dev 源插件配置，供手动注册 dev 源） |

## harness 模式做什么

不启动 Tauri、不启动 Rust 后端，纯浏览器调试：

1. 起 stub mock server（`scripts/harness/stub.mjs`，固定 `:5100`）。
2. 复用已有 Vite dev（`:1420`）；未运行则自动 spawn `pnpm run dev`。
3. `addInitScript` 注入 **Tauri API mock**（`window.__TAURI_INTERNALS__` 等，跨导航保留）——否则前端在纯浏览器里无法挂载。
4. 打开插件页 `http://127.0.0.1:1420/plugins/p/{pluginId}`。
5. `fs.watch` 监听插件 `src/`（含 `index.html`/`theme.css`/`overlay.html`/`vite.config.ts`）→ 变更后重建（`pnpm run build`）→ 整页 reload（iframe 重新挂载）。

**前置要求**：Playwright + Chromium：

```bash
pnpm add -D playwright
pnpm exec playwright install chromium
```

## 手动运行 harness

```bash
node scripts/harness/run.mjs <pluginId> [--headed] [--mock file.json] [--build-cmd "pnpm run build"]
# 或仓库根：pnpm run harness -- hello-plugin
```

| 参数 | 说明 |
|------|------|
| `--headed` | 有头模式（默认 headless，看不到窗口；调试用 --headed） |
| `--mock file.json` | 自定义 stub 返回（mock 数据） |
| `--build-cmd "..."` | 覆盖重建命令（默认 `pnpm run build`） |

## 注意事项

- **网络请求转发**：前端直连 `:5000` 的 `/api/**` 请求被 route 到 stub `:5100`。stub 返回什么，插件就拿到什么——需要真实后端数据时请先跑 Rust 后端或改 mock。
- **热重载陷阱**：浏览器(Chromium) ≠ WebView2，复合/backdrop-filter 等行为可能有差异，结论需在真实 Tauri 复核。
- **停止**：`Ctrl+C`，会一并清理 stub / Vite。
- **浏览器直开降级**：独立 `pnpm dev`（不经 harness）时 `window.__PLUGIN_API__` 为 `null`，`getApi()` 返回 null，UI 需优雅降级（模板已处理）。
- 只读操作可放心跑；避免在调试页触发写数据 / 启动实例类操作。
