# ADR-010：Puppeteer 自动化组件素材采集方案

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-08-14 |
| 决策者 | AI Agent |

## 背景

Tauri 桌面应用无法在普通浏览器中运行（@tauri-apps/* API 依赖原生 IPC），导致 Puppeteer 无法直接截取 UI 组件素材。需要一种方案让前端在浏览器中渲染，同时跳过 Tauri 依赖。

## 决策

在 vite.config.ts 中通过 CAPTURE_MODE 环境变量条件注入 Vite resolve.alias，将所有 @tauri-apps/* 模块重定向到 browser-stub/tauri-stub.mjs（导出完整 mock：getCurrentWindow 含 onResized/toggleMaximize，listen 返回 thenable）。Puppeteer 连接 Vite dev server（带 CAPTURE_MODE），可截取全页截图 + 元素级透明底抠图。

## 备选方案


### 方案 evaluateOnNewDocument JS mock
- 优点：无需改 Vite 配置
- 缺点：Vite 预打包的静态 import 无法被运行时 mock 拦截，页面仍然崩溃
- 为何不选：不可行

### 方案 单独 Vite capture config
- 优点：不影响主配置
- 缺点：Start-Process 启动的 Vite 进程不稳定，端口冲突
- 为何不选：曾尝试但不稳定

### 方案 CAPTURE_MODE 条件注入
- 优点：复用主 config，仅环境变量触发，不影响正常 tauri dev
- 缺点：需要手动设置环境变量
- 为何不选：最终方案

## 影响
- vite.config.ts — 新增 CAPTURE_MODE 条件分支
- video-assets/browser-stub/tauri-stub.mjs — 新增 Tauri API mock
- video-assets/scripts/capture-final.mjs — Puppeteer 采集脚本

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|:---|:---|:---|:---|
| 2026-08-14 | v1.0 | 初版创建 | AI Agent |
