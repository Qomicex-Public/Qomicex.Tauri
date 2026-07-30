# ADR-004： C# ASP.NET → Rust/Tauri IPC 全量迁移架构决策

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-07-29 |
| 决策者 | AI Agent |

## 背景

项目原架构为 C# ASP.NET Core (NativeAOT) 后端 + React 前端 + Tauri 桌面壳。后端通过 HTTP JSON API 与前端通信，Tauri 仅作为 WebView 壳。当前已部分迁移至 Rust，但采用了混合模式：Axum 路由器嵌入 Tauri 进程内，通过 call_api IPC 桥接转发请求。此架构引入了不必要的间接层（HTTP 路由抽象在 IPC 之上）。目标为：全量移植到 Rust，使用 Tauri 原生 #[tauri::command] IPC，消除 Axum 层和 C# 子模块依赖。

## 决策

采用三阶段迁移策略：
1. Phase I（Fix Stubs）：在当前 Axum 层中修复所有 stub/fake handler，确保 Rust 功能完整性与原 C# 一致。
2. Phase II（IPC 转换）：将 Axum handler 逐组迁移为 #[tauri::command] IPC 命令，完成后移除 api_server/mod.rs 和 call_api 桥接。
3. Phase III（子模块迁移）：将 Core.AOT 作为独立 core Rust crate 迁移，Connector.Scaffolding 内联到 app/connector/。

## 备选方案

### 方案 保持 Axum 混合架构
- 优点：改动最小，现有前端调用 API_BASE 不变
- 缺点：保留不必要的 HTTP 路由抽象；call_api 桥接层增加调试复杂度；无法利用 Tauri 原生 IPC 类型安全
- 为何不选：未说明

### 方案 C# 后端保持不变
- 优点：无需迁移
- 缺点：维护两套技术栈；Tauri 无法内联后端；C# NativeAOT 跨平台问题

- 为何不选：未说明

## 影响
- 前端 API 调用层需从 HTTP 切换为 Tauri invoke
- 移除 lib.rs 中的 call_api 桥接和 ApiRouter
- 删除 app/api_server/mod.rs（3156 行 Axum 代码）
- 删除 Cargo.toml 中的 axum/tower-http/hyper 依赖
- 子模块 Core.AOT 不再需要
- .github/workflows/release.yml 构建流程需调整（不再编译 C# 后端）
- 需要重写 frontend API client (src/api/client.ts)

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-07-29 | v1.0 | 初版创建 | AI Agent |