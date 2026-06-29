import { useEffect, useState, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDownload, faCube, faBox, faRotate, faTrashCan, faArrowRight, faPause, faPlay, faStop, faHammer, faCoffee } from '@fortawesome/free-solid-svg-icons'
import { PageHeader } from '../components/PageHeader.tsx'
import { Button } from '../components/ui/button.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { useNavigate } from 'react-router-dom'
import { getTasks, subscribe, removeTask, clearCompleted, updateTask } from '../stores/downloadStore.ts'
import { getInstallProgress, pauseInstall, resumeInstall, cancelInstall } from '../api/instance.ts'
import { getResourceDownloadProgress, cancelResourceDownload } from '../api/resource-download.ts'
import { getJavaDownloadProgress, cancelJavaDownload, pauseJavaDownload, resumeJavaDownload } from '../api/java.ts'
import { ApiError } from '../api/client.ts'
import type { DownloadTask } from '../types/index.ts'

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

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  queued: { label: '排队中', color: 'text-muted-foreground bg-muted border-border' },
  downloading: { label: '下载中', color: 'text-blue-400 bg-blue-500/10 border-blue-500/25' },
  paused: { label: '已暂停', color: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  completed: { label: '已完成', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' },
  failed: { label: '失败', color: 'text-red-400 bg-red-500/10 border-red-500/25' },
  cancelled: { label: '已取消', color: 'text-gray-400 bg-gray-500/10 border-gray-500/25' },
}

const STAGE_LABELS: Record<string, string> = {
  'downloading-json': '下载版本 JSON',
  'downloading-libraries': '下载支持库',
  'downloading-assets': '下载资源文件',
  'downloading-mainjar': '下载主文件',
  'downloading-loader': '下载加载器',
  'downloading-loader-libs': '下载加载器库',
  'installing-loader': '安装加载器',
  'downloading-addons': '下载附加内容',
}

const FILTERS: { key: FilterMode; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'downloading', label: '下载中' },
  { key: 'paused', label: '已暂停' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' },
]

export default function DownloadCenter() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<DownloadTask[]>(() => getTasks())
  const [filter, setFilter] = useState<FilterMode>('all')

  useEffect(() => {
    const unsub = subscribe(() => setTasks([...getTasks()]))
    return unsub
  }, [])

  const pollingRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const javaTasks = tasks.filter((t) => t.type === 'java' && t.taskId && (t.status === 'queued' || t.status === 'downloading' || t.status === 'paused'))
    if (javaTasks.length === 0) return
    Promise.all(javaTasks.map(async (t) => {
      try {
        await getJavaDownloadProgress(t.taskId!)
      } catch (e: unknown) {
        if (e instanceof ApiError && e.status === 404) {
          updateTask(t.id, { status: 'failed', error: '下载任务已失效（后端已重启），请重新创建' })
        }
      }
    }))
  }, [])

  useEffect(() => {
    const activeCount = tasks.filter((t) => (t.status === 'queued' || t.status === 'downloading' || t.status === 'paused') && (t.instanceId || t.taskId)).length

    if (activeCount === 0) {
      if (pollingRef.current !== undefined) {
        clearInterval(pollingRef.current)
        pollingRef.current = undefined
      }
      return
    }

    if (pollingRef.current !== undefined) return

    pollingRef.current = window.setInterval(async () => {
      const ts = getTasks()
      const active = ts.filter((t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'paused')
      for (const task of active) {
        if (task.type === 'java' && task.taskId) {
          try {
            const progress = await getJavaDownloadProgress(task.taskId)
            let newStatus: DownloadTask['status'] = 'downloading'
            if (progress.status === 'completed') newStatus = 'completed'
            else if (progress.status === 'cancelled') newStatus = 'cancelled'
            else if (progress.status === 'failed') newStatus = 'failed'
            else if (progress.status === 'paused') newStatus = 'paused'
            else if (progress.status === 'queued' || progress.status === 'resolving') newStatus = 'queued'

            updateTask(task.id, {
              status: newStatus,
              stage: progress.status,
              progress: Math.round(progress.progress),
              speed: progress.speed,
              currentFile: progress.fileName || undefined,
              error: progress.error || undefined,
             completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
            })
          } catch (e: unknown) {
            if (e instanceof ApiError && (e.status === 404 || e.code === 'JAVA_DOWNLOAD_PACKAGE_NOT_FOUND')) {
              updateTask(task.id, { status: 'failed', error: '下载任务已失效（后端已重启），请重新创建' })
            }
          }
          continue
        }

        if (task.type === 'file' && task.taskId) {
          try {
            const progress = await getResourceDownloadProgress(task.taskId)
            let newStatus: DownloadTask['status'] = 'downloading'
            if (progress.status === 'completed') newStatus = 'completed'
            else if (progress.status === 'cancelled') newStatus = 'cancelled'
            else if (progress.status === 'failed') newStatus = 'failed'

            updateTask(task.id, {
              status: newStatus,
              progress: Math.round(progress.progress),
              speed: progress.speed,
              error: progress.error || undefined,
              currentFile: progress.fileName || undefined,
              completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
            })
          } catch (e: unknown) {
            if (e instanceof ApiError && (e.status === 404 || e.code === 'JAVA_DOWNLOAD_PACKAGE_NOT_FOUND')) {
              updateTask(task.id, { status: 'failed', error: '下载任务已失效（后端已重启），请重新创建' })
            }
          }
          continue
        }
        if (!task.instanceId) continue
        try {
          const progress = await getInstallProgress(task.instanceId)

          if (progress.status === 'not-started') continue

          let newStatus: DownloadTask['status'] = 'downloading'
          if (progress.status === 'completed') newStatus = 'completed'
          else if (progress.status === 'cancelled') newStatus = 'cancelled'
          else if (progress.status === 'failed') newStatus = 'failed'
          else if (progress.isPaused) newStatus = 'paused'

          updateTask(task.id, {
            status: newStatus,
            stage: progress.status,
            progress: Math.round(progress.progress),
            speed: progress.speed,
            currentFile: progress.currentFile || undefined,
            totalFiles: progress.totalFiles || undefined,
            completedFiles: progress.completedFiles || undefined,
            error: progress.error || undefined,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
        } catch {
          // skip
        }
      }
    }, 1000)

    return () => {
      if (pollingRef.current !== undefined) {
        clearInterval(pollingRef.current)
        pollingRef.current = undefined
      }
    }
  }, [tasks.length, tasks.filter((t) => (t.status === 'queued' || t.status === 'downloading' || t.status === 'paused')).length])

  const filtered = tasks.filter((t) => {
    if (filter === 'all') return true
    return t.status === filter
  })

  return (
    <div className="animate-in slide-up space-y-6 p-8">
      <PageHeader title="下载中心" subtitle={`${tasks.length} 个任务`} actions={
        tasks.some((t) => t.status === 'completed') ? (
          <Button variant="outline" size="sm" onClick={clearCompleted} className="gap-1.5">
            <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />清除已完成
          </Button>
        ) : undefined
      } />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'h-9 rounded-md px-3 text-sm font-medium transition-all',
              filter === f.key
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
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
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      task.status === 'completed' ? 'bg-emerald-500/10' : task.status === 'failed' ? 'bg-red-500/10' : 'bg-primary/10'
                    )}>
                      <FontAwesomeIcon
                          icon={task.type === 'java' ? faCoffee : task.type === 'resource' ? faBox : task.type === 'repair' ? faHammer : task.type === 'batch' ? faDownload : faCube}
                        className={cn(
                          'h-5 w-5',
                          task.status === 'completed' ? 'text-emerald-400' : task.status === 'failed' ? 'text-red-400' : 'text-primary'
                        )}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{task.name}</span>
                        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', cfg.color)}>
                          {cfg.label}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
                        {task.gameVersion && <span>Minecraft {task.gameVersion}</span>}
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
                              cancelInstall(task.instanceId).then(() => removeTask(task.id))
                            }
                          }}>
                            <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
                      </>
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
                              cancelInstall(task.instanceId).then(() => removeTask(task.id))
                            }
                          }}>
                            <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
                      </>
                    )}
                    {task.status === 'failed' && (
                      <Tooltip content="重试">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                          <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    )}
                    {(task.status === 'completed' || task.status === 'failed') && (
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
                       <>
                         {task.stage && STAGE_LABELS[task.stage] ? STAGE_LABELS[task.stage] : '下载中'} {task.progress}%
                         {task.currentFile && <span className="ml-1.5 opacity-70">· {task.currentFile}</span>}
                       </>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 ml-2">
                      {task.totalFiles !== undefined && task.totalFiles > 0 && task.stage && (
                        <span>{task.completedFiles ?? 0}/{task.totalFiles} 文件</span>
                      )}
                      {task.speed !== undefined && task.speed > 0 && <span className="tabular-nums">{formatSpeed(task.speed)}</span>}
                      {task.status === 'downloading' && <span className="tabular-nums">{task.progress}%</span>}
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
    </div>
  )
}
