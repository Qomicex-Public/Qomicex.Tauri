import { useEffect, useState, useMemo, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDownload, faCube, faBox, faRotate, faTrashCan, faArrowRight, faPause, faPlay, faStop, faHammer, faCoffee } from '@fortawesome/free-solid-svg-icons'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Button } from '../components/ui'
import { Tooltip } from '../components/ui'
import { Tabs } from '../components/ui'
import type { Tab } from '../components/ui'
import { useNavigate } from 'react-router-dom'
import { getTasks, subscribe, removeTask, updateTask } from '../stores/downloadStore.ts'
import { pauseInstall, resumeInstall, cancelInstall, getInstallProgress } from '../api/instance.ts'
import { cancelResourceDownload, getResourceDownloadProgress } from '../api/resource-download.ts'
import { cancelJavaDownload, pauseJavaDownload, resumeJavaDownload, getJavaDownloadProgress } from '../api/java.ts'
import { refreshCustomRuntimes } from '../stores/javaStore.ts'
import { useI18n } from '../i18n/index.tsx'

import type { DownloadTask } from '../types/index.ts'
import { useDownloadSSE } from '../hooks/useDownloadSSE.ts'

type FilterMode = 'all' | 'downloading' | 'paused' | 'completed' | 'failed'

function getSafeIconDataUrl(icon?: string): string | null {
  if (!icon) return null
  const trimmed = icon.trim()
  const safeDataImagePattern = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/i
  return safeDataImagePattern.test(trimmed) ? trimmed : null
}

function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return dateStr }
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return ''
  if (bytesPerSec >= 1_073_741_824) return `${(bytesPerSec / 1_073_741_824).toFixed(1)} GB/s`
  if (bytesPerSec >= 1_048_576) return `${(bytesPerSec / 1_048_576).toFixed(1)} MB/s`
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${bytesPerSec.toFixed(0)} B/s`
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return ''
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes.toFixed(0)} B`
}

