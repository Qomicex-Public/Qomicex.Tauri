// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { API_BASE } from '../api/client.ts'
import { openStream, createSseParser, uploadFile } from '../api/ipc.ts'
import { addTask } from '../stores/downloadStore.ts'
import { normalizeResourceKind } from '../lib/downloadGroups.ts'
import { RESOURCES } from '../../qomicex-tauri-i18n/src/index.ts'
import { resolveLang } from '../i18n/lang.ts'
import { getHookRegistry } from './hook-registry.ts'
import { requestPluginSettings } from './pluginSettingsNav.ts'
import type { HookContext } from './hook-registry.ts'

function i18nKey(key: string, params?: Record<string, string | number>): string {
  const dict = RESOURCES[resolveLang(localStorage.getItem('qomicex-language'))] as unknown as Record<string, unknown>
  let val: unknown = dict
  for (const part of key.split('.')) {
    if (val && typeof val === 'object' && part in val) val = (val as Record<string, unknown>)[part]
    else return key
  }
  if (typeof val !== 'string') return key
  if (!params) return val
  return val.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

export interface ProxyRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  body?: string | null
  bodyBase64?: string | null
}

export interface PluginListEntry {
  id: string
  name: string
  version: string
  status: string
  [k: string]: unknown
}

export interface PluginDownloadOptions {
  url: string
  targetPath?: string
  instanceId?: string
  category?: string
  fileName?: string
  headers?: Record<string, string>
  extract?: boolean
  name?: string
}

export interface PluginDownloadStartResult {
  taskId: string
  status: string
  targetPath: string
}

/** 批量下载的单个目标（一次调用只占下载中心一张卡）。 */
export interface PluginBatchDownloadFile {
  url: string
  destPath: string
  headers?: Record<string, string>
}

export interface PluginBatchDownloadOptions {
  files: PluginBatchDownloadFile[]
  /** 归属的外部任务 id（task.register 返回值）；省略则自建只含单步的任务。 */
  taskId?: string
  /** 推进哪个步骤的百分比；省略则只推任务总进度。 */
  stepId?: string
  /** 自建任务时的卡片标题。 */
  title?: string
}

export interface PluginBatchDownloadResult {
  taskId: string
  /** 批次 id：用 `download.batchStatus` 轮询完成状态。 */
  batchId: string
  totalFiles: number
}

export interface PluginBatchStatus {
  status: 'running' | 'completed' | 'failed'
  totalFiles: number
  error?: string
}

/** 插件自报的多步骤任务（复用下载中心同款卡片渲染）。 */
export interface PluginTaskStepSpec {
  id: string
  weight?: number
  label?: string
}

export interface PluginTaskUpdate {
  status?: string
  stage?: string
  stepId?: string
  stepStatus?: 'pending' | 'active' | 'done' | 'failed'
  stepPercent?: number
  stepLabel?: string
  currentFile?: string
  error?: string
  blockedFiles?: number
}

export interface PluginTaskProgress {
  instanceId: string
  status: string
  progress: number
  stage: string
  title?: string
  steps: Array<{ id: string; status: string; percent: number; weight: number; label?: string }>
  currentFile: string
  blockedFiles?: number
  error?: string | null
}

/** CurseForge 文件元数据（不暴露 API key）。 */
export interface PluginCfFileInfo {
  projectId: number
  fileId: number
  fileName: string
  downloadUrl: string | null
  fileLength: number
  blockedReason?: string
}

export interface PluginDownloadSnapshot {
  sessionId: string
  type: string
  status: string
  stage: string
  progress: number
  currentFile: string | null
  totalFiles: number
  completedFiles: number
  failedFiles: number
  speed: number
  error: string | null
  isPaused: boolean
  instanceId: string | null
}

export interface PluginModpackInstallOptions {
  id: string
  type?: 'mr' | 'cf' | 'ftb' | 'modrinth' | 'curseforge' | 'ftb'
  projectId?: string
  fileId?: string
  path?: string
  gameDir: string
  versionIsolation?: boolean
  maxMemory?: number
}

