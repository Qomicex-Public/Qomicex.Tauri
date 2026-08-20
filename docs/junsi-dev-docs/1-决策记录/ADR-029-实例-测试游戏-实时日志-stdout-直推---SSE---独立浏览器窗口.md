# ADR-029：实例「测试游戏」实时日志：stdout 直推 + SSE + 独立浏览器窗口

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-20 |
| 决策者 | AI Agent |

## 背景

实例详情页需要「测试游戏」按钮：点击照常启动游戏，并另开独立日志窗口实时显示游戏 stdout/stderr。现有核心子模块 launch/process.rs 的 forward_pipe 只把输出 println 到控制台，未暴露给 API；前端无实时日志机制。

## 决策

采用 stdout 直推方案：在 qomicex-core-rust 增加一个全局游戏日志总线（subscribe_game_log，GameLogLine{pid,is_stdout,text}），forward_pipe 读到的每一行除 println 外也广播进该总线（不改 LaunchOptions 公开串行化模型）。后端新增 GameLogService：订阅总线→按 pid→instance 归属→每实例缓冲 5000 行 + broadcast 通道。新增 GET /api/instance/{id}/logs（历史，供回显）与 /api/instance/{id}/logs/stream（SSE：先发 snapshot 全量再逐行发 line，重连幂等）。由后端托管独立页 /logs-view/{id}（自包含 HTML，直连后端 SSE，textContent 防注入），前端 window.open 另开系统级浏览器窗口。前端实例详情头部新增「测试游戏」按钮 = 复用现有 launch 流程 + 打开日志窗口。

## 备选方案

### 方案 轮询 GameDir/logs/latest.log
- 优点：不改核心子模块、改动小
- 缺点：实时性差（写盘延迟）、无法捕获 Java 进程层面的原生错误/早期输出、需文件读+轮询
- 为何不选：用户明确选择 stdout 直推以获最佳实时性与完整性

### 方案 内嵌面板/应用内全屏窗口
- 优点：不依赖系统浏览器窗口、样式统一
- 缺点：与用户要求的「另开独立日志窗口」不符
- 为何不选：用户选择另开系统级浏览器窗口

### 方案 在 LaunchOptions 加非串行化 log_sink 字段
- 优点：显式按次传递
- 缺点：破坏模型 Serialize/Deserialize/PartialEq derive，侵入公开模型
- 为何不选：改用全局 pid 日志总线，避免改公开模型

## 影响
- qomicex-core-rust/src/services/launch/process.rs（总线 + forward_pipe）
- src-backend/qomicex-backend：services/game_log.rs、endpoints/instance_logs.rs、state.rs、app.rs、instance.rs
- src/api/instance.ts、src/pages/InstanceDetail.tsx
- i18n submodule instanceDetail 全语言
- 性能：每行一次 broadcast，缓冲有上限，内存有界

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-20 | v1.0 | 初版创建 | AI Agent |

### 2026-08-21 更新

## 修订（2026-08-20）：落地改为启动器原生独立窗口

经实现验证，用户要求的是**启动器自身的独立日志窗口**（非系统浏览器、非站外页面）。最终实现调整为：

- 日志窗口改为 **Tauri 原生 `WebviewWindow`**（label `game-log-window`），加载本 SPA 的 `?logWindow=1&instance=<id>` 分支，与主窗口**共用同一套 Tailwind 主题/字体**。
- Windows 下 `decorations:false` 隐藏系统标题栏，并复用主窗口同款自定义标题栏（拖拽区 + 最小化/最大化/关闭）；非 Windows 保留系统标题栏（与主窗口一致）。
- 新增前端组件 `src/pages/GameLogWindow.tsx`：日志**等级筛选**（INFO/WARN/ERROR/DEBUG/FATAL/OTHER，客户端按 `[thread/LEVEL]` 解析）、**关键词搜索**、自动滚动、连接状态、**停止游戏**按钮（`POST /api/instance/{id}/launch/cancel`）。
- `src/App.tsx` 检测 `?logWindow=1` 分支，独立渲染该组件（不加载主 Layout/路由/后台轮询）。
- 能力配置 `src-tauri/capabilities/default.json`：新增 `core:webview:allow-create-webview-window`，并把 `windows` 覆盖到 `game-log-window`（窗口内 close/minimize/toggle-maximize/start-dragging）。
- i18n submodule 新增 `gameLog` 命名空间（7 语言）。
- 后端 `/logs-view/{id}` 独立页不再被日志窗口使用（保留后端 `/instance/{id}/logs` + `/logs/stream` SSE 数据接口）。

