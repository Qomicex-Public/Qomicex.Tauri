export interface PluginBridge {
  getSettings: () => Promise<Record<string, unknown>>
  setSettings: (key: string, value: unknown) => Promise<void>
  callBackend: (endpoint: string, data?: unknown) => Promise<unknown>
  navigate: (path: string) => void
  addMenuItem: (item: { path: string; label: string; icon?: string }) => void
  showToast: (message: string, type?: 'info' | 'error' | 'success') => void
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
    callBackend: async (endpoint, data) => {
      const res = await fetch(`/api${endpoint}`, {
        method: data ? 'POST' : 'GET',
        headers: data ? { 'Content-Type': 'application/json' } : undefined,
        body: data ? JSON.stringify(data) : undefined
      })
      if (!res.ok) throw new Error(`Backend error: ${res.status}`)
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
    }
  }
}
