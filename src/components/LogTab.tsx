import { useEffect, useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faFileLines, faDownload, faTrashCan, faRotate,
  faEye, faFolderOpen, faTimes, faInfoCircle,
} from '@fortawesome/free-solid-svg-icons'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card.tsx'
import { Button } from './ui/button.tsx'
import { Badge } from './ui/badge.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import { cn } from '../lib/utils.ts'
import { useMessageBox } from './ui/message-box.tsx'
import {
  listLogs, previewLog, getExportUrl, getExportAllUrl, exportLogTo, exportAllLogsTo, deleteLog, openLog, openLogDir,
} from '../api/logs.ts'
import type { LogEntry, PreviewResult } from '../api/logs.ts'
import { save } from '@tauri-apps/plugin-dialog'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export default function LogTab() {
  const { notify, confirm: msgConfirm } = useMessageBox()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<{ entry: LogEntry; result: PreviewResult } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: LogEntry } | null>(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      setLogs(await listLogs())
    } catch {
      notify('加载日志列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  useEffect(() => {
    const close = () => setContextMenu(null)
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  const handlePreview = async (entry: LogEntry) => {
    if (preview?.entry.path === entry.path) { setPreview(null); return }
    setPreviewLoading(true)
    try {
      setPreview({ entry, result: await previewLog(entry.path) })
    } catch {
      notify('预览失败', 'error')
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleExport = async (entry: LogEntry) => {
    try {
      const dest = await save({ defaultPath: `${entry.name}.gz`, filters: [{ name: 'GZip', extensions: ['gz'] }] })
      if (!dest) return
      await exportLogTo(entry.path, dest)
      notify(`已导出到 ${dest}`, 'success')
    } catch {
      const a = document.createElement('a')
      a.href = getExportUrl(entry.path)
      a.click()
      notify('已开始下载', 'success')
    }
  }

  const handleExportAll = async () => {
    try {
      const dest = await save({ defaultPath: `logs-${Date.now()}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] })
      if (!dest) return
      await exportAllLogsTo(dest)
      notify(`已导出到 ${dest}`, 'success')
    } catch {
      const a = document.createElement('a')
      a.href = getExportAllUrl()
      a.click()
      notify('已开始下载', 'success')
    }
  }

  const handleDelete = async (entry: LogEntry) => {
    const ok = await msgConfirm(`确定要删除 "${entry.name}" 吗？`, '删除日志')
    if (!ok) return
    try {
      await deleteLog(entry.path)
      if (preview?.entry.path === entry.path) setPreview(null)
      notify('已删除', 'success')
      fetchLogs()
    } catch {
      notify('删除失败', 'error')
    }
  }

  const handleOpenDir = (entry: LogEntry) => {
    openLogDir(entry.path).catch(() => notify('无法打开目录', 'error'))
  }

  const handleContextMenu = (e: React.MouseEvent, entry: LogEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const currentSessionCount = logs.filter(e => e.isCurrentSession).length

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <FontAwesomeIcon icon={faFileLines} className="mr-2 h-4 w-4 text-primary" />
            日志管理
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={fetchLogs} disabled={loading}>
                <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', loading && 'animate-spin')} />
                刷新
              </Button>
              <Button size="sm" variant="outline" onClick={handleExportAll} disabled={logs.length === 0}>
                <FontAwesomeIcon icon={faDownload} className="h-4 w-4" />
                导出全部
              </Button>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>日志文件 <span className="font-medium text-foreground">{logs.length}</span></span>
              {currentSessionCount > 0 && (
                <span>当前会话 <span className="font-medium text-primary">{currentSessionCount}</span></span>
              )}
            </div>
          </div>

          {logs.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
                <FontAwesomeIcon icon={faFileLines} className="h-7 w-7 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">暂无日志</p>
                <p className="mt-1 text-xs text-muted-foreground">启动器和后端运行时会产生日志文件</p>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((entry, i) => (
                <div key={`${entry.path}-${i}`}>
                  <div
                    onClick={() => handlePreview(entry)}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors cursor-pointer',
                      'hover:border-muted-foreground/30',
                      preview?.entry.path === entry.path
                        ? 'border-primary/30 bg-accent'
                        : 'border-border bg-background'
                    )}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FontAwesomeIcon icon={faFileLines} className="h-4 w-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{entry.name}</span>
                        {entry.isCurrentSession && (
                          <Badge variant="default" className="shrink-0 h-5 px-1.5 text-[10px]">当前会话</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatSize(entry.size)} · {formatDate(entry.lastModified)}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                      <Tooltip content="打开">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openLog(entry.path).catch(() => notify('无法打开文件', 'error'))}>
                          <FontAwesomeIcon icon={faEye} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="导出 (.gz)">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleExport(entry)}>
                          <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="删除">
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive/70 hover:text-destructive" onClick={() => handleDelete(entry)}>
                          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    </div>
                  </div>

                  {preview?.entry.path === entry.path && (
                    <div className="mx-3 mb-1 rounded-lg border border-border/50 overflow-hidden">
                      <div className="flex items-center justify-between bg-muted/30 px-3 py-1.5">
                        <span className="text-xs text-muted-foreground">
                          <FontAwesomeIcon icon={faEye} className="mr-1.5 h-3 w-3" />
                          预览 ({formatSize(preview.result.totalSize)}
                          {preview.result.totalSize > 100_000 && `, 显示末尾 ${formatSize(preview.result.previewSize)}`})
                        </span>
                        <button
                          onClick={() => setPreview(null)}
                          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                        >
                          <FontAwesomeIcon icon={faTimes} className="h-3 w-3" />
                        </button>
                      </div>
                      <pre className="max-h-60 overflow-y-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                        {previewLoading ? (
                          <span className="text-muted-foreground">加载中...</span>
                        ) : (
                          preview.result.content || <span className="text-muted-foreground">（空）</span>
                        )}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {logs.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
              <FontAwesomeIcon icon={faInfoCircle} className="h-3.5 w-3.5 text-primary" />
              <span>
                自动保留最近 10 条日志，超出自动清理最旧文件
                {currentSessionCount > 0 && ` · ${currentSessionCount} 条当前会话`}
              </span>
              <span className="ml-auto">{logs.length} 个文件</span>
            </div>
          )}
        </CardContent>
      </Card>

      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded-lg border bg-popover p-1 shadow-md text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <button
            onClick={() => { openLog(contextMenu.entry.path).catch(() => {}); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-accent"
          >
            <FontAwesomeIcon icon={faEye} className="h-3.5 w-3.5" />打开
          </button>
          <button
            onClick={() => { handleOpenDir(contextMenu.entry); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-accent"
          >
            <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开所在目录
          </button>
          <button
            onClick={async () => { await handleExport(contextMenu.entry); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-accent"
          >
            <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />导出 (.gz)
          </button>
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => { handleDelete(contextMenu.entry); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50"
          >
            <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />删除
          </button>
        </div>
      )}
    </div>
  )
}
