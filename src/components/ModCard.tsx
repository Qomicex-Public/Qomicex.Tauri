import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCube, faRotate } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { cn } from '../lib/utils.ts'
import { enableMod, disableMod, deleteMod } from '../api/instance-files.ts'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { ModMetadata } from '../types/index.ts'

interface ModCardProps {
  mod: ModMetadata
  instanceId: string
  gameVersion?: string
  loader?: string
  onRefresh: () => void
  onChangeVersion: (mod: ModMetadata) => void
  batchMode?: boolean
  selected?: boolean
  onSelect?: (fileName: string) => void
}

export default function ModCard({
  mod, instanceId, gameVersion, loader, onRefresh, onChangeVersion,
  batchMode, selected, onSelect,
}: ModCardProps) {
  const navigate = useNavigate()
  const [toggling, setToggling] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [imgError, setImgError] = useState(false)

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
      onRefresh()
    } catch (e) { console.error('Toggle mod failed:', e) }
    setToggling(false)
  }, [instanceId, mod, onRefresh])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    setConfirmDelete(false)
    try {
      await deleteMod(instanceId, mod.fileName)
      onRefresh()
    } catch (e) { console.error('Delete mod failed:', e) }
    setDeleting(false)
  }, [instanceId, mod, onRefresh])

  const contextItems: ContextMenuItem[] = []
  if (mod.mcmodId) {
    contextItems.push({
      label: 'MC百科',
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
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId ?? ''
    contextItems.push({
      label: '查看详情',
      onClick: () => navigate(`/resource-center/${encodeURIComponent(id)}?${params.toString()}&expandBody=1`),
    })
  }
  contextItems.push(
    { label: '更换版本', onClick: () => onChangeVersion(mod) },
    { label: '删除', onClick: () => setConfirmDelete(true), danger: true },
  )

  return (
    <>
      <ContextMenu items={contextItems}>
        <Card
          className={cn(
            'group cursor-pointer select-none border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm',
            !mod.active && 'opacity-50',
            batchMode && selected && 'ring-2 ring-primary border-primary/30'
          )}
          onClick={() => batchMode && onSelect?.(mod.fileName)}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
              {mod.iconBase64 ? (
                <img src={`data:image/png;base64,${mod.iconBase64}`} alt={mod.name} className="h-full w-full object-cover" loading="lazy" />
              ) : mod.iconUrl && !imgError ? (
                <img src={mod.iconUrl} alt={mod.name} className="h-full w-full object-cover" loading="lazy" onError={() => setImgError(true)} />
              ) : (
                <FontAwesomeIcon icon={faCube} className="h-5 w-5 opacity-50" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {mod.chineseName ? <>{mod.chineseName}<span className="ml-1.5 text-xs font-normal text-muted-foreground/60">| {mod.name}</span></> : mod.name}
                </h3>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{mod.version || '未知版本'}</span>
                {mod.authors.length > 0 && (
                  <>
                    <span className="text-border">·</span>
                    <span className="truncate">{mod.authors[0]}</span>
                  </>
                )}
              </div>
              {mod.description && mod.description !== 'No description available' && (
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{mod.description}</p>
              )}
            </div>
            <Tooltip content={mod.active ? '已启用' : '已禁用'}>
              <button
                onClick={(e) => { e.stopPropagation(); handleToggle() }}
                disabled={toggling}
                className={cn(
                  'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  mod.active ? 'bg-primary' : 'bg-muted-foreground/25',
                  toggling && 'opacity-50 cursor-wait'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                    mod.active ? 'translate-x-[22px]' : 'translate-x-[4px]'
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
          <DialogTitle>删除 Mod</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">确定要删除 Mod「{mod.name}」吗？此操作不可撤销。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>取消</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? '删除中...' : '删除'}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}