/** Re-verify an SSE-absent file task at most this often, at most this many times. */
const STALE_FILE_RECHECK_MS = 2000
const STALE_FILE_MAX_CHECKS = 10

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  queued: { label: 'queued', color: 'text-muted-foreground bg-muted border-border' },
  downloading: { label: 'downloading', color: 'text-blue-400 bg-blue-500/10 border-blue-500/25' },
  paused: { label: 'paused', color: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  completed: { label: 'completed', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' },
  failed: { label: 'failed', color: 'text-red-400 bg-red-500/10 border-red-500/25' },
  cancelled: { label: 'cancelled', color: 'text-gray-400 bg-gray-500/10 border-gray-500/25' },
}

const STAGE_LABELS: Record<string, string> = {
  'queued': 'queued',
  'downloading-json': 'downloading-json',
  'downloading': 'downloading',
  'downloading-libraries': 'downloading-libraries',
  'downloading-assets': 'downloading-assets',
  'downloading-mainjar': 'downloading-mainjar',
  'downloading-loader': 'downloading-loader',
  'downloading-loader-libs': 'downloading-loader-libs',
  'installing-loader': 'installing-loader',
  'downloading-addons': 'downloading-addons',
  'downloading-modpack': 'downloading-modpack',
  'parsing-modpack': 'parsing-modpack',
  'modpack-files': 'modpack-files',
  'modpack-overrides': 'modpack-overrides',
}

const FILTER_TABS: Tab[] = [
  { id: 'all', label: 'all' },
  { id: 'downloading', label: 'downloading' },
  { id: 'paused', label: 'paused' },
  { id: 'completed', label: 'completed' },
  { id: 'failed', label: 'failed' },
]

export default function DownloadCenter() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<DownloadTask[]>(() => getTasks())
  const [filter, setFilter] = useState<FilterMode>('all')

  useEffect(() => {
    const unsub = subscribe(() => setTasks([...getTasks()]))
    return unsub
  }, [])

  const { data: sseData, reconnectKey } = useDownloadSSE()
  const prevInstallIds = useRef<Set<string>>(new Set())
  const prevJavaIds = useRef<Set<string>>(new Set())
  const checkedStaleJavaIds = useRef<Set<string>>(new Set())
  const checkedStaleInstallIds = useRef<Set<string>>(new Set())
  /**
   * File tasks absent from the SSE payload get re-verified against the backend,
   * because "absent" is ambiguous (not started yet / completed & evicted /
   * backend restarted). Attempts are counted and throttled so this can't turn
   * into an unbounded polling loop for a task that stays absent and active.
   */
  const staleFileChecks = useRef<Map<string, { attempts: number; lastAt: number }>>(new Map())

  // Reset stale-check caches on SSE reconnect so zombie tasks get re-verified
  useEffect(() => {
    checkedStaleInstallIds.current = new Set()
    checkedStaleJavaIds.current = new Set()
    staleFileChecks.current = new Map()
  }, [reconnectKey])

  useEffect(() => {
    if (!sseData) return

    const ts = getTasks()
    for (const task of ts) {
      if (task.status !== 'queued' && task.status !== 'downloading' && task.status !== 'paused') continue

      if (task.type === 'java' && task.taskId) {
        const match = sseData.javaDownloads.find((j) => j.taskId === task.taskId)
        if (match) {
          let newStatus: DownloadTask['status'] = 'downloading'
          if (match.status === 'completed') newStatus = 'completed'
          else if (match.status === 'cancelled') newStatus = 'cancelled'
          else if (match.status === 'failed') newStatus = 'failed'
          else if (match.status === 'paused') newStatus = 'paused'
          else if (match.status === 'queued' || match.status === 'resolving') newStatus = 'queued'
          updateTask(task.id, {
            status: newStatus,
            stage: match.status,
            progress: Math.round(match.progress),
            speed: match.speed,
            currentFile: match.fileName || undefined,
            error: match.error || undefined,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
          if (newStatus === 'completed') refreshCustomRuntimes()
        } else if (!checkedStaleJavaIds.current.has(task.taskId)) {
          checkedStaleJavaIds.current.add(task.taskId)
          getJavaDownloadProgress(task.taskId).then(p => {
            if (!p) {
              updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskExpired') })
            } else if (p.status === 'failed') {
              updateTask(task.id, { status: 'failed', error: p.error || t('downloads.errors.downloadFailed') })
            } else if (p.status === 'cancelled') {
              updateTask(task.id, { status: 'cancelled' })
            } else if (p.status === 'completed') {
              updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
              refreshCustomRuntimes()
            }
          }).catch(() => {
            updateTask(task.id, { status: 'failed', error: t('downloads.errors.cannotVerify') })
          })
        }
        continue
      }

      if (task.type === 'file' && task.taskId) {
        const match = sseData.resources.find((r) => r.sessionId === task.taskId)
        if (match) {
          let newStatus: DownloadTask['status'] = 'downloading'
          if (match.status === 'completed') newStatus = 'completed'
          else if (match.status === 'cancelled') newStatus = 'cancelled'
          else if (match.status === 'failed') newStatus = 'failed'
          updateTask(task.id, {
            status: newStatus,
            progress: newStatus === 'completed' ? 100 : Math.round(match.progress),
            speed: newStatus === 'completed' ? 0 : match.speed,
            error: match.error || undefined,
            currentFile: match.currentFile || undefined,
            downloadedBytes: match.downloadedBytes,
            totalBytes: match.totalBytes,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
        } else {
          // Session not in SSE — either not started yet, completed & removed, or backend restarted.
          const prev = staleFileChecks.current.get(task.taskId)
          const attempts = prev?.attempts ?? 0
          const sinceLast = Date.now() - (prev?.lastAt ?? 0)
          if (attempts >= STALE_FILE_MAX_CHECKS) {
            updateTask(task.id, { status: 'failed', error: t('downloads.errors.statusUnknown') })
          } else if (sinceLast >= STALE_FILE_RECHECK_MS) {
            staleFileChecks.current.set(task.taskId, { attempts: attempts + 1, lastAt: Date.now() })
            getResourceDownloadProgress(task.taskId).then(p => {
              if (!p || p.status === 'not_found') {
                updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskExpired') })
              } else if (p.status === 'completed') {
                updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
              } else if (p.status === 'failed' || p.status === 'cancelled') {
                updateTask(task.id, { status: p.status, error: p.error || undefined })
              }
            }).catch(() => {
              updateTask(task.id, { status: 'failed', error: t('downloads.errors.cannotVerify') })
            })
          }
        }
        continue
      }

      if (task.instanceId) {
        const match = sseData.installs.find((i) => i.instanceId === task.instanceId)
        if (match) {
          let newStatus: DownloadTask['status'] = 'downloading'
          if (match.status === 'completed') newStatus = 'completed'
          else if (match.status === 'cancelled') newStatus = 'cancelled'
          else if (match.status === 'failed') newStatus = 'failed'
          else if (match.isPaused) newStatus = 'paused'
          updateTask(task.id, {
            status: newStatus,
            stage: match.stage,
            progress: Math.round(match.progress),
            speed: match.speed,
            currentFile: match.currentFile || undefined,
            totalFiles: match.totalFiles || undefined,
            completedFiles: match.completedFiles || undefined,
            currentFileProgress: match.currentFileProgress,
            error: match.error || undefined,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
        } else if (!checkedStaleInstallIds.current.has(task.instanceId)) {
          checkedStaleInstallIds.current.add(task.instanceId)
          getInstallProgress(task.instanceId).then(p => {
            if (!p || p.status === 'not-started') {
              if (task.status === 'queued') {
                // Not-started may be a race with SSE push — wait 5s then re-check before removal
                const taskId = task.id
                const instId = task.instanceId!
                setTimeout(() => {
                  const t = getTasks().find(t => t.id === taskId)
                  if (!t || t.status !== 'queued') return
                  getInstallProgress(instId).then(p2 => {
                    if (!p2 || p2.status === 'not-started') removeTask(taskId)
                  }).catch(() => {})
                }, 5000)
              } else {
                updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskExpired') })
              }
            } else if (p.status === 'completed') {
              // 任务已完成后才被 SSE 剔除（get_all_active 不含 completed），
              // 此处补正终态，否则任务会永远卡在"连接中/下载中"
              updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
            } else if (p.status === 'failed' || p.status === 'cancelled') {
              updateTask(task.id, { status: p.status, error: p.error || undefined })
            }
          }).catch(() => {
            updateTask(task.id, { status: 'failed', error: t('downloads.errors.cannotVerify') })
          })
        }
      }
    }

    const currentIds = new Set(sseData.installs.map(i => i.instanceId))
    for (const prevId of prevInstallIds.current) {
      if (!currentIds.has(prevId)) {
        const lost = getTasks().find(t => t.instanceId === prevId && (t.status === 'downloading' || t.status === 'paused'))
        if (lost) {
          getInstallProgress(prevId).then(p => {
            if (p.status === 'completed') updateTask(lost.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
            else if (p.status === 'failed' || p.status === 'cancelled' || p.status === 'not-started') updateTask(lost.id, { status: p.status === 'not-started' ? 'cancelled' : p.status })
          }).catch(() => {})
        }
      }
    }
    prevInstallIds.current = currentIds

    const currentJavaIds = new Set(sseData.javaDownloads.map(j => j.taskId))
    for (const prevId of prevJavaIds.current) {
      if (!currentJavaIds.has(prevId)) {
        const lost = getTasks().find(t => t.taskId === prevId && t.type === 'java' && (t.status === 'downloading' || t.status === 'paused'))
        if (lost) {
          getJavaDownloadProgress(prevId).then(p => {
            if (p.status === 'completed') { updateTask(lost.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() }); refreshCustomRuntimes() }
            else if (p.status === 'failed' || p.status === 'cancelled') updateTask(lost.id, { status: p.status })
          }).catch(() => {})
        }
      }
    }
    prevJavaIds.current = currentJavaIds
  }, [sseData])

  const filterTabs = useMemo(() => FILTER_TABS.map((tab) => ({ ...tab, label: t(`downloads.filter.${tab.id}`) })), [t])

  const filtered = useMemo(() => tasks.filter((t) => {
    if (filter === 'all') return true
    return t.status === filter
  }), [tasks, filter])

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title={t('downloads.title')} subtitle={t('downloads.subtitle', { count: tasks.length })} actions={
        <Button variant="outline" size="sm" onClick={() => {
          import('../stores/downloadStore.ts').then(m => {
            m.getTasks().filter(t => t.status !== 'downloading' && t.status !== 'paused' && t.status !== 'queued').forEach(t => m.removeTask(t.id))
          })
        }} className="gap-1.5">
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />{t('downloads.clearFinished')}
        </Button>
      } />

      <div className="flex items-center gap-2">
        <Tabs tabs={filterTabs} activeTab={filter} onChange={(id) => setFilter(id as FilterMode)} className="flex-1 min-w-0" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('downloads.taskCount', { count: filter === 'all' ? tasks.length : filtered.length })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-24 text-center">
          <FontAwesomeIcon icon={faDownload} className="mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">{t('downloads.empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">{t('downloads.emptyHint')}</p>
          <Button variant="outline" size="sm" onClick={() => navigate('/instances')} className="mt-4 gap-1.5">
            <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" />{t('downloads.goToInstances')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((task) => {
            const cfg = STATUS_CONFIG[task.status]
            const isActive = task.status === 'downloading' || task.status === 'paused' || task.status === 'queued'
            const safeIcon = getSafeIconDataUrl(task.icon)
            return (
              <div key={task.id} className="group glass-surface rounded-xl border bg-card p-4 transition-all hover:border-primary/20">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg',
                      task.status === 'completed' ? 'bg-emerald-500/10' : task.status === 'failed' ? 'bg-red-500/10' : 'bg-primary/10'
                    )}>
                      {safeIcon ? (
                        <img src={safeIcon} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <FontAwesomeIcon
                            icon={task.type === 'java' ? faCoffee : task.type === 'resource' ? faBox : task.type === 'repair' ? faHammer : task.type === 'batch' ? faDownload : faCube}
                          className={cn(
                            'h-5 w-5',
                            task.status === 'completed' ? 'text-emerald-400' : task.status === 'failed' ? 'text-red-400' : 'text-primary'
                          )}
                        />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{task.name}</span>
                        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', cfg.color)}>
                          {t(`downloads.status.${task.status}`)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
                        {task.gameVersion && <span>{task.type === 'java' ? 'Java' : 'Minecraft'} {task.gameVersion}</span>}
                        {task.loader && <span>{task.loader}{task.loaderVersion ? ` ${task.loaderVersion}` : ''}</span>}
                        {task.addons && task.addons.length > 0 && <span>{t('downloads.addonsCount', { count: task.addons.length })}</span>}
                        <span>{t('downloads.createdAt', { date: formatDate(task.createdAt) })}</span>
                        {task.completedAt && <span>{t('downloads.completedAt', { date: formatDate(task.completedAt) })}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isActive && task.type === 'java' && task.status !== 'queued' && (
                      <>
                        {task.status === 'paused' ? (
                          <Tooltip content={t('downloads.resume')}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => task.taskId && resumeJavaDownload(task.taskId).catch(() => updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskInvalid') }))}>
                              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip content={t('downloads.pause')}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-amber-400" onClick={() => task.taskId && pauseJavaDownload(task.taskId).catch(() => updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskInvalid') }))}>
                              <FontAwesomeIcon icon={faPause} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        )}
                        <Tooltip content={t('downloads.cancel')}>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                            if (task.type === 'java' && task.taskId) {
                              cancelJavaDownload(task.taskId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                            } else if (task.status === 'queued') {
                              removeTask(task.id)
                            } else if (task.type === 'batch' && task.batchTaskIds && task.batchTaskIds.length > 0) {
                              import('../api/resource-download.ts').then(m => m.cancelBatch(task.batchTaskIds!)).then(() => removeTask(task.id))
                            } else if (task.type === 'file' && task.taskId) {
                              cancelResourceDownload(task.taskId).then(() => removeTask(task.id))
                            } else if (task.instanceId) {
                              cancelInstall(task.instanceId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                            }
                          }}>
                            <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
                      </>
                    )}
                    {isActive && task.type === 'file' && task.status !== 'queued' && (
                      <Tooltip content={t('downloads.cancel')}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                          if (task.taskId) {
                            cancelResourceDownload(task.taskId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                          } else {
                            removeTask(task.id)
                          }
                        }}>
                          <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    )}
                    {isActive && task.type !== 'file' && task.type !== 'java' && task.status !== 'queued' && (
                      <>
                        {task.status === 'paused' ? (
                          <Tooltip content={t('downloads.resume')}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => task.instanceId && resumeInstall(task.instanceId)}>
                              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip content={t('downloads.pause')}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-amber-400" onClick={() => task.instanceId && pauseInstall(task.instanceId)}>
                              <FontAwesomeIcon icon={faPause} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        )}
                        <Tooltip content={t('downloads.cancel')}>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                            if (task.type === 'java' && task.taskId) {
                              cancelJavaDownload(task.taskId).then(() => removeTask(task.id))
                            } else if (task.status === 'queued') {
                              removeTask(task.id)
                            } else if (task.type === 'batch' && task.batchTaskIds && task.batchTaskIds.length > 0) {
                              import('../api/resource-download.ts').then(m => m.cancelBatch(task.batchTaskIds!)).then(() => removeTask(task.id))
                            } else if (task.type === 'file' && task.taskId) {
                              cancelResourceDownload(task.taskId).then(() => removeTask(task.id))
                            } else if (task.instanceId) {
                              cancelInstall(task.instanceId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                            }
                          }}>
                            <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
                      </>
                    )}
                    {task.status === 'failed' && (
                      <Tooltip content={t('downloads.retry')}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => removeTask(task.id)}>
                          <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    )}
                    {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'queued') && (
                      <Tooltip content={t('downloads.remove')}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeTask(task.id)}>
                          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-500',
                        task.status === 'completed' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : task.status === 'paused' ? 'bg-amber-400' : 'bg-primary'
                      )}
                      style={{ width: `${task.progress}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
                    <span className="min-w-0 truncate">
                      {task.status === 'completed' ? t('downloads.statusText.done') :
                       task.status === 'failed' ? (task.error ? t('downloads.statusText.failedWith', { error: task.error }) : t('downloads.statusText.failed')) :
                       task.status === 'paused' ? t('downloads.statusText.pausedProgress', { progress: task.progress }) :
                       task.status === 'queued' ? t('downloads.statusText.waiting') :
                       // "连接中" only while nothing is known yet — a large file can sit at
                       // a rounded 0% with bytes already flowing.
                         (task.progress > 0 || (task.downloadedBytes ?? 0) > 0 || (task.totalBytes ?? 0) > 0) ? (
                          <>
                            {task.stage && STAGE_LABELS[task.stage] ? t(`downloads.stage.${task.stage}`) : t('downloads.statusText.downloading')} ({Math.round((task.currentFileProgress ?? 0) > 0 ? (task.currentFileProgress ?? 0) : task.progress)}%)
                            {task.currentFile && <span className="ml-1.5 opacity-70">· {task.currentFile}</span>}
                          </>
                        ) : (
                         <span>{t('downloads.statusText.connecting')}</span>
                       )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 ml-2">
                      {task.totalFiles !== undefined && task.totalFiles > 0 && task.stage && (
                        <span>{t('downloads.filesCount', { done: task.completedFiles ?? 0, total: task.totalFiles })}</span>
                      )}
                      {task.totalBytes !== undefined && task.totalBytes > 0 && (
                        <span className="tabular-nums">{formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}</span>
                      )}
                      {task.speed !== undefined && task.speed > 0 && <span className="tabular-nums">{formatSpeed(task.speed)}</span>}
                      {task.status === 'downloading' && task.progress > 0 && <span className="tabular-nums">{task.progress}%</span>}
                    </span>
                  </div>
                  {task.status === 'failed' && task.error && (
                    <div className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
                      {task.error}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}
