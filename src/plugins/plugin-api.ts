import { API_BASE } from '../api/client.ts'
import { openStream, createSseParser, uploadFile } from '../api/ipc.ts'
import { addTask } from '../stores/downloadStore.ts'
import { RESOURCES } from '../../qomicex-tauri-i18n/src/index.ts'
import { resolveLang } from '../i18n/lang.ts'

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
    progress: (taskId: string) => Promise<PluginDownloadSnapshot | null>
    cancel: (taskId: string) => Promise<void>
    list: () => Promise<PluginDownloadSnapshot[]>
    registerInstall: (opts: { instanceId: string; name: string; gameVersion: string; loader?: string; loaderVersion?: string }) => void
  }
  modpack: {
    install: (opts: PluginModpackInstallOptions) => Promise<{ instanceId: string }>
  }
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
      if (!res.ok) throw new Error(`Backend error: ${res.status}`)
      return res.status === 204 ? null : res.json()
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
  }
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
