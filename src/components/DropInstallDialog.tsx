// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, Layers, PackageOpen, Puzzle, RotateCw, Search, WandSparkles } from 'lucide-react'
import { Download as DownloadData, RotateCw as RotateCwData } from 'lucide'
import { MorphActionIcon } from './MorphActionIcon.tsx'
import { cn } from '../lib/utils.ts'
import { cacheInvalidate } from '../lib/simple-cache.ts'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Separator } from './ui'
import { useMessageBox } from './ui'
import { getInstances } from '../api/instance.ts'
import { installModpackDirect } from '../api/instance.ts'
import { loadSettings } from '../api/settings.ts'
import { importLocalFile, modpackRequestTimeout } from '../api/drop-install.ts'
import type { ClassifyFileResult } from '../api/drop-install.ts'
import type { GameInstance } from '../types/index.ts'
import { addTask } from '../stores/downloadStore.ts'
import { orderInstancesByPreferred } from '../lib/drop-routing.ts'
import { useI18n } from '../i18n/index.tsx'

export interface DropFileItem extends ClassifyFileResult {
  path: string
}

export type DropGroupKind = 'modpack' | 'mod' | 'resourcepack' | 'shaderpack'

export interface DropGroup {
  kind: DropGroupKind
  files: DropFileItem[]
}

const KIND_CATEGORY: Record<Exclude<DropGroupKind, 'modpack'>, 'mods' | 'resourcepacks' | 'shaderpacks'> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shaderpack: 'shaderpacks',
}

const KIND_CACHE_KEY: Record<Exclude<DropGroupKind, 'modpack'>, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shaderpack: 'shaders',
}

interface Props {
  group: DropGroup | null
  onClose: () => void
  /** 当前打开的实例 id（`/instances/:id`）：置顶并预选，其他页面为空。 */
  preferredInstanceId?: string | null
}

