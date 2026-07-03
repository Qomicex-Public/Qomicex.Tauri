import { useEffect, useState, useRef, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate, faDownload, faTrashCan, faBug, faCircleCheck, faCircleXmark, faServer } from '@fortawesome/free-solid-svg-icons'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card.tsx'
import { Button } from './ui/button.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { cn } from '../lib/utils.ts'
import { useDebug } from './DebugContext.tsx'
import { getSystemInfo } from '../api/system.ts'
import { get, post, API_BASE } from '../api/client.ts'
import type { SystemInfo } from '../types/index.ts'
import { useMessageBox } from './ui/message-box.tsx'

function LogCard() {
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const { notify } = useMessageBox()

  const fetchLogs = useCallback(async () => {
    try {
      const entries = await get<string[]>('/diagnostics/trace')
      setLogs(entries.length > 500 ? entries.slice(-500) : entries)
    } catch { console.warn('Failed to fetch logs') }
  }, [])

  useEffect(() => {
    fetchLogs()
    const timer = setInterval(fetchLogs, 3000)
    return () => clearInterval(timer)
  }, [fetchLogs])

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleExport = () => {
    const text = logs.join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `launcher-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDump = async () => {
    try {
      const res = await post<{ path: string }>('/diagnostics/dump')
      notify(`日志已导出到: ${res.path}`, 'success')
    } catch { console.warn('Failed to dump logs') }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><FontAwesomeIcon icon={faServer} className="mr-2 h-4 w-4" />实时日志</CardTitle>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={autoScroll ? 'default' : 'outline'} onClick={() => setAutoScroll(!autoScroll)} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faRotate} className={cn('h-3 w-3', autoScroll && 'animate-spin')} />自动滚动
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLogs([])} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faTrashCan} className="h-3 w-3" />清空
          </Button>
          <Button size="sm" variant="outline" onClick={handleExport} disabled={logs.length === 0} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />导出日志
          </Button>
          <Button size="sm" variant="outline" onClick={handleDump} className="h-7 text-xs gap-1">
            <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />触发 Dump
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div
          ref={containerRef}
          onScroll={() => {
            if (containerRef.current) {
              const { scrollTop, scrollHeight, clientHeight } = containerRef.current
              setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20)
            }
          }}
          className="h-80 overflow-y-auto bg-muted/30 p-3 font-mono text-xs leading-relaxed"
        >
          {logs.length === 0 ? (
            <span className="text-muted-foreground">暂无日志...</span>
          ) : (
            logs.map((line, i) => <div key={i} className="text-foreground/80 whitespace-pre-wrap">{line}</div>)
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function DiagnosticsCard() {
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [health, setHealth] = useState<any>(null)
  const [apiTests, setApiTests] = useState<Record<string, { ok: boolean; latency: number }>>({})
  const [loading, setLoading] = useState(true)
  const [backendOk, setBackendOk] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [sys, h] = await Promise.all([
          getSystemInfo(),
          get<any>('/diagnostics/health'),
        ])
        if (cancelled) return
        setSysInfo(sys)
        setHealth(h)
      } catch { setBackendOk(false); console.warn('Failed to fetch system info / health') }
      const endpoints = ['/instances', '/settings', '/resources/search?category=mod&pageSize=1']
      const results: typeof apiTests = {}
      for (const ep of endpoints) {
        const start = performance.now()
        try {
          await get(ep)
          results[ep] = { ok: true, latency: Math.round(performance.now() - start) }
        } catch {
          console.warn(`API health check failed for ${ep}`)
          results[ep] = { ok: false, latency: -1 }
        }
      }
      if (!cancelled) setApiTests(results)
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle><FontAwesomeIcon icon={faBug} className="mr-2 h-4 w-4" />启动器诊断</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...</div>
        ) : (
          <>
            {sysInfo && (
              <div>
                <p className="font-medium text-xs text-muted-foreground mb-1">系统信息</p>
                <p className="text-xs">OS: {sysInfo.osName} {sysInfo.architecture} | RAM: {(sysInfo.availableMemory / 1024).toFixed(1)} / {(sysInfo.memory / 1024).toFixed(1)} GiB</p>
              </div>
            )}
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">版本信息</p>
              <p className="text-xs">Launcher: 0.1.0 | React: 19 | Build: {import.meta.env.DEV ? 'dev' : 'release'}</p>
            </div>
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">连通状态</p>
              <p className="text-xs space-x-3">
                <span><FontAwesomeIcon icon={backendOk ? faCircleCheck : faCircleXmark} className={cn('h-3 w-3 mr-1', backendOk ? 'text-green-500' : 'text-red-500')} />Backend</span>
                {health && (
                  <>
                    <span><FontAwesomeIcon icon={health.modrinth?.ok ? faCircleCheck : faCircleXmark} className={cn('h-3 w-3 mr-1', health.modrinth?.ok ? 'text-green-500' : 'text-red-500')} />Modrinth ({health.modrinth?.latency ?? '?'}ms)</span>
                    <span><FontAwesomeIcon icon={health.curseforge?.ok ? faCircleCheck : faCircleXmark} className={cn('h-3 w-3 mr-1', health.curseforge?.ok ? 'text-green-500' : 'text-red-500')} />CurseForge ({health.curseforge?.latency ?? '?'}ms)</span>
                  </>
                )}
              </p>
            </div>
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">API 健康检查</p>
              <div className="space-y-0.5">
                {Object.entries(apiTests).map(([ep, r]) => (
                  <p key={ep} className="text-xs"><FontAwesomeIcon icon={r.ok ? faCircleCheck : faCircleXmark} className={cn('h-3 w-3 mr-1', r.ok ? 'text-green-500' : 'text-red-500')} />{ep} {r.ok ? `${r.latency}ms` : 'FAILED'}</p>
                ))}
              </div>
            </div>
            <div>
              <p className="font-medium text-xs text-muted-foreground mb-1">路径信息</p>
              <p className="text-xs">API Base: {API_BASE}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function TogglesCard() {
  const { state, toggle } = useDebug()

  const items: { key: keyof typeof state; label: string }[] = [
    { key: 'disableAnimations', label: '禁用动画' },
    { key: 'showComponentBoundaries', label: '显示组件边界' },
    { key: 'simulateApiErrors', label: '模拟 API 错误' },
    { key: 'networkLogging', label: '网络请求日志' },
    { key: 'disableCaching', label: '禁用缓存' },
    { key: 'logOverlay', label: '日志浮层（全局）' },
    { key: 'showGameSettings', label: '显示游戏设置入口' },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle><FontAwesomeIcon icon={faBug} className="mr-2 h-4 w-4" />调试开关（临时，重启归零）</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {items.map(item => (
            <label key={item.key} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={state[item.key]} onCheckedChange={() => toggle(item.key)} />
              {item.label}
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default function DebugTab() {
  return (
    <div className="space-y-4">
      <LogCard />
      <DiagnosticsCard />
      <TogglesCard />
    </div>
  )
}
