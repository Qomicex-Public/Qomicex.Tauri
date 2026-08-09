import { useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { usePluginStore, type PluginOverlay } from '../stores/pluginStore.ts'
import { registerOverlayIframe } from '../plugins/sandbox.ts'
import { pluginCss, registerThemeSync, getThemeVarsCss, themeBridgeScript } from '../plugins/plugin-css.ts'

const apiScript = `<script>
window.__PLUGIN_ID__ = null
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
    registry.register(window.__PLUGIN_ID__ || 'unknown', method, fn)
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

function overlayHtml(inner: string, pluginId: string) {
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
<style data-theme-vars>${getThemeVarsCss()}</style><script>document.documentElement.classList.toggle('dark',getComputedStyle(document.documentElement).colorScheme==='dark');document.documentElement.classList.toggle('light',getComputedStyle(document.documentElement).colorScheme==='light')</script>
${themeBridgeScript}
${styles.join('\n')}
</head>
<body>
<div id="root">${body}</div>
<script>window.__PLUGIN_ID__ = ${JSON.stringify(pluginId)}<\/script>
${apiScript}
</body>
</html>`
}

/** Shared bookkeeping for a pointer-driven drag/resize gesture. */
type GestureRef = {
  sx: number
  sy: number
  active: boolean
  /** Pointer that owns the capture, or -1 when idle. */
  pointerId: number
  /** Element the capture was taken on, so it can be released on the same one. */
  target: HTMLElement | null
}

/** End a gesture: drop the active flag and hand pointer capture back. */
function endGesture(ref: { current: GestureRef }): boolean {
  const g = ref.current
  if (!g.active) return false
  g.active = false
  if (g.target && g.pointerId >= 0 && g.target.hasPointerCapture?.(g.pointerId)) {
    g.target.releasePointerCapture(g.pointerId)
  }
  g.target = null
  g.pointerId = -1
  return true
}

