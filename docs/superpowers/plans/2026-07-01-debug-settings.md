# 调试设置页 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过连按 8 次 F8（2 秒内）打开调试设置页，提供实时日志查看、导出、诊断信息、调试开关功能。

**Architecture:** 后端新增 DiagnosticsController 暴露 trace/dump/health API。前端通过模块级 `window.__DEBUG__` 单例管理开关状态（重启归零），DebugContext 同步到 React 组件树。Layout.tsx 监听 F8 连击。

**Tech Stack:** ASP.NET Core (.NET 10), React 19 + TypeScript, Tailwind CSS

## Global Constraints

- 前端所有 import 必须带文件扩展名
- 使用已有的 `cn()`、`Card`、`Button`、`Input`、`Checkbox` 等 UI 组件
- 调试开关不持久化到 `AppSettings`，重启归零，路由切换保留
- 无测试框架（项目无测试基础设施）
- 后端已有 `TraceBufferStore`、`TraceDumpService` 单例，直接注入即可

---

### Task 1: 后端 — DiagnosticsController

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Controllers/DiagnosticsController.cs`

**Interfaces:**
- Produces: `GET /api/diagnostics/trace` → `string[]`, `POST /api/diagnostics/dump` → `{ path: string }`, `GET /api/diagnostics/health` → `{ modrinth: { ok, latency }, curseforge: { ok, latency }, backend: true }`

- [ ] **Step 1: 创建 DiagnosticsController**

创建 `src-backend/Qomicex.Launcher.Backend/Controllers/DiagnosticsController.cs`：

```csharp
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Diagnostics;
using Qomicex.Launcher.Backend.Services;
using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/diagnostics")]
public class DiagnosticsController : ControllerBase
{
    private readonly TraceBufferStore _traceBuffer;
    private readonly TraceDumpService _traceDump;
    private readonly IHttpClientFactory _httpClientFactory;

    public DiagnosticsController(
        TraceBufferStore traceBuffer,
        TraceDumpService traceDump,
        IHttpClientFactory httpClientFactory)
    {
        _traceBuffer = traceBuffer;
        _traceDump = traceDump;
        _httpClientFactory = httpClientFactory;
    }

    [HttpGet("trace")]
    public IActionResult GetTrace()
    {
        return Ok(_traceBuffer.Snapshot());
    }

    [HttpPost("dump")]
    public IActionResult DumpTrace()
    {
        var path = _traceDump.Dump("manual");
        return Ok(new { path });
    }

    [HttpGet("health")]
    public async Task<IActionResult> Health()
    {
        var result = new
        {
            backend = true,
            modrinth = await PingUrl("https://api.modrinth.com/v2/statistics"),
            curseforge = await PingUrl("https://api.curseforge.com"),
        };
        return Ok(result);
    }

    private async Task<object> PingUrl(string url)
    {
        try
        {
            var client = _httpClientFactory.CreateClient();
            var sw = Stopwatch.StartNew();
            var response = await client.GetAsync(url);
            sw.Stop();
            return new { ok = response.IsSuccessStatusCode, latency = sw.ElapsedMilliseconds };
        }
        catch
        {
            return new { ok = false, latency = -1 };
        }
    }
}
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded, 0 errors

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/DiagnosticsController.cs
git commit -m "feat: add DiagnosticsController with trace, dump, health endpoints"
```

---

### Task 2: 前端 — DebugContext + window.__DEBUG__ 单例

**Files:**
- Create: `src/components/DebugContext.tsx`

**Interfaces:**
- Produces: `DebugProvider` 组件, `useDebug()` hook, `window.__DEBUG__` 全局对象

- [ ] **Step 1: 创建 DebugContext.tsx**

```tsx
import { createContext, useContext, useState, useCallback, useEffect } from 'react'

export interface DebugState {
  disableAnimations: boolean
  showComponentBoundaries: boolean
  simulateApiErrors: boolean
  networkLogging: boolean
  disableCaching: boolean
}