/** process.spawn 选项（issue #295：插件常驻进程管理）。 */
export interface PluginProcessSpawnOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface PluginProcessHandleInfo {
  pid: number
  command: string
  args: string[]
  startedAtMs: number
  alive: boolean
  exitCode: number | null
  oldestSeq: number
  nextSeq: number
}

export interface PluginProcessLogLine {
  seq: number
  /** "out" | "err" */
  stream: string
  text: string
}

export interface PluginProcessLogsResult {
  lines: PluginProcessLogLine[]
  nextSeq: number
  oldestSeq: number
  alive: boolean
  exitCode: number | null
}

export interface PluginFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modifiedMs?: number | null
}

export interface PluginDialogOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface PluginBridge {
  getSettings: () => Promise<Record<string, unknown>>
  setSettings: (key: string, value: unknown) => Promise<void>
  setCache: (key: string, value: unknown, ttlSeconds?: number) => Promise<void>
  getCache: (key: string) => Promise<unknown>
  callBackend: (endpoint: string, data?: unknown) => Promise<unknown>
  uploadPlugin: (fileData: number[], fileName: string) => Promise<unknown>
  proxyFetch: (req: ProxyRequest) => Promise<ProxyResponse>
  proxyFetchStream: (req: ProxyRequest, onChunk: (chunk: string) => void, signal?: AbortSignal) => Promise<void>
  registerMethod: (method: string, fn: (...args: unknown[]) => unknown) => void
  /** 注册 hook：拦截/增强启动器 hookable 方法（如 launchInstance、scanVersions）。
   * handler 为洋葱中间件 `(ctx, next) => Promise<void>`：next 前改 ctx.args，
   * next 后改 ctx.result，ctx.prevent() 阻止默认实现。需 hook:register 权限。 */
  registerHook: (method: string, handler: (ctx: HookContext, next: () => Promise<void>) => Promise<void>) => void
  callPlugin: (pluginId: string, method: string, ...args: unknown[]) => Promise<unknown>
  callWasm: (pluginId: string, exportName?: string) => Promise<unknown>
  listWasmPlugins: () => Promise<string[]>
  readText: (path: string, options?: { start?: number; length?: number }) => Promise<{ path: string; content: string }>
  readBytes: (path: string, options?: { start?: number; length?: number }) => Promise<{ path: string; contentBase64: string }>
  writeText: (path: string, content: string) => Promise<{ path: string }>
  writeBytes: (path: string, bytes: Uint8Array) => Promise<{ path: string }>
  deleteFile: (path: string) => Promise<{ path: string }>
  execCommand: (command: string, timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  navigate: (path: string) => void
  /** 打开启动器「设置 → 插件 → 插件设置」并定位到指定插件（缺省定位到本插件第一个设置页）。
   * 目标插件须在 manifest 声明 contributes.settingsPages 才有对应 tab。 */
  openPluginSettings: (targetPluginId?: string) => void
  addMenuItem: (item: { path: string; label: string; icon?: string }) => void
  showToast: (message: string, type?: 'info' | 'error' | 'success') => void
  log: (message: string, level?: 'debug' | 'info' | 'warn' | 'error') => void
  getSystemInfo: () => Promise<unknown>
  openUrl: (url: string) => Promise<void>
  listPlugins: () => Promise<PluginListEntry[]>
  createOverlay: (opts: { title: string; html: string; x?: number; y?: number; width?: number; height?: number; minimizable?: boolean; resizable?: boolean }) => string
  showOverlay: (id: string) => void
  hideOverlay: (id: string) => void
  destroyOverlay: (id: string) => void
  setOverlayHtml: (id: string, html: string) => void
  setOverlayPosition: (id: string, x: number, y: number) => void
  download: {
    addTask: (opts: PluginDownloadOptions) => Promise<PluginDownloadStartResult>
    /** 批量下载：一次调用下多个文件、只占一张卡片（几百个 mod 不会刷屏）。
     * 返回后下载在后台进行，用 `batchStatus(batchId)` 轮询完成。 */
    addBatch: (opts: PluginBatchDownloadOptions) => Promise<PluginBatchDownloadResult>
    batchStatus: (batchId: string) => Promise<PluginBatchStatus | null>
    progress: (taskId: string) => Promise<PluginDownloadSnapshot | null>
    cancel: (taskId: string) => Promise<void>
    list: () => Promise<PluginDownloadSnapshot[]>
    registerInstall: (opts: { instanceId: string; name: string; gameVersion: string; loader?: string; loaderVersion?: string }) => void
  }
  /** 插件自报的分步任务：注册后出现在下载中心，进度由插件自己推进。 */
  task: {
    register: (opts: { taskId?: string; title: string; steps: PluginTaskStepSpec[] }) => Promise<{ taskId: string }>
    update: (taskId: string, patch: PluginTaskUpdate) => Promise<void>
    complete: (taskId: string, error?: string) => Promise<void>
    progress: (taskId: string) => Promise<PluginTaskProgress | null>
  }
  curseforge: {
    /** 批量查 CF 文件 → 下载直链。key 留在启动器，插件只拿结果。 */
    files: (files: Array<{ projectId?: number; fileId: number }>) => Promise<PluginCfFileInfo[]>
  }
  /** 不解压整包，直接读 zip 内单个条目的文本（模组元数据/整合包清单）。
   * 条目不存在返回 null（用于「有这个文件吗」的探测）。 */
  readArchiveEntry: (archivePath: string, entryPath: string, opts?: { maxBytes?: number }) => Promise<{ content: string; size: number } | null>
  modpack: {
    install: (opts: PluginModpackInstallOptions) => Promise<{ instanceId: string }>
  }
  /** 常驻进程管理（issue #295）：spawn 拉起进程，logs 按 seq 游标增量轮询，
   * stdin 写控制台命令，kill 走进程树终止。插件只能管理自己拉起的进程。 */
  process: {
    spawn: (opts: PluginProcessSpawnOptions) => Promise<{ pid: number; startedAtMs: number }>
    stdin: (pid: number, data: string, opts?: { appendNewline?: boolean }) => Promise<void>
    kill: (pid: number) => Promise<{ message: string }>
    alive: (pid: number) => Promise<PluginProcessHandleInfo>
    logs: (pid: number, afterSeq?: number) => Promise<PluginProcessLogsResult>
    list: () => Promise<PluginProcessHandleInfo[]>
  }
  /** 系统/原生文件选择对话框（主窗口 Tauri pick_dialog 中转）。取消返回 null。 */
  pickFile: (opts?: PluginDialogOptions & { multiple?: boolean }) => Promise<string | null>
  pickDirectory: (opts?: PluginDialogOptions) => Promise<string | null>
  /** 本地 zip 解压到目标目录（zip-slip 防护 + 体积上限）。需两个路径的 FS 授权。
   * `prefix` 只解压该子目录；`stripPrefix` 解压时剥掉它（`overrides/mods/a.jar`
   * → `mods/a.jar`）。整合包 overrides 提到根目录就靠这两个选项。 */
  extractArchive: (archivePath: string, destPath: string, opts?: { prefix?: string; stripPrefix?: boolean }) => Promise<{ destPath: string }>
  /** 移动/重命名文件或目录（跨目录 move 也走这里）。需源与目标都有 FS 授权。 */
  renamePath: (from: string, to: string) => Promise<{ path: string }>
  /** 列举目录条目（名称/类型/大小/mtime）。 */
  listDir: (path: string, opts?: { recursive?: boolean; maxEntries?: number }) => Promise<PluginFileEntry[]>
  /** 系统级通知（WebView Notification API）；不可用/被拒返回 false（可降级 showToast）。 */
  sendNotification: (opts: { title: string; body?: string }) => Promise<boolean>
  /** 插件自持 i18n：返回本插件合并后的字符串包（bundle.json 打底、当前 locale
   * 覆盖）。插件运行时 UI 用它渲染自己的文案，不依赖启动器 i18n。 */
  getPluginStrings: () => Promise<Record<string, string>>
  /** 启动器当前 locale（如 'zh-CN'），与 getPluginStrings 的覆盖层一致。 */
  getLocale: () => Promise<string>
  /** 内置图标 SVG 数据（Font Awesome 类名，如 'fa-solid fa-server'）→
   * { width, height, path }。插件用内联 <svg><path/></svg> 渲染（currentColor
   * 跟随主题色），不引入图标字体。未知类名返回 null。 */
  getIconSvg: (cls: string) => Promise<{ width: number; height: number; path: string } | null>
}

export function createPluginBridge(pluginId: string): PluginBridge {
  return {
    getSettings: async () => {
      const res = await fetch(`${API_BASE}/plugins/settings/${pluginId}`)
      if (!res.ok) throw new Error(`Failed to get settings: ${res.status}`)
      return res.json()
    },
    setSettings: async (key, value) => {
      const res = await fetch(`${API_BASE}/plugins/settings/${pluginId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      })
      if (!res.ok) throw new Error(`Failed to set settings: ${res.status}`)
    },
    setCache: async (key, value, ttlSeconds) => {
      const res = await fetch(`${API_BASE}/plugins/cache/${pluginId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, ttlSeconds })
      })
      if (!res.ok) throw new Error(`Failed to set cache: ${res.status}`)
    },
    getCache: async (key) => {
      const res = await fetch(`${API_BASE}/plugins/cache/${pluginId}?key=${encodeURIComponent(key)}`)
      if (!res.ok) throw new Error(`Failed to get cache: ${res.status}`)
      const data = await res.json()
      return data.value ?? null
    },
    callBackend: async (endpoint, data) => {
      const d = data && typeof data === 'object' ? data as Record<string, unknown> : undefined
      const method = (d?._method as string) ?? (data ? 'POST' : 'GET')
      const body = d ? { ...d } : undefined
      if (body) delete body._method
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      })
      if (!res.ok) {
        // 后端 ApiError 形如 { code, message }：把 message 带出来，插件侧的
        // "Backend error: 422" 才有排障价值（422 多为请求体形状不符）。
        const err = await res.json().catch(() => null)
        const detail = err?.message ?? err?.error
        throw new Error(`Backend error: ${res.status}${detail ? ` - ${detail}` : ''}`)
      }
      // 200/204 且空 body 的端点（如 /settings/open-folder）没有 JSON 可解析，
      // res.json() 会抛 "Unexpected end of JSON input"——按 null 处理。
      const text = await res.text()
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    },
    uploadPlugin: async (fileData, fileName) => {
      const file = new File([new Uint8Array(fileData)], fileName)
      const res = await uploadFile('/plugins/upload', file, 'plugin')
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      return res.json()
    },
    proxyFetch: async (req) => {
      const res = await fetch(`${API_BASE}/plugins/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      })
      if (!res.ok) throw new Error(`Proxy failed: ${res.status}`)
      return res.json()
    },
    proxyFetchStream: async (req, onChunk, signal) => {
      const parser = createSseParser(onChunk)
      const handle = openStream(
        '/plugins/proxy',
        parser.feed,
        { method: 'POST', body: JSON.stringify({ ...req, stream: true }), signal },
      )
      await handle.done
      parser.flush()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    },
    registerMethod: (method, fn) => {
      const registry = (window as any).__pluginRegistry
      if (!registry) throw new Error('Plugin registry not initialized')
      registry.register(pluginId, method, fn)
    },
    registerHook: (method, handler) => {
      // iframe/inline 插件的 registerHook 在桥脚本中直接处理；此实现供主窗口侧
      // （l4 桥等）直接注册到主窗口 HookRegistry。
      getHookRegistry().register(pluginId, method, handler)
    },
    callPlugin: async (targetId, method, ...args) => {
      const registry = (window as any).__pluginRegistry
      if (!registry) throw new Error('Plugin registry not initialized')
      return registry.call(targetId, method, args)
    },
    callWasm: async (pluginId, exportName) => {
      const res = await fetch(`${API_BASE}/plugins/wasm/${encodeURIComponent(pluginId)}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ export: exportName ?? 'on_load' })
      })
      if (!res.ok) throw new Error(`WASM invoke failed: ${res.status}`)
      return res.json()
    },
    listWasmPlugins: async () => {
      const res = await fetch(`${API_BASE}/plugins/wasm`)
      if (!res.ok) throw new Error(`WASM list failed: ${res.status}`)
      const data = await res.json()
      return data.plugins ?? []
    },
    readText: async (path, options) => {
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, mode: 'text', start: options?.start, length: options?.length })
      }))
      return res as { path: string; content: string }
    },
    readBytes: async (path, options) => {
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, mode: 'byte', start: options?.start, length: options?.length })
      }))
      return res as { path: string; contentBase64: string }
    },
    writeText: async (path, content) => {
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content })
      }))
      return res as { path: string }
    },
    writeBytes: async (path, bytes) => {
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, contentBase64: bytesToBase64(bytes) })
      }))
      return res as { path: string }
    },
    deleteFile: async (path) => {
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      }))
      return res as { path: string }
    },
    execCommand: async (command, timeoutMs) => {
      const res = await fetch(`${API_BASE}/plugins/shell/${encodeURIComponent(pluginId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, timeoutMs })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.message ?? `Shell exec failed: ${res.status}`)
      }
      return res.json()
    },
    getSystemInfo: async () => {
      const res = await fetch(`${API_BASE}/systeminfo`)
      if (!res.ok) throw new Error(`Get system info failed: ${res.status}`)
      return res.json()
    },
    openUrl: async (url) => {
      const res = await fetch(`${API_BASE}/system/open-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
      if (!res.ok) throw new Error(`Open url failed: ${res.status}`)
    },
    listPlugins: async () => {
      const res = await fetch(`${API_BASE}/plugins/`)
      if (!res.ok) throw new Error(`List plugins failed: ${res.status}`)
      const data = await res.json()
      return (Array.isArray(data) ? data : []).map((p: any) => ({
        id: p.manifest?.id,
        name: p.manifest?.name,
        version: p.manifest?.version,
        status: p.status,
      }))
    },
    navigate: (path) => {
      window.dispatchEvent(new CustomEvent('plugin:navigate', { detail: { pluginId, path } }))
    },
    openPluginSettings: (targetPluginId) => {
      requestPluginSettings(targetPluginId ?? pluginId)
    },
    addMenuItem: (item) => {
      window.dispatchEvent(new CustomEvent('plugin:add-menu-item', { detail: { pluginId, item } }))
    },
    showToast: (message, type) => {
      window.dispatchEvent(new CustomEvent('plugin:show-toast', { detail: { pluginId, message, type } }))
    },
    log: (message, level = 'info') => {
      void fetch(`${API_BASE}/plugins/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId, level, message })
      }).catch(() => {})
    },
    createOverlay: (opts) => {
      const { createOverlay } = (window as any).__pluginOverlayStore || {}
      if (!createOverlay) throw new Error('Overlay system not initialized')
      return createOverlay(pluginId, opts)
    },
    showOverlay: (id) => {
      const { showOverlay } = (window as any).__pluginOverlayStore
      if (showOverlay) showOverlay(id)
    },
    hideOverlay: (id) => {
      const { hideOverlay } = (window as any).__pluginOverlayStore
      if (hideOverlay) hideOverlay(id)
    },
    destroyOverlay: (id) => {
      const { destroyOverlay } = (window as any).__pluginOverlayStore
      if (destroyOverlay) destroyOverlay(id)
    },
    setOverlayHtml: (id, html) => {
      const { setOverlayHtml } = (window as any).__pluginOverlayStore
      if (setOverlayHtml) setOverlayHtml(id, html)
    },
    setOverlayPosition: (id, x, y) => {
      const { setOverlayPosition } = (window as any).__pluginOverlayStore
      if (setOverlayPosition) setOverlayPosition(id, x, y)
    },
    download: {
      addTask: async (opts) => {
        const res = await fetch(`${API_BASE}/plugins/download/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts)
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Download start failed: ${res.status}`)
        }
        const result = await res.json() as PluginDownloadStartResult
        addTask({
          id: result.taskId,
          name: opts.name ?? opts.fileName ?? result.taskId.slice(0, 8),
          type: 'file',
          gameVersion: '',
          taskId: result.taskId,
          status: 'queued',
          progress: 0,
          createdAt: new Date().toISOString(),
          // 分类只写进前端任务，**不能**塞进 `opts`：插件桥会用
          // `JSON.stringify(opts)` 把整个对象发给后端。认不出的值就不写，
          // 让下载中心把它归入「其他」而不是猜成模组。
          resourceKind: normalizeResourceKind(opts.category),
        })
        return result
      },
      progress: async (taskId) => {
        const res = await fetch(`${API_BASE}/plugins/download/${encodeURIComponent(taskId)}/progress`)
        if (!res.ok) throw new Error(`Download progress failed: ${res.status}`)
        const data = await res.json()
        return data.status === 'not_found' ? null : data as PluginDownloadSnapshot
      },
      cancel: async (taskId) => {
        const res = await fetch(`${API_BASE}/plugins/download/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' })
        if (!res.ok) throw new Error(`Download cancel failed: ${res.status}`)
      },
      list: async () => {
        const res = await fetch(`${API_BASE}/plugins/download/list`)
        if (!res.ok) throw new Error(`Download list failed: ${res.status}`)
        return res.json()
      },
      registerInstall: (opts) => {
        addTask({
          id: opts.instanceId,
          name: opts.name,
          type: 'game',
          gameVersion: opts.gameVersion,
          loader: opts.loader,
          loaderVersion: opts.loaderVersion,
          status: 'queued',
          progress: 0,
          createdAt: new Date().toISOString(),
          instanceId: opts.instanceId,
        })
      },
      addBatch: async (opts) => {
        const res = await fetch(`${API_BASE}/plugins/download/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Batch download failed: ${res.status}`)
        }
        const result = await res.json() as PluginBatchDownloadResult
        // 自建任务（非插件指定 taskId）才会在这里补卡片；外部任务已有卡片。
        if (!opts.taskId) {
          addTask({
            id: result.taskId,
            name: opts.title ?? `批量下载 (${result.totalFiles})`,
            type: 'modpack',
            gameVersion: '',
            status: 'downloading',
            progress: 0,
            createdAt: new Date().toISOString(),
            instanceId: result.taskId,
            kind: 'plugin',
          })
        }
        return result
      },
      batchStatus: async (batchId) => {
        const res = await fetch(`${API_BASE}/plugins/download/batch/${encodeURIComponent(batchId)}`)
        if (res.status === 404) return null
        if (!res.ok) throw new Error(`Batch status failed: ${res.status}`)
        return res.json() as Promise<PluginBatchStatus>
      },
    },
    task: {
      register: async (opts) => {
        const res = await fetch(`${API_BASE}/plugins/tasks/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Task register failed: ${res.status}`)
        }
        return res.json() as Promise<{ taskId: string }>
      },
      update: async (taskId, patch) => {
        const res = await fetch(`${API_BASE}/plugins/tasks/${encodeURIComponent(taskId)}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Task update failed: ${res.status}`)
        }
      },
      complete: async (taskId, error) => {
        const res = await fetch(`${API_BASE}/plugins/tasks/${encodeURIComponent(taskId)}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(error ? { error } : {}),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Task complete failed: ${res.status}`)
        }
      },
      progress: async (taskId) => {
        const res = await fetch(`${API_BASE}/plugins/tasks/${encodeURIComponent(taskId)}`)
        if (res.status === 404) return null
        if (!res.ok) throw new Error(`Task progress failed: ${res.status}`)
        return res.json() as Promise<PluginTaskProgress>
      },
    },
    curseforge: {
      files: async (files) => {
        const res = await fetch(`${API_BASE}/plugins/cf/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `CurseForge lookup failed: ${res.status}`)
        }
        return res.json() as Promise<PluginCfFileInfo[]>
      },
    },
    readArchiveEntry: async (archivePath, entryPath, opts) => {
      const res = await fetch(`${API_BASE}/plugins/archive/entry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archivePath, entryPath, maxBytes: opts?.maxBytes }),
      })
      if (res.status === 404) return null
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.message ?? `Archive entry read failed: ${res.status}`)
      }
      return res.json()
    },
    modpack: {
      install: async (opts) => {
        const res = await fetch(`${API_BASE}/modpack/install-direct`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts)
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Modpack install failed: ${res.status}`)
        }
        return res.json()
      },
    },
    process: {
      spawn: async (opts) => {
        const res = await fetch(`${API_BASE}/plugins/process/${encodeURIComponent(pluginId)}/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts)
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Process spawn failed: ${res.status}`)
        }
        return res.json()
      },
      stdin: async (pid, data, opts) => {
        const res = await fetch(`${API_BASE}/plugins/process/${encodeURIComponent(pluginId)}/${pid}/stdin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data, appendNewline: opts?.appendNewline ?? true })
        })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Process stdin failed: ${res.status}`)
        }
      },
      kill: async (pid) => {
        const res = await fetch(`${API_BASE}/plugins/process/${encodeURIComponent(pluginId)}/${pid}/kill`, { method: 'POST' })
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Process kill failed: ${res.status}`)
        }
        return res.json()
      },
      alive: async (pid) => {
        const res = await fetch(`${API_BASE}/plugins/process/${encodeURIComponent(pluginId)}/${pid}/alive`)
        if (!res.ok) throw new Error(`Process alive check failed: ${res.status}`)
        return res.json()
      },
      logs: async (pid, afterSeq) => {
        const q = afterSeq !== undefined ? `?after=${afterSeq}` : ''
        const res = await fetch(`${API_BASE}/plugins/process/${encodeURIComponent(pluginId)}/${pid}/logs${q}`)
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          throw new Error(err?.message ?? `Process logs failed: ${res.status}`)
        }
        return res.json()
      },
      list: async () => {
        const res = await fetch(`${API_BASE}/plugins/process/${encodeURIComponent(pluginId)}/list`)
        if (!res.ok) throw new Error(`Process list failed: ${res.status}`)
        return res.json()
      },
    },
    pickFile: async (opts) => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        return await invoke<string | null>('pick_dialog', {
          options: {
            title: opts?.title,
            defaultPath: opts?.defaultPath,
            filters: opts?.filters,
            multiple: opts?.multiple,
          }
        })
      } catch {
        // 浏览器 dev 环境无 Tauri：按用户取消处理
        return null
      }
    },
    pickDirectory: async (opts) => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        return await invoke<string | null>('pick_dialog', {
          options: {
            title: opts?.title,
            defaultPath: opts?.defaultPath,
            directory: true,
          }
        })
      } catch {
        return null
      }
    },
    extractArchive: async (archivePath, destPath, opts) => {
      const res = await extractWithAuth(pluginId, archivePath, destPath, opts)
      return res as { destPath: string }
    },
    renamePath: async (from, to) => {
      const res = await fileOpWithAuth(pluginId, from, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to })
      }))
      return res as { path: string }
    },
    listDir: async (path, opts) => {
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, recursive: opts?.recursive, maxEntries: opts?.maxEntries })
      }))
      return res as PluginFileEntry[]
    },
    sendNotification: async (opts) => {
      try {
        if (typeof Notification === 'undefined') return false
        let perm = Notification.permission
        if (perm === 'default') perm = await Notification.requestPermission()
        if (perm !== 'granted') return false
        new Notification(opts.title, { body: opts.body })
        return true
      } catch {
        return false
      }
    },
    getPluginStrings: async () => {
      const l10nDir = await fetch(`${API_BASE}/plugins/${encodeURIComponent(pluginId)}`)
        .then(r => (r.ok ? r.json() : null))
        .then((p: { manifest?: { l10n?: string } } | null) => p?.manifest?.l10n)
        .catch(() => null)
      if (!l10nDir) return {}
      const { getPluginBundle, currentLocale } = await import('./l10n.ts')
      return getPluginBundle(pluginId, l10nDir, currentLocale())
    },
    getLocale: async () => {
      const { currentLocale } = await import('./l10n.ts')
      return currentLocale()
    },
    getIconSvg: async (cls) => {
      const { resolveFaIcon } = await import('../components/BuiltinIcons.tsx')
      const def = resolveFaIcon(cls)
      if (!def) return null
      // FA IconDefinition.icon = [width, height, ligatures[], unicode, svgPathData]：
      // 路径在索引 4（可能是字符串或字符串数组，数组需 join）。索引 2 是 ligatures
      // （如 ["add"]），取错会渲染出 "10133 61543 add" 这类非法 d。
      const icon = def.icon as unknown as [number, number, string[], string, string | string[]]
      const raw = icon[4]
      const path = Array.isArray(raw) ? raw.join(' ') : raw
      return { width: icon[0], height: icon[1], path }
    },
  }
}

