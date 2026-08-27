import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package } from 'lucide-react'
import { MinecraftText } from './MinecraftText.tsx'
import { Card, CardContent } from './ui'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { useMessageBox } from './ui'
import { ApiError } from '../api/client.ts'
import { openFolder } from '../api/settings.ts'
import { Button } from './ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { ResourcePackMetadata } from '../types/index.ts'
import { cn } from '../lib/utils.ts'

interface Props {
  pack: ResourcePackMetadata
  instanceId: string
  gameDir: string
  gameVersion?: string
  loader?: string
  onDelete: (fileName: string) => void
  compact?: boolean
  selected?: boolean
  onSelect?: React.MouseEventHandler
}

export default function ResourcePackCard({ pack, instanceId, gameDir, gameVersion, loader, onDelete, compact, selected, onSelect }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteResourcePack } = await import('../api/instance-files.ts')
      await deleteResourcePack(instanceId, pack.fileName)
      notify(t('dialogs.common.deleted', { name: pack.name }), 'success')
      onDelete(pack.fileName)
    } catch (e) {
      notify(t('dialogs.common.deleteFailed', { error: e instanceof ApiError ? e.displayMessage : t('dialogs.common.unknownError') }), 'error')
      setDeleting(false)
    }
  }, [instanceId, pack.fileName, pack.name, onDelete, notify])

  const contextItems: ContextMenuItem[] = []

  contextItems.push({
    label: t('dialogs.common.openFolder'),
    onClick: () => openFolder(gameDir + '/resourcepacks').catch(() => notify(t('dialogs.common.openFailed'), 'error')),
  })

  if (pack.curseForgeId || pack.modrinthId) {
    const params = new URLSearchParams()
    params.set('source', pack.source || 'modrinth')
    params.set('category', 'resourcepack')
    if (gameVersion) params.set('gameVersion', gameVersion)
    if (loader) params.set('loader', loader.toLowerCase())
    if (instanceId) params.set('instanceId', instanceId)
    const id = pack.curseForgeId?.toString() ?? pack.modrinthId ?? ''
    contextItems.push({
      label: t('dialogs.common.viewDetail'),
      onClick: () => navigate(`/resource-center/${encodeURIComponent(id)}?${params.toString()}&expandBody=1`),
    })
  }

  contextItems.push({
    label: t('common.delete'),
    onClick: () => setConfirmOpen(true),
    danger: true,
  })

  const sourceLabel = pack.source === 'curseforge' ? 'CurseForge' : pack.source === 'modrinth' ? 'Modrinth' : null

  return (
    <>
    <ContextMenu items={contextItems}>
      <Card className={cn('group cursor-pointer border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm', selected && 'border-primary/40 bg-primary/[0.03]')} onClick={onSelect}>
        <CardContent className={`flex items-center gap-4 ${compact ? 'p-3' : 'p-4'} relative`}>
          <div className={cn('absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200', selected ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0')} />
          <div className={`flex ${compact ? 'h-10 w-10' : 'h-12 w-12'} shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden`}>
            {pack.iconBase64 ? (
              <img src={`data:image/png;base64,${pack.iconBase64}`} alt={pack.name} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <Package className="h-5 w-5 opacity-50" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">{pack.name}</h3>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              {pack.version && <span>{pack.version}</span>}
              {pack.version && pack.packFormat > 0 && <span className="text-border">·</span>}
              {pack.packFormat > 0 && <span>format {pack.packFormat}</span>}
            </div>
            <div className="h-5">
              {pack.description && (
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">
                  <MinecraftText text={pack.description} />
                </p>
              )}
            </div>
          </div>
          {sourceLabel && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              pack.source === 'curseforge' ? 'bg-orange-500/10 text-orange-500' : 'bg-green-500/10 text-green-500'
            }`}>
              {sourceLabel}
            </span>
          )}
        </CardContent>
      </Card>
    </ContextMenu>
    <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
      <DialogHeader onClose={() => setConfirmOpen(false)}>
        <DialogTitle>{t('dialogs.confirmDelete.titleResourcePack')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">{t('dialogs.confirmDelete.bodyResourcePack', { name: pack.name })}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
        <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
          {deleting ? t('dialogs.common.deleting') : t('common.delete')}
        </Button>
      </DialogFooter>
    </Dialog>
    </>
  )
}
