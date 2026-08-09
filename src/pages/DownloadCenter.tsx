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

import type { DownloadTask } from '../types/index.ts'
import { useDownloadSSE } from '../hooks/useDownloadSSE.ts'

type FilterMode = 'all' | 'downloading' | 'paused' | 'completed' | 'failed'

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
  queued: { label: '排队中', color: 'text-muted-foreground bg-muted border-border' },
  downloading: { label: '下载中', color: 'text-blue-400 bg-blue-500/10 border-blue-500/25' },
  paused: { label: '已暂停', color: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  completed: { label: '已完成', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' },
  failed: { label: '失败', color: 'text-red-400 bg-red-500/10 border-red-500/25' },
  cancelled: { label: '已取消', color: 'text-gray-400 bg-gray-500/10 border-gray-500/25' },
}

const STAGE_LABELS: Record<string, string> = {
  'queued': '排队中',
  'downloading-json': '下载版本 JSON',
  'downloading': '下载游戏文件',
  'downloading-libraries': '下载支持库',
  'downloading-assets': '下载资源文件',
  'downloading-mainjar': '下载主文件',
  'downloading-loader': '下载加载器',
  'downloading-loader-libs': '下载加载器库',
  'installing-loader': '安装加载器',
  'downloading-addons': '下载附加内容',
  'modpack-files': '下载整合包文件',
  'modpack-overrides': '解压覆盖文件',
}

const FILTER_TABS: Tab[] = [
  { id: 'all', label: '全部' },
  { id: 'downloading', label: '下载中' },
  { id: 'paused', label: '已暂停' },
  { id: 'completed', label: '已完成' },
  { id: 'failed', label: '失败' },
]

export default function DownloadCenter() {
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
              updateTask(task.id, { status: 'failed', error: '任务已过期（后端已重启）' })
            } else if (p.status === 'failed') {
              updateTask(task.id, { status: 'failed', error: p.error || '下载失败' })
            } else if (p.status === 'cancelled') {
              updateTask(task.id, { status: 'cancelled' })
            } else if (p.status === 'completed') {
              updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
              refreshCustomRuntimes()
            }
          }).catch(() => {
            updateTask(task.id, { status: 'failed', error: '无法连接后端验证任务状态' })
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
            updateTask(task.id, { status: 'failed', error: '任务状态无法确认（后端未报告该会话）' })
          } else if (sinceLast >= STALE_FILE_RECHECK_MS) {
            staleFileChecks.current.set(task.taskId, { attempts: attempts + 1, lastAt: Date.now() })
            getResourceDownloadProgress(task.taskId).then(p => {
              if (!p || p.status === 'not_found') {
                updateTask(task.id, { status: 'failed', error: '任务已过期（后端已重启）' })
              } else if (p.status === 'completed') {
                updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
              } else if (p.status === 'failed' || p.status === 'cancelled') {
                updateTask(task.id, { status: p.status, error: p.error || undefined })
              }
            }).catch(() => {
              updateTask(task.id, { status: 'failed', error: '无法连接后端验证任务状态' })
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
                updateTask(task.id, { status: 'failed', error: '任务已过期（后端已重启）' })
              }
            }
          }).catch(() => {
            updateTask(task.id, { status: 'failed', error: '无法连接后端验证任务状态' })
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

  const filtered = useMemo(() => tasks.filter((t) => {
    if (filter === 'all') return true
    return t.status === filter
  }), [tasks, filter])

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title="下载中心" subtitle={`${tasks.length} 个任务`} actions={
        <Button variant="outline" size="sm" onClick={() => {
          import('../stores/downloadStore.ts').then(m => {
            m.getTasks().filter(t => t.status !== 'downloading' && t.status !== 'paused' && t.status !== 'queued').forEach(t => m.removeTask(t.id))
          })
        }} className="gap-1.5">
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />清除已完成/失败
        </Button>
      } />

      <div className="flex items-center gap-2">
        <Tabs tabs={FILTER_TABS} activeTab={filter} onChange={(id) => setFilter(id as FilterMode)} className="flex-1 min-w-0" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {filter === 'all' ? tasks.length : filtered.length} 个任务
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-24 text-center">
          <FontAwesomeIcon icon={faDownload} className="mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">暂无下载任务</p>
          <p className="mt-1 text-xs text-muted-foreground/70">在"实例"页面选择版本并开始下载，任务将显示在此处</p>
          <Button variant="outline" size="sm" onClick={() => navigate('/instances')} className="mt-4 gap-1.5">
            <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" />前往实例
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((task) => {
            const cfg = STATUS_CONFIG[task.status]
            const isActive = task.status === 'downloading' || task.status === 'paused' || task.status === 'queued'
            return (
              <div key={task.id} className="group rounded-xl border bg-card p-4 transition-all hover:border-primary/20">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg',
                      task.status === 'completed' ? 'bg-emerald-500/10' : task.status === 'failed' ? 'bg-red-500/10' : 'bg-primary/10'
                    )}>
                      {task.icon?.startsWith('data:image/') ? (
                        <img src={task.icon} alt="" className="h-full w-full object-cover" />
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
                          {cfg.label}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
                        {task.gameVersion && <span>{task.type === 'java' ? 'Java' : 'Minecraft'} {task.gameVersion}</span>}
                        {task.loader && <span>{task.loader}{task.loaderVersion ? ` ${task.loaderVersion}` : ''}</span>}
                        {task.addons && task.addons.length > 0 && <span>+ {task.addons.length} 个附加</span>}
                        <span>创建于 {formatDate(task.createdAt)}</span>
                        {task.completedAt && <span>完成于 {formatDate(task.completedAt)}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isActive && task.type === 'java' && task.status !== 'queued' && (
                      <>
                        {task.status === 'paused' ? (
                          <Tooltip content="继续">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => task.taskId && resumeJavaDownload(task.taskId).catch(() => updateTask(task.id, { status: 'failed', error: '任务已失效' }))}>
                              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip content="暂停">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-amber-400" onClick={() => task.taskId && pauseJavaDownload(task.taskId).catch(() => updateTask(task.id, { status: 'failed', error: '任务已失效' }))}>
                              <FontAwesomeIcon icon={faPause} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        )}
                        <Tooltip content="取消">
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
                      <Tooltip content="取消">
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
                          <Tooltip content="继续">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => task.instanceId && resumeInstall(task.instanceId)}>
                              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip content="暂停">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-amber-400" onClick={() => task.instanceId && pauseInstall(task.instanceId)}>
                              <FontAwesomeIcon icon={faPause} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        )}
                        <Tooltip content="取消">
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
                      <Tooltip content="重试">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => removeTask(task.id)}>
                          <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    )}
                    {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'queued') && (
                      <Tooltip content="移除">
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
                      {task.status === 'completed' ? '下载完成' :
                       task.status === 'failed' ? (task.error ? `失败: ${task.error}` : '下载失败') :
                       task.status === 'paused' ? `已暂停 ${task.progress}%` :
                       task.status === 'queued' ? '等待中' :
                       // "连接中" only while nothing is known yet — a large file can sit at
                       // a rounded 0% with bytes already flowing.
                       (task.progress > 0 || (task.downloadedBytes ?? 0) > 0 || (task.totalBytes ?? 0) > 0) ? (
                         <>
                           {task.stage && STAGE_LABELS[task.stage] ? STAGE_LABELS[task.stage] : '下载中'} {task.progress}%
                           {task.currentFile && <span className="ml-1.5 opacity-70">· {task.currentFile}</span>}
                         </>
                       ) : (
                         <span>连接中…</span>
                       )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 ml-2">
                      {task.totalFiles !== undefined && task.totalFiles > 0 && task.stage && (
                        <span>{task.completedFiles ?? 0}/{task.totalFiles} 文件</span>
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
