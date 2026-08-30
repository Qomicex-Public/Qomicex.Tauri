# ADR-064：通用插件 Hook 系统：Koa 洋葱管道 + 前端方法层 hook（v1）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-30 |
| 决策者 | AI Agent |

## 背景

插件系统需要修改启动器原有逻辑（如启动参数注入、版本扫描结果过滤、下载拦截），实现功能强化/性能优化/重构。此前仅有一个单一可取消事件 plugin:launch-progress-override（LaunchProgressDialog.tsx:24），无通用 hook/intercept/override 机制。插件生态技术提案（2026-08-25）规划了协议 v2 生命周期但未含通用 hook。需求：插件可在启动器方法执行前后执行插件方法，也能修改方法实现逻辑；支持读取/修改参数/修改返回值/阻止执行/完全替换；支持前后端；支持嵌套 hook。

## 决策

v1 采用 Koa 式洋葱中间件管道 + 前端方法层 hook。核心设计：①hookable() 包装器把启动器方法暴露为可 hook 点（无 hook 时零开销快路径）；②HookRegistry（主窗口）持有 method→RegisteredHook[] 表，run() 执行洋葱管道（默认实现为终点）；③插件 hook 函数在 iframe 中执行，两阶段桥协议：before（__plugin_hook_invoke → 修改 args/prevent → __plugin_hook_before_done）→ 主窗口 impl → after（__plugin_hook_continue 带 result → 恢复 next() → __plugin_hook_after_done）；④ctx 提供 args/result 修改、prevent() 阻止、替换（设置 result+prevent）；⑤注册=manifest contributes.hooks 声明 + __PLUGIN_API__.registerHook 运行时注册，权限 hook:register（danger）；⑥嵌套=多个插件按注册顺序串行洋葱，先注册者在外层。首批 hookable：launchInstanceFlow（RunningContext）、launchInstance/syncScan（api/instance.ts）、scanVersions（api/versions.ts）。后端 Rust 进程内 hook 作 v2（插件回调端点机制），v1 后端经前端中转间接参与。

## 备选方案

### 方案 纯前端事件总线
- 优点：实现简单，复用 CustomEvent
- 缺点：无优先级/顺序控制，事件名易冲突，无法统一管理嵌套
- 为何不选：被弃：无法满足嵌套/替换/优先级需求

### 方案 后端 HookRegistry（Rust 进程内）
- 优点：可直接修改核心 Rust 逻辑
- 缺点：插件 hook 函数在 iframe 无法被 Rust 调用，需插件回调端点机制，复杂度显著上升
- 为何不选：被弃：与插件 iframe 执行约束冲突，推迟到 v2

### 方案 函数代理 Proxy 模式
- 优点：精确控制粒度
- 缺点：需显式包装每个函数，TS 类型推断复杂，性能开销
- 为何不选：被弃：hookable 显式包装更清晰

## 影响
- src/plugins/hook-registry.ts（HookRegistry + 两阶段桥协议）
- src/plugins/hookable.ts（hookable 包装器）
- src/plugins/types.ts（contributes.hooks + hook:register 权限）
- src/plugins/sandbox.ts（iframe 桥注入 __pluginHookLocal + registerHook）
- src/plugins/plugin-api.ts（PluginBridge.registerHook）
- src/plugins/plugin-loader.tsx（停用清理 hooks）
- src/contexts/RunningContext.tsx（launchInstanceFlow hookable）
- src/api/instance.ts（launchInstance/syncScan hookable）
- src/api/versions.ts（scanVersions hookable）
- src-backend/qomicex-backend/src/services/plugin.rs（PluginContributes.hooks）
- qomicex-tauri-i18n（7 语言 hookRegister 权限文案）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-30 | v1.0 | 初版创建 | AI Agent |