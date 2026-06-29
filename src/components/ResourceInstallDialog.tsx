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
import { getInstalledFileNames } from '../api/instance-files.ts'
import { startResourceDownload } from '../api/resource-download.ts'
import { addTask, updateTask } from '../stores/downloadStore.ts'
import { useMessageBox } from './ui/message-box.tsx'
import type { GameInstance, ResourceVersion, ResolvedDependency } from '../types/index.ts'

interface ResourceInstallDialogProps {
  open: boolean
  onClose: () => void
  resourceId: string
  resourceTitle: string
  resourceIcon: string
  source: string
  category: string
}

export default function ResourceInstallDialog({
  open, onClose, resourceId, resourceTitle, resourceIcon, source, category,
}: ResourceInstallDialogProps) {
  const { notify } = useMessageBox()
  const [instances, setInstances] = useState<GameInstance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<GameInstance | null>(null)
  const [versions, setVersions] = useState<ResourceVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<ResourceVersion | null>(null)
  const [deps, setDeps] = useState<ResolvedDependency[]>([])
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [loadingInstance, setLoadingInstance] = useState(false)
  const [loadingDeps, setLoadingDeps] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [depVersionOptions, setDepVersionOptions] = useState<Record<string, ResourceVersion[]>>({})
  const [depSelectedVersion, setDepSelectedVersion] = useState<Record<string, { downloadUrl: string; fileName: string }>>({})
  const [depPickerOpen, setDepPickerOpen] = useState<string | null>(null)
  const depPickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setSelectedInstance(null)
    setSelectedVersion(null)
    setDeps([])
    setInstalledNames(new Set())
    setVersions([])
    setInstalling(false)
    ;(async () => {
      setLoadingInstance(true)
      try {
        const all = await getInstances()
        setInstances(all)

        const vlist = await getResourceVersions(resourceId, source)
        setVersions(vlist)

        if (all.length > 0 && vlist.length > 0) {
          const compat = findCompatibleInstances(all, vlist)
          if (compat.length > 0) {
            setSelectedInstance(compat.find(i => i.isDefault) ?? compat[0])
          }
        }
      } catch { notify('加载实例列表失败', 'error') }
      setLoadingInstance(false)
    })()
  }, [open, resourceId, source, notify])

  const compatibleInstances = useMemo(() => {
    if (versions.length === 0) return instances
    return findCompatibleInstances(instances, versions)
  }, [instances, versions])

  const versionOptions = useMemo(() => {
    if (!selectedInstance) return versions
    const instLoader = (selectedInstance.loader || '').toLowerCase()
    return versions.filter(v =>
      v.gameVersions.includes(selectedInstance.gameVersion) &&
      (v.loaders.length === 0 || v.loaders.some(l => l.toLowerCase() === instLoader))
    ).sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime())
  }, [versions, selectedInstance])

  useEffect(() => {
    if (!selectedInstance || !selectedVersion) { setDeps([]); return }
    setLoadingDeps(true)
    ;(async () => {
      try {
        const resolved = await getResourceDependencies(
          resourceId, source, selectedVersion.id,
          selectedInstance.gameVersion, (selectedInstance.loader || '').toLowerCase()
        )
        setDeps(resolved)
        const cats = new Set(resolved.map(d => d.category))
        const nameMap: Record<string, string[]> = {}
        for (const cat of cats) {
          try { nameMap[cat] = await getInstalledFileNames(selectedInstance.id, cat) }
          catch { nameMap[cat] = [] }
        }
        setInstalledNames(new Set(Object.values(nameMap).flat()))
      } catch { notify('加载前置模组失败', 'error') }
      setLoadingDeps(false)
    })()
  }, [selectedInstance, selectedVersion, source, resourceId, notify])

  useEffect(() => {
    const pending = deps.filter(d => !installedNames.has(d.fileName))
    if (pending.length === 0 || !selectedInstance) { setDepVersionOptions({}); return }
    let cancelled = false
    ;(async () => {
      const map: Record<string, ResourceVersion[]> = {}
      for (const dep of pending) {
        try {
          const vers = await getResourceVersions(dep.projectId, 'modrinth', selectedInstance.gameVersion, (selectedInstance.loader || '').toLowerCase() || undefined)
          if (!cancelled) map[dep.projectId] = vers
        } catch { /* skip failed dep version fetch */ }
      }
      if (!cancelled) setDepVersionOptions(map)
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
    const allItems: { url: string; fileName: string; category: string; name: string }[] = []

    for (const dep of deps) {
      const sel = depSelectedVersion[dep.projectId]
      const url = sel?.downloadUrl ?? dep.downloadUrl
      const fileName = sel?.fileName ?? dep.fileName
      if (url && !installedNames.has(fileName)) {
        allItems.push({ url, fileName, category: dep.category, name: dep.name })
      }
    }
    const mainFile = selectedVersion.downloads[0]
    if (!mainFile) { notify('该版本没有可下载的文件', 'error'); setInstalling(false); return }
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
      } catch {
        updateTask(batchId, { status: 'failed', progress: (i / allItems.length) * 100, error: `${item.name} 下载失败` })
        notify(`${item.name} 下载失败`, 'error')
        setInstalling(false)
        return
      }
    }
    notify(`安装完成：${resourceTitle}`, 'success')
    setInstalling(false)
    onClose()
  }, [selectedInstance, selectedVersion, deps, installedNames, category, resourceTitle, notify, onClose])

  const noCompatible = !loadingInstance && instances.length > 0 && compatibleInstances.length === 0

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
              加载中...
            </div>
          ) : noCompatible ? (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              没有兼容的实例（版本/加载器不匹配）
            </div>
          ) : compatibleInstances.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              暂无实例，请先创建实例
            </div>
          ) : (
            <div className="grid gap-1.5 max-h-[180px] overflow-y-auto">
              {compatibleInstances.map(inst => (
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
          {selectedInstance ? (
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
          ) : (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              请先选择一个实例
            </div>
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
      </DialogBody>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={installing}>取消</Button>
        <Button
          onClick={handleInstall}
          disabled={!selectedVersion || installing || loadingDeps}
        >
          <FontAwesomeIcon icon={installing ? faRotate : faDownload} className={cn('mr-1.5 h-3.5 w-3.5', installing && 'animate-spin')} />
          {installing ? '安装中...' : '确认安装'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function findCompatibleInstances(insts: GameInstance[], vers: ResourceVersion[]): GameInstance[] {
  return insts.filter(inst => {
    const instLoader = (inst.loader || '').toLowerCase()
    if (!instLoader) return false
    return vers.some(v =>
      v.gameVersions.includes(inst.gameVersion) &&
      (v.loaders.length === 0 || v.loaders.some(l => l.toLowerCase() === instLoader))
    )
  })
}
