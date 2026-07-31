declare global {
  interface Window {
    __PLUGIN_API__?: {
      call: (method: string, ...args: unknown[]) => Promise<unknown>
    }
  }
}

export function initApi(): Promise<void> {
  return new Promise((resolve, reject) => {
    let n = 0
    function check() {
      if (window.__PLUGIN_API__) { resolve(); return }
      n++
      if (n > 100) { reject(new Error('API bridge timeout')); return }
      setTimeout(check, 50)
    }
    check()
  })
}

export function apiCall<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  if (!window.__PLUGIN_API__) throw new Error('API not initialized')
  return window.__PLUGIN_API__.call(method, ...args) as Promise<T>
}

export interface Settings {
  baseUrl?: string
  deepseekApiKey?: string
  deepseekModel?: string
  maxCtx?: number
}

export async function getSettings(): Promise<Settings> {
  try {
    const s = await apiCall<Settings>('getSettings')
    return s || {}
  } catch {
    return {}
  }
}

export function setSetting(key: string, value: unknown): Promise<unknown> {
  return apiCall('setSettings', key, value)
}

export function callBackend<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
  return apiCall<T>('callBackend', endpoint, body)
}

export function showToast(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
  apiCall('showToast', message, type)
}
