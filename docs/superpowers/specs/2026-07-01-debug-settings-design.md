# 调试设置页 — 设计文档

**日期:** 2026-07-01
**状态:** 已确认

## 背景

项目目前没有调试入口，排查问题需要手动查看后端控制台和前端浏览器控制台。需要一个统一的调试页面来集中查看日志、诊断信息和临时调试开关。

## 目标

- 连按 8 次 F8（5 秒内）打开调试页
- 实时查看后端 TraceBufferStore 的日志流
- 导出日志文件、触发 TraceDump
- 显示启动器诊断信息（系统、版本、连通性、路径）
- 临时调试开关（禁用动画、组件边界、模拟 API 错误、网络日志、禁用缓存）

---

## 触发方式

- **快捷键**: 连按 8 次 F8，5 秒内完成
- **目标**: 导航到 `/settings?tab=debug`
- **实现**: `Layout.tsx` 中添加 `keydown` 监听，维护 `pressCount` + 5 秒超时定时器

---

## 后端变更

### 新增 DiagnosticsController

`src-backend/Qomicex.Launcher.Backend/Controllers/DiagnosticsController.cs`

注入 `TraceBufferStore`、`TraceDumpService`、`IHttpClientFactory`。

| 方法 | 路由 | 功能 |
|------|------|------|
| `GET` | `/api/diagnostics/trace` | 返回 `string[]`（`TraceBufferStore.Snapshot()`） |
| `POST` | `/api/diagnostics/dump` | 调用 `TraceDumpService.Dump("manual")`，返回 `{ path: string }` |
| `GET` | `/api/diagnostics/health` | 并发请求 Modrinth/CurseForge API 根地址，返回 `{ modrinth: { ok, latency }, curseforge: { ok, latency }, backend: true }` |

### Program.cs 注册

在 `Program.cs` 的 `AddSingleton` 中将 `TraceBufferStore` 和 `TraceDumpService` 注册为可通过 DI 注入（已注册为单例，无需改动）。

---

## 前端变更

### 1. Settings.tsx — 新增"调试"分类

在现有 5 个分类外新增 `debug`：

```ts
{ id: 'debug', label: '调试', icon: faBug }
```

F8 触发导航时设置 URL search param `tab=debug`。

右侧内容为调试 Tab 组件（新建 `DebugTab.tsx`）。

### 2. DebugTab.tsx — 调试页主组件

**Props**: 无（独立组件，通过 hooks 获取数据）

**3 个 Card 区域**:

#### Card 1: 实时日志

```
┌─ 实时日志 ─────────────────────────────────────┐
│ [自动滚动] [清空] [导出日志] [触发 Dump]          │
│ ┌─────────────────────────────────────────────┐ │
│ │ <monospace 日志行，深色背景，可滚动>          │ │
│ └─────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

- 1 秒轮询 `GET /api/diagnostics/trace`，追加新行
- "自动滚动" 按钮切换：ON 时滚动到底部；用户手动上滚暂停
- "清空" 清空前端日志缓冲区
- "导出日志" 拼接日志文本 → `Blob` → `URL.createObjectURL` → 触发下载
- "触发 Dump" → `POST /api/diagnostics/dump` → 显示成功/失败

#### Card 2: 启动器诊断

```
┌─ 启动器诊断 ────────────────────────────────────┐
│ 系统信息   │ OS: Windows 11, CPU: Intel, RAM: 16GB / 32GB  │
│ 版本信息   │ Launcher: 0.1.0, Tauri: 2.x, React: 19.x      │
│ 连通状态   │ Backend: ✅ | Modrinth: ✅ 120ms | CF: ❌     │
│ API 健康   │ GET /api/instances: ✅ 45ms ................. │
│            │ GET /api/settings: ✅ 30ms .................  │
│ 路径信息   │ QOMICEX_HOME: D:/qomicex-launcher             │
│            │ GameDir: .minecraft                            │
└────────────────────────────────────────────────────────────┘
```

- 系统信息：调用已有 `getSystemInfo()` API
- 版本信息：前端硬编码 + `navigator` API
- 连通状态：`GET /api/diagnostics/health`
- API 健康：依次调用已有 API（instances、settings、resources/search 等）
- 路径信息：从 settings API 或前端环境变量获取

#### Card 3: 调试开关

```
┌─ 调试开关（临时，不持久化）──────────────────────┐
│ ☐ 禁用动画     ☐ 显示组件边界   ☐ 模拟 API 错误  │
│ ☐ 网络请求日志  ☐ 禁用缓存                       │
└─────────────────────────────────────────────────┘
```

- 通过 React Context (`DebugContext`) 管理状态
- 不写入 `AppSettings`，刷新页面后重置

### 3. DebugContext.tsx — 调试状态 Context

```ts
interface DebugState {
  disableAnimations: boolean
  showComponentBoundaries: boolean
  simulateApiErrors: boolean
  networkLogging: boolean
  disableCaching: boolean
}
```

Provider 包裹在 `Layout.tsx` 中，所有开关通过 Context 影响全局行为：

| 开关 | 实现方式 |
|------|---------|
| 禁用动画 | 覆盖 CSS 变量 `--anim-duration-multiplier: 0` |
| 显示组件边界 | 注入 `<style>* { outline: 1px solid rgba(255,0,0,0.3) !important }</style>` |
| 模拟 API 错误 | DebugContext 通过全局 `window.__DEBUG__` 对象暴露开关，`client.ts` 读取该对象决定是否 mock |
| 网络请求日志 | 同上，`client.ts` 的 `request` 函数中按开关输出 console.log |
| 禁用缓存 | 同上，给 API 请求 URL 追加 `_t=Date.now()` 参数 |

### 4. Layout.tsx — F8 键盘监听

```tsx
useEffect(() => {
  let count = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const handler = (e: KeyboardEvent) => {
    if (e.key === 'F8') {
      e.preventDefault()
      count++
      if (count >= 8) {
        count = 0
        if (timer) clearTimeout(timer)
        navigate('/settings?tab=debug')
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { count = 0 }, 5000)
    }
  }

  document.addEventListener('keydown', handler)
  return () => {
    document.removeEventListener('keydown', handler)
    if (timer) clearTimeout(timer)
  }
}, [navigate])
```

### 5. 路由

不新增路由。调试页作为 `/settings?tab=debug` 的 Tab 内嵌在 Settings 页面中。

---

## 文件变更清单

| 操作 | 文件 |
|------|------|
| 创建 | `src-backend/.../Controllers/DiagnosticsController.cs` |
| 创建 | `src/components/DebugTab.tsx` |
| 创建 | `src/components/DebugContext.tsx` |
| 修改 | `src/pages/Settings.tsx` — 新增 debug 分类 + DebugTab 渲染 |
| 修改 | `src/components/Layout.tsx` — F8 监听 + DebugContext Provider |
| 修改 | `src/api/client.ts` — 模拟 API 错误 + 缓存禁用逻辑 |

---

## 不涉及的范围

- 不持久化调试开关（刷新归零）
- 不修改现有 Settings 数据模型
- 不新增路由
- LogAnalysis 页面保持不变（不嵌入调试页）
