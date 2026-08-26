import { useEffect, useRef, useState } from 'react'
import type { PluginInfo } from '../plugins/types.ts'
import { fetchPlugin } from '../api/plugins.ts'
import { convertScriptSrcs, convertCssLinks, getFileUrl, buildPluginDoc } from '../plugins/sandbox.ts'
import { getThemeVars, getThemeScheme } from '../plugins/plugin-css.ts'
import { initApiTransport } from '../api/ipc.ts'

/**
 * l4 独立窗口页：由主窗口 `createRemoteWebview` 以 `/plugins/p/:id?pluginWebview=1`
 * 打开。轻量启动（不加载主 Layout / 路由 / 插件自动激活），只做一件事：把插件页面
 * 渲染进本窗口的 iframe，并把插件桥的 `__plugin_api_call` 经 Tauri 事件转发到主窗口
 * 执行（主窗口持有真实 instance + 权限校验），响应再转回 iframe。
 *
 * 插件自身渲染在独立 WebView 进程，busy-loop 只冻结本窗口，不影响主 UI。
 */
export default function PluginWebviewPage({ pluginId }: { pluginId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [plugin, setPlugin] = useState<PluginInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const iframe = iframeRef.current
    if (!iframe) return
    const unlistens: (() => void)[] = []
    const cleanup = () => {
      disposed = true
      unlistens.forEach(f => { try { f() } catch { /* ignore */ } })
    }

    ;(async () => {
      let info: PluginInfo
      try {
        // 与主窗口一致：release 下探测并切到 qomicex:// 管道传输（否则默认 http :5000 也通，CSP 已放行）
        await initApiTransport()
        info = await fetchPlugin(pluginId)
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
        return
      }
      if (disposed) return
      setPlugin(info)

      const entry = info.manifest.entry.frontend
      if (!entry) {
        if (!disposed) setError('manifest.entry.frontend 缺失，无法渲染')
        return
      }
      try {
        const fileUrl = (p: string) => getFileUrl(info.manifest.id, entry, p)
        const res = await fetch(fileUrl(entry.split('/').pop()!))
        if (!res.ok) throw new Error(`插件前端资源加载失败 (${res.status})`)
        let html = await res.text()
        html = convertScriptSrcs(html, fileUrl)
        html = convertCssLinks(html, fileUrl)
        html = buildPluginDoc(info, html)

        const { listen, emitTo } = await import('@tauri-apps/api/event')

        // 插件桥 → 主窗口：仅转发 API 调用（协议消息体原样，传输层换成跨窗口事件）
        const forward = (e: MessageEvent) => {
          if (e.source !== iframe.contentWindow) return
          const msg = e.data
          if (!msg?.type) return
          if (msg.type === '__plugin_api_call') {
            void emitTo('main', 'plugin-l4-api-call', { pluginId, id: msg.id, method: msg.method, args: msg.args })
          } else if (msg.type === '__plugin_api_abort') {
            void emitTo('main', 'plugin-l4-api-abort', { id: msg.id })
          }
        }
        window.addEventListener('message', forward)
        unlistens.push(() => window.removeEventListener('message', forward))

        // 主窗口 → 插件桥：响应按协议原样 post 回 iframe
        unlistens.push(await listen('plugin-l4-api-response', (e) => {
          iframe.contentWindow?.postMessage(e.payload, '*')
        }))

        iframe.onload = () => {
          // 主题一次性推送（本窗口无完整主题管线，取计算样式同步一次即可）
          iframe.contentWindow?.postMessage(
            { type: '__qomicex_theme', vars: getThemeVars(), scheme: getThemeScheme() },
            '*'
          )
        }
        iframe.srcdoc = html
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return cleanup
  }, [pluginId])

  return (
    <div className="flex h-screen w-screen flex-col bg-background">
      {plugin && (
        <div className="flex items-center gap-3 border-b border-border/50 px-4 py-2 text-sm">
          <span className="font-medium">{plugin.manifest.name}</span>
          <span className="text-xs text-muted-foreground">v{plugin.manifest.version} · 独立窗口</span>
        </div>
      )}
      {error && (
        <div className="px-4 py-3 text-sm text-destructive">{error}</div>
      )}
      <iframe ref={iframeRef} sandbox="allow-scripts" className="min-h-0 flex-1 border-0" />
    </div>
  )
}
