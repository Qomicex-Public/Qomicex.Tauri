import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { API_BASE } from '../api/client.ts'
import { cancelLaunch, type GameLogLine } from '../api/instance.ts'
import { Button, Input } from '../components/ui'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../lib/utils.ts'

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'FATAL' | 'OTHER'
const LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG', 'FATAL', 'OTHER']

/** Minecraft 日志行形如 `[12:34:56] [main/INFO]: ...`，提取 LEVEL。 */
/**
 * 解析 Minecraft 日志行的等级：`[thread/LEVEL]`，如 `[main/INFO]`、`[Render thread/ERROR]`。
 * NeoForge 日志形如 `[time] [main/INFO] [logger/]: message`，等级括号后可能还有其它括号，
 * 故只按「括号内 线程/LEVEL」匹配，不要求其后紧跟冒号。无等级标签则返回 null。
 */
const LEVEL_RE = /\[([^\]]+)\/(INFO|WARN|ERROR|DEBUG|FATAL|TRACE)\]/

function detectLevel(text: string): LogLevel | null {
  const m = LEVEL_RE.exec(text)
  if (m) {
    const lvl = m[2].toUpperCase()
    return lvl === 'TRACE' ? 'DEBUG' : (lvl as LogLevel)
  }
  return null
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  INFO: 'text-sky-500',
  WARN: 'text-amber-500',
  ERROR: 'text-red-500',
  DEBUG: 'text-fuchsia-500',
  FATAL: 'text-red-600 font-bold',
  OTHER: 'text-muted-foreground',
}

const MAX_LINES = 5000

interface Line extends GameLogLine {
  id: number
  level: LogLevel
}

/** 独立的实时游戏日志窗口（Tauri 子窗口，加载本 SPA 的 ?logWindow=1 分支）。 */
export default function GameLogWindow({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const win = isTauri ? getCurrentWindow() : null
  // 与主窗口 Layout 判定一致：Windows 隐藏系统标题栏并渲染自定义标题栏。
  const isWindows = !navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Mac')

  const [lines, setLines] = useState<Line[]>([])
  const [search, setSearch] = useState('')
  const [connected, setConnected] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [visible, setVisible] = useState<Record<LogLevel, boolean>>({
    INFO: true, WARN: true, ERROR: true, DEBUG: true, FATAL: true, OTHER: true,
  })
  const idRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  // 最近一条带等级日志的等级，供堆栈/续行继承（无 [thread/LEVEL] 时沿用）。
  const lastLevelRef = useRef<LogLevel>('OTHER')

  /** 由一行原始输出构造 Line：优先自身等级；无等级则继承上一行（异常堆栈续行）。 */
  const lineFrom = (base: GameLogLine): Line => {
    const detected = detectLevel(base.text)
    let level: LogLevel
    if (detected) {
      level = detected
      lastLevelRef.current = detected
    } else {
      level = lastLevelRef.current
    }
    return { ...base, id: ++idRef.current, level }
  }

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/instance/${encodeURIComponent(instanceId)}/logs/stream`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.type === 'snapshot') {
          const arr: Line[] = (d.lines || []).map((l: GameLogLine) => lineFrom(l))
          setLines(arr)
        } else if (d.type === 'line') {
          const l = d.entry as GameLogLine
          setLines(prev => {
            const next = [...prev, lineFrom(l)]
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
          })
        }
      } catch { /* ignore malformed frame */ }
    }
    return () => es.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  // 自动滚动到底部（默认跟随新日志）。
  useEffect(() => {
    if (stickRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [lines])

  const toggle = (lv: LogLevel) => setVisible(v => ({ ...v, [lv]: !v[lv] }))
  const allOn = LEVELS.every(lv => visible[lv])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return lines.filter(l => visible[l.level] && (!q || l.text.toLowerCase().includes(q)))
  }, [lines, visible, search])

  const onStop = async () => {
    if (stopping) return
    if (!window.confirm(t('gameLog.confirmStop'))) return
    setStopping(true)
    try { await cancelLaunch(instanceId) } catch { /* 后端不可达等，忽略 */ }
    setStopping(false)
  }

  const onClose = () => { win?.close() }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {isWindows && (
        <div data-tauri-drag-region className="flex h-9 shrink-0 items-center justify-between bg-background/50 pl-3 pr-0">
          <span className="select-none text-xs text-muted-foreground">{t('gameLog.title')}</span>
          <div className="flex">
            <button onClick={() => win?.minimize()} data-tauri-drag-region={false}
              className="flex h-9 w-11 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-all duration-150 hover:bg-white/10 hover:text-foreground active:bg-white/20">
              <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="5.5" width="9" height="1" fill="currentColor" /></svg>
            </button>
            <button onClick={() => win?.toggleMaximize()} data-tauri-drag-region={false}
              className="flex h-9 w-11 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-all duration-150 hover:bg-white/10 hover:text-foreground active:bg-white/20">
              <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.15" fill="none" /></svg>
            </button>
            <button onClick={onClose} data-tauri-drag-region={false}
              className="flex h-9 w-11 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-all duration-150 hover:bg-destructive/80 hover:text-destructive-foreground active:bg-destructive">
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* 工具栏：搜索 + 等级筛选 + 状态 + 停止 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('gameLog.search')}
          className="h-8 w-56"
        />
        <div className="flex items-center gap-1">
          <button
            onClick={() => setVisible(Object.fromEntries(LEVELS.map(lv => [lv, !allOn])) as Record<LogLevel, boolean>)}
            className={cn('rounded px-2 py-1 text-xs', allOn ? 'bg-primary/15 text-foreground' : 'text-muted-foreground/50 hover:text-foreground')}
          >
            {t('gameLog.all')}
          </button>
          {LEVELS.map(lv => (
            <button
              key={lv}
              onClick={() => toggle(lv)}
              title={lv}
              className={cn(
                'rounded px-2 py-1 text-xs',
                visible[lv] ? 'bg-primary/15 text-foreground' : 'text-muted-foreground/40 hover:text-foreground',
              )}
            >
              <span className={cn(visible[lv] && LEVEL_CLASS[lv])}>{t(`gameLog.${lv.toLowerCase()}`)}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className={cn('flex items-center gap-1.5 text-xs', connected ? 'text-green-500' : 'text-muted-foreground')}>
            <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-green-500' : 'bg-muted-foreground')} />
            {connected ? t('gameLog.connected') : t('gameLog.disconnected')}
          </span>
          <Button size="sm" variant="destructive" disabled={stopping} onClick={onStop}>
            {t('gameLog.stopGame')}
          </Button>
        </div>
      </div>

      {/* 日志列表 */}
      <div ref={listRef} className="log-selectable flex-1 overflow-auto px-3 py-2 font-mono text-[13px] leading-5" onScroll={e => {
        const el = e.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}>
        {filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t('gameLog.empty')}</div>
        ) : filtered.map(l => (
          <div key={l.id} className="whitespace-pre-wrap break-all">
            <span className="text-muted-foreground">[{l.timestamp}]</span>{' '}
            <span className={cn(LEVEL_CLASS[l.level])}>{l.level.padEnd(5)}</span>{' '}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  )
}
