import { API_BASE } from '../api/client.ts'

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
  readFile: (path: string) => Promise<{ path: string; content?: string | null; contentBase64?: string | null; isBinary: boolean }>
  writeFile: (path: string, content: string | Uint8Array) => Promise<{ path: string }>
  execCommand: (command: string, timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  navigate: (path: string) => void
  addMenuItem: (item: { path: string; label: string; icon?: string }) => void
  showToast: (message: string, type?: 'info' | 'error' | 'success') => void
  getSystemInfo: () => Promise<unknown>
  openUrl: (url: string) => Promise<void>
  listPlugins: () => Promise<PluginListEntry[]>
  createOverlay: (opts: { title: string; html: string; x?: number; y?: number; width?: number; height?: number; minimizable?: boolean; resizable?: boolean }) => string
  showOverlay: (id: string) => void
  hideOverlay: (id: string) => void
  destroyOverlay: (id: string) => void
  setOverlayHtml: (id: string, html: string) => void
  setOverlayPosition: (id: string, x: number, y: number) => void
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
      const blob = new Blob([new Uint8Array(fileData)])
      const fd = new FormData()
      fd.append('plugin', blob, fileName)
      const res = await fetch(`${API_BASE}/plugins/upload`, { method: 'POST', body: fd })
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
      const res = await fetch(`${API_BASE}/plugins/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, stream: true }),
        signal
      })
      if (!res.ok || !res.body) throw new Error(`Proxy stream failed: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          const trimmed = line.trim()
          if (trimmed.startsWith('data:')) {
            onChunk(trimmed.slice(5).trim())
          }
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data:')) onChunk(trimmed.slice(5).trim())
      }
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
    readFile: async (path) => {
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      }))
      return res as { path: string; content?: string | null; contentBase64?: string | null; isBinary: boolean }
    },
    writeFile: async (path, content) => {
      const isBinary = content instanceof Uint8Array
      const res = await fileOpWithAuth(pluginId, path, () => fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          content: isBinary ? undefined : typeof content === 'string' ? content : '',
          contentBase64: isBinary ? bytesToBase64(content) : undefined,
        })
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
  }
}

async function fileOpWithAuth(pluginId: string, path: string, op: () => Promise<Response>): Promise<unknown> {
  let res = await op()
  if (res.status === 403) {
    const err = await res.json().catch(() => null)
    if (err?.code === 'FS_AUTHORIZATION_REQUIRED') {
      const ok = window.confirm(`插件「${pluginId}」请求访问路径：\n${path}\n\n是否允许？`)
      if (!ok) throw new Error('用户拒绝了文件访问授权')
      const authRes = await fetch(`${API_BASE}/plugins/files/${encodeURIComponent(pluginId)}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, allow: true })
      })
      if (!authRes.ok) throw new Error('授权失败')
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
