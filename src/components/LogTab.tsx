import { useEffect, useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faFileLines, faDownload, faTrashCan, faRotate, faEye,
  faFolderOpen, faTimes,
} from '@fortawesome/free-solid-svg-icons'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card.tsx'
import { Button } from './ui/button.tsx'
import { Badge } from './ui/badge.tsx'
import { cn } from '../lib/utils.ts'
import { useMessageBox } from './ui/message-box.tsx'
import {
  listLogs, previewLog, getExportUrl, getExportAllUrl, deleteLog,
} from '../api/logs.ts'
import type { LogEntry, PreviewResult } from '../api/logs.ts'
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener'

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
      const entries = await listLogs()
      setLogs(entries)
    } catch {
      notify('加载日志列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    const handler = () => setContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [])

  const handlePreview = async (entry: LogEntry) => {
    setPreviewLoading(true)
    try {
      const result = await previewLog(entry.path)
      setPreview({ entry, result })
    } catch {
      notify('预览失败', 'error')
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleExport = (entry: LogEntry) => {
    const url = getExportUrl(entry.path)
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    a.click()
  }

  const handleExportAll = () => {
    const url = getExportAllUrl()
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    a.click()
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

  const handleOpen = (entry: LogEntry) => {
    openPath(entry.path).catch(() => {})
  }

  const handleOpenDir = (entry: LogEntry) => {
    revealItemInDir(entry.path).catch(() => {
      const dir = entry.path.replace(/[/\\][^/\\]+$/, '')
      openPath(dir).catch(() => {})
    })
  }

  const handleContextMenu = (e: React.MouseEvent, entry: LogEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }

  return (
    <div className="space-y-4">
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
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">文件名</th>
                  <th className="px-4 py-2 text-right font-medium w-24">大小</th>
                  <th className="px-4 py-2 text-right font-medium w-40">修改时间</th>
                  <th className="px-4 py-2 text-center font-medium w-24">状态</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-12 text-center text-muted-foreground text-xs">暂无日志</td></tr>
                ) : (
                  logs.map((entry, i) => (
                    <tr
                      key={`${entry.path}-${i}`}
                      onClick={() => handlePreview(entry)}
                      onContextMenu={(e) => handleContextMenu(e, entry)}
                      className={cn(
                        'border-b border-border/50 cursor-pointer transition-colors hover:bg-accent/50',
                        preview?.entry.path === entry.path && 'bg-accent'
                      )}
                    >
                      <td className="px-4 py-2.5 truncate max-w-md">{entry.name}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{formatSize(entry.size)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{formatDate(entry.lastModified)}</td>
                      <td className="px-4 py-2.5 text-center">
                        {entry.isCurrentSession && (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0">当前会话</Badge>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              <FontAwesomeIcon icon={faEye} className="mr-2 h-3 w-3" />
              预览: {preview.entry.name}
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                ({formatSize(preview.result.totalSize)}
                {preview.result.totalSize > 100_000 && `, 显示末尾 ${formatSize(preview.result.previewSize)}`})
              </span>
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)} className="h-7 w-7">
              <FontAwesomeIcon icon={faTimes} className="h-3 w-3" />
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <pre className="max-h-96 overflow-y-auto bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {previewLoading ? (
                <span className="text-muted-foreground">加载中...</span>
              ) : (
                preview.result.content || <span className="text-muted-foreground">（空）</span>
              )}
            </pre>
          </CardContent>
        </Card>
      )}

      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded-lg border bg-popover p-1 shadow-md text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <button
            onClick={() => { handleExport(contextMenu.entry); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-accent"
          >
            <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />导出 (.gz)
          </button>
          <button
            onClick={() => { handleOpen(contextMenu.entry); setContextMenu(null) }}
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
