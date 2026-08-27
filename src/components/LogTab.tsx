import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Download, Eye, FileText, FolderOpen, Info, RotateCw, Search, Trash2, X } from 'lucide-react'
import { ChevronDown as ChevronDownData, ChevronRight as ChevronRightData } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { Card, CardHeader, CardTitle, CardContent } from './ui'
import { Button } from './ui'
import { Badge } from './ui'
import { Tooltip } from './ui'
import { cn } from '../lib/utils.ts'
import { useMessageBox } from './ui'
import {
  listLogs, getExportUrl, getExportAllUrl, exportLogTo, exportAllLogsTo, deleteLog, openLog, openLogDir, getLogContent,
} from '../api/logs.ts'
import type { LogEntry, LogContent } from '../api/logs.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../i18n/index.tsx'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string, lang: string): string {
  const d = new Date(iso)
  return d.toLocaleString(lang, {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/** 从日志行推断级别（tracing 的 " INFO "/" ERROR " 与 [frontend:level]/[downloader:Level]）。 */
function inferLevel(line: string): 'ERROR' | 'WARN' | 'DEBUG' | 'INFO' {
  if (/\bERROR\b/.test(line) || /\[(?:frontend|downloader):error\]/i.test(line) || /\[(?:frontend|downloader):Error\]/.test(line)) return 'ERROR'
  if (/\bWARN\b/.test(line) || /\[(?:frontend|downloader):warn\]/i.test(line) || /\[(?:frontend|downloader):Warn\]/.test(line)) return 'WARN'
  if (/\bDEBUG\b/.test(line) || /\[(?:frontend|downloader):debug\]/i.test(line) || /\[(?:frontend|downloader):Debug\]/.test(line)) return 'DEBUG'
  return 'INFO'
}

export default function LogTab() {
  const { notify, confirm: msgConfirm } = useMessageBox()
  const { t, lang } = useI18n()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: LogEntry } | null>(null)
  const [preview, setPreview] = useState<LogContent | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewSearch, setPreviewSearch] = useState('')
  const [previewLevel, setPreviewLevel] = useState<'all' | 'ERROR' | 'WARN' | 'INFO'>('all')
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)

  const openPreview = useCallback(async (entry: LogEntry) => {
    setPreviewLoading(true)
    setPreviewSearch('')
    setPreviewLevel('all')
    setPreviewExpanded(false)
    try {
      setPreview(await getLogContent(entry.path))
    } catch {
      setPreview(null)
      notify(t('tools.logs.loadFailed'), 'error')
    } finally {
      setPreviewLoading(false)
    }
  }, [notify, t])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      setLogs(await listLogs())
    } catch {
      notify(t('tools.logs.loadFailed'), 'error')
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

  const handleExport = async (entry: LogEntry) => {
    try {
      const dest = await save({ defaultPath: `${entry.name}.gz`, filters: [{ name: 'GZip', extensions: ['gz'] }] })
      if (!dest) return
      await exportLogTo(entry.path, dest)
      notify(t('tools.logs.exportedTo', { dest }), 'success')
    } catch {
      const a = document.createElement('a')
      a.href = getExportUrl(entry.path)
      a.click()
      notify(t('tools.logs.downloadStarted'), 'success')
    }
  }

  const handleExportAll = async () => {
    try {
      const dest = await save({ defaultPath: `logs-${Date.now()}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] })
      if (!dest) return
      await exportAllLogsTo(dest)
      notify(t('tools.logs.exportedTo', { dest }), 'success')
    } catch {
      const a = document.createElement('a')
      a.href = getExportAllUrl()
      a.click()
      notify(t('tools.logs.downloadStarted'), 'success')
    }
  }

  const handleDelete = async (entry: LogEntry) => {
    const ok = await msgConfirm(t('tools.logs.deleteConfirm', { name: entry.name }), t('tools.logs.deleteTitle'))
    if (!ok) return
    try {
      await deleteLog(entry.path)
      notify(t('tools.logs.deleted'), 'success')
      fetchLogs()
    } catch {
      notify(t('tools.logs.deleteFailed'), 'error')
    }
  }

  const handleOpenDir = (entry: LogEntry) => {
    openLogDir(entry.path).catch(() => notify(t('tools.logs.openDirFailed'), 'error'))
  }

  const handleContextMenu = (e: React.MouseEvent, entry: LogEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const currentSessionCount = logs.filter(e => e.isCurrentSession).length

  // 日志查看器：解析行（级别提取）+ 过滤 + 高亮
  const previewLines = useMemo(() => {
    if (!preview) return []
    const lines = preview.content.split('\n')
    const search = previewSearch.trim().toLowerCase()
    return lines
      .map((raw) => ({ raw, lvl: inferLevel(raw) }))
      .filter((l) => {
        if (previewLevel !== 'all' && l.lvl !== previewLevel) return false
        if (search && !l.raw.toLowerCase().includes(search)) return false
        return true
      })
  }, [preview, previewSearch, previewLevel])

  // 高亮搜索词（切分 raw，命中段标色）
  function renderLine(raw: string, key: number) {
    const search = previewSearch.trim()
    if (!search) return raw
    const lower = raw.toLowerCase()
    const q = search.toLowerCase()
    const parts: React.ReactNode[] = []
    let i = 0
    let idx = 0
    while ((idx = lower.indexOf(q, i)) >= 0) {
      if (idx > i) parts.push(raw.slice(i, idx))
      parts.push(<mark key={`${key}-${idx}`} className="rounded bg-yellow-400/30 px-0.5 text-foreground">{raw.slice(idx, idx + q.length)}</mark>)
      i = idx + q.length
    }
    if (i < raw.length) parts.push(raw.slice(i))
    return parts.length ? parts : raw
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <FileText className="mr-2 h-4 w-4 text-muted-foreground" />
            {t('tools.logs.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={fetchLogs} disabled={loading}>
                <RotateCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                {t('common.refresh')}
              </Button>
              <Button size="sm" variant="outline" onClick={handleExportAll} disabled={logs.length === 0}>
                <Download className="h-4 w-4" />
                {t('tools.logs.exportAll')}
              </Button>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{t('tools.logs.filesLabel')} <span className="font-medium text-foreground">{logs.length}</span></span>
              {currentSessionCount > 0 && (
                <span>{t('tools.logs.currentSession')} <span className="font-medium text-primary">{currentSessionCount}</span></span>
              )}
            </div>
          </div>

          {logs.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
                <FileText className="h-7 w-7 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t('tools.logs.none')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('tools.logs.emptyDescription')}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((entry, i) => (
                <div key={`${entry.path}-${i}`}>
                  <div
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                    onClick={() => openPreview(entry)}
                    className="flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors cursor-pointer hover:border-muted-foreground/30 border-border bg-background"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FileText className="h-4 w-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{entry.name}</span>
                        {entry.isCurrentSession && (
                          <Badge variant="default" className="shrink-0 h-5 px-1.5 text-[10px]">{t('tools.logs.currentSession')}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatSize(entry.size)} · {formatDate(entry.lastModified, lang)}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                      <Tooltip content={t('tools.logs.open')}>
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openLog(entry.path).catch(() => notify(t('tools.logs.openFailed'), 'error'))}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                      <Tooltip content={t('tools.logs.exportGz')}>
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleExport(entry)}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                      <Tooltip content={t('common.delete')}>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive/70 hover:text-destructive" onClick={() => handleDelete(entry)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    </div>
                  </div>

                </div>
              ))}
            </div>
          )}

          {logs.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 text-primary" />
              <span>
                {t('tools.logs.retentionHint')}
                {currentSessionCount > 0 && ` · ${t('tools.logs.currentSessionSuffix', { count: currentSessionCount })}`}
              </span>
              <span className="ml-auto">{t('tools.logs.fileCountSuffix', { count: logs.length })}</span>
            </div>
          )}

          {/* 日志内容查看器：点文件行预览 */}
          {preview && (
            <div className="overflow-hidden rounded-lg border">
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
                <button
                  onClick={() => setPreviewExpanded(!previewExpanded)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium text-foreground hover:text-primary"
                >
                  <MorphIcon icon={previewExpanded ? ChevronDownData : ChevronRightData} className="h-3 w-3 shrink-0 text-muted-foreground" spring="snappy" reducedMotion="user" />
                  <span className="truncate">{preview.path.split(/[/\\]/).pop()}</span>
                  {preview.truncated && (
                    <Badge variant="secondary" className="shrink-0 h-4 px-1.5 text-[9px]">{t('tools.logs.truncated')}</Badge>
                  )}
                </button>
                <div className="flex items-center gap-1.5">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={previewSearch}
                      onChange={(e) => setPreviewSearch(e.target.value)}
                      placeholder={t('tools.logs.searchPlaceholder')}
                      className="h-7 w-40 rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <select
                    value={previewLevel}
                    onChange={(e) => setPreviewLevel(e.target.value as typeof previewLevel)}
                    className="h-7 rounded-md border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="all">{t('tools.logs.levelAll')}</option>
                    <option value="ERROR">{t('tools.logs.levelError')}</option>
                    <option value="WARN">{t('tools.logs.levelWarn')}</option>
                    <option value="INFO">{t('tools.logs.levelInfo')}</option>
                  </select>
                  <Tooltip content={t('common.close')}>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setPreview(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                </div>
              </div>
              <div
                ref={previewRef}
                className={cn('log-selectable overflow-y-auto bg-muted/20 p-3 font-mono text-xs leading-relaxed', previewExpanded ? 'h-96' : 'h-64')}
              >
                {previewLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <RotateCw className="h-3.5 w-3.5 animate-spin" />
                    {t('common.loading')}
                  </div>
                ) : previewLines.length === 0 ? (
                  <div className="text-muted-foreground">{t('tools.logs.noMatch')}</div>
                ) : (
                  previewLines.map((l, i) => (
                    <div
                      key={i}
                      className={cn(
                        'whitespace-pre-wrap break-all',
                        l.lvl === 'ERROR' && 'text-red-400',
                        l.lvl === 'WARN' && 'text-yellow-500/90',
                        l.lvl === 'DEBUG' && 'text-muted-foreground/70',
                        l.lvl === 'INFO' && 'text-foreground/80'
                      )}
                    >
                      {renderLine(l.raw, i)}
                    </div>
                  ))
                )}
              </div>
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
            <Eye className="h-3.5 w-3.5" />{t('tools.logs.open')}
          </button>
          <button
            onClick={() => { handleOpenDir(contextMenu.entry); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-accent"
          >
            <FolderOpen className="h-3.5 w-3.5" />{t('tools.logs.openContainingDir')}
          </button>
          <button
            onClick={async () => { await handleExport(contextMenu.entry); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-accent"
          >
            <Download className="h-3.5 w-3.5" />{t('tools.logs.exportGz')}
          </button>
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => { handleDelete(contextMenu.entry); setContextMenu(null) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50"
          >
            <Trash2 className="h-3.5 w-3.5" />{t('common.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
