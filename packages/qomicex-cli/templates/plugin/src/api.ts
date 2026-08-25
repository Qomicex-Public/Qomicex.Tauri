/// <reference types="vite/client" />

declare global {
  interface Window {
    __PLUGIN_API__?: PluginApi
    __PLUGIN_ID__?: string
  }
}

export interface ProxyRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface PluginApi {
  call: (method: string, ...args: unknown[]) => Promise<unknown>
  registerMethod: (method: string, fn: (...args: unknown[]) => unknown) => void
  callPlugin: (pluginId: string, method: string, ...args: unknown[]) => Promise<unknown>
  proxyFetchStream: (req: ProxyRequest, handlers: { onChunk: (c: string) => void; onError: (e: Error) => void }) => Promise<void>
}

/**
 * 沙箱注入的插件 API 桥；在 l2 iframe / inline 渲染中均可用。
 * 独立 `pnpm dev`（浏览器直开）时返回 null，UI 可优雅降级。
 */
export function getApi(): PluginApi | null {
  return window.__PLUGIN_API__ ?? null
}

export function getPluginId(): string {
  return window.__PLUGIN_ID__ ?? 'unknown'
}
