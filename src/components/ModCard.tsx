import { useCallback, useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCube, faRotate } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui'
import { Tooltip } from './ui'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { cn } from '../lib/utils.ts'
import { MinecraftText } from './MinecraftText.tsx'
import { enableMod, disableMod, deleteMod } from '../api/instance-files.ts'
import { updateModsViaDownloadCenter } from '../lib/updateMods.ts'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { ModMetadata, ModUpdateEntry } from '../types/index.ts'

interface ModCardProps {
  mod: ModMetadata
  instanceId: string
  gameVersion?: string
  loader?: string
  onRefresh: () => void
  onToggle: (fileName: string) => void
  onChangeVersion: (mod: ModMetadata) => void
  selected?: boolean
  onSelect?: (fileName: string, shiftKey: boolean, ctrlKey: boolean) => void
  update?: ModUpdateEntry
  /** 单个模组更新完成后回调（用于移除更新标记） */
  onUpdated?: (fileName: string) => void
}

export default function ModCard({
  mod, instanceId, gameVersion, loader, onRefresh, onToggle, onChangeVersion,
  selected, onSelect, update, onUpdated,
}: ModCardProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const hasUpdate = !!update
  const [toggling, setToggling] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [imgError, setImgError] = useState(false)
  const iconRef = useRef<HTMLDivElement>(null)
  const [iconVisible, setIconVisible] = useState(false)

  const handleToggle = useCallback(async () => {
    const wasActive = mod.active
    setToggling(true)
    try {
      if (wasActive) {
        await disableMod(instanceId, mod.fileName)
      } else {
        const disabledName = mod.fileName.endsWith('.disabled') ? mod.fileName : mod.fileName + '.disabled'
        await enableMod(instanceId, disabledName)
      }
      onToggle(mod.fileName)
    } catch (e) { console.error('Toggle mod failed:', e) }
    setToggling(false)
  }, [instanceId, mod, onToggle])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    setConfirmDelete(false)
    try {
      await deleteMod(instanceId, mod.fileName)
      onRefresh()
    } catch (e) { console.error('Delete mod failed:', e) }
    setDeleting(false)
  }, [instanceId, mod, onRefresh])

  useEffect(() => {
    if (!iconRef.current) return
    const el = iconRef.current
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setIconVisible(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const contextItems: ContextMenuItem[] = []
  if (mod.mcmodId) {
    contextItems.push({
      label: t('dialogs.mod.mcwiki'),
      onClick: () => openUrl(`https://www.mcmod.cn/class/${mod.mcmodId}`),
    })
  }
  if (mod.curseForgeId || mod.modrinthId) {
    const params = new URLSearchParams()
    params.set('source', mod.source || 'modrinth')
    params.set('category', 'mod')
    if (gameVersion) params.set('gameVersion', gameVersion)
    if (loader) params.set('loader', loader.toLowerCase())
    if (instanceId) params.set('instanceId', instanceId)
    params.set('from', 'instance')
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId ?? ''
    const iconUrl = mod.iconUrl || (mod.iconBase64 ? `data:image/png;base64,${mod.iconBase64}` : '')
    contextItems.push({
      label: t('dialogs.common.viewDetail'),
      onClick: () => navigate(`/resource-center/${encodeURIComponent(id)}?${params.toString()}&expandBody=1`, { state: { iconUrl } }),
    })
  }
  contextItems.push(
    { label: t('dialogs.mod.changeVersion'), onClick: () => onChangeVersion(mod) },
    {
      label: t('dialogs.mod.update'),
      disabled: !update,
      onClick: async () => {
        if (!update) return
        try {
          const result = await updateModsViaDownloadCenter(instanceId, [update], () => notify(t('dialogs.mod.addedToDownloadList'), 'success'), t)
          onUpdated?.(update.fileName)
          onRefresh()
          if (result.failed === 0) notify(t('dialogs.mod.updatedWithName', { name: mod.name }), 'success')
          else notify(t('dialogs.mod.updateFailedWithName', { name: mod.name }), 'error')
        } catch { notify(t('dialogs.mod.updateFailed'), 'error') }
      },
    },
    { label: t('common.delete'), onClick: () => setConfirmDelete(true), danger: true },
  )

  return (
    <>
      <ContextMenu items={contextItems}>
        <Card
          className={cn(
            'group cursor-pointer select-none border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm',
            !mod.active && 'opacity-50',
            selected && 'border-primary/40 bg-primary/[0.03]'
          )}
          onClick={(e) => onSelect?.(mod.fileName, e.shiftKey, e.ctrlKey || e.metaKey)}
        >
          <CardContent className="flex items-center gap-4 p-4 relative">
            <div className={cn('absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200', selected ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0')} />
            <div ref={iconRef} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
              {iconVisible ? (
                mod.iconBase64 ? (
                  <img src={`data:image/png;base64,${mod.iconBase64}`} alt={mod.name} className="h-full w-full object-cover" loading="lazy" />
                ) : mod.iconUrl && !imgError ? (
                  <img src={mod.iconUrl} alt={mod.name} className="h-full w-full object-cover" loading="lazy" onError={() => setImgError(true)} />
                ) : (
                  <FontAwesomeIcon icon={faCube} className="h-5 w-5 opacity-50" />
                )
              ) : (
                <FontAwesomeIcon icon={faCube} className="h-5 w-5 opacity-50" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {mod.chineseName ? <>{mod.chineseName}<span className="ml-1.5 text-xs font-normal text-muted-foreground/60">| {mod.name}</span></> : mod.name}
                </h3>
                {hasUpdate && (
                  <Tooltip content={update ? t('dialogs.mod.updateAvailableTo', { version: update.latestVersion }) : ''}>
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                  </Tooltip>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{mod.version || t('dialogs.mod.unknownVersion')}</span>
                {mod.authors.length > 0 && (
                  <>
                    <span className="text-border">·</span>
                    <span className="truncate">{mod.authors[0]}</span>
                  </>
                )}
              </div>
              {mod.description && mod.description !== 'No description available' && (
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">
                  <MinecraftText text={mod.description} />
                </p>
              )}
            </div>
            <Tooltip content={mod.active ? t('common.enabled') : t('common.disabled')}>
              <button
                onClick={(e) => { e.stopPropagation(); handleToggle() }}
                disabled={toggling}
                className={cn(
                  'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  'ring-1 ring-inset ring-white/[0.06]',
                  mod.active ? 'bg-primary' : 'bg-muted-foreground/25',
                  toggling && 'opacity-50 cursor-wait'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 rounded-full bg-white transition-all duration-200',
                    mod.active ? 'translate-x-[22px] shadow-md' : 'translate-x-[4px] shadow-sm'
                  )}
                />
                {toggling && <FontAwesomeIcon icon={faRotate} className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80" />}
              </button>
            </Tooltip>
          </CardContent>
        </Card>
      </ContextMenu>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogHeader onClose={() => setConfirmDelete(false)}>
          <DialogTitle>{t('dialogs.confirmDelete.titleMod')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('dialogs.confirmDelete.bodyMod', { name: mod.name })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? t('dialogs.common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}