const INITIAL: DebugState = {
  disableAnimations: false,
  showComponentBoundaries: false,
  simulateApiErrors: false,
  networkLogging: false,
  disableCaching: false,
}

interface DebugContextValue {
  state: DebugState
  toggle: (key: keyof DebugState) => void
}

const ctx = createContext<DebugContextValue>({ state: INITIAL, toggle: () => {} })

declare global {
  interface Window {
    __DEBUG__: DebugState
  }
}

// 模块级单例：路由切换保留，重启归零
const globalState: DebugState = window.__DEBUG__ ?? { ...INITIAL }
window.__DEBUG__ = globalState

export function DebugProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DebugState>(globalState)

  const toggle = useCallback((key: keyof DebugState) => {
    setState(prev => {
      const next = { ...prev, [key]: !prev[key] }
      Object.assign(globalState, next)
      return next
    })
  }, [])

  useEffect(() => {
    // 同步到 client.ts 可读取的全局对象
    window.__DEBUG__ = { ...state }
  }, [state])

  return <ctx.Provider value={{ state, toggle }}>{children}</ctx.Provider>
}

export function useDebug() {
  return useContext(ctx)
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/DebugContext.tsx
git commit -m "feat: add DebugContext with window.__DEBUG__ singleton"
```

---

### Task 3: 前端 — client.ts 调试开关集成

**Files:**
- Modify: `src/api/client.ts`

**Interfaces:**
- Consumes: `window.__DEBUG__` (Task 2)
- Produces: 网络日志、缓存禁用、API 错误模拟（通过 `request` 函数注入）

- [ ] **Step 1: 修改 client.ts 的 request 函数**

在 `async function request<T>(path, options)` 函数体的**第一行**（`const res = await fetch(...)` 之前）注入调试逻辑：

```ts
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const debug = window.__DEBUG__

  if (debug?.networkLogging) {
    console.log(`[API] ${options?.method ?? 'GET'} ${path}`)
  }

  if (debug?.simulateApiErrors && Math.random() < 0.3) {
    const fakeError: ApiErrorResponse = {
      code: 'DEBUG_SIMULATED',
      message: `[调试模拟] 请求失败: ${options?.method ?? 'GET'} ${path}`,
      detail: null,
      traceId: 'debug-trace-id',
      timestamp: new Date().toISOString(),
      status: 500,
    }
    throw new ApiError(fakeError)
  }

  const url = debug?.disableCaching
    ? `${API_BASE}${path}${path.includes('?') ? '&' : '?'}_t=${Date.now()}`
    : `${API_BASE}${path}`

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  // ... 剩余代码不变
```

- [ ] **Step 2: 修改文件顶部的 import 和 API_BASE 行附近的结构**

确保 `window.__DEBUG__` 的类型声明能在 C# 中正确引用。在 `API_BASE` 前面添加类型声明（如果 DebugContext 的 declare global 已覆盖则不需要——但 client.ts 是独立的模块文件，需要确认类型检查）。

实际做法：在 `request` 函数中使用 `(window as any).__DEBUG__` 避免类型问题：

```ts
const debug = (window as any).__DEBUG__
```

完整改动后的 `request` 函数：

```ts
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const debug = (window as any).__DEBUG__

  if (debug?.networkLogging) {
    console.log(`[API] ${debug?.disableCaching ? '⚡' : ''}${options?.method ?? 'GET'} ${path}`)
  }

  if (debug?.simulateApiErrors && Math.random() < 0.3) {
    const fakeError: ApiErrorResponse = {
      code: 'DEBUG_SIMULATED',
      message: `[调试模拟] 请求失败: ${options?.method ?? 'GET'} ${path}`,
      detail: null,
      traceId: 'debug-trace-id',
      timestamp: new Date().toISOString(),
      status: 500,
    }
    throw new ApiError(fakeError)
  }

  const url = debug?.disableCaching
    ? `${API_BASE}${path}${path.includes('?') ? '&' : '?'}_t=${Date.now()}`
    : `${API_BASE}${path}`

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    let parsed: ApiErrorResponse | null = null
    try {
      const json = await res.json()
      if (json && typeof json.code === 'string' && typeof json.message === 'string') {
        parsed = json as ApiErrorResponse
      }
    } catch { }
    if (parsed) throw new ApiError(parsed)
    throw new ApiError({
      code: 'UNKNOWN_ERROR', message: `请求失败 (${res.status})`,
      detail: null, traceId: '', timestamp: new Date().toISOString(), status: res.status,
    })
  }
  if (res.status === 204) return undefined as T
  return res.json()
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/api/client.ts
git commit -m "feat: integrate debug toggles (network log, cache, simulate errors) into API client"
```

---

### Task 4: 前端 — DebugTab 组件（日志 + 诊断 + 开关）

**Files:**
- Create: `src/components/DebugTab.tsx`

**Interfaces:**
- Consumes: `useDebug()` (Task 2), `getSystemInfo()` (existing), API diagnostics endpoints
- Produces: 完整的调试 Tab UI（3 个 Card）

- [ ] **Step 1: 创建 DebugTab.tsx**

写入完整的 `src/components/DebugTab.tsx`：

```tsx
import { useEffect, useState, useRef, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate, faDownload, faTrashCan, faBug, faCircleCheck, faCircleXmark, faServer, faGlobe } from '@fortawesome/free-solid-svg-icons'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card.tsx'
import { Button } from './ui/button.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { cn } from '../lib/utils.ts'
import { useDebug } from './DebugContext.tsx'
import { getSystemInfo } from '../api/system.ts'
import { get, post, API_BASE } from '../api/client.ts'
import type { SystemInfo } from '../types/index.ts'

