import { useRef, useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { usePluginStore, type PluginOverlay } from '../stores/pluginStore.ts'
import { registerOverlayIframe } from '../plugins/sandbox.ts'
import { pluginCss } from '../plugins/plugin-css.ts'

const apiScript = `<script>
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
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.p-tabs').forEach(tabs=>{
    tabs.querySelectorAll('.p-tab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        tabs.querySelectorAll('.p-tab').forEach(t=>t.classList.remove('active'))
        tab.classList.add('active')
        const panelId=tab.dataset.pTab||tab.dataset.tab
        if(!panelId)return
        document.querySelectorAll('.p-panel.active,.p-panel--active').forEach(p=>p.classList.remove('active','p-panel--active'))
        const panel=document.getElementById('panel-'+panelId)
        if(panel)panel.classList.add('active')
      })
    })
  })
  document.querySelectorAll('.p-swiper input[type="checkbox"]').forEach(cb=>{
    cb.addEventListener('change',()=>{
      const panel=document.getElementById(cb.dataset.pSwitch)
      if(panel)panel.style.display=cb.checked?'block':'none'
    })
  })
})<\/script>`

function overlayHtml(inner: string) {
  const styles: string[] = []
  let body = inner
  body = body.replace(/<style[\s\S]*?<\/style>/gi, m => { styles.push(m); return '' })
  body = body.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, m => { styles.push(m); return '' })
  body = body
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
    .replace(/id="root"/g, '')
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${pluginCss}</style>
${styles.join('\n')}
</head>
<body>
<div id="root">${body}</div>
${apiScript}
</body>
</html>`
}

function Floater({ overlay }: { overlay: PluginOverlay }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef({ sx: 0, sy: 0, ox: 0, oy: 0 })
  const setOverlayPosition = usePluginStore(s => s.setOverlayPosition)
  const destroyOverlay = usePluginStore(s => s.destroyOverlay)
  const hideOverlay = usePluginStore(s => s.hideOverlay)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const blob = overlayHtml(overlay.html)
    const url = URL.createObjectURL(new Blob([blob], { type: 'text/html' }))
    iframe.src = url
    const onLoad = () => {
      URL.revokeObjectURL(url)
      if (iframe.contentWindow) registerOverlayIframe(iframe.contentWindow, overlay.pluginId)
      try {
        iframe.contentDocument?.addEventListener('mousedown', () => {
          usePluginStore.getState().showOverlay(overlay.id)
        })
      } catch { /* sandboxed iframe without allow-same-origin: contentDocument not accessible */ }
    }
    iframe.addEventListener('load', onLoad)
    return () => iframe.removeEventListener('load', onLoad)
  }, [overlay.html, overlay.pluginId, overlay.id])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: overlay.x, oy: overlay.y }
    setDragging(true)
  }, [overlay.x, overlay.y])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      setOverlayPosition(
        overlay.id,
        Math.max(0, dragRef.current.ox + e.clientX - dragRef.current.sx),
        Math.max(0, dragRef.current.oy + e.clientY - dragRef.current.sy)
      )
    }
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, overlay.id, setOverlayPosition])

  if (!overlay.visible) return null

  return createPortal(
    <div
      ref={rootRef}
      style={{ position: 'fixed', left: overlay.x, top: overlay.y, width: overlay.width, height: overlay.height, zIndex: overlay.ordering }}
      className="flex flex-col rounded-lg border border-border/50 bg-card/95 backdrop-blur shadow-2xl overflow-hidden"
      onMouseDown={() => { const { showOverlay } = usePluginStore.getState(); showOverlay(overlay.id) }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-muted/50 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onMouseDown}
      >
        <span className="text-xs font-medium text-popover-foreground truncate flex-1">{overlay.title}</span>
        <button className="text-muted-foreground hover:text-foreground transition-colors text-xs w-5 h-5 flex items-center justify-center rounded" onClick={() => hideOverlay(overlay.id)}>—</button>
        <button className="text-muted-foreground hover:text-destructive transition-colors text-xs w-5 h-5 flex items-center justify-center rounded" onClick={() => destroyOverlay(overlay.id)}>x</button>
      </div>
      <iframe ref={iframeRef} sandbox="allow-scripts" className="flex-1 w-full" />
    </div>,
    document.body
  )
}

function MinimizedBar() {
  const overlays = usePluginStore(s => s.overlays).filter(o => !o.visible)
  const showOverlay = usePluginStore(s => s.showOverlay)
  const destroyOverlay = usePluginStore(s => s.destroyOverlay)
  if (overlays.length === 0) return null

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[9999] flex items-center gap-2 bg-card/95 backdrop-blur border border-border/50 rounded-lg shadow-lg px-3 py-2">
      <span className="text-xs text-muted-foreground">最小化 {overlays.length}</span>
      {overlays.map(o => (
        <span key={o.id} className="flex items-center gap-1">
          <button
            className="text-xs bg-muted/50 hover:bg-muted px-2 py-1 rounded text-popover-foreground transition-colors"
            onClick={() => showOverlay(o.id)}
          >{o.title}</button>
          <button
            className="text-xs text-muted-foreground hover:text-destructive w-4 h-4 flex items-center justify-center rounded transition-colors"
            onClick={() => destroyOverlay(o.id)}
          >x</button>
        </span>
      ))}
    </div>,
    document.body
  )
}

export default function PluginOverlayManager() {
  const overlays = usePluginStore(s => s.overlays)
  return <>
    {overlays.filter(o => o.visible).map(o => <Floater key={o.id} overlay={o} />)}
    <MinimizedBar />
  </>
}