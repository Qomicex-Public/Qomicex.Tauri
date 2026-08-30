# 插件 Hook 系统

> 生成时间：2026-08-30 19:37

# 插件 Hook 系统

> 状态：v1 已实现（2026-08-30）。关联决策：ADR-064。

## 概述

插件可通过 Hook 系统拦截/增强启动器方法（如启动、版本扫描、实例同步），在方法**执行前**修改参数、**执行后**修改结果、**阻止**默认实现或**完全替换**实现。适用于功能强化、性能优化、逻辑重构。

- 执行模型：**Koa 式洋葱中间件管道**（`(ctx, next) => Promise<void>`）
- 执行位置：插件 hook 函数在**插件 iframe** 中执行
- 数据传递：Context 对象（`ctx.args` / `ctx.result` / `ctx.prevent()`）
- 注册：manifest `contributes.hooks` 声明 + 运行时 `registerHook` API（混合）
- 权限：`hook:register`（danger）

## 可 hook 的方法（首批）

| 方法名 | 文件 | 签名 | 典型用途 |
|--------|------|------|---------|
| `launchInstanceFlow` | `src/contexts/RunningContext.tsx` | `(id, name, javaInfo?, quickJoin?)` | 前端启动编排拦截、阻止启动 |
| `launchInstance` | `src/api/instance.ts` | `(id, options?)` | 注入 joinServer/accountUuid、修改启动请求 |
| `syncScan` | `src/api/instance.ts` | `(gameDir, versions)` | 修改扫描结果、过滤/增强实例列表 |
| `scanVersions` | `src/api/versions.ts` | `(gameDir)` | 虚拟版本、过滤版本、自定义 loader 探测 |

后续方法可随时用 `hookable()` 包装器暴露（见下）。

## 插件侧用法

### manifest 声明（可选，文档性 + 权限预检）

```json
{
  "permissions": ["hook:register"],
  "contributes": {
    "hooks": [
      { "method": "scanVersions", "priority": 10 }
    ]
  }
}
```

### 注册 hook（运行时）

```js
__PLUGIN_API__.registerHook('scanVersions', async (ctx, next) => {
  // before：next() 前修改参数
  ctx.args[0] = ctx.args[0] + '/custom'

  // 继续默认实现（impl 用修改后的 args）
  await next()

  // after：next() 后修改结果
  ctx.result = [...ctx.result, { name: 'virtual-1.20.1', gameVersion: '1.20.1', state: 'Available' }]
})
```

### 能力对照

| 能力 | 写法 |
|------|------|
| 读取参数 | `ctx.args` |
| 修改参数 | `ctx.args[i] = ...`（before） |
| 修改返回值 | `ctx.result = ...`（after） |
| 阻止执行 | `ctx.prevent()`（跳过默认实现与后续 hook） |
| 完全替换 | `ctx.prevent()` + `ctx.result = 自定义结果` |
| 嵌套 | 多个插件按注册顺序洋葱执行，先注册者在外层 |

### 阻止启动示例

```js
__PLUGIN_API__.registerHook('launchInstance', async (ctx) => {
  const [id] = ctx.args
  if (id === 'blocked-instance') {
    ctx.prevent()
    ctx.result = { success: false, error: '被插件阻止启动' }
  }
})
```

## 架构

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/plugins/hook-registry.ts` | 主窗口 HookRegistry（method→hooks 表 + run 洋葱管道）+ 两阶段桥协议 |
| `src/plugins/hookable.ts` | `hookable(method, impl)` 包装器，暴露方法为可 hook 点 |
| `src/plugins/types.ts` | `PluginContributes.hooks` + `hook:register` 权限目录 |
| `src/plugins/sandbox.ts` | iframe 桥注入 `__pluginHookLocal` + `registerHook` + 两阶段桥处理 |
| `src/plugins/plugin-api.ts` | `PluginBridge.registerHook` 类型与主窗口侧实现 |
| `src/plugins/plugin-loader.tsx` | 停用时 `unregisterAll` 清理 hooks |

### 两阶段桥（跨 iframe 洋葱）

插件 hook 函数在 iframe 中执行，而默认实现（impl）在主窗口执行。为保证洋葱语义（before → impl → after），采用两阶段桥：

```
主窗口 hookable 调用
  └─ HookRegistry.run(method, args, impl)
       ├─ hook[0] (frame): 发 __plugin_hook_invoke → iframe
       │     ├─ hook before 改 ctx.args
       │     └─ 调 next() 挂起，回传 __plugin_hook_before_done
       ├─ 主窗口继续管道 → impl(...ctx.args) → ctx.result
       ├─ 发 __plugin_hook_continue(result) → iframe
       │     ├─ next() resolve，hook after 改 ctx.result
       │     └─ 回传 __plugin_hook_after_done
       └─ 返回最终 result
```

### 消息协议

| 消息 | 方向 | 载荷 |
|------|------|------|
| `__plugin_hook_register` | iframe→主窗口 | `{ pluginId, method }`（权限校验后登记转发型 hook） |
| `__plugin_hook_unregister_all` | iframe→主窗口 | `{ pluginId }` |
| `__plugin_hook_invoke` | 主窗口→iframe | `{ callId, payload: { method, pluginId, args, result, prevented } }` |
| `__plugin_hook_before_done` | iframe→主窗口 | `{ callId, ctx }` |
| `__plugin_hook_continue` | 主窗口→iframe | `{ callId, result }` |
| `__plugin_hook_after_done` | iframe→主窗口 | `{ callId, ctx }` |

## 权限

`hook:register`（danger 级）：插件需在 manifest `permissions` 中声明，否则 `registerHook` 上报被主窗口拒绝。

## 已知限制（v1）

- 仅覆盖前端方法层（hookable 包装的方法）；后端 Rust 进程内 hook 为 v2（需插件回调端点机制）。
- 内联渲染插件（`render: "inline"`）的 hook 直接在主窗口上下文执行（同 registry），iframe 插件经桥执行。
- l4 WebView 插件的 registerHook 暂未接入跨窗口桥（走主窗口侧实现路径）。

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-08-30 | v1.0 | 初版创建 | AI Agent |