/** extractArchive 的授权流：涉及读压缩包 + 写目标目录两条路径，
 * 403 时合并为一次确认、两个前缀都授权后重试（比逐路径弹两次窗更贴近用户意图）。 */
async function extractWithAuth(
  pluginId: string,
  archivePath: string,
  destPath: string,
  opts?: { prefix?: string; stripPrefix?: boolean },
): Promise<unknown> {
  const op = () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivePath, destPath, prefix: opts?.prefix, stripPrefix: opts?.stripPrefix })
  })
  let res = await op()
  if (res.status === 403) {
    const err = await res.json().catch(() => null)
    if (err?.code === 'FS_AUTHORIZATION_REQUIRED') {
      const ok = window.confirm(i18nKey('plugins.fileAuthRequest', { pluginId, path: `${archivePath} → ${destPath}` }))
      if (!ok) throw new Error(i18nKey('plugins.fileAuthDenied'))
      for (const p of [archivePath, destPath]) {
        const authRes = await fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/authorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p, allow: true })
        })
        if (!authRes.ok) throw new Error(i18nKey('plugins.fileAuthFailed'))
      }
      res = await op()
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.message ?? `Extract failed: ${res.status}`)
  }
  return res.json()
}

async function fileOpWithAuth(pluginId: string, path: string, op: () => Promise<Response>): Promise<unknown> {
  let res = await op()
  if (res.status === 403) {
    const err = await res.json().catch(() => null)
    if (err?.code === 'FS_AUTHORIZATION_REQUIRED') {
      const ok = window.confirm(i18nKey('plugins.fileAuthRequest', { pluginId, path }))
      if (!ok) throw new Error(i18nKey('plugins.fileAuthDenied'))
      const authRes = await fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, allow: true })
      })
      if (!authRes.ok) throw new Error(i18nKey('plugins.fileAuthFailed'))
      res = await op()
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.message ?? `File operation failed: ${res.status}`)
  }
  return res.json()
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
