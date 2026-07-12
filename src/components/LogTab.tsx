import { useEffect, useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faFileLines, faDownload, faTrashCan, faRotate,
  faEye, faFolderOpen, faTimes,
} from '@fortawesome/free-solid-svg-icons'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card.tsx'
import { Button } from './ui/button.tsx'
import { Badge } from './ui/badge.tsx'
import { cn } from '../lib/utils.ts'
import { useMessageBox } from './ui/message-box.tsx'
import {
  listLogs, previewLog, exportLog, getExportAllUrl, deleteLog, openLog, openLogDir,
} from '../api/logs.ts'
import type { LogEntry, PreviewResult } from '../api/logs.ts'

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
      const blob = await exportLog(entry.path)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${entry.name}.gz`
      a.click()
      URL.revokeObjectURL(url)
    } catch { notify('导出失败', 'error') }
  }

  const handleExportAll = async () => {
    try {
      const res = await fetch(getExportAllUrl())
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `logs-${Date.now()}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch { notify('导出失败', 'error') }
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

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>
            <FontAwesomeIcon icon={faFileLines} className="mr-2 h-4 w-4 text-primary" />
            日志管理
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={fetchLogs} disabled={loading} className="h-7 text-xs gap-1">
              <FontAwesomeIcon icon={faRotate} className={cn('h-3 w-3', loading && 'animate-spin')} />
              刷新
            </Button>
            <Button size="sm" variant="outline" onClick={handleExportAll} disabled={logs.length === 0} className="h-7 text-xs gap-1">
              <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
              导出全部
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {logs.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {loading ? '加载中...' : '暂无日志'}
            </p>
          ) : (
            logs.map((entry, i) => (
              <div key={`${entry.path}-${i}`}>
                <div
                  onClick={() => handlePreview(entry)}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors',
                    'hover:bg-accent/50 border border-transparent',
                    preview?.entry.path === entry.path
                      ? 'border-primary/30 bg-accent'
                      : 'border-border/40'
                  )}
                >
                  <FontAwesomeIcon icon={faFileLines} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm truncate">{entry.name}</span>
                      {entry.isCurrentSession && (
                        <Badge variant="default" className="shrink-0 text-[10px] px-1.5 py-0">当前会话</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(entry.size)} · {formatDate(entry.lastModified)}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => openLog(entry.path).catch(() => notify('无法打开文件', 'error'))}
                      className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title="打开"
                    >
                      <FontAwesomeIcon icon={faEye} className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleExport(entry)}
                      className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title="导出 (.gz)"
                    >
                      <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(entry)}
                      className="rounded-md p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                      title="删除"
                    >
                      <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {preview?.entry.path === entry.path && (
                  <div className="mx-2 mb-1 rounded-lg border border-border/50 overflow-hidden">
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
            ))
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