function LogCard() {
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async () => {
    try {
      const entries = await get<string[]>('/diagnostics/trace')
      setLogs(prev => {
        if (entries.length <= prev.length) return entries
        return entries
      })
    } catch {}
  }, [])

  useEffect(() => {
    fetchLogs()
    const timer = setInterval(fetchLogs, 1000)
    return () => clearInterval(timer)
  }, [fetchLogs])

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleExport = () => {
    const text = logs.join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `launcher-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDump = async () => {
    try {
      const res = await post<{ path: string }>('/diagnostics/dump')
      alert(`日志已导出到: ${res.path}`)
    } catch {}
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><FontAwesomeIcon icon={faServer} className="mr-2 h-4 w-4" />实时日志</CardTitle>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={autoScroll ? 'default' : 'outline'} onClick={() => setAutoScroll(!autoScroll)} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faRotate} className={cn('h-3 w-3', autoScroll && 'animate-spin')} />自动滚动
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLogs([])} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faTrashCan} className="h-3 w-3" />清空
          </Button>
          <Button size="sm" variant="outline" onClick={handleExport} disabled={logs.length === 0} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />导出日志
          </Button>
          <Button size="sm" variant="outline" onClick={handleDump} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />触发 Dump
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div
          ref={containerRef}
          onScroll={() => {
            if (containerRef.current) {
              const { scrollTop, scrollHeight, clientHeight } = containerRef.current
              setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20)
            }
          }}
          className="h-80 overflow-y-auto bg-muted/30 p-3 font-mono text-xs leading-relaxed"
        >
          {logs.length === 0 ? (
            <span className="text-muted-foreground">暂无日志...</span>
          ) : (
            logs.map((line, i) => <div key={i} className="text-foreground/80 whitespace-pre-wrap">{line}</div>)
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function DiagnosticsCard() {
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [health, setHealth] = useState<any>(null)
  const [apiTests, setApiTests] = useState<Record<string, { ok: boolean; latency: number }>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [sys, h] = await Promise.all([
          getSystemInfo(),
          get<any>('/diagnostics/health'),
        ])
        if (cancelled) return
        setSysInfo(sys)
        setHealth(h)
      } catch {}
      // API 健康检查
      const endpoints = ['/instances', '/settings', '/resources/search?category=mod&pageSize=1']
      const results: typeof apiTests = {}
      for (const ep of endpoints) {
        const start = performance.now()
        try {
          await get(ep)
          results[ep] = { ok: true, latency: Math.round(performance.now() - start) }
        } catch {
          results[ep] = { ok: false, latency: -1 }
        }
      }
      if (!cancelled) setApiTests(results)
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle><FontAwesomeIcon icon={faBug} className="mr-2 h-4 w-4" />启动器诊断</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...</div>
        ) : (
          <>
            {sysInfo && (
              <div>
                <p className="font-medium text-xs text-muted-foreground mb-1">系统信息</p>
                <p className="text-xs">OS: {sysInfo.osName} {sysInfo.osArch} | CPU: {sysInfo.cpuName} | RAM: {(sysInfo.availableMemory / 1024).toFixed(1)} / {(sysInfo.memory / 1024).toFixed(1)} GiB</p>
              </div>
            )}
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">版本信息</p>
              <p className="text-xs">Launcher: 0.1.0 | React: 19 | Build: {import.meta.env.DEV ? 'dev' : 'release'}</p>
            </div>
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">连通状态</p>
              <p className="text-xs space-x-3">
                <span><FontAwesomeIcon icon={faCircleCheck} className="h-3 w-3 text-green-500 mr-1" />Backend</span>
                {health && (
                  <>
                    <span><FontAwesomeIcon icon={health.modrinth?.ok ? faCircleCheck : faCircleXmark} className={cn('h-3 w-3 mr-1', health.modrinth?.ok ? 'text-green-500' : 'text-red-500')} />Modrinth ({health.modrinth?.latency ?? '?'}ms)</span>
                    <span><FontAwesomeIcon icon={health.curseforge?.ok ? faCircleCheck : faCircleXmark} className={cn('h-3 w-3 mr-1', health.curseforge?.ok ? 'text-green-500' : 'text-red-500')} />CurseForge ({health.curseforge?.latency ?? '?'}ms)</span>
                  </>
                )}
              </p>
            </div>
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">API 健康检查</p>
              <div className="space-y-0.5">
                {Object.entries(apiTests).map(([ep, r]) => (
                  <p key={ep} className="text-xs"><FontAwesomeIcon icon={r.ok ? faCircleCheck : faCircleXmark} className={cn('h-3 w-3 mr-1', r.ok ? 'text-green-500' : 'text-red-500')} />{ep} {r.ok ? `${r.latency}ms` : 'FAILED'}</p>
                ))}
              </div>
            </div>
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">路径信息</p>
              <p className="text-xs">API Base: {API_BASE}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function TogglesCard() {
  const { state, toggle } = useDebug()

  const items: { key: keyof typeof state; label: string }[] = [
    { key: 'disableAnimations', label: '禁用动画' },
    { key: 'showComponentBoundaries', label: '显示组件边界' },
    { key: 'simulateApiErrors', label: '模拟 API 错误' },
    { key: 'networkLogging', label: '网络请求日志' },
    { key: 'disableCaching', label: '禁用缓存' },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle><FontAwesomeIcon icon={faBug} className="mr-2 h-4 w-4" />调试开关（临时，重启归零）</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {items.map(item => (
            <label key={item.key} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={state[item.key]} onCheckedChange={() => toggle(item.key)} />
              {item.label}
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default function DebugTab() {
  return (
    <div className="space-y-4">
      <LogCard />
      <DiagnosticsCard />
      <TogglesCard />
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/DebugTab.tsx
git commit -m "feat: add DebugTab with live logs, diagnostics, and debug toggles"
```

---

### Task 5: 前端 — Settings.tsx 新增调试分类

**Files:**
- Modify: `src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `DebugTab` (Task 4)
- Produces: 第 6 个 sidebar 分类 `debug`

- [ ] **Step 1: 添加 import 和 CATEGORIES 条目**

在文件顶部添加 import：

```tsx
import { faBug } from '@fortawesome/free-solid-svg-icons'
import DebugTab from '../components/DebugTab.tsx'
```

在 `CATEGORIES` 数组中追加第 6 项：

```tsx
const CATEGORIES = [
  { id: 'launcher', label: '启动器', icon: faRocket },
  { id: 'java', label: 'Java 运行时', icon: faCoffee },
  { id: 'appearance', label: '外观', icon: faPalette },
  { id: 'roomcode', label: '联机房间码', icon: faKey },
  { id: 'about', label: '关于', icon: faInfoCircle },
  { id: 'debug', label: '调试', icon: faBug },
]
```

- [ ] **Step 2: 添加 DebugTab 渲染**

在 Settings 页面的内容区（5 个分类的条件渲染区域），追加 debug tab 的渲染。找到 `{activeCategory === 'about' && (...)}` 区块之后，添加：

```tsx
{activeCategory === 'debug' && <DebugTab />}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat: add debug category to settings with DebugTab"
```

---

### Task 6: 前端 — Layout.tsx F8 连击监听 + DebugProvider + 组件边界/动画开关

**Files:**
- Modify: `src/components/Layout.tsx`

**Interfaces:**
- Consumes: `DebugProvider` (Task 2), `useDebug()` (Task 2)
- Produces: F8 连击 → `/settings?tab=debug`，全局 CSS 注入（组件边界、禁用动画）

- [ ] **Step 1: 读取 Layout.tsx 当前内容**

先读取 `src/components/Layout.tsx` 了解当前结构，确认注入点。

- [ ] **Step 2: 添加 import**

```tsx
import { DebugProvider, useDebug } from './DebugContext.tsx'
import { useNavigate } from 'react-router-dom'
```

（检查 `useNavigate` 是否已 import——如果已有则不需要重复）

- [ ] **Step 3: 创建内部组件 DebugEffects 处理全局副作用**

在 `Layout` 函数内部，在 `return` 之前添加 hooks（或在 return 的 JSX 中包裹 Provider）：

```tsx
function DebugEffects() {
  const { state } = useDebug()
  const navigate = useNavigate()

  // F8 连击
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
        timer = setTimeout(() => { count = 0 }, 2000)
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      if (timer) clearTimeout(timer)
    }
  }, [navigate])

  // 禁用动画
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--anim-duration-multiplier',
      state.disableAnimations ? '0' : ''
    )
  }, [state.disableAnimations])

  // 组件边界
  useEffect(() => {
    const id = 'debug-component-boundaries'
    if (state.showComponentBoundaries) {
      if (!document.getElementById(id)) {
        const style = document.createElement('style')
        style.id = id
        style.textContent = '* { outline: 1px solid rgba(255,0,0,0.3) !important }'
        document.head.appendChild(style)
      }
    } else {
      const el = document.getElementById(id)
      if (el) el.remove()
    }
  }, [state.showComponentBoundaries])

  return null
}
```

- [ ] **Step 4: 用 DebugProvider 包裹 Layout 内容**

修改 Layout 的 `return`，用 `<DebugProvider>` 包裹渲染内容（不是整个 div，而是包含 `DebugEffects` 的 fragment）。在现有根 `<div className="flex h-screen">` 内部顶部加入 `<DebugEffects />`，并用 `<DebugProvider>` 包裹。

例如，在 `return (` 之后的第一个元素前加入 `<DebugProvider>`:

```tsx
return (
  <DebugProvider>
    <div className="flex h-screen ...">
      <DebugEffects />
      {/* 现有内容 */}
    </div>
  </DebugProvider>
)
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/components/Layout.tsx
git commit -m "feat: add F8 combo listener, DebugProvider, component boundary and animation debug toggles"
```

---

### Task 7: 验证 — 构建检查

- [ ] **Step 1: 后端编译**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded, 0 errors

- [ ] **Step 2: 前端类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: 前端构建**

Run: `npm run build`
Expected: Build succeeded