function Floater({ overlay }: { overlay: PluginOverlay }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // No `dragging`/`resizing` state: a gesture writes styles straight to the DOM and
  // only commits to the store on release, so the refs below are the source of truth
  // and an extra render per gesture edge would buy nothing.
  const dragRef = useRef<GestureRef & { ox: number; oy: number }>({
    sx: 0, sy: 0, ox: 0, oy: 0, active: false, pointerId: -1, target: null,
  })
  const resizeRef = useRef<GestureRef & { ow: number; oh: number }>({
    sx: 0, sy: 0, ow: 0, oh: 0, active: false, pointerId: -1, target: null,
  })
  const livePosRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const setOverlayPosition = usePluginStore(s => s.setOverlayPosition)
  const setOverlaySize = usePluginStore(s => s.setOverlaySize)
  const destroyOverlay = usePluginStore(s => s.destroyOverlay)
  const hideOverlay = usePluginStore(s => s.hideOverlay)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const blob = overlayHtml(overlay.html, overlay.pluginId)
    const url = URL.createObjectURL(new Blob([blob], { type: 'text/html' }))
    iframe.src = url
    const onLoad = () => {
      URL.revokeObjectURL(url)
      if (iframe.contentWindow) registerOverlayIframe(iframe.contentWindow, overlay.pluginId)
      registerThemeSync(iframe)
      try {
        iframe.contentDocument?.addEventListener('mousedown', () => {
          usePluginStore.getState().showOverlay(overlay.id)
        })
      } catch { /* sandboxed iframe without allow-same-origin: contentDocument not accessible */ }
    }
    iframe.addEventListener('load', onLoad)
    return () => iframe.removeEventListener('load', onLoad)
  }, [overlay.html, overlay.pluginId, overlay.id])

  // Re-apply live gesture coordinates if a re-render resets inline styles mid-gesture
  useLayoutEffect(() => {
    const el = rootRef.current
    const live = livePosRef.current
    if (!el || !live) return
    el.style.left = `${live.x}px`
    el.style.top = `${live.y}px`
    el.style.width = `${live.w}px`
    el.style.height = `${live.h}px`
  })

  const onDragStart = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) {
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    dragRef.current = {
      sx: e.clientX, sy: e.clientY, ox: overlay.x, oy: overlay.y,
      active: true, pointerId: e.pointerId, target,
    }
    livePosRef.current = { x: overlay.x, y: overlay.y, w: overlay.width, h: overlay.height }
  }, [overlay.x, overlay.y, overlay.width, overlay.height])

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.active) return
    const el = rootRef.current
    if (!el) return
    const x = Math.max(0, dragRef.current.ox + e.clientX - dragRef.current.sx)
    const y = Math.max(0, dragRef.current.oy + e.clientY - dragRef.current.sy)
    livePosRef.current = { x, y, w: overlay.width, h: overlay.height }
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [overlay.width, overlay.height])

  const onDragEnd = useCallback(() => {
    if (!endGesture(dragRef)) return
    const live = livePosRef.current
    livePosRef.current = null
    if (live) setOverlayPosition(overlay.id, live.x, live.y)
  }, [overlay.id, setOverlayPosition])

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    resizeRef.current = {
      sx: e.clientX, sy: e.clientY, ow: overlay.width, oh: overlay.height,
      active: true, pointerId: e.pointerId, target,
    }
    livePosRef.current = { x: overlay.x, y: overlay.y, w: overlay.width, h: overlay.height }
  }, [overlay.x, overlay.y, overlay.width, overlay.height])

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current.active) return
    const el = rootRef.current
    if (!el) return
    const w = Math.max(200, resizeRef.current.ow + e.clientX - resizeRef.current.sx)
    const h = Math.max(120, resizeRef.current.oh + e.clientY - resizeRef.current.sy)
    livePosRef.current = { x: overlay.x, y: overlay.y, w, h }
    el.style.width = `${w}px`
    el.style.height = `${h}px`
  }, [overlay.x, overlay.y])

  const onResizeEnd = useCallback(() => {
    if (!endGesture(resizeRef)) return
    const live = livePosRef.current
    livePosRef.current = null
    if (live) setOverlaySize(overlay.id, live.w, live.h)
  }, [overlay.id, setOverlaySize])

  // Commit any in-flight gesture if the window loses focus (Alt-Tab, etc.).
  // Delegates to the normal end handlers so this path can't drift from them.
  // Clearing `active` is the critical part: pointermove is bound on the header
  // and fires on plain hover, so a stale `active` would make the overlay follow
  // the cursor with no button held once focus came back.
  useEffect(() => {
    const onBlur = () => {
      onDragEnd()
      onResizeEnd()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [onDragEnd, onResizeEnd])

  if (!overlay.visible) return null

  return createPortal(
    <div
      ref={rootRef}
      style={{ position: 'fixed', left: overlay.x, top: overlay.y, width: overlay.width, height: overlay.height, zIndex: overlay.ordering }}
      className="flex flex-col rounded-lg border border-border/50 bg-card/95 backdrop-blur shadow-2xl overflow-hidden"
      onMouseDown={() => { const { showOverlay } = usePluginStore.getState(); showOverlay(overlay.id) }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-muted/50 cursor-grab active:cursor-grabbing select-none touch-none"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span className="text-xs font-medium text-popover-foreground truncate flex-1">{overlay.title}</span>
        {overlay.minimizable && (
          <button className="text-muted-foreground hover:text-foreground transition-colors text-xs w-5 h-5 flex items-center justify-center rounded" onClick={() => hideOverlay(overlay.id)}>—</button>
        )}
        <button className="text-muted-foreground hover:text-destructive transition-colors text-xs w-5 h-5 flex items-center justify-center rounded" onClick={() => destroyOverlay(overlay.id)}>x</button>
      </div>
      <iframe ref={iframeRef} sandbox="allow-scripts" className="flex-1 w-full" />
      {overlay.resizable && (
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize touch-none"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        >
          <svg viewBox="0 0 16 16" className="w-full h-full text-muted-foreground/60">
            <path d="M12 12 L16 8 M12 16 L16 12 M8 16 L12 12" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      )}
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