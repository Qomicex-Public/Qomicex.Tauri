import { useEffect, useState, useRef, useCallback } from 'react'
import { Bug, CheckCircle2, Copy, Download, RotateCw, Server, Trash2, XCircle } from 'lucide-react'
import { Button } from './ui'
import { Switch } from './ui'
import { SettingSection } from './settings/SettingRow.tsx'
import { cn } from '../lib/utils.ts'
import { useDebug } from './DebugContext.tsx'
import { getSystemInfo } from '../api/system.ts'
import { get, post, API_BASE } from '../api/client.ts'
import type { SystemInfo } from '../types/index.ts'
import { useMessageBox } from './ui'
import { clearAllTasks } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'

/** 从日志行推断级别（支持 tracing 的 " INFO "/" ERROR " 与 [frontend:level]/[downloader:Level]）。 */
function inferLevel(line: string): 'ERROR' | 'WARN' | 'DEBUG' | 'INFO' {
  if (/\bERROR\b/.test(line) || /\[(?:frontend|downloader):error\]/i.test(line) || /\[(?:frontend|downloader):Error\]/.test(line)) return 'ERROR'
  if (/\bWARN\b/.test(line) || /\[(?:frontend|downloader):warn\]/i.test(line) || /\[(?:frontend|downloader):Warn\]/.test(line)) return 'WARN'
  if (/\bDEBUG\b/.test(line) || /\[(?:frontend|downloader):debug\]/i.test(line) || /\[(?:frontend|downloader):Debug\]/.test(line)) return 'DEBUG'
  return 'INFO'
}

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'text-red-400',
  WARN: 'text-yellow-500/90',
  INFO: 'text-foreground/80',
  DEBUG: 'text-muted-foreground/70',
}

function LogCard() {
  const [logs, setLogs] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const { notify } = useMessageBox()
  const { t } = useI18n()

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
      notify(t('tools.debug.dumpExported', { path: res.path }), 'success')
    } catch { console.warn('Failed to dump logs') }
  }

  const handleCopy = async () => {
    if (logs.length === 0) return
    try {
      await navigator.clipboard.writeText(logs.join('\n'))
      notify(t('common.copied'), 'success')
    } catch { /* 剪贴板不可用时忽略 */ }
  }

  return (
    <SettingSection title={t('tools.debug.liveLogs')} icon={<Server className="h-4 w-4" />}>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={autoScroll ? 'default' : 'outline'} onClick={() => setAutoScroll(!autoScroll)} className="gap-1">
              <RotateCw className={cn('h-4 w-4', autoScroll && 'animate-spin')} />{t('tools.debug.autoScroll')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setLogs([])} className="gap-1">
              <Trash2 className="h-4 w-4" />{t('tools.debug.clear')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleExport} disabled={logs.length === 0} className="gap-1">
              <Download className="h-4 w-4" />{t('tools.debug.exportLogs')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleCopy} disabled={logs.length === 0} className="gap-1">
              <Copy className="h-4 w-4" />{t('common.copy')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleDump} className="gap-1">
              <Download className="h-4 w-4" />{t('tools.debug.triggerDump')}
            </Button>
          </div>
          <div className="overflow-hidden rounded-lg border">
            <div
              ref={containerRef}
              onScroll={() => {
                if (containerRef.current) {
                  const { scrollTop, scrollHeight, clientHeight } = containerRef.current
                  setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20)
                }
              }}
              className="log-selectable h-80 overflow-y-auto bg-muted/30 p-3 font-mono text-xs leading-relaxed"
            >
              {logs.length === 0 ? (
                <span className="text-muted-foreground">{t('tools.debug.noLogs')}</span>
              ) : (
                logs.map((line, i) => (
                  <div key={i} className={cn('whitespace-pre-wrap', LEVEL_COLOR[inferLevel(line)])}>{line}</div>
                ))
              )}
            </div>
          </div>
        </div>
      </SettingSection>
  )
}

function DiagnosticsCard() {
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [health, setHealth] = useState<any>(null)
  const [apiTests, setApiTests] = useState<Record<string, { ok: boolean; latency: number }>>({})
  const [loading, setLoading] = useState(true)
  const [backendOk, setBackendOk] = useState(true)
  const { t } = useI18n()

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      // 系统信息秒显：不依赖 /diagnostics/health（该端点含外部网络 ping，可能数秒）
      try {
        const sys = await getSystemInfo()
        if (!cancelled) setSysInfo(sys)
      } catch { if (!cancelled) setBackendOk(false); console.warn('Failed to fetch system info') }
      if (!cancelled) setLoading(false)
      // 连通状态（Modrinth/CurseForge）异步更新，慢 ping 不阻塞其余诊断信息
      try {
        const h = await get<any>('/diagnostics/health')
        if (!cancelled) setHealth(h)
      } catch { if (!cancelled) setBackendOk(false); console.warn('Failed to fetch health') }
      const endpoints = ['/instance', '/settings', '/resources/search?category=mod&pageSize=1']
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
    }
    load()
    return () => { cancelled = true }
  }, [])

  return (
    <SettingSection title={t('tools.debug.diagnostics')} icon={<Bug className="h-4 w-4" />}>
        <div className="space-y-3 p-4 text-sm">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground"><RotateCw className="h-4 w-4 animate-spin" />{t('common.loading')}</div>
          ) : (
            <>
              {sysInfo && (
                <div>
                  <p className="font-medium text-xs text-muted-foreground mb-1">{t('tools.debug.systemInfo')}</p>
                  <p className="text-xs">OS: {sysInfo.osName} {sysInfo.architecture} | RAM: {(sysInfo.availableMemory / 1024).toFixed(1)} / {(sysInfo.memory / 1024).toFixed(1)} GiB</p>
                </div>
              )}
              <div>
                <p className="font-medium text-xs text-muted-foreground mb-1">{t('tools.debug.versionInfo')}</p>
                <p className="text-xs">Launcher: {__APP_VERSION__} | React: 19 | Build: {import.meta.env.DEV ? 'dev' : 'release'}</p>
              </div>
              <div>
                <p className="font-medium text-xs text-muted-foreground mb-1">{t('tools.debug.connectivity')}</p>
                <p className="text-xs space-x-3">
                  <span>{backendOk ? <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" /> : <XCircle className="h-3 w-3 mr-1 text-red-500" />}Backend</span>
                  {health ? (
                    <>
                      <span>{health.modrinth?.ok ? <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" /> : <XCircle className="h-3 w-3 mr-1 text-red-500" />}Modrinth ({health.modrinth?.latency ?? '?'}ms)</span>
                      <span>{health.curseforge?.ok ? <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" /> : <XCircle className="h-3 w-3 mr-1 text-red-500" />}CurseForge ({health.curseforge?.latency ?? '?'}ms)</span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground"><RotateCw className="h-3 w-3 mr-1 animate-spin" />Modrinth</span>
                      <span className="text-muted-foreground"><RotateCw className="h-3 w-3 mr-1 animate-spin" />CurseForge</span>
                    </>
                  )}
                </p>
              </div>
              <div>
                <p className="font-medium text-xs text-muted-foreground mb-1">{t('tools.debug.apiHealthCheck')}</p>
                <div className="space-y-0.5">
                  {Object.entries(apiTests).map(([ep, r]) => (
                    <p key={ep} className="text-xs">{r.ok ? <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" /> : <XCircle className="h-3 w-3 mr-1 text-red-500" />}{ep} {r.ok ? `${r.latency}ms` : 'FAILED'}</p>
                  ))}
                </div>
              </div>
              <div>
                <p className="font-medium text-xs text-muted-foreground mb-1">{t('tools.debug.pathInfo')}</p>
                <p className="text-xs">API Base: {API_BASE}</p>
              </div>
            </>
          )}
        </div>
      </SettingSection>
  )
}

function TogglesCard() {
  const { state, toggle } = useDebug()
  const { t } = useI18n()

  const items: { key: keyof typeof state; label: string }[] = [
    { key: 'disableAnimations', label: t('tools.debug.toggleDisableAnimations') },
    { key: 'showComponentBoundaries', label: t('tools.debug.toggleShowComponentBoundaries') },
    { key: 'simulateApiErrors', label: t('tools.debug.toggleSimulateApiErrors') },
    { key: 'networkLogging', label: t('tools.debug.toggleNetworkLogging') },
    { key: 'disableCaching', label: t('tools.debug.toggleDisableCaching') },
    { key: 'logOverlay', label: t('tools.debug.toggleLogOverlay') },
    { key: 'showFps', label: t('tools.debug.toggleShowFps') },
  ]

  return (
    <SettingSection title={t('tools.debug.togglesTitle')} icon={<Bug className="h-4 w-4" />}>
        <div className="grid grid-cols-2 gap-3 p-4">
          {items.map(item => (
            <label key={item.key} className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch checked={state[item.key]} onCheckedChange={() => toggle(item.key)} />
              {item.label}
            </label>
          ))}
        </div>
      </SettingSection>
  )
}

function ClearDataCard() {
  const { confirm, notify } = useMessageBox()
  const { t } = useI18n()

  async function handleClearDownloadTasks() {
    const ok = await confirm(t('tools.debug.clearTasksConfirm'), t('tools.debug.clearTasksTitle'))
    if (!ok) return
    clearAllTasks()
    notify(t('tools.debug.tasksCleared'), 'success')
  }

  return (
    <SettingSection title={t('tools.debug.dataManagement')} icon={<Trash2 className="h-4 w-4 text-destructive" />}>
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('tools.debug.downloadTaskList')}</p>
            <p className="text-xs text-muted-foreground">{t('tools.debug.clearTasksDescription')}</p>
          </div>
          <Button size="sm" variant="destructive" onClick={handleClearDownloadTasks} className="gap-1.5 shrink-0">
            <Trash2 className="h-4 w-4" />
            {t('tools.debug.clearTasksButton')}
          </Button>
        </div>
      </SettingSection>
  )
}

export default function DebugTab() {
  return (
    <div className="space-y-4">
      <LogCard />
      <DiagnosticsCard />
      <TogglesCard />
      <ClearDataCard />
    </div>
  )
}
