# ADR-054：ADR-054: l4 远程 WebView 隔离层跨窗口桥设计

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-26 |
| 决策者 | AI Agent |

## 背景

为「重 UI 且不可控」的插件提供独立 renderer 进程托管（l4 层）。目标：即使插件 busy-loop，也只冻结其自身 renderer，不卡主 UI。Tauri WebviewWindow 天然独立进程/渲染器。

## 决策

跨窗口 Tauri 事件桥（Design P）：主窗口 createRemoteWebview 创建 WebviewWindow 加载 `/plugins/p/:id?pluginWebview=1` → App.tsx 轻量启动 PluginWebviewPage（不加载主 Layout/路由/插件自动激活）→ iframe 加载插件页面并复用 apiBridgeScript → `__plugin_api_call` 经 `emitTo('main')` 转发 → 主窗口 `initL4Bridge` 调 `handleApiCall`（权限+executePluginMethod）→ 响应经 `emitTo(l4label)` 回传 postMessage。跨窗口通道用 Tauri event 而非 window.opener（子 WebviewWindow 非 window.open 创建，opener 为 null）。纯浏览器降级为同窗口 iframe。registry（registerMethod/callPlugin）由 l4 窗口自身 plugin-registry.ts 本地处理，跨窗口 registry 留 TODO。

## 备选方案

### 方案 本地处理（Design S）
- 优点：改动最少（~5 文件），复用 sandbox.ts 全链路，跨插件 registry 同窗口可用
- 缺点：插件 API 在 l4 窗口本地执行，非主窗口代理，偏离 spec 关键设计
- 为何不选：与 spec「主窗口持有真实 instance」相悖

### 方案 跨窗口事件桥（Design P，选用）
- 优点：满足 spec 关键设计；主窗口集中权限校验；toast/overlay/navigate 等侧效应落在主窗口；为 PHASE1.5+ 跨窗口 registry 打底
- 缺点：改动较大（约 9 文件+新模块）；依赖 Tauri event 系统；registry 跨窗口需额外路由
- 为何不选：spec 明确要求，且为后续架构留路

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-26 | v1.0 | 初版创建 | AI Agent |