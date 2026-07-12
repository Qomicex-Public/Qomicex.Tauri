import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate, faDownload, faCheckCircle, faCircle, faLayerGroup, faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { cn } from '../lib/utils.ts'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { Select, SelectOption } from './ui/select.tsx'
import { getInstances } from '../api/instance.ts'
import { getResourceVersions, getResourceDependencies } from '../api/resource.ts'
import { getSettings } from '../api/settings.ts'
import { getInstalledFileNames, getModsMetadata, deleteMod } from '../api/instance-files.ts'
import { startResourceDownload } from '../api/resource-download.ts'
import { addTask, updateTask } from '../stores/downloadStore.ts'
import { useMessageBox } from './ui/message-box.tsx'
import type { GameInstance, ModMetadata, ResourceVersion, ResolvedDependency } from '../types/index.ts'

interface ResourceInstallDialogProps {
  open: boolean
  onClose: () => void
  resourceId: string
  resourceTitle: string
  resourceIcon: string
  source: string
  category: string
  instanceId?: string
}

interface InstallProgress {
  step: number
  total: number
  name: string
}

const versionCache = new Map<string, ResourceVersion[]>()

function versionCacheKey(resourceId: string, gameVersion: string, loader: string): string {
  return `${resourceId}|${gameVersion}|${loader.toLowerCase()}`
}

