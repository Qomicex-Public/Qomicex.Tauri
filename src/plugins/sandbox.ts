import type { PluginInfo } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createPluginBridge } from './plugin-api.ts'
import { injectCss, registerThemeSync, getThemeVarsCss, themeBridgeScript } from './plugin-css.ts'
import { API_BASE } from '../api/client.ts'
import { applyThemeOverride, clearThemeOverride } from '../theme/override.ts'
import { normalizeHex, THEME_COLOR_MODE_BACKGROUND } from '../lib/themeColor.ts'
import { getSettings as getAppSettings } from '../api/settings.ts'
import type { PluginErrorType } from '../api/telemetry.ts'
import { reportPluginError } from '../lib/telemetry.ts'

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

/** l4：插件托管在独立 WebviewWindow 中（跨窗口桥代理）。 */
export interface WebviewInstance {
  plugin: PluginInfo
  destroy: () => void
}

const sandboxes = new Map<string, SandboxInstance>()
const inlineInstances = new Map<string, InlineInstance>()
const webviewInstances = new Map<string, WebviewInstance>()
/** UI 槽位沙箱：pluginId → 该插件挂载到各槽位的 iframe 列表（与主页面沙箱独立管理） */
const slotSandboxes = new Map<string, SandboxInstance[]>()
const sourceMap = new WeakMap<Window, string>()

export function getFileUrl(pluginId: string, frontend: string, path: string) {
  const base = frontend.split('/').slice(0, -1).join('/')
  return `${API_BASE}/plugins/${pluginId}/files/${base ? base + '/' + path : path}`
}