export default function DropInstallDialog({ group, onClose, preferredInstanceId }: Props) {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [instances, setInstances] = useState<GameInstance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<GameInstance | null>(null)
  const [loadingInstances, setLoadingInstances] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [instanceName, setInstanceName] = useState('')
  const [gameDir, setGameDir] = useState('')
  const [versionIsolation, setVersionIsolation] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  const open = !!group
  const isModpack = group?.kind === 'modpack'
  const modpackFile = group?.files[0]
  // 对话框打开期间路由可能变化（深链/外部唤起）：首选实例必须固定在打开那一刻，
  // 否则 effect 重跑会把用户已经改过的选择/实例名重置掉。
  const preferredIdRef = useRef<string | null>(null)
  const initializedGroupRef = useRef<DropGroup | null>(null)

  useEffect(() => {
    if (!open || !group) {
      initializedGroupRef.current = null
      return
    }
    // 只有「新打开/换了文件」才初始化；route 变化导致的 effect 重跑直接跳过。
    if (initializedGroupRef.current === group) return
    initializedGroupRef.current = group
    preferredIdRef.current = preferredInstanceId ?? null

    setError('')
    setSearchQuery('')
    setInstalling(false)
    if (isModpack) {
      const first = group.files[0]
      const fallbackName = first?.fileName.replace(/\.[^.]+$/, '') || ''
      setInstanceName(first?.packName || fallbackName)
      ;(async () => {
        try {
          const settings = await loadSettings()
          setGameDir(settings.gameDir)
          setVersionIsolation(settings.versionIsolation ?? true)
        } catch { /* keep defaults */ }
      })()
      return
    }
    ;(async () => {
      setLoadingInstances(true)
      try {
        const settings = await loadSettings()
        const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const raw = (await getInstances()).filter(i => norm(i.gameDir) === norm(settings.gameDir))
        const all = [...new Map(raw.map(i => [i.id, i])).values()]
          .filter(i => group.kind !== 'mod' || i.loader)
        // 当前实例置顶并预选（issue #326）：用户在看哪个实例，拖入的资源就默认装到
        // 哪个实例。它被过滤掉（如无 loader 装 mod）或不在当前 gameDir 时退回固定实例。
        const preferredId = preferredIdRef.current
        const ordered = orderInstancesByPreferred(all, preferredId)
        const preferred = preferredId ? ordered.find(i => i.id === preferredId) : undefined
        setInstances(ordered)
        setSelectedInstance(ordered.length > 0 ? (preferred ?? ordered.find(i => i.isDefault) ?? ordered[0]) : null)
      } catch {
        notify(t('dialogs.resourceInstall.instancesLoadFailed'), 'error')
      }
      setLoadingInstances(false)
    })()
  }, [open, group, isModpack, notify, t, preferredInstanceId])

  const filteredInstances = useMemo(() => {
    if (!searchQuery) return instances
    const q = searchQuery.toLowerCase()
    return instances.filter(i => i.name.toLowerCase().includes(q))
  }, [instances, searchQuery])

  const handleInstallFiles = async () => {
    if (!group || !selectedInstance) return
    setInstalling(true)
    setError('')
    let ok = 0
    let failed = 0
    let lastError = ''
    for (const f of group.files) {
      try {
        await importLocalFile(selectedInstance.id, KIND_CATEGORY[group.kind as Exclude<DropGroupKind, 'modpack'>], f.path)
        ok++
      } catch (e) {
        failed++
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    if (group.kind !== 'modpack') {
      cacheInvalidate(`api-instance-${selectedInstance.id}-${KIND_CACHE_KEY[group.kind as Exclude<DropGroupKind, 'modpack'>]}`)
    }
    setInstalling(false)
    if (failed === 0) {
      notify(t('dialogs.dropInstall.installSuccess', { count: ok, instance: selectedInstance.name }), 'success')
      onClose()
    } else if (ok === 0) {
      setError(lastError || t('dialogs.common.unknownError'))
    } else {
      notify(t('dialogs.dropInstall.installPartial', { ok, failed }), 'warning')
      onClose()
    }
  }

  const handleInstallModpack = async () => {
    if (!group || !modpackFile) return
    if (!instanceName.trim()) return
    setInstalling(true)
    setError('')
    try {
      const { instanceId } = await installModpackDirect(
        {
          id: instanceName.trim(),
          path: modpackFile.path,
          gameDir,
          versionIsolation,
        },
        modpackRequestTimeout(modpackFile.fileSize),
      )
      addTask({
        id: instanceId,
        name: instanceName.trim(),
        type: 'modpack',
        gameVersion: modpackFile.gameVersion ?? '',
        status: 'downloading',
        progress: 0,
        createdAt: new Date().toISOString(),
        instanceId,
      })
      setInstalling(false)
      notify(t('dialogs.dropInstall.modpackQueued', { name: instanceName.trim() }), 'success')
      onClose()
    } catch (e) {
      setInstalling(false)
      setError(e instanceof Error ? e.message : t('dialogs.dropInstall.modpackStartFailed'))
    }
  }

  const KindIcon = isModpack ? PackageOpen : group?.kind === 'shaderpack' ? WandSparkles : group?.kind === 'resourcepack' ? Image : Puzzle

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          <KindIcon className="h-4 w-4 text-muted-foreground" />
          {t('dialogs.dropInstall.title')}
        </DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t('dialogs.dropInstall.filesTitle', { count: group?.files.length ?? 0 })}
          </span>
          <div className="grid gap-1 max-h-[100px] overflow-y-auto rounded-lg border border-border/60 p-2">
            {(group?.files ?? []).map(f => (
              <div key={f.path} className="flex items-center gap-2 text-xs">
                <Layers className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.fileName}</span>
              </div>
            ))}
          </div>
        </div>

        {isModpack ? (
          <>
            {(modpackFile?.gameVersion || modpackFile?.loader) && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  {modpackFile?.gameVersion && (
                    <div>
                      <Label>{t('dialogs.import.gameVersion')}</Label>
                      <p className="text-sm">{modpackFile.gameVersion}</p>
                    </div>
                  )}
                  {modpackFile?.loader && (
                    <div>
                      <Label>{t('dialogs.import.loader')}</Label>
                      <p className="text-sm capitalize">{modpackFile.loader}</p>
                    </div>
                  )}
                </div>
                <Separator />
              </>
            )}
            {gameDir && (
              <div>
                <Label>{t('dialogs.dropInstall.targetDir')}</Label>
                <p className="truncate text-xs text-muted-foreground">
                  {gameDir}{versionIsolation ? ` (${t('dialogs.dropInstall.isolated')})` : ''}
                </p>
              </div>
            )}
            <div>
              <Label htmlFor="drop-inst-name">{t('dialogs.import.instanceName')}</Label>
              <Input id="drop-inst-name" value={instanceName} onChange={e => setInstanceName(e.target.value)} />
            </div>
          </>
        ) : (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('dialogs.resourceInstall.selectInstance')}</span>
            {loadingInstances ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <RotateCw className="h-3 w-3 animate-spin" />
                {t('common.loading')}
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
                <div className="grid max-h-[160px] gap-1.5 overflow-y-auto">
                  {filteredInstances.map(inst => (
                    <button
                      key={inst.id}
                      onClick={() => setSelectedInstance(inst)}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                        selectedInstance?.id === inst.id
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border/60 bg-background text-muted-foreground hover:bg-accent/30',
                      )}
                    >
                      <div className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                        selectedInstance?.id === inst.id ? 'border-primary' : 'border-muted-foreground/40',
                      )}>
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
        )}

        {error && <p className="text-destructive truncate text-sm" title={error}>{error}</p>}
      </DialogBody>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={installing}>{t('common.cancel')}</Button>
        {isModpack ? (
          <Button onClick={handleInstallModpack} disabled={!instanceName.trim() || installing}>
            <MorphActionIcon active={installing} busy={RotateCwData} rest={DownloadData} className="mr-1.5 h-3.5 w-3.5" />
            {t('dialogs.resourceInstall.installConfirm')}
          </Button>
        ) : (
          <Button onClick={handleInstallFiles} disabled={!selectedInstance || installing}>
            <MorphActionIcon active={installing} busy={RotateCwData} rest={DownloadData} className="mr-1.5 h-3.5 w-3.5" />
            {t('dialogs.resourceInstall.installConfirm')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
