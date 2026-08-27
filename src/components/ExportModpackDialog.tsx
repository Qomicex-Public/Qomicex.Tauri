import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogBody, DialogHeader, DialogTitle, Tooltip } from '../components/ui'
import { Button } from '../components/ui'
import { Label } from '../components/ui'
import { Checkbox } from '../components/ui'
import { Separator } from '../components/ui'
import { Input } from '../components/ui'
import { useMessageBox } from '../components/ui'
import { startExportTask, getExportTask, cancelExportTask, downloadExportTask, listExportFiles } from '../api/instance.ts'
import type { GameInstance, ModpackExportFileNode } from '../types/index.ts'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../components/ui'

interface Props {
  open: boolean
  onClose: () => void
  instance: GameInstance | null
}

/** 根级目录分类 → i18n key（未命中视为「其他」）。 */
const ROOT_CATEGORY_KEYS: Record<string, string> = {
  mods: 'dialogs.modpackExport.catMods',
  resourcepacks: 'dialogs.modpackExport.catResourcepacks',
  shaderpacks: 'dialogs.modpackExport.catShaderpacks',
  saves: 'dialogs.modpackExport.catSaves',
  screenshots: 'dialogs.modpackExport.catScreenshots',
  config: 'dialogs.modpackExport.catConfig',
}

