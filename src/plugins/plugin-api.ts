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

export interface PluginBridge {
  getSettings: () => Promise<Record<string, unknown>>
  setSettings: (key: string, value: unknown) => Promise<void>
  setCache: (key: string, value: unknown, ttlSeconds?: number) => Promise<void>
  getCache: (key: string) => Promise<unknown>
  callBackend: (endpoint: string, data?: unknown) => Promise<unknown>
  proxyFetch: (req: ProxyRequest) => Promise<ProxyResponse>
  navigate: (path: string) => void
  addMenuItem: (item: { path: string; label: string; icon?: string }) => void
  showToast: (message: string, type?: 'info' | 'error' | 'success') => void
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
      const res = await fetch(`/api/plugins/settings/${pluginId}`)
      if (!res.ok) throw new Error(`Failed to get settings: ${res.status}`)
      return res.json()
    },
    setSettings: async (key, value) => {
      const res = await fetch(`/api/plugins/settings/${pluginId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      })
      if (!res.ok) throw new Error(`Failed to set settings: ${res.status}`)
    },
    setCache: async (key, value, ttlSeconds) => {
      const res = await fetch(`/api/plugins/cache/${pluginId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, ttlSeconds })
      })
      if (!res.ok) throw new Error(`Failed to set cache: ${res.status}`)
    },
    getCache: async (key) => {
      const res = await fetch(`/api/plugins/cache/${pluginId}?key=${encodeURIComponent(key)}`)
      if (!res.ok) throw new Error(`Failed to get cache: ${res.status}`)
      const data = await res.json()
      return data.value ?? null
    },
    callBackend: async (endpoint, data) => {
      const res = await fetch(`/api${endpoint}`, {
        method: data ? 'POST' : 'GET',
        headers: data ? { 'Content-Type': 'application/json' } : undefined,
        body: data ? JSON.stringify(data) : undefined
      })
      if (!res.ok) throw new Error(`Backend error: ${res.status}`)
      return res.json()
    },
    proxyFetch: async (req) => {
      const res = await fetch('/api/plugins/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      })
      if (!res.ok) throw new Error(`Proxy failed: ${res.status}`)
      return res.json()
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
