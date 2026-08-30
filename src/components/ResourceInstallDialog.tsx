import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, ChevronDown, Circle, Layers, RotateCw, Search } from 'lucide-react'
import { Download as DownloadData, RotateCw as RotateCwData } from 'lucide'
import { MorphActionIcon } from './MorphActionIcon.tsx'
import { cn } from '../lib/utils.ts'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Select, SelectOption } from './ui'
import { getInstances } from '../api/instance.ts'
import { getResourceVersions, getResourceDependencies } from '../api/resource.ts'
import { loadSettings } from '../api/settings.ts'
import { getInstalledFileNames, getModsMetadata } from '../api/instance-files.ts'
import { quickInstallViaDownloadCenter } from '../lib/quickInstall.ts'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
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
  initialVersionId?: string
  /** 中文名（mcmod.cn），用于 [{cn}] 命名模板 */
  resourceCnName?: string | null
}

const versionCache = new Map<string, ResourceVersion[]>()

function versionCacheKey(resourceId: string, gameVersion: string, loader: string): string {
  return `${resourceId}|${gameVersion}|${loader.toLowerCase()}`
}

export default function ResourceInstallDialog({
  open, onClose, resourceId, resourceTitle, resourceIcon, source, category, instanceId, initialVersionId, resourceCnName,
}: ResourceInstallDialogProps) {
  const { t, lang } = useI18n()
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
  const [starting, setStarting] = useState(false)
  const [depVersionOptions, setDepVersionOptions] = useState<Record<string, ResourceVersion[]>>({})
  const [depSelectedVersion, setDepSelectedVersion] = useState<Record<string, { downloadUrl: string; fileName: string }>>({})
  const [depPickerOpen, setDepPickerOpen] = useState<string | null>(null)
  const depPickerRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)
  const [loadStage, setLoadStage] = useState('')

  useEffect(() => {
    if (!open) return
    versionCache.clear()
    setSelectedInstance(null)
    setSelectedVersion(null)
    setDeps([])
    setInstalledNames(new Set())
    setVersions([])
    setStarting(false)
    setInstallError(null)
    setSearchQuery('')
    ;(async () => {
      setLoadingInstance(true)
      setLoadStage(t('dialogs.resourceInstall.loadingInstances'))
      try {
        const settings = await loadSettings()
        const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const raw = (await getInstances()).filter(i => norm(i.gameDir) === norm(settings.gameDir))
        const all = [...new Map(raw.map(i => [i.id, i])).values()]
          .filter(i => category !== 'mod' || i.loader)
        setInstances(all)
        if (all.length > 0) {
          const target = instanceId ? all.find(i => i.id === instanceId) : undefined
          setSelectedInstance(target ?? all.find(i => i.isDefault) ?? all[0])
        }
      } catch { notify(t('dialogs.resourceInstall.instancesLoadFailed'), 'error') }
      setLoadingInstance(false)
      setLoadStage('')
    })()
  }, [open, notify])

  // on instance change, fetch versions filtered by gameVersion + loader
  useEffect(() => {
    if (!selectedInstance) { setVersions([]); return }
    const loaderFilter = category === 'mod'
      ? (selectedInstance.loader || '').toLowerCase() || undefined
      : category === 'datapack' ? 'datapack' : undefined
    const key = versionCacheKey(resourceId, selectedInstance.gameVersion, loaderFilter || '')
    const cached = versionCache.get(key)
    if (cached) {
      setVersions(cached)
      // auto-select initial version from cache
      if (initialVersionId) {
        const match = cached.find(v => v.id === initialVersionId)
        if (match) setSelectedVersion(match)
      }
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
          loaderFilter
        )
        if (cancelled) return
        versionCache.set(key, vlist)
        setVersions(vlist)
        // auto-select initial version
        if (initialVersionId) {
          const match = vlist.find(v => v.id === initialVersionId)
          if (match) setSelectedVersion(match)
        }
      } catch { notify(t('dialogs.resourceInstall.versionsLoadFailed'), 'error') }
      if (!cancelled) setLoadingVersions(false)
    })()
    return () => { cancelled = true }
  }, [selectedInstance, resourceId, source, notify, initialVersionId])

  const versionOptions = useMemo(() => {
    return [...versions].sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime())
  }, [versions])

  useEffect(() => {
    if (!selectedInstance || !selectedVersion) { setDeps([]); setDepVersionOptions({}); return }
    if (category !== 'mod') { setDeps([]); setDepVersionOptions({}); return }
    setLoadingDeps(true)
    setDepVersionOptions({})
    let cancelled = false
    ;(async () => {
      try {
        const resolved = await getResourceDependencies(
          resourceId, source, selectedVersion.id,
          selectedInstance.gameVersion,
          (selectedInstance.loader || '').toLowerCase() || undefined
        )
        if (cancelled) return
        setDeps(resolved)
        const cats = [...new Set(resolved.map(d => d.category))]
        const results = await Promise.allSettled(
          cats.map(cat => getInstalledFileNames(selectedInstance.id, cat))
        )
        if (cancelled) return
        const allInstalledNames = new Set<string>()
        cats.forEach((_, i) => {
          if (results[i].status === 'fulfilled')
            for (const n of results[i].value) allInstalledNames.add(n)
        })
        setInstalledNames(allInstalledNames)
        const meta = await getModsMetadata(selectedInstance.id).catch(() => [] as ModMetadata[])
        if (cancelled) return
        const pidMap = new Map<string, { fileName: string; version: string }>()
        for (const m of meta) {
          const entry = { fileName: m.fileName, version: m.version }
          if (m.modrinthId) pidMap.set(m.modrinthId, entry)
          if (m.curseForgeId) pidMap.set(String(m.curseForgeId), entry)
        }
        setInstalledByProjectId(pidMap)
        const pending = resolved.filter(d => !allInstalledNames.has(d.fileName) && !pidMap.has(d.projectId))
        if (pending.length > 0) {
          const vResults = await Promise.allSettled(
            pending.map(dep =>
              getResourceVersions(dep.projectId, dep.source || 'modrinth', selectedInstance.gameVersion, (selectedInstance.loader || '').toLowerCase() || undefined)
                .then(vers => ({ projectId: dep.projectId, vers }))
            )
          )
          if (cancelled) return
          const vMap: Record<string, ResourceVersion[]> = {}
          for (const r of vResults) {
            if (r.status === 'fulfilled') vMap[r.value.projectId] = r.value.vers
          }
          setDepVersionOptions(vMap)
        }
      } catch { notify(t('dialogs.resourceInstall.depsLoadFailed'), 'error') }
      if (!cancelled) setLoadingDeps(false)
    })()
    return () => { cancelled = true }
  }, [selectedInstance, selectedVersion, source, resourceId, notify])

  useEffect(() => {
    if (!depPickerOpen) return
    function handleClick(e: MouseEvent) {
      if (depPickerRef.current && !depPickerRef.current.contains(e.target as Node)) setDepPickerOpen(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [depPickerOpen])

  const handleInstall = useCallback(async () => {
    if (!selectedInstance || !selectedVersion) return
    setStarting(true)
    setInstallError(null)
    const depsItems: { url: string; fileName: string; category: string; name: string }[] = []
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
      if (url) depsItems.push({ url, fileName, category: dep.category, name: dep.name })
    }
    const mainFile = selectedVersion.downloads[0]
    if (!mainFile) { setInstallError(t('dialogs.resourceInstall.noDownloadableFile')); setStarting(false); return }

    try {
      await quickInstallViaDownloadCenter({
        instanceId: selectedInstance.id,
        gameVersion: selectedInstance.gameVersion,
        resourceTitle,
        deps: depsItems,
        main: { url: mainFile.url, fileName: mainFile.fileName, category, name: resourceTitle, cnName: resourceCnName },
        toDelete,
        taskName: t('downloads.quickInstallName', { name: resourceTitle }),
        icon: resourceIcon || undefined,
        t,
        lang,
      })
      onClose()
      notify(t('dialogs.resourceInstall.addedToDownloadCenter'), 'success')
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : t('dialogs.common.unknownError')
      setInstallError(errMsg)
      setStarting(false)
    }
  }, [selectedInstance, selectedVersion, deps, installedByProjectId, depSelectedVersion, category, resourceTitle, onClose, notify, t])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          {resourceIcon ? (
            <img src={resourceIcon} alt="" className="h-5 w-5 rounded object-cover" />
          ) : (
            <Layers className="h-4 w-4 text-muted-foreground" />
          )}
          {t('dialogs.resourceInstall.title', { name: resourceTitle })}
        </DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('dialogs.resourceInstall.selectInstance')}</span>
          {loadingInstance ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <RotateCw className="h-3 w-3 animate-spin" />
              {loadStage || t('common.loading')}
            </div>
          ) : instances.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              {t('dialogs.resourceInstall.noInstances')}
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('dialogs.resourceInstall.searchPlaceholder')}
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <div className="grid gap-1.5 max-h-[160px] overflow-y-auto">
                {instances.filter(i => !searchQuery || i.name.toLowerCase().includes(searchQuery.toLowerCase())).map(inst => (
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
                      {inst.gameVersion}{inst.loader ? ` · ${inst.loader}` : ''}{inst.isDefault ? ` · ${t('dialogs.resourceInstall.default')}` : ''}
                    </div>
                  </div>
                </button>
              ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('dialogs.resourceInstall.selectVersion')}</span>
          {!selectedInstance ? (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              {t('dialogs.resourceInstall.selectInstanceFirst')}
            </div>
          ) : loadingVersions ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
              <RotateCw className="h-3 w-3 animate-spin" />
              {t('dialogs.resourceInstall.loadingVersions')}
            </div>
          ) : (
            <Select
              value={selectedVersion?.id ?? ''}
              onChange={(val) => {
                const v = versionOptions.find(x => x.id === val)
                setSelectedVersion(v ?? null)
              }}
            >
              <SelectOption value="">{t('dialogs.resourceInstall.selectVersionPlaceholder')}</SelectOption>
              {versionOptions.length === 0 ? (
                <SelectOption value="" disabled>{t('dialogs.resourceInstall.noVersions')}</SelectOption>
              ) : (
                versionOptions.map(v => (
                  <SelectOption key={v.id} value={v.id}>{v.versionNumber}</SelectOption>
                ))
              )}
            </Select>
          )}
        </div>

        {selectedVersion && category === 'mod' && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('dialogs.resourceInstall.depsTitle')} {loadingDeps && <RotateCw className="ml-1 h-3 w-3 animate-spin" />}
            </span>
            {loadingDeps ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                <RotateCw className="h-3 w-3 animate-spin" />
                {t('dialogs.resourceInstall.parsingDeps')}
              </div>
            ) : deps.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
                {t('dialogs.resourceInstall.noDeps')}
              </div>
            ) : (
              <div className="grid gap-1.5 max-h-[200px] overflow-y-auto">
                {deps.map(d => {
                  const installed = installedNames.has(d.fileName) || installedByProjectId.has(d.projectId)
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
                          <Layers className="h-3 w-3" />
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
                            <ChevronDown className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                          </button>
                          {depPickerOpen === d.projectId && createPortal(
                            <div
                              ref={depPickerRef}
                              className="fixed z-[9999] rounded-lg border border-border/50 bg-popover p-1 shadow-xl animate-in fade-in zoom-in-95"
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
                                      setDepSelectedVersion(prev => ({ ...prev, [d.projectId]: { downloadUrl: url, fileName: v.downloads[0]!.fileName } }))
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
                          <CheckCircle2 className="h-3 w-3" />
                          {t('dialogs.resourceInstall.installed')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-400 shrink-0">
                          <Circle className="h-3 w-3" />
                          {t('dialogs.resourceInstall.pending')}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {starting && (
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-xs text-muted-foreground">
            <RotateCw className="h-3 w-3 animate-spin" />
            {t('dialogs.resourceInstall.installing')}
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
            <RotateCw className="mr-1 h-3 w-3" /> {t('common.retry')}
          </Button>
        </div>
      )}

      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={starting}>{installError ? t('common.close') : t('common.cancel')}</Button>
        <Button
          onClick={handleInstall}
          disabled={!selectedVersion || starting || loadingDeps || !!installError}
        >
          <MorphActionIcon active={starting} busy={RotateCwData} rest={DownloadData} className="mr-1.5 h-3.5 w-3.5" />
          {starting ? t('dialogs.resourceInstall.installing') : t('dialogs.resourceInstall.installConfirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
