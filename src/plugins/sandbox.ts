import type { PluginInfo } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createPluginBridge } from './plugin-api.ts'
import { injectCss, registerThemeSync, getThemeVarsCss, themeBridgeScript } from './plugin-css.ts'
import { API_BASE } from '../api/client.ts'

export interface SandboxInstance {
  iframe: HTMLIFrameElement
  plugin: PluginInfo
  destroy: () => void
}

export interface InlineInstance {
  container: HTMLDivElement
  plugin: PluginInfo
  mount: (parent: HTMLElement) => void
  destroy: () => void
}

const sandboxes = new Map<string, SandboxInstance>()
const inlineInstances = new Map<string, InlineInstance>()
const sourceMap = new WeakMap<Window, string>()

function getFileUrl(pluginId: string, frontend: string, path: string) {
  const base = frontend.split('/').slice(0, -1).join('/')
  return `${API_BASE}/plugins/${pluginId}/files/${base ? base + '/' + path : path}`
}

function toAssetUrl(src: string, fileUrl: (p: string) => string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/') || src.startsWith('data:')) return src
  return fileUrl(src.replace(/^\.\//, ''))
}

function convertScriptSrcs(html: string, fileUrl: (p: string) => string): string {
  return html.replace(/(<script[^>]+src=")([^"]+)("[^>]*><\/script>)/g, (_, pre, src, post) => pre + toAssetUrl(src, fileUrl) + post)
}

function convertCssLinks(html: string, fileUrl: (p: string) => string): string {
  return html.replace(/(<link[^>]+href=")([^"]+)("[^>]*>)/g, (_, pre, href, post) => pre + toAssetUrl(href, fileUrl) + post)
}

const apiBridgeScript = `<script>
window.__PLUGIN_API__ = {
  call: (method, ...args) => {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2)
      const handler = (e) => {
        if (e.data.type === '__plugin_api_response' && e.data.id === id) {
          window.removeEventListener('message', handler)
          if (e.data.error) reject(new Error(e.data.error))
          else resolve(e.data.result)
        }
      }
      window.addEventListener('message', handler)
      parent.postMessage({ type: '__plugin_api_call', id, method, args }, '*')
    })
  },
  proxyFetchStream: (req, handlers) => {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2)
      const onChunk = handlers && handlers.onChunk
      const onError = handlers && handlers.onError
      const signal = req && req.signal
      const payload = req ? { ...req } : req
      if (payload) delete payload.signal
      const handler = (e) => {
        if (e.data && e.data.id !== id) return
        if (e.data.type === '__plugin_api_stream_chunk') {
          if (onChunk) try { onChunk(e.data.chunk) } catch (err) { reject(err) }
        } else if (e.data.type === '__plugin_api_stream_error') {
          window.removeEventListener('message', handler)
          if (onError) onError(new Error(e.data.error))
          reject(new Error(e.data.error))
        } else if (e.data.type === '__plugin_api_stream_end') {
          window.removeEventListener('message', handler)
          resolve()
        }
      }
      window.addEventListener('message', handler)
      const onAbort = () => {
        parent.postMessage({ type: '__plugin_api_abort', id }, '*')
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort)
      }
      parent.postMessage({ type: '__plugin_api_call', id, method: 'proxyFetchStream', args: [payload] }, '*')
    })
  }
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.p-tabs').forEach(tabs => {
    tabs.querySelectorAll('.p-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.querySelectorAll('.p-tab').forEach(t => t.classList.remove('active'))
        tabs.querySelectorAll('.p-tab--active').forEach(t => t.classList.remove('p-tab--active'))
        tab.classList.add('active')
        const panelId = tab.dataset.pTab || tab.dataset.tab
        if (!panelId) return
        document.querySelectorAll('.p-panel.active,.p-panel--active').forEach(p => p.classList.remove('active','p-panel--active'))
        const panel = document.getElementById('panel-' + panelId)
        if (panel) panel.classList.add('active')
      })
    })
  })
})
<\/script>`

export function createSandbox(plugin: PluginInfo): SandboxInstance {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.style.cssText = 'border:none;width:100%;height:100%'

  const instance: SandboxInstance = {
    iframe, plugin,
    destroy: () => {
      sandboxes.delete(plugin.manifest.id)
      iframe.remove()
    }
  }

  sandboxes.set(plugin.manifest.id, instance)
  loadSandboxContent(plugin, iframe)
  return instance
}

async function loadSandboxContent(plugin: PluginInfo, iframe: HTMLIFrameElement) {
  if (!plugin.manifest.entry.frontend) return
  try {
    const entry = plugin.manifest.entry.frontend
    const fileUrl = (p: string) => getFileUrl(plugin.manifest.id, entry, p)
    const res = await fetch(fileUrl(entry.split('/').pop()!))
    if (!res.ok) return
    let html = await res.text()

    html = convertScriptSrcs(html, fileUrl)
    html = convertCssLinks(html, fileUrl)

    const themeInit = `<style data-theme-vars>${getThemeVarsCss()}</style>`
    html = html.replace('</head>', themeInit + '\n' + injectCss + '\n' + apiBridgeScript + '\n' + themeBridgeScript + '\n</head>')

    iframe.onload = () => {
      if (iframe.contentWindow) sourceMap.set(iframe.contentWindow, plugin.manifest.id)
      registerThemeSync(iframe)
    }
    iframe.srcdoc = html
  } catch (e) {
    console.error('[sandbox] loadSandboxContent failed for', plugin.manifest.id, e)
  }
}

export function renderInline(plugin: PluginInfo): InlineInstance {
  const container = document.createElement('div')

  const instance: InlineInstance = {
    container, plugin,
    mount: (parent) => {
      if (container.parentElement !== parent) {
        parent.appendChild(container)
      }
    },
    destroy: () => {
      inlineInstances.delete(plugin.manifest.id)
      container.remove()
      container.innerHTML = ''
    }
  }

  inlineInstances.set(plugin.manifest.id, instance)
  loadInlineContent(plugin, container)
  return instance
}

async function loadInlineContent(plugin: PluginInfo, container: HTMLDivElement) {
  if (!plugin.manifest.entry.frontend) return
  try {
    const entry = plugin.manifest.entry.frontend
    const fileUrl = (p: string) => getFileUrl(plugin.manifest.id, entry, p)
    const fetchUrl = fileUrl(entry.split('/').pop()!)
    console.log('[sandbox] fetching inline', fetchUrl)
    const res = await fetch(fetchUrl)
    if (!res.ok) {
      console.warn('[sandbox] inline fetch failed', plugin.manifest.id, res.status)
      return
    }
    let html = await res.text()

    html = convertScriptSrcs(html, fileUrl)
    html = convertCssLinks(html, fileUrl)

    const inner = html
      .replace(/<!DOCTYPE[^>]*>/i, '')
      .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
      .replace(/id="root"/g, '')

    sourceMap.set(window, plugin.manifest.id)

    console.log('[sandbox] inline content loaded for', plugin.manifest.id, 'length:', inner.length)
    container.innerHTML = inner + `
<script>
console.log('[plugin:inline] inline bridge executing for', '${plugin.manifest.id}')
window.__PLUGIN_API__ = {
  call: (method, ...args) => {
    var id = Math.random().toString(36).slice(2)
    return new Promise(function (resolve, reject) {
      var handler = function (e) {
        if (e.data.type === '__plugin_api_response' && e.data.id === id) {
          window.removeEventListener('message', handler)
          if (e.data.error) reject(new Error(e.data.error))
          else resolve(e.data.result)
        }
      }
      window.addEventListener('message', handler)
      window.postMessage({ type: '__plugin_api_call', id: id, method: method, args: args }, '*')
    })
  },
  proxyFetchStream: (req, handlers) => {
    var id = Math.random().toString(36).slice(2)
    return new Promise(function (resolve, reject) {
      var onChunk = handlers && handlers.onChunk
      var onError = handlers && handlers.onError
      var signal = req && req.signal
      var payload = req ? Object.assign({}, req) : req
      if (payload) delete payload.signal
      var handler = function (e) {
        if (e.data && e.data.id !== id) return
        if (e.data.type === '__plugin_api_stream_chunk') {
          if (onChunk) try { onChunk(e.data.chunk) } catch (err) { reject(err) }
        } else if (e.data.type === '__plugin_api_stream_error') {
          window.removeEventListener('message', handler)
          if (onError) onError(new Error(e.data.error))
          reject(new Error(e.data.error))
        } else if (e.data.type === '__plugin_api_stream_end') {
          window.removeEventListener('message', handler)
          resolve()
        }
      }
      window.addEventListener('message', handler)
      var onAbort = function () {
        window.postMessage({ type: '__plugin_api_abort', id: id }, '*')
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort)
      }
      window.postMessage({ type: '__plugin_api_call', id: id, method: 'proxyFetchStream', args: [payload] }, '*')
    })
  }
}
<\/script>`
  } catch (e) {
    console.error('[sandbox] loadInlineContent failed for', plugin.manifest.id, e)
  }
}

export function getInstance(pluginId: string): SandboxInstance | InlineInstance | undefined {
  return sandboxes.get(pluginId) || inlineInstances.get(pluginId)
}

export function registerOverlayIframe(contentWindow: Window, pluginId: string) {
  sourceMap.set(contentWindow, pluginId)
}

window.addEventListener('message', (e) => {
  if (e.data?.type === '__plugin_api_call') {
    const { id, method, args } = e.data
    const pluginId = sourceMap.get(e.source as Window)
    if (pluginId) handleApiCall(id, method, args, pluginId, e.source as Window)
  }
  if (e.data?.type === '__plugin_api_abort') {
    const controller = streamAborters.get(e.data.id)
    if (controller) controller.abort()
  }
})

const streamAborters = new Map<string, AbortController>()

async function handleApiCall(callId: string, method: string, args: unknown[], pluginId: string, source: Window) {
  if (method === 'proxyFetchStream') {
    const req = args[0] as any
    const controller = new AbortController()
    streamAborters.set(callId, controller)
    try {
      await executePluginMethod(pluginId, method, [
        req,
        (chunk: string) => source.postMessage({ type: '__plugin_api_stream_chunk', id: callId, chunk }, '*'),
        controller.signal,
      ])
      source.postMessage({ type: '__plugin_api_stream_end', id: callId }, '*')
    } catch (e) {
      source.postMessage({
        type: '__plugin_api_stream_error',
        id: callId,
        error: e instanceof Error ? e.message : String(e),
      }, '*')
    } finally {
      streamAborters.delete(callId)
    }
    return
  }
  let result: unknown
  let error: string | undefined
  try {
    result = await executePluginMethod(pluginId, method, args)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  source.postMessage({ type: '__plugin_api_response', id: callId, result, error }, '*')
}

const METHOD_PERMISSIONS: Record<string, string> = {
  getSettings: 'config:read', setSettings: 'config:write', setCache: 'cache:access', getCache: 'cache:access', callBackend: 'network:fetch', proxyFetch: 'network:cors_proxy', proxyFetchStream: 'network:cors_proxy',
  navigate: 'config:read', showToast: 'ui:toast',
  'overlay.create': 'ui:sub_window', 'overlay.show': 'ui:sub_window', 'overlay.hide': 'ui:sub_window',
  'overlay.destroy': 'ui:sub_window', 'overlay.setHtml': 'ui:sub_window', 'overlay.setPosition': 'ui:sub_window',
}

async function executePluginMethod(pluginId: string, method: string, args: unknown[]): Promise<unknown> {
  const requiredPerm = METHOD_PERMISSIONS[method]
  if (requiredPerm) {
    const plugin = usePluginStore.getState().getPlugin(pluginId)
    if (!plugin || !plugin.manifest.permissions.includes(requiredPerm))
      throw new Error(`Permission denied: requires ${requiredPerm}`)
  }
  const bridge = createPluginBridge(pluginId)
  switch (method) {
    case 'getSettings': return bridge.getSettings()
    case 'setSettings': return bridge.setSettings(args[0] as string, args[1])
    case 'setCache': return bridge.setCache(args[0] as string, args[1], args[2] as number | undefined)
    case 'getCache': return bridge.getCache(args[0] as string)
    case 'callBackend': return bridge.callBackend(args[0] as string, args[1])
    case 'proxyFetch': return bridge.proxyFetch(args[0] as any)
    case 'proxyFetchStream': return bridge.proxyFetchStream(args[0] as any, args[1] as (chunk: string) => void, args[2] as AbortSignal | undefined)
    case 'navigate': bridge.navigate(args[0] as string); return
    case 'showToast': bridge.showToast(args[0] as string, args[1] as 'info' | 'error' | 'success' | undefined); return
    case 'overlay.create': return bridge.createOverlay(args[0] as any)
    case 'overlay.show': bridge.showOverlay(args[0] as string); return
    case 'overlay.hide': bridge.hideOverlay(args[0] as string); return
    case 'overlay.destroy': bridge.destroyOverlay(args[0] as string); return
    case 'overlay.setHtml': bridge.setOverlayHtml(args[0] as string, args[1] as string); return
    case 'overlay.setPosition': bridge.setOverlayPosition(args[0] as string, args[1] as number, args[2] as number); return
    default: throw new Error(`Unknown method: ${method}`)
  }
}
