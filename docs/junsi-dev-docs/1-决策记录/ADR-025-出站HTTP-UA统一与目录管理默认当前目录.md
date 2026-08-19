# ADR-025：出站 HTTP UA 统一 + 目录管理默认「当前目录」占位入口

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-18 |
| 决策者 | AI Agent |

## 背景

两点改进：

1. **User-Agent 不统一**：后端各出站 HTTP 调用的 UA 拼写分散（部分带多余空格、格式不一致），服务端统计与限流识别困难。
2. **目录管理入口缺失当前目录**：Instances 的目录管理弹窗只列出「已保存目录」（`qomicex-directories`），而实际默认目录（`currentDir`，默认 `.minecraft` 所在目录）不一定在其中，用户切换/找回默认目录不便，也容易误删。

## 决策

### 1）UA 统一

后端统一出站 HTTP UA 为：

```
Qomicex.Launcher/{CARGO_PKG_VERSION}
```

- 在 `state.rs` 新增 `pub const USER_AGENT`（`concat!("Qomicex.Launcher/", env!("CARGO_PKG_VERSION"))`），并用于全局 `AppState.user_agent` 构建与 downloader `DownloadOptions` 传入。
- `system.rs`、`modpack.rs`、`install_service.rs`、`update.rs` 等散落的 UA 构建全部改用 `crate::state::USER_AGENT`。
- 走共享 `http_client` 的上游（资源中心 / curseforge_fetch / translation 等）天然携带规范 UA。
- **例外**：联机节点获取（`connector.rs` `ScaffoldingClient`）的 UA 保持 `QML/{version}` 不变——向 SCF 服务端标识节点身份，不属于启动器 HTTP 请求语义，不做统一。

### 2）目录管理默认「当前目录」占位入口

目录管理弹窗顶部新增一个**固定「当前目录」占位条目**：

- 指向 `currentDir`（默认 `.minecraft` 目录），始终展示、带选中态高亮。
- **不在 `managedDirs`（localStorage `qomicex-directories`）中**：不持久化、不可重命名、不可删除；仅提供「打开目录」操作。
- 下方仍保留「已保存目录」列表（可增删改）。

## 备选方案

### UA：保留各处自行拼接
- 优点：改动小
- 缺点：格式不统一，遗漏变体难以维护
- 为何不选：无法保证一致识别

### UA：连联机 nodes 一起统一为 Qomicex.Launcher
- 优点：全面统一
- 缺点：改变 SCF 节点身份标识语义，可能与服务端/统计冲突
- 为何不选：`ScaffoldingClient` UA 是节点身份，不属于启动器 HTTP 请求

### 目录管理：把 currentDir 强行并入 managedDirs
- 优点：复用现有列表逻辑
- 缺点：会持久化一个用户未主动添加的目录，且允许被改名/误删
- 为何不选：破坏「当前目录」的常量语义，易误操作

## 影响
- `src-backend/qomicex-backend/src/state.rs`（新增 `USER_AGENT` 常量）
- `src-backend/qomicex-backend/src/endpoints/{system,modpack,update}.rs`
- `src-backend/qomicex-backend/src/services/install_service.rs`
- `src/pages/Instances.tsx`（目录管理弹窗新增「当前目录」占位入口）
- `qomicex-tauri-i18n/src/{zh-CN,zh-TW,zh-HK,en-US,en-GB,ja-JP,ru-RU}/instances.ts`（新增 `currentDir` key），需在 i18n 子模块单独提交推送

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-18 | v1.0 | 初版创建 | AI Agent |