function toAssetUrl(src: string, fileUrl: (p: string) => string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/') || src.startsWith('data:')) return src
  return fileUrl(src.replace(/^\.\//, ''))
}

export function convertScriptSrcs(html: string, fileUrl: (p: string) => string): string {
  return html.replace(/(<script\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2([^>]*>\s*<\/script\b[^>]*>)/gi, (_, pre, quote, src, post) => pre + quote + toAssetUrl(src, fileUrl) + quote + post)
}

export function convertCssLinks(html: string, fileUrl: (p: string) => string): string {
  return html.replace(/(<link[^>]+href=")([^"]+)("[^>]*>)/g, (_, pre, href, post) => pre + toAssetUrl(href, fileUrl) + post)
}

const apiBridgeScript = `<script>
window.__PLUGIN_ID__ = '__PLUGIN_ID_TOKEN__'
window.__PLUGIN_API_BASE__ = '__API_BASE_TOKEN__'
;(function () {
  // iframe 侧插件注册表：本地保存 fn，经主窗口中转跨插件调用
  var __localExports = {}
  window.__pluginRegistry = {
    register: function (pluginId, method, fn) {
      if (!__localExports[pluginId]) __localExports[pluginId] = {}
      __localExports[pluginId][method] = fn
      parent.postMessage({ type: '__plugin_registry_register', pluginId: pluginId, method: method }, '*')
    },
    unregister: function (pluginId) {
      delete __localExports[pluginId]
      parent.postMessage({ type: '__plugin_registry_unregister', pluginId: pluginId }, '*')
    },
    has: function (pluginId, method) {
      var e = __localExports[pluginId]
      if (!e) return false
      return method ? typeof e[method] === 'function' : Object.keys(e).length > 0
    },
    call: function (pluginId, method, args) {
      return new Promise(function (resolve, reject) {
        var callId = Math.random().toString(36).slice(2)
        var handler = function (e) {
          if (e.data && e.data.type === '__plugin_registry_result' && e.data.callId === callId) {
            window.removeEventListener('message', handler)
            if (e.data.error) reject(new Error(e.data.error))
            else resolve(e.data.result)
          }
        }
        window.addEventListener('message', handler)
        parent.postMessage({ type: '__plugin_registry_call', callId: callId, pluginId: pluginId, method: method, args: args }, '*')
      })
    },
    _callLocal: function (method, args) {
      var fn = (__localExports[window.__PLUGIN_ID__] || {})[method]
      if (typeof fn !== 'function') return Promise.reject(new Error('插件 ' + window.__PLUGIN_ID__ + ' 未提供方法 ' + method))
      return Promise.resolve(fn.apply(null, args))
    }
  }
  // iframe 侧本地 hook 注册表：pluginId -> method -> handler（洋葱管道）
  var __localHooks = {}
  window.__pluginHookLocal = {
    register: function (pluginId, method, fn) {
      if (!__localHooks[method]) __localHooks[method] = []
      var list = __localHooks[method]
      var idx = -1
      for (var i = 0; i < list.length; i++) if (list[i].pluginId === pluginId) { idx = i; break }
      if (idx >= 0) list[idx] = { pluginId: pluginId, fn: fn }
      else list.push({ pluginId: pluginId, fn: fn })
    },
    unregisterAll: function (pluginId) {
      for (var method in __localHooks) {
        var list = __localHooks[method]
        var next = list.filter(function (h) { return h.pluginId !== pluginId })
        if (next.length === 0) delete __localHooks[method]
        else __localHooks[method] = next
      }
    }
  }
  window.addEventListener('message', function (e) {
    var msg = e.data
    if (!msg) return
    if (msg.type === '__plugin_registry_call') {
      window.__pluginRegistry._callLocal(msg.method, msg.args).then(
        function (result) { parent.postMessage({ type: '__plugin_registry_result', callId: msg.callId, result: result }, '*') },
        function (err) { parent.postMessage({ type: '__plugin_registry_result', callId: msg.callId, error: err instanceof Error ? err.message : String(err) }, '*') }
      )
    } else if (msg.type === '__plugin_hook_invoke') {
      // 阶段1（before）：主窗口发来 hook 调用，执行本地 hook 的 before 部分。
      // hook 内调用 next() 时挂起（返回 resumePromise），此时回传 before_done；
      // 收到 __plugin_hook_continue 后 resolve 挂起，after 继续，完整链 resolve 后回传 after_done。
      var callId = msg.callId
      var payload = msg.payload || {}
      var method = payload.method || ''
      var ctx = {
        method: method,
        pluginId: window.__PLUGIN_ID__,
        args: payload.args || [],
        result: payload.result,
        prevented: payload.prevented || false,
        prevent: function () { this.prevented = true }
      }
      var list = __localHooks[method] || []
      var resumeResolve = null
      var resumePromise = new Promise(function (resolve) { resumeResolve = resolve })
      var beforeSent = false
      var sendBefore = function () {
        if (beforeSent) return
        beforeSent = true
        parent.postMessage({
          type: '__plugin_hook_before_done',
          callId: callId,
          ctx: { method: ctx.method, pluginId: ctx.pluginId, args: ctx.args, result: ctx.result, prevented: ctx.prevented }
        }, '*')
      }
      var sendAfter = function () {
        parent.postMessage({
          type: '__plugin_hook_after_done',
          callId: callId,
          ctx: { method: ctx.method, pluginId: ctx.pluginId, args: ctx.args, result: ctx.result, prevented: ctx.prevented }
        }, '*')
      }
      var dispatch = function (index) {
        if (ctx.prevented) { sendBefore(); return Promise.resolve() }
        if (index >= list.length) { sendBefore(); return resumePromise } // 挂起等 continue
        var h = list[index]
        ctx.pluginId = h.pluginId
        return Promise.resolve().then(function () {
          return h.fn(ctx, function () { return dispatch(index + 1) })
        })
      }
      // 完整链 promise：挂起时 before_done 已发，continue 后 after 执行完 → after_done
      dispatch(0).then(function () {
        // hook 若不调 next() 直接 prevent/返回，dispatch 内不会发 before_done，这里补发
        if (!beforeSent) sendBefore()
        sendAfter()
      }, function (err) {
        if (!beforeSent) sendBefore()
        sendAfter()
      })
      // 保存挂起上下文，供 continue 恢复
      window.__pluginHookPending = window.__pluginHookPending || {}
      window.__pluginHookPending[callId] = {
        ctx: ctx,
        resume: resumeResolve
      }
    } else if (msg.type === '__plugin_hook_continue') {
      // 阶段2（after）：主窗口 impl 完成，带 result 回来，恢复挂起的 next()。
      var callId = msg.callId
      var pending = (window.__pluginHookPending || {})[callId]
      if (!pending) return
      pending.ctx.result = msg.result
      pending.resume() // next() 的 promise resolve → hook 的 after 部分继续执行
      delete window.__pluginHookPending[callId]
    }
  })
})()
window.addEventListener('error', function () { parent.postMessage({ type: '__plugin_runtime_error', pluginId: '__PLUGIN_ID_TOKEN__', pluginVersion: '__PLUGIN_VERSION_TOKEN__' }, '*') })
window.addEventListener('unhandledrejection', function () { parent.postMessage({ type: '__plugin_runtime_error', pluginId: '__PLUGIN_ID_TOKEN__', pluginVersion: '__PLUGIN_VERSION_TOKEN__' }, '*') })
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
  registerMethod: (method, fn) => {
    const registry = window.__pluginRegistry
    if (!registry) throw new Error('Plugin registry not initialized')
    registry.register(window.__PLUGIN_ID__, method, fn)
  },
  registerHook: (method, handler) => {
    if (!window.__pluginHookLocal) throw new Error('Hook registry not initialized')
    const fn = handler
    window.__pluginHookLocal.register(window.__PLUGIN_ID__, method, fn)
    parent.postMessage({ type: '__plugin_hook_register', pluginId: window.__PLUGIN_ID__, method }, '*')
  },
  callPlugin: (pluginId, method, ...args) => {
    const registry = window.__pluginRegistry
    if (!registry) return Promise.reject(new Error('Plugin registry not initialized'))
    return registry.call(pluginId, method, args)
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

/** 创建 UI 槽位 iframe 沙箱：把插件包内任意 HTML 文件以沙箱渲染，供 slots 槽位挂载。 */
export function createSlotSandbox(plugin: PluginInfo, file: string): SandboxInstance {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.style.cssText = 'border:none;width:100%;height:100%'

  const instance: SandboxInstance = {
    iframe, plugin,
    destroy: () => {
      const list = slotSandboxes.get(plugin.manifest.id)
      if (list) {
        const idx = list.indexOf(instance)
        if (idx >= 0) list.splice(idx, 1)
        if (list.length === 0) slotSandboxes.delete(plugin.manifest.id)
      }
      iframe.remove()
    }
  }

  const list = slotSandboxes.get(plugin.manifest.id) ?? []
  list.push(instance)
  slotSandboxes.set(plugin.manifest.id, list)

  loadSandboxContent(plugin, iframe, file)
  return instance
}

/** 销毁某插件全部槽位沙箱（停用时调用）。 */
export function destroySlotSandboxes(pluginId: string) {
  const list = slotSandboxes.get(pluginId)
  if (!list) return
  for (const sb of [...list]) sb.destroy()
  slotSandboxes.delete(pluginId)
}

async function loadSandboxContent(plugin: PluginInfo, iframe: HTMLIFrameElement, file?: string) {
  const entry = file ?? plugin.manifest.entry?.frontend
  if (!entry) return
  try {
    const fileUrl = (p: string) => getFileUrl(plugin.manifest.id, entry, p)
    const res = await fetch(fileUrl(entry.split('/').pop()!))
    if (!res.ok) return
    let html = await res.text()

    html = convertScriptSrcs(html, fileUrl)
    html = convertCssLinks(html, fileUrl)

    html = buildPluginDoc(plugin, html, entry)

    iframe.onload = () => {
      if (iframe.contentWindow) sourceMap.set(iframe.contentWindow, plugin.manifest.id)
      registerThemeSync(iframe)
    }
    iframe.srcdoc = html
  } catch (e) {
    console.error('[sandbox] loadSandboxContent failed for', plugin.manifest.id, e)
    reportPluginError(plugin.manifest.id, plugin.manifest.version, 'plugin_load_failed')
  }
}

/** 向插件页面注入主题初始化 + 通用样式 + API 桥 + 主题桥，返回最终 srcdoc。 */
export function buildPluginDoc(plugin: PluginInfo, html: string, file?: string): string {
  // 注入 <base href> 指向插件文件服务目录：srcdoc 环境（about:srcdoc）下所有相对
  // URL（含 JS 模块内部 import）必须基于插件文件服务解析，否则多 chunk 产物白屏
  const entry = file ?? plugin.manifest.entry?.frontend ?? ''
  const dir = entry.split('/').slice(0, -1).join('/')
  const baseHref = `${API_BASE}/plugins/${encodeURIComponent(plugin.manifest.id)}/files/${dir ? dir + '/' : ''}`
  html = html.replace(/<head>/i, `<head><base href="${baseHref}">`)
  const themeInit = `<style data-theme-vars>${getThemeVarsCss()}</style><script>document.documentElement.classList.toggle('dark',getComputedStyle(document.documentElement).colorScheme==='dark');document.documentElement.classList.toggle('light',getComputedStyle(document.documentElement).colorScheme==='light')</script>`
  return html.replace('</head>', themeInit + '\n' + injectCss + '\n' + apiBridgeScript.replace('__PLUGIN_ID_TOKEN__', plugin.manifest.id).replace('__PLUGIN_VERSION_TOKEN__', plugin.manifest.version).replace('__API_BASE_TOKEN__', `${API_BASE}/plugins/${plugin.manifest.id}/files`) + '\n' + themeBridgeScript + '\n</head>')
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
    container.innerHTML = inner
    const bridgeScript = document.createElement('script')
    bridgeScript.textContent = `
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
  registerMethod: function (method, fn) {
    var registry = window.__pluginRegistry
    if (!registry) throw new Error('Plugin registry not initialized')
    registry.register('${plugin.manifest.id}', method, fn)
  },
  registerHook: function (method, handler) {
    var reg = window.__pluginHookRegistry
    if (!reg) throw new Error('Hook registry not initialized')
    reg.register('${plugin.manifest.id}', method, handler)
  },
  callPlugin: function (pluginId, method) {
    var registry = window.__pluginRegistry
    if (!registry) return Promise.reject(new Error('Plugin registry not initialized'))
    var args = Array.prototype.slice.call(arguments, 2)
    return registry.call(pluginId, method, args)
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
window.addEventListener('error', function () { window.dispatchEvent(new CustomEvent('qomicex:plugin-error', { detail: { pluginId: '${plugin.manifest.id}', pluginVersion: '${plugin.manifest.version}', errorType: 'plugin_runtime_error' } })) })
window.addEventListener('unhandledrejection', function () { window.dispatchEvent(new CustomEvent('qomicex:plugin-error', { detail: { pluginId: '${plugin.manifest.id}', pluginVersion: '${plugin.manifest.version}', errorType: 'plugin_runtime_error' } })) })
`
    // script 元素必须在已连接 document 中才会执行：临时挂到隐藏节点，执行后移除宿主（容器不留在 body，避免撑出滚动条）
    const hiddenHost = document.createElement('div')
    hiddenHost.style.cssText = 'display:none'
    document.body.appendChild(hiddenHost)
    hiddenHost.appendChild(container)
    hiddenHost.appendChild(bridgeScript)
    ;[...container.querySelectorAll('script')].forEach(oldScript => {
      if (oldScript === bridgeScript) return
      const newScript = document.createElement('script')
      if (oldScript.src) newScript.src = oldScript.src
      if (oldScript.type) newScript.type = oldScript.type
      if (!oldScript.src) newScript.textContent = oldScript.textContent
      oldScript.replaceWith(newScript)
    })
    // 脚本已同步执行，移除隐藏宿主（容器随之脱离 document，等待 PluginPage 挂载）
    hiddenHost.remove()
  } catch (e) {
    console.error('[sandbox] loadInlineContent failed for', plugin.manifest.id, e)
    reportPluginError(plugin.manifest.id, plugin.manifest.version, 'plugin_load_failed')
  }
}

export function getInstance(pluginId: string): SandboxInstance | InlineInstance | WebviewInstance | undefined {
  return sandboxes.get(pluginId) || inlineInstances.get(pluginId) || webviewInstances.get(pluginId)
}

export function registerWebviewInstance(pluginId: string, inst: WebviewInstance) {
  webviewInstances.set(pluginId, inst)
}

export function getWebviewInstance(pluginId: string): WebviewInstance | undefined {
  return webviewInstances.get(pluginId)
}

export function destroyWebviewInstance(pluginId: string) {
  const inst = webviewInstances.get(pluginId)
  webviewInstances.delete(pluginId)
  if (inst) {
    try { inst.destroy() } catch { /* already destroyed */ }
  }
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
    abortStream(e.data.id)
  }
  if (e.data?.type === '__plugin_runtime_error') {
    reportPluginError(e.data.pluginId, e.data.pluginVersion, 'plugin_runtime_error')
  }
})

// 内联渲染桥脚本注入的运行时错误 → 转发遥测（无 iframe 边界，用 CustomEvent 中转）
window.addEventListener('qomicex:plugin-error', ((e: Event) => {
  const d = (e as CustomEvent<{ pluginId: string; pluginVersion: string; errorType: PluginErrorType }>).detail
  reportPluginError(d.pluginId, d.pluginVersion, d.errorType)
}) as EventListener)

const streamAborters = new Map<string, AbortController>()

/** 取消指定 callId 的流式调用（l4 跨窗口桥经 Tauri 事件转发到这里）。 */
export function abortStream(callId: string) {
  const controller = streamAborters.get(callId)
  if (controller) controller.abort()
}

export async function handleApiCall(callId: string, method: string, args: unknown[], pluginId: string, source: Window) {
  if (
    typeof method !== 'string' ||
    !Object.prototype.hasOwnProperty.call(METHOD_PERMISSIONS, method)
  ) {
    source.postMessage({
      type: '__plugin_api_response',
      id: callId,
      error: `Unsupported API method: ${String(method)}`,
    }, '*')
    return
  }
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
  getSettings: 'config:read', setSettings: 'config:write', setCache: 'cache:access', getCache: 'cache:access', callBackend: 'network:fetch', uploadPlugin: 'plugin:install', proxyFetch: 'network:cors_proxy', proxyFetchStream: 'network:cors_proxy',
  registerMethod: 'config:write', callPlugin: 'network:fetch', callWasm: 'wasm:execute', listWasmPlugins: 'wasm:execute',
  readText: 'filesystem:read', readBytes: 'filesystem:read', writeText: 'filesystem:write', writeBytes: 'filesystem:write', deleteFile: 'filesystem:write', execCommand: 'shell:execute',
  navigate: 'config:read', showToast: 'ui:toast', log: 'plugin:log', getSystemInfo: 'system:info', openUrl: 'system:notification', listPlugins: 'plugin:list',
  getThemeColor: 'config:read', applyThemeOverride: 'config:write', clearThemeOverride: 'config:write',
  'overlay.create': 'ui:sub_window', 'overlay.show': 'ui:sub_window', 'overlay.hide': 'ui:sub_window',
  'overlay.destroy': 'ui:sub_window', 'overlay.setHtml': 'ui:sub_window', 'overlay.setPosition': 'ui:sub_window',
  'download.addTask': 'download:manage', 'download.progress': 'download:manage', 'download.cancel': 'download:manage', 'download.list': 'download:manage', 'download.registerInstall': 'instance:write',
  'modpack.install': 'instance:write',
}

/** "H S% L%" → #rrggbb。非法返回 null。 */
function hslStringToHex(hsl: string): string | null {
  const m = /^(\d{1,3})\s+(\d{1,3})%\s+(\d{1,3})%$/.exec(hsl.trim())
  if (!m) return null
  const h = +m[1]!
  const s = +m[2]! / 100
  const l = +m[3]! / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const to = (v: number) => Math.round((v + mm) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** 返回插件主题的种子色 hex：优先外观设置 themeColor，'background'(Monet) 时取当前 --primary（themeColor.ts 已 inline 应用）。无则 null。 */
function getCurrentThemeColorHex(): string | null {
  const mode = getAppSettings().themeColor ?? ''
  if (mode === THEME_COLOR_MODE_BACKGROUND) {
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    return primary ? hslStringToHex(primary) : null
  }
  if (mode) return normalizeHex(mode)
  return null
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
    case 'uploadPlugin': return bridge.uploadPlugin(args[0] as number[], args[1] as string)
    case 'proxyFetch': return bridge.proxyFetch(args[0] as any)
    case 'proxyFetchStream': return bridge.proxyFetchStream(args[0] as any, args[1] as (chunk: string) => void, args[2] as AbortSignal | undefined)
    case 'registerMethod': bridge.registerMethod(args[0] as string, args[1] as (...a: unknown[]) => unknown); return
    case 'callPlugin': return bridge.callPlugin(args[0] as string, args[1] as string, ...(args.slice(2) as unknown[]))
    case 'callWasm': return bridge.callWasm(args[0] as string, args[1] as string | undefined)
    case 'listWasmPlugins': return bridge.listWasmPlugins()
    case 'readText': return bridge.readText(args[0] as string, args[1] as { start?: number; length?: number } | undefined)
    case 'readBytes': return bridge.readBytes(args[0] as string, args[1] as { start?: number; length?: number } | undefined)
    case 'writeText': return bridge.writeText(args[0] as string, args[1] as string)
    case 'writeBytes': return bridge.writeBytes(args[0] as string, args[1] as Uint8Array)
    case 'deleteFile': return bridge.deleteFile(args[0] as string)
    case 'execCommand': return bridge.execCommand(args[0] as string, args[1] as number | undefined)
    case 'getSystemInfo': return bridge.getSystemInfo()
    case 'openUrl': return bridge.openUrl(args[0] as string)
    case 'listPlugins': return bridge.listPlugins()
    case 'navigate': bridge.navigate(args[0] as string); return
    case 'showToast': bridge.showToast(args[0] as string, args[1] as 'info' | 'error' | 'success' | undefined); return
    case 'log': bridge.log(args[0] as string, args[1] as 'debug' | 'info' | 'warn' | 'error' | undefined); return
    case 'getThemeColor': return getCurrentThemeColorHex()
    case 'applyThemeOverride': applyThemeOverride(args[0] as Record<string, string>); return
    case 'clearThemeOverride': clearThemeOverride(); return
    case 'overlay.create': return bridge.createOverlay(args[0] as any)
    case 'overlay.show': bridge.showOverlay(args[0] as string); return
    case 'overlay.hide': bridge.hideOverlay(args[0] as string); return
    case 'overlay.destroy': bridge.destroyOverlay(args[0] as string); return
    case 'overlay.setHtml': bridge.setOverlayHtml(args[0] as string, args[1] as string); return
    case 'overlay.setPosition': bridge.setOverlayPosition(args[0] as string, args[1] as number, args[2] as number); return
    case 'download.addTask': return bridge.download.addTask(args[0] as any)
    case 'download.progress': return bridge.download.progress(args[0] as string)
    case 'download.cancel': bridge.download.cancel(args[0] as string); return
    case 'download.list': return bridge.download.list()
    case 'download.registerInstall': bridge.download.registerInstall(args[0] as any); return
    case 'modpack.install': return bridge.modpack.install(args[0] as any)
    default: throw new Error(`Unknown method: ${method}`)
  }
}
