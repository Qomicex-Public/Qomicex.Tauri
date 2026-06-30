import { useEffect, useState, useRef, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBug, faXmark, faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons'
import { get } from '../api/client.ts'

const MAX_VISIBLE = 50

export default function LogOverlay() {
  const [collapsed, setCollapsed] = useState(true)
  const [logs, setLogs] = useState<string[]>([])
  const [latest, setLatest] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async () => {
    try {
      const entries = await get<string[]>('/diagnostics/trace')
      setLogs(entries)
      setLatest(entries.length > 0 ? entries[entries.length - 1] : '')
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchLogs()
    const timer = setInterval(fetchLogs, 2000)
    return () => clearInterval(timer)
  }, [fetchLogs])

  useEffect(() => {
    if (!collapsed && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, collapsed])

  if (collapsed) {
    return (
      <div className="fixed bottom-4 right-4 z-[9999]" style={{ pointerEvents: 'none' }}>
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-[11px] text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/85"
          style={{ pointerEvents: 'auto' }}
        >
          <FontAwesomeIcon icon={faBug} className="h-3 w-3" />
          <span className="tabular-nums">{logs.length}</span>
          {latest && <span className="max-w-[200px] truncate text-white/60">{latest}</span>}
          <FontAwesomeIcon icon={faChevronUp} className="h-2.5 w-2.5 text-white/40" />
        </button>
      </div>
    )
  }

  return (
    <div className="fixed bottom-4 right-4 z-[9999]" style={{ pointerEvents: 'none' }}>
      <div
        className="w-96 rounded-lg border border-border bg-background/95 shadow-2xl backdrop-blur-sm"
        style={{ pointerEvents: 'auto' }}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            <FontAwesomeIcon icon={faBug} className="mr-1.5 h-3 w-3" />
            调试日志 ({logs.length})
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setLogs([])} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <FontAwesomeIcon icon={faXmark} className="h-3 w-3" />
            </button>
            <button onClick={() => setCollapsed(true)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <FontAwesomeIcon icon={faChevronDown} className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div
          ref={containerRef}
          className="h-48 overflow-y-auto p-2 font-mono text-[10px] leading-relaxed"
        >
          {logs.length === 0 ? (
            <span className="text-muted-foreground">暂无日志</span>
          ) : (
            logs.slice(-MAX_VISIBLE).map((line, i) => (
              <div key={i} className="text-foreground/70 whitespace-pre-wrap border-b border-border/30 py-0.5 last:border-0">{line}</div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