function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`
  return `${bytes} B`
}

/** 简单进度条（0-100）。 */
function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all duration-200"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

/** 收集节点子树内全部文件相对路径。 */
function collectFilePaths(node: ModpackExportFileNode, out: string[]) {
  if (node.type === 'file') {
    out.push(node.path)
    return
  }
  for (const child of node.children ?? []) {
    collectFilePaths(child, out)
  }
}

/** 收集节点子树内全部文件相对路径与大小。 */
function collectFileSizes(node: ModpackExportFileNode, out: Map<string, number>) {
  if (node.type === 'file') {
    out.set(node.path, node.size)
    return
  }
  for (const child of node.children ?? []) {
    collectFileSizes(child, out)
  }
}

/** 默认选中：除 saves/screenshots 外全部（对齐旧行为）。 */
function defaultSelection(tree: ModpackExportFileNode[]): Set<string> {
  const set = new Set<string>()
  const walk = (nodes: ModpackExportFileNode[]) => {
    for (const node of nodes) {
      if (node.type === 'file') {
        const lower = node.path.toLowerCase()
        if (!lower.startsWith('saves/') && !lower.startsWith('screenshots/')) {
          set.add(node.path)
        }
      } else {
        walk(node.children ?? [])
      }
    }
  }
  walk(tree)
  return set
}

export default function ExportModpackDialog({ open, onClose, instance }: Props) {
  const { t } = useI18n()
  const { confirm: msgConfirm } = useMessageBox()
  const [format, setFormat] = useState<'cf' | 'mr' | 'qml'>('cf')
  const [tree, setTree] = useState<ModpackExportFileNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  // 包信息（默认带出实例元数据，仅本次导出生效）
  const [packName, setPackName] = useState('')
  const [packVersion, setPackVersion] = useState('')
  const [packAuthor, setPackAuthor] = useState('')
  // 导出任务（异步：进度轮询 + 取消）
  const [exportTaskId, setExportTaskId] = useState<string | null>(null)
  const [exportStatus, setExportStatus] = useState<'running' | 'completed' | 'cancelled' | 'failed' | null>(null)
  const [exportStage, setExportStage] = useState('lookup')
  const [exportPercent, setExportPercent] = useState(0)
  const [exportCurrentFile, setExportCurrentFile] = useState('')
  const [exportError, setExportError] = useState('')
  const [exportTargetPath, setExportTargetPath] = useState('')
  const pollTimerRef = useRef<number | null>(null)
  // Tauri 桌面环境（有 IPC）才弹系统保存对话框；纯浏览器 dev 走 download fallback
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  // CF/MR 格式不支持 legacyfabric/babric 加载器（仅 QML 支持原加载器）→ 禁用对应按钮
  const loaderLower = (instance?.loader ?? '').toLowerCase()
  const cfMrDisabled = loaderLower === 'legacyfabric' || loaderLower === 'babric'

  // 实例加载器不支持 CF/MR 时自动切到 Qomicex 格式
  useEffect(() => {
    if (cfMrDisabled && format !== 'qml') {
      setFormat('qml')
    }
  }, [cfMrDisabled, format])

  const reset = () => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    setExportTaskId(null)
    setExportStatus(null)
    setExportStage('lookup')
    setExportPercent(0)
    setExportCurrentFile('')
    setExportError('')
    setExportTargetPath('')
    setExporting(false)
  }

  const loadFiles = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    setLoadError('')
    try {
      const nodes = await listExportFiles(instance.id)
      setTree(nodes)
      setSelected(defaultSelection(nodes))
      setExpanded(new Set())
    } catch (e: any) {
      setLoadError(e.message || t('dialogs.modpackExport.loadFailed'))
      setTree(null)
    } finally {
      setLoading(false)
    }
  }, [instance, t])

  useEffect(() => {
    if (open && instance) {
      void loadFiles()
      setPackName(instance.modpackName?.trim() || instance.name)
      setPackVersion(instance.modpackVersion?.trim() || '1.0.0')
      setPackAuthor(instance.modpackAuthor?.trim() || '')
    }
  }, [open, instance, loadFiles])

  // 全量文件路径与大小表（memo，树不变时不重算）
  const { allFilePaths, fileSizes, totalFileCount } = useMemo(() => {
    const paths: string[] = []
    const sizes = new Map<string, number>()
    for (const node of tree ?? []) {
      collectFilePaths(node, paths)
      collectFileSizes(node, sizes)
    }
    const total = paths.reduce((acc, p) => acc + (sizes.get(p) ?? 0), 0)
    return { allFilePaths: paths, fileSizes: sizes, totalFileCount: total }
  }, [tree])

  const selectedSize = useMemo(
    () => [...selected].reduce((acc, p) => acc + (fileSizes.get(p) ?? 0), 0),
    [selected, fileSizes],
  )

  const allSelected = totalFileCount > 0 && selected.size === totalFileCount

  /** 节点选中态：目录返回 true(全选)/false(未选)/'indeterminate'(部分)。 */
  const nodeState = useCallback(
    (node: ModpackExportFileNode): boolean | 'indeterminate' => {
      if (node.type === 'file') {
        return selected.has(node.path)
      }
      const files: string[] = []
      collectFilePaths(node, files)
      if (files.length === 0) return false
      const count = files.filter((p) => selected.has(p)).length
      if (count === files.length) return true
      if (count === 0) return false
      return 'indeterminate'
    },
    [selected],
  )

  const toggleNode = useCallback(
    (node: ModpackExportFileNode) => {
      setSelected((prev) => {
        const next = new Set(prev)
        const files: string[] = []
        collectFilePaths(node, files)
        if (node.type === 'file') {
          next.has(node.path) ? next.delete(node.path) : next.add(node.path)
        } else if (files.length > 0) {
          const all = files.every((p) => next.has(p))
          for (const p of files) {
            if (all) next.delete(p)
            else next.add(p)
          }
        }
        return next
      })
    },
    [],
  )

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }, [])

  const formatExt = format === 'cf' ? 'zip' : format === 'mr' ? 'mrpack' : 'qmodpack'
  const fileName = `${packName.trim() || 'modpack'}.${formatExt}`

  /** 阶段 → 当前操作文案（对齐后端 stage：lookup/manifest/packing）。 */
  const stageText = (stage: string, file: string) => {
    if (stage === 'lookup') return t('dialogs.modpackExport.stageLookup')
    if (stage === 'manifest') return t('dialogs.modpackExport.stageManifest')
    if (stage === 'packing') {
      return file ? t('dialogs.modpackExport.stagePacking', { file }) : t('dialogs.modpackExport.stageManifest')
    }
    return ''
  }

  /** 轮询导出任务直至终态。 */
  const pollExport = useCallback(async (taskId: string, targetPath: string | undefined) => {
    const tick = async () => {
      try {
        const p = await getExportTask(taskId)
        setExportStage(p.stage)
        setExportPercent(p.percent)
        setExportCurrentFile(p.currentFile ?? '')
        if (p.status === 'running') {
          pollTimerRef.current = window.setTimeout(() => void tick(), 800)
          return
        }
        setExportStatus(p.status)
        setExporting(false)
        if (p.status === 'completed' && !targetPath) {
          // 未传 targetPath（浏览器 dev fallback）：下载 zip 字节
          try {
            const { blob, filename } = await downloadExportTask(taskId)
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = filename
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
          } catch (e: any) {
            setExportError(e.message || t('dialogs.modpackExport.exportFailed'))
          }
        }
        if (p.status === 'failed') {
          setExportError(p.error || t('dialogs.modpackExport.exportFailed'))
        }
      } catch (e: any) {
        setExportStatus('failed')
        setExportError(e.message || t('dialogs.modpackExport.exportFailed'))
        setExporting(false)
      }
    }
    void tick()
  }, [t])

  const handleExport = async () => {
    if (!instance || selected.size === 0) return

    // 1. 桌面环境：先弹系统保存对话框选路径（取消则中止）
    let targetPath: string | undefined
    if (isTauri) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const picked = await save({
          defaultPath: fileName,
          filters: format === 'cf'
            ? [{ name: 'CurseForge Modpack', extensions: ['zip'] }]
            : format === 'mr'
              ? [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }]
              : [{ name: 'Qomicex Modpack', extensions: ['qmodpack'] }],
        })
        if (!picked) return
        targetPath = picked
      } catch {
        // dialog 不可用（浏览器 dev）→ 走无 targetPath fallback
      }
    }

    // 2. 启动异步导出任务
    const meta: { name?: string; version?: string; author?: string } = {}
    if (packName.trim()) meta.name = packName.trim()
    if (packVersion.trim()) meta.version = packVersion.trim()
    if (packAuthor.trim()) meta.author = packAuthor.trim()
    // 全选时走旧语义（includeSaves/includeScreenshots=true 全含），
    // 避免传递巨型白名单；部分选择时传 includeFiles 白名单。
    const body = allSelected
      ? { format, includeSaves: true, includeScreenshots: true, ...meta }
      : { format, includeFiles: [...selected], ...meta }

    setExportTaskId(null)
    setExportStatus('running')
    setExportStage('lookup')
    setExportPercent(0)
    setExportCurrentFile('')
    setExportError('')
    setExportTargetPath(targetPath ?? '')
    setExporting(true)
    try {
      const taskId = await startExportTask(instance.id, { ...body, targetPath })
      setExportTaskId(taskId)
      void pollExport(taskId, targetPath)
    } catch (e: any) {
      setExportStatus('failed')
      setExportError(e.message || t('dialogs.modpackExport.exportFailed'))
      setExporting(false)
    }
  }

  /** 取消导出（先确认，防误触）。 */
  const handleCancelExport = async () => {
    if (!exportTaskId) return
    const ok = await msgConfirm(t('dialogs.modpackExport.cancelConfirm'))
    if (!ok) return
    try {
      await cancelExportTask(exportTaskId)
    } catch {
      // 任务已完成/已结束：cancel 返回 404，忽略（轮询会收到终态）
    }
  }

  const renderNode = (node: ModpackExportFileNode, depth: number) => {
    const isDir = node.type === 'dir'
    const state = nodeState(node)
    const isExpanded = expanded.has(node.path)
    const isRoot = depth === 0
    const catKey = isRoot && isDir ? ROOT_CATEGORY_KEYS[node.name.toLowerCase()] : undefined
    const displayName = catKey ? t(catKey) : node.name

    return (
      <div key={node.path}>
        <div
          className={cn(
            'flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent/50',
            isDir && 'font-medium',
          )}
          style={{ paddingLeft: depth * 16 }}
        >
          {isDir ? (
            <button
              type="button"
              onClick={() => toggleExpand(node.path)}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label={isExpanded ? t('dialogs.modpackExport.collapse') : t('dialogs.modpackExport.expand')}
            >
              <svg className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 4l4 4-4 4" /></svg>
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <Checkbox
            checked={state}
            disabled={isDir && (node.children?.length ?? 0) === 0}
            onCheckedChange={() => toggleNode(node)}
          />
          <span className="min-w-0 flex-1 truncate">
            <Tooltip content={node.path}>
              <span className="block truncate">{displayName}</span>
            </Tooltip>
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {isDir
              ? `${t('dialogs.modpackExport.fileCount', { count: node.fileCount })} · ${formatSize(node.size)}`
              : formatSize(node.size)}
          </span>
        </div>
        {isDir && isExpanded && (node.children ?? []).map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose() }}
      className="max-w-2xl"
      closeOnBackdrop={exportStatus !== 'running'}
      closeOnEsc={exportStatus !== 'running'}
    >
      <DialogHeader onClose={exportStatus === 'running' ? undefined : () => { reset(); onClose() }}>
        <DialogTitle>
          {exportStatus === 'running' ? t('dialogs.modpackExport.exportingTitle') : t('dialogs.modpackExport.title')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        {exportStatus !== null ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <Label>{t('dialogs.modpackExport.exportingTitle')}</Label>
              {exportStatus === 'running' && (
                <span className="text-xs tabular-nums text-muted-foreground">{Math.round(exportPercent)}%</span>
              )}
            </div>
            <ProgressBar percent={exportPercent} />
            {exportStatus === 'running' && (
              <p className="text-sm text-muted-foreground">{stageText(exportStage, exportCurrentFile)}</p>
            )}
            {exportStatus === 'completed' && (
              <p className="text-sm text-emerald-500 break-all">
                {exportTargetPath
                  ? t('dialogs.modpackExport.exportSavedTo', { path: exportTargetPath })
                  : t('dialogs.modpackExport.exportSaved')}
              </p>
            )}
            {exportStatus === 'cancelled' && (
              <p className="text-sm text-muted-foreground">{t('dialogs.modpackExport.exportCancelled')}</p>
            )}
            {exportStatus === 'failed' && (
              <p className="text-sm text-destructive break-all">{exportError || t('dialogs.modpackExport.exportFailed')}</p>
            )}
            {exportStatus === 'running' && (
              <div className="flex justify-end pt-1">
                <Button variant="outline" onClick={() => void handleCancelExport()}>
                  {t('dialogs.modpackExport.cancelExport')}
                </Button>
              </div>
            )}
          </div>
        ) : (
        <div className="space-y-4">
          <div>
            <Label>{t('dialogs.modpackExport.format')}</Label>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={cfMrDisabled}
                onClick={() => setFormat('cf')}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm transition-colors',
                  cfMrDisabled && 'cursor-not-allowed opacity-40',
                  format === 'cf' && !cfMrDisabled ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                )}
              >
                CurseForge (.zip)
              </button>
              <button
                type="button"
                disabled={cfMrDisabled}
                onClick={() => setFormat('mr')}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm transition-colors',
                  cfMrDisabled && 'cursor-not-allowed opacity-40',
                  format === 'mr' && !cfMrDisabled ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                )}
              >
                Modrinth (.mrpack)
              </button>
              <button
                type="button"
                onClick={() => setFormat('qml')}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm transition-colors',
                  format === 'qml' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                )}
              >
                Qomicex (.qmodpack)
              </button>
            </div>
            {cfMrDisabled && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {loaderLower} 加载器仅支持 Qomicex (.qmodpack) 格式导出
              </p>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>{t('dialogs.modpackExport.packInfo')}</Label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('dialogs.modpackExport.packName')}</Label>
                <Input value={packName} onChange={(e) => setPackName(e.target.value)} placeholder={instance?.name || 'modpack'} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('dialogs.modpackExport.packVersion')}</Label>
                <Input value={packVersion} onChange={(e) => setPackVersion(e.target.value)} placeholder="1.0.0" />
              </div>
              {format !== 'mr' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{t('dialogs.modpackExport.packAuthor')}</Label>
                  <Input value={packAuthor} onChange={(e) => setPackAuthor(e.target.value)} />
                </div>
              )}
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('dialogs.modpackExport.include')}</Label>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <button type="button" className="text-primary hover:underline" onClick={() => setSelected(new Set(allFilePaths))}>
                  {t('dialogs.modpackExport.selectAll')}
                </button>
                <span className="text-border">|</span>
                <button type="button" className="text-primary hover:underline" onClick={() => setSelected(new Set())}>
                  {t('dialogs.modpackExport.deselectAll')}
                </button>
                <span className="tabular-nums">
                  {t('dialogs.modpackExport.selectedSummary', { count: selected.size, size: formatSize(selectedSize) })}
                </span>
              </div>
            </div>

            {loading && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('dialogs.modpackExport.loading')}
              </p>
            )}

            {!loading && loadError && (
              <div className="flex flex-col items-center gap-2 py-6">
                <p className="text-sm text-destructive">{loadError}</p>
                <Button variant="outline" size="sm" onClick={() => void loadFiles()}>
                  {t('dialogs.modpackExport.retry')}
                </Button>
              </div>
            )}

            {!loading && !loadError && tree && tree.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('dialogs.modpackExport.empty')}
              </p>
            )}

            {!loading && !loadError && tree && tree.length > 0 && (
              <div className="max-h-[55vh] overflow-y-auto rounded-md border border-border p-1.5">
                {tree.map((node) => renderNode(node, 0))}
              </div>
            )}
          </div>

          <div>
            <Label>{t('dialogs.modpackExport.fileName')}</Label>
            <p className="mt-0.5 text-sm font-medium break-all">{fileName}</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={exporting} onClick={() => { reset(); onClose() }}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleExport} disabled={exporting || !instance || selected.size === 0}>
              {t('dialogs.modpackExport.startExport')}
            </Button>
          </div>
        </div>
        )}
      </DialogBody>
    </Dialog>
  )
}
