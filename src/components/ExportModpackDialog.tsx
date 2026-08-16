import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '../components/ui'
import { Button } from '../components/ui'
import { Label } from '../components/ui'
import { Checkbox } from '../components/ui'
import { Separator } from '../components/ui'
import { exportModpack, listExportFiles } from '../api/instance.ts'
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
  const [format, setFormat] = useState<'cf' | 'mr'>('cf')
  const [tree, setTree] = useState<ModpackExportFileNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const reset = () => {
    setExporting(false)
    setDone(false)
    setError('')
  }

  const loadFiles = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    setLoadError('')
    setError('')
    try {
      const nodes = await listExportFiles(instance.id)
      setTree(nodes)
      setSelected(defaultSelection(nodes))
      setExpanded(new Set())
      setDone(false)
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

  const packName = instance?.modpackName?.trim() || instance?.name || 'modpack'
  const fileName = `${packName}.${format === 'cf' ? 'zip' : 'mrpack'}`

  const handleExport = async () => {
    if (!instance || selected.size === 0) return
    setExporting(true)
    setDone(false)
    setError('')
    try {
      // 全选时走旧语义（includeSaves/includeScreenshots=true 全含），
      // 避免传递巨型白名单；部分选择时传 includeFiles 白名单。
      const body = allSelected
        ? { format, includeSaves: true, includeScreenshots: true }
        : { format, includeFiles: [...selected] }
      const { blob, filename } = await exportModpack(instance.id, body)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDone(true)
    } catch (e: any) {
      setError(e.message || t('dialogs.modpackExport.exportFailed'))
    } finally {
      setExporting(false)
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
          <span className="min-w-0 flex-1 truncate" title={node.path}>
            {displayName}
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
    <Dialog open={open} onClose={() => { reset(); onClose() }} className="max-w-2xl">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.modpackExport.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-4">
          <div>
            <Label>{t('dialogs.modpackExport.format')}</Label>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFormat('cf')}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm transition-colors',
                  format === 'cf' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                )}
              >
                CurseForge (.zip)
              </button>
              <button
                type="button"
                onClick={() => setFormat('mr')}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm transition-colors',
                  format === 'mr' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                )}
              >
                Modrinth (.mrpack)
              </button>
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

          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && <p className="text-sm text-muted-foreground">{t('dialogs.modpackExport.exported')}</p>}
          {exporting && <p className="text-sm text-muted-foreground">{t('dialogs.modpackExport.exporting')}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={exporting} onClick={() => { reset(); onClose() }}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleExport} disabled={exporting || !instance || selected.size === 0}>
              {t('dialogs.modpackExport.startExport')}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}