export default function ResourceInstallDialog({
  open, onClose, resourceId, resourceTitle, resourceIcon, source, category, instanceId,
}: ResourceInstallDialogProps) {
  const { notify } = useMessageBox()
  const [instances, setInstances] = useState<GameInstance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<GameInstance | null>(null)
  const [versions, setVersions] = useState<ResourceVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<ResourceVersion | null>(null)
  const [deps, setDeps] = useState<ResolvedDependency[]>([])
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [installedByProjectId, setInstalledByProjectId] = useState<Map<string, { fileName: string; version: string }>>(new Map())
  const [loadingInstance, setLoadingInstance] = useState(false)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [loadingDeps, setLoadingDeps] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [depVersionOptions, setDepVersionOptions] = useState<Record<string, ResourceVersion[]>>({})
  const [depSelectedVersion, setDepSelectedVersion] = useState<Record<string, { downloadUrl: string; fileName: string }>>({})
  const [depPickerOpen, setDepPickerOpen] = useState<string | null>(null)
  const depPickerRef = useRef<HTMLDivElement>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [loadStage, setLoadStage] = useState('')
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null)

  useEffect(() => {
    if (!open) return
    versionCache.clear()
    setSelectedInstance(null)
    setSelectedVersion(null)
    setDeps([])
    setInstalledNames(new Set())
    setVersions([])
    setInstalling(false)
    setInstallError(null)
    setInstallProgress(null)
    ;(async () => {
      setLoadingInstance(true)
      setLoadStage('加载实例列表中...')
      try {
        const all = (await getInstances()).filter(i => i.gameDir === getSettings().gameDir)
        setInstances(all)
        if (all.length > 0) {
          const target = instanceId ? all.find(i => i.id === instanceId) : undefined
          setSelectedInstance(target ?? all.find(i => i.isDefault) ?? all[0])
        }
      } catch { notify('加载实例列表失败', 'error') }
      setLoadingInstance(false)
      setLoadStage('')
    })()
  }, [open, notify])

  // on instance change, fetch versions filtered by gameVersion + loader
  useEffect(() => {
    if (!selectedInstance) { setVersions([]); return }
    const key = versionCacheKey(resourceId, selectedInstance.gameVersion, selectedInstance.loader || '')
    const cached = versionCache.get(key)
    if (cached) {
      setVersions(cached)
      return
    }
    setLoadingVersions(true)
    setSelectedVersion(null)
    setDeps([])
    setDepSelectedVersion({})
    setDepVersionOptions({})
    let cancelled = false
    ;(async () => {
      try {
        const vlist = await getResourceVersions(
          resourceId, source,
          selectedInstance.gameVersion,
          category === 'mod' ? (selectedInstance.loader || '').toLowerCase() || undefined : undefined
        )
        if (cancelled) return
        versionCache.set(key, vlist)
        setVersions(vlist)
      } catch { notify('加载版本列表失败', 'error') }
      if (!cancelled) setLoadingVersions(false)
    })()
    return () => { cancelled = true }
  }, [selectedInstance, resourceId, source, notify])

  const versionOptions = useMemo(() => {
    return [...versions].sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime())
  }, [versions])

  useEffect(() => {
    if (!selectedInstance || !selectedVersion) { setDeps([]); return }
    setLoadingDeps(true)
    let cancelled = false
    ;(async () => {
      try {
        const resolved = await getResourceDependencies(
          resourceId, source, selectedVersion.id,
          selectedInstance.gameVersion,
          category === 'mod' ? (selectedInstance.loader || '').toLowerCase() : undefined
        )
        if (cancelled) return
        setDeps(resolved)
        const cats = [...new Set(resolved.map(d => d.category))]
        const results = await Promise.allSettled(
          cats.map(cat => getInstalledFileNames(selectedInstance.id, cat))
        )
        if (cancelled) return
        const nameMap: Record<string, string[]> = {}
        cats.forEach((cat, i) => {
          nameMap[cat] = results[i].status === 'fulfilled' ? results[i].value : []
        })
        setInstalledNames(new Set(Object.values(nameMap).flat()))
        // build projectId→(fileName, version) map from mods metadata
        const meta = await getModsMetadata(selectedInstance.id).catch(() => [] as ModMetadata[])
        if (cancelled) return
        const pidMap = new Map<string, { fileName: string; version: string }>()
        for (const m of meta) {
          const pid = m.modrinthId ?? (m.curseForgeId ? String(m.curseForgeId) : null)
          if (pid) pidMap.set(pid, { fileName: m.fileName, version: m.version })
        }
        setInstalledByProjectId(pidMap)
      } catch { notify('加载前置模组失败', 'error') }
      if (!cancelled) setLoadingDeps(false)
    })()
    return () => { cancelled = true }
  }, [selectedInstance, selectedVersion, source, resourceId, notify])

  useEffect(() => {
    const pending = deps.filter(d => !installedNames.has(d.fileName))
    if (pending.length === 0 || !selectedInstance) { setDepVersionOptions({}); return }
    let cancelled = false
    ;(async () => {
      const results = await Promise.allSettled(
        pending.map(dep =>
          getResourceVersions(dep.projectId, dep.source || 'modrinth', selectedInstance.gameVersion, (selectedInstance.loader || '').toLowerCase() || undefined)
            .then(vers => ({ projectId: dep.projectId, vers }))
        )
      )
      if (cancelled) return
      const map: Record<string, ResourceVersion[]> = {}
      for (const r of results) {
        if (r.status === 'fulfilled') map[r.value.projectId] = r.value.vers
      }
      setDepVersionOptions(map)
    })()
    return () => { cancelled = true }
  }, [deps, installedNames, selectedInstance])

  useEffect(() => {
    if (!depPickerOpen) return
    function handleClick(e: MouseEvent) {
      if (depPickerRef.current && !depPickerRef.current.contains(e.target as Node)) setDepPickerOpen(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [depPickerOpen])

  useEffect(() => {
    if (!selectedInstance) return
    setSelectedVersion(null)
    setDeps([])
    setDepSelectedVersion({})
    setDepVersionOptions({})
  }, [selectedInstance])

  const handleInstall = useCallback(async () => {
    if (!selectedInstance || !selectedVersion) return
    setInstalling(true)
    setInstallProgress(null)
    const allItems: { url: string; fileName: string; category: string; name: string; oldFileName?: string }[] = []
    const toDelete: { fileName: string; category: string }[] = []

    for (const dep of deps) {
      const existing = installedByProjectId.get(dep.projectId)
      if (existing) {
        if (existing.fileName !== dep.fileName)
          toDelete.push({ fileName: existing.fileName, category: dep.category })
        continue
      }
      const sel = depSelectedVersion[dep.projectId]
      const url = sel?.downloadUrl ?? dep.downloadUrl
      const fileName = sel?.fileName ?? dep.fileName
      if (url) allItems.push({ url, fileName, category: dep.category, name: dep.name })
    }
    // clean up old files before downloading new ones
    for (const d of toDelete) {
      try { await deleteMod(selectedInstance.id, d.fileName) } catch { /* skip */ }
    }
    const mainFile = selectedVersion.downloads[0]
    if (!mainFile) { setInstallError('该版本没有可下载的文件'); setInstalling(false); return }
    allItems.push({ url: mainFile.url, fileName: mainFile.filename, category, name: resourceTitle })

    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const taskIds: string[] = []
    addTask({
      id: batchId,
      name: resourceTitle,
      type: 'batch',
      gameVersion: selectedInstance.gameVersion,
      status: 'downloading',
      progress: 0,
      totalFiles: allItems.length,
      completedFiles: 0,
      createdAt: new Date().toISOString(),
      instanceId: selectedInstance.id,
      batchTaskIds: taskIds,
    })

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i]
      setInstallProgress({ step: i + 1, total: allItems.length, name: item.name })
      try {
        const result = await startResourceDownload(selectedInstance.id, item.url, item.fileName, item.category)
        taskIds.push(result.taskId)
        updateTask(batchId, {
          currentFile: item.name,
          completedFiles: i + 1,
          progress: ((i + 1) / allItems.length) * 100,
          batchTaskIds: [...taskIds],
          status: i + 1 === allItems.length ? 'completed' : 'downloading',
        })
      } catch (e) {
        const errMsg = `${item.name} 下载失败: ${e instanceof Error ? e.message : '未知错误'}`
        updateTask(batchId, { status: 'failed', progress: (i / allItems.length) * 100, error: errMsg })
        setInstallError(errMsg)
        setInstalling(false)
        setInstallProgress(null)
        return
      }
    }
    setInstallProgress(null)
    notify(`安装完成：${resourceTitle}`, 'success')
    setInstalling(false)
    onClose()
  }, [selectedInstance, selectedVersion, deps, installedNames, installedByProjectId, category, resourceTitle, notify, onClose])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          {resourceIcon ? (
            <img src={resourceIcon} alt="" className="h-5 w-5 rounded object-cover" />
          ) : (
            <FontAwesomeIcon icon={faLayerGroup} className="h-4 w-4 text-muted-foreground" />
          )}
          安装 {resourceTitle}
        </DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">选择实例</span>
          {loadingInstance ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
              {loadStage || '加载中...'}
            </div>
          ) : instances.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              暂无实例，请先创建实例
            </div>
          ) : (
            <div className="grid gap-1.5 max-h-[180px] overflow-y-auto">
              {instances.map(inst => (
                <button
                  key={inst.id}
                  onClick={() => setSelectedInstance(inst)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    selectedInstance?.id === inst.id
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border/60 bg-background text-muted-foreground hover:bg-accent/30'
                  )}
                >
                  <div className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                    selectedInstance?.id === inst.id ? 'border-primary' : 'border-muted-foreground/40')}>
                    {selectedInstance?.id === inst.id && <div className="h-2 w-2 rounded-full bg-primary" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{inst.name}</div>
                    <div className="text-[11px] opacity-60">
                      {inst.gameVersion}{inst.loader ? ` · ${inst.loader}` : ''}{inst.isDefault ? ' · 默认' : ''}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">选择版本</span>
          {!selectedInstance ? (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              请先选择一个实例
            </div>
          ) : loadingVersions ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
              正在加载版本列表...
            </div>
          ) : (
            <Select
              value={selectedVersion?.id ?? ''}
              onChange={(val) => {
                const v = versionOptions.find(x => x.id === val)
                setSelectedVersion(v ?? null)
              }}
            >
              <SelectOption value="">请选择版本</SelectOption>
              {versionOptions.length === 0 ? (
                <SelectOption value="" disabled>无可用版本</SelectOption>
              ) : (
                versionOptions.map(v => (
                  <SelectOption key={v.id} value={v.id}>{v.versionNumber}</SelectOption>
                ))
              )}
            </Select>
          )}
        </div>

        {selectedVersion && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              前置模组 {loadingDeps && <FontAwesomeIcon icon={faRotate} className="ml-1 h-3 w-3 animate-spin" />}
            </span>
            {loadingDeps ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
                正在解析前置模组...
              </div>
            ) : deps.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
                无前置模组
              </div>
            ) : (
              <div className="grid gap-1.5 max-h-[200px] overflow-y-auto">
                {deps.map(d => {
                  const installed = installedNames.has(d.fileName)
                  const depVersions = depVersionOptions[d.projectId]
                  const sel = depSelectedVersion[d.projectId]
                  const currentUrl = sel?.downloadUrl ?? d.downloadUrl
                  return (
                    <div key={d.projectId} className={cn(
                      'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
                      installed ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border/60 bg-background'
                    )}>
                      {d.iconUrl ? (
                        <img src={d.iconUrl} alt="" className="h-5 w-5 rounded object-cover" />
                      ) : (
                        <div className="flex h-5 w-5 items-center justify-center rounded bg-muted text-muted-foreground">
                          <FontAwesomeIcon icon={faLayerGroup} className="h-3 w-3" />
                        </div>
                      )}
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      {!installed && depVersions && depVersions.length > 0 ? (
                        <div className="relative shrink-0">
                          <button
                            type="button"
                            data-dep-picker={d.projectId}
                            onClick={() => setDepPickerOpen(depPickerOpen === d.projectId ? null : d.projectId)}
                            className="flex h-6 items-center gap-1 rounded-md border border-input bg-background px-2 text-[11px] shadow-sm transition-colors hover:bg-accent/30"
                          >
                            <span className="max-w-[80px] truncate">{depSelectedVersion[d.projectId]?.downloadUrl ? depVersions.find(v => v.downloads[0]?.url === depSelectedVersion[d.projectId].downloadUrl)?.versionNumber : d.versionNumber}</span>
                            <FontAwesomeIcon icon={faChevronDown} className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                          </button>
                          {depPickerOpen === d.projectId && createPortal(
                            <div
                              ref={depPickerRef}
                              className="fixed z-[9999] rounded-lg border border-border/50 bg-popover/90 backdrop-blur-lg p-1 shadow-xl animate-in fade-in zoom-in-95"
                              style={{
                                top: (() => { const r = document.querySelector(`[data-dep-picker="${d.projectId}"]`)?.getBoundingClientRect(); return r ? r.bottom + 4 : 0 })(),
                                left: (() => { const r = document.querySelector(`[data-dep-picker="${d.projectId}"]`)?.getBoundingClientRect(); return r ? r.left : 0 })(),
                                width: 180,
                              }}
                            >
                              {depVersions.map(v => {
                                const url = v.downloads[0]?.url
                                if (!url) return null
                                return (
                                  <button
                                    key={v.id}
                                    type="button"
                                    onClick={() => {
                                      setDepSelectedVersion(prev => ({ ...prev, [d.projectId]: { downloadUrl: url, fileName: v.downloads[0]!.filename } }))
                                      setDepPickerOpen(null)
                                    }}
                                    className={cn(
                                      'flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors',
                                      currentUrl === url ? 'bg-primary/10 text-primary font-medium' : 'text-foreground hover:bg-accent'
                                    )}
                                  >
                                    {v.versionNumber}
                                  </button>
                                )
                              })}
                            </div>,
                            document.body
                          )}
                        </div>
                      ) : null}
                      {installed ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400 shrink-0">
                          <FontAwesomeIcon icon={faCheckCircle} className="h-3 w-3" />
                          已安装
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-400 shrink-0">
                          <FontAwesomeIcon icon={faCircle} className="h-3 w-3" />
                          待安装
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {installing && installProgress && (
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
                正在下载
              </span>
              <span className="font-medium text-foreground/80">{installProgress.step} / {installProgress.total}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${(installProgress.step / installProgress.total) * 100}%` }}
              />
            </div>
            <p className="truncate text-xs text-muted-foreground">{installProgress.name}</p>
          </div>
        )}
      </DialogBody>

      {installError && (
        <div className="mx-5 mb-2 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <span className="flex-1">{installError}</span>
          <Button
            variant="ghost" size="sm" className="h-7 text-xs"
            onClick={() => { setInstallError(null); handleInstall() }}
          >
            <FontAwesomeIcon icon={faRotate} className="mr-1 h-3 w-3" /> 重试
          </Button>
        </div>
      )}

      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={installing}>{installError ? '关闭' : '取消'}</Button>
        <Button
          onClick={handleInstall}
          disabled={!selectedVersion || installing || loadingDeps || !!installError}
        >
          <FontAwesomeIcon icon={installing ? faRotate : faDownload} className={cn('mr-1.5 h-3.5 w-3.5', installing && 'animate-spin')} />
          {installing && installProgress ? `正在下载 ${installProgress.name} (${installProgress.step}/${installProgress.total})` : installing ? '安装中...' : '确认安装'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
