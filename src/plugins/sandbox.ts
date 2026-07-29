import type { PluginInfo } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createPluginBridge } from './plugin-api.ts'

export interface SandboxInstance {
  iframe: HTMLIFrameElement
  plugin: PluginInfo
  destroy: () => void
}

const sandboxes = new Map<string, SandboxInstance>()
const sourceMap = new WeakMap<Window, string>()

const pluginCss = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;color:#e2e8f0;background:transparent;padding:16px}
.p-tabs{display:flex;gap:4px;margin-bottom:16px}
.p-tab{padding:6px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;background:#1e293b;color:#94a3b8;transition:all .15s}
.p-tab.active,.p-tab--active{background:#22c55e;color:#0f172a;font-weight:600}
.p-tab:hover:not(.active):not(.p-tab--active){background:#334155;color:#e2e8f0}
.p-panel{display:none}
.p-panel.active,.p-panel--active{display:block}
.p-card{background:#1e293b;border-radius:8px;padding:12px;margin-bottom:8px}
.p-card h3,.p-card-title{font-size:13px;color:#94a3b8;margin-bottom:8px}
.p-input,.p-textarea{width:100%;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px;color:#e2e8f0;font-size:13px;outline:none}
.p-input:focus,.p-textarea:focus{border-color:#22c55e}
.p-textarea{resize:vertical;min-height:80px}
.p-btn{padding:6px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s}
.p-btn--primary,.p-btn-primary{background:#22c55e;color:#0f172a}
.p-btn--primary:hover,.p-btn-primary:hover{background:#16a34a}
.p-btn--default,.p-btn-default{background:#334155;color:#e2e8f0}
.p-btn--default:hover,.p-btn-default:hover{background:#475569}
.p-btn--ghost,.p-btn-ghost{background:transparent;color:#94a3b8}
.p-btn--ghost:hover,.p-btn-ghost:hover{background:#1e293b;color:#e2e8f0}
.p-row{display:flex;gap:8px;align-items:center}
.p-row--wrap{flex-wrap:wrap}
.p-col{display:flex;flex-direction:column;gap:8px}
.p-label{font-size:12px;color:#94a3b8;margin-bottom:2px}
.p-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:500}
.p-badge--green{background:#166534;color:#86efac}
.p-badge--red{background:#7f1d1d;color:#fca5a5}
.p-badge--yellow{background:#713f12;color:#fde68a}
.p-divider{height:1px;background:#334155;margin:12px 0}
.p-pre{font-size:12px;background:#0f172a;border-radius:6px;padding:8px;margin-top:8px;max-height:200px;overflow:auto;white-space:pre-wrap;color:#e2e8f0}
.p-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.p-status-dot--up{background:#22c55e}
.p-status-dot--down{background:#ef4444}
.p-icon{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center}
.p-ml-auto{margin-left:auto}
.p-mt-1{margin-top:4px}
.p-mt-2{margin-top:8px}
.p-mb-1{margin-bottom:4px}
.p-mb-2{margin-bottom:8px}
.p-gap-1{gap:4px}
.p-gap-2{gap:8px}
.p-text-center{text-align:center}
.p-text-muted{color:#64748b}
.p-text-sm{font-size:12px}
`
const injectCss = `<style>${pluginCss}<\/style>`
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
  }
}
<\/script>`

export function createSandbox(plugin: PluginInfo): SandboxInstance {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.style.cssText = 'border:none;width:100%;height:100%'

  const instance: SandboxInstance = {
    iframe,
    plugin,
    destroy: () => {
      sandboxes.delete(plugin.manifest.id)
      iframe.remove()
    }
  }

  sandboxes.set(plugin.manifest.id, instance)

  loadPluginContent(plugin, iframe)
  return instance
}

async function loadPluginContent(plugin: PluginInfo, iframe: HTMLIFrameElement) {
  if (!plugin.manifest.entry.frontend) return
  try {
    const base = plugin.manifest.entry.frontend.split('/').slice(0, -1).join('/')
    const fileUrl = (p: string) => `/api/plugins/${plugin.manifest.id}/files/${base ? base + '/' + p : p}`

    const res = await fetch(fileUrl(plugin.manifest.entry.frontend.split('/').pop()!))
    if (!res.ok) return
    let html = await res.text()

    const scriptMatches = html.matchAll(/<script[^>]+src="([^"]+)"[^>]*><\/script>/g)
    for (const match of scriptMatches) {
      const src = match[1]
      const scriptRes = await fetch(fileUrl(src))
      if (scriptRes.ok) {
        const code = await scriptRes.text()
        html = html.replace(match[0], `<script>${code}<\/script>`)
      }
    }

    html = html.replace('</head>', injectCss + '\n' + apiBridgeScript + '\n</head>')

    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    iframe.onload = () => {
      if (iframe.contentWindow) sourceMap.set(iframe.contentWindow, plugin.manifest.id)
      URL.revokeObjectURL(url)
    }
    iframe.setAttribute('src', url)
  } catch { /* plugin content not available */ }
}

window.addEventListener('message', (e) => {
  if (e.data?.type === '__plugin_api_call') {
    const { id, method, args } = e.data
    const pluginId = sourceMap.get(e.source as Window)
    if (pluginId) {
      handleApiCall(id, method, args, pluginId, e.source as Window)
    }
  }
})

async function handleApiCall(
  callId: string,
  method: string,
  args: unknown[],
  pluginId: string,
  source: Window
) {
  let result: unknown
  let error: string | undefined

  try {
    result = await executePluginMethod(pluginId, method, args)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  source.postMessage({
    type: '__plugin_api_response',
    id: callId,
    result,
    error
  }, '*')
}

const METHOD_PERMISSIONS: Record<string, string> = {
  getSettings: 'config:read',
  setSettings: 'config:write',
  callBackend: 'network:fetch',
  navigate: 'config:read',
  showToast: 'ui:toast',
}

async function executePluginMethod(pluginId: string, method: string, args: unknown[]): Promise<unknown> {
  const requiredPerm = METHOD_PERMISSIONS[method]
  if (requiredPerm) {
    const plugin = usePluginStore.getState().getPlugin(pluginId)
    if (!plugin || !plugin.manifest.permissions.includes(requiredPerm)) {
      throw new Error(`Permission denied: requires ${requiredPerm}`)
    }
  }
  const bridge = createPluginBridge(pluginId)
  switch (method) {
    case 'getSettings':
      return bridge.getSettings()
    case 'setSettings':
      return bridge.setSettings(args[0] as string, args[1])
    case 'callBackend':
      return bridge.callBackend(args[0] as string, args[1])
    case 'navigate':
      bridge.navigate(args[0] as string)
      return
    case 'showToast':
      bridge.showToast(args[0] as string, args[1] as 'info' | 'error' | 'success' | undefined)
      return
    default:
      throw new Error(`Unknown method: ${method}`)
  }
}
