import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, Ellipsis } from 'lucide-react'
import { MinecraftText } from './MinecraftText.tsx'
import { Card, CardContent, Popover, Checkbox } from './ui'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { useMessageBox } from './ui'
import { ApiError } from '../api/client.ts'
import { openFolder } from '../api/settings.ts'
import { Button } from './ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { DataPackMetadata } from '../types/index.ts'
import { cn } from '../lib/utils.ts'
import type { ModViewMode } from './ModCard.tsx'

interface Props {
  pack: DataPackMetadata
  instanceId: string
  gameDir: string
  gameVersion?: string
  loader?: string
  onDelete: (fileName: string) => void
  /** 列表模式：compact 日常管理（紧凑行）/ detailed 查看信息（含描述） */
  viewMode?: ModViewMode
  selected?: boolean
  onSelect?: React.MouseEventHandler
  /** 批量选择模式：true 时常驻显示复选框（由工具栏多选按钮 / Ctrl+点击 / Ctrl+A 置位） */
  selectMode?: boolean
}

export default function DataPackCard({ pack, instanceId, gameDir, gameVersion, loader, onDelete, viewMode = 'compact', selected, onSelect, selectMode }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const compact = viewMode === 'compact'

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteDataPack } = await import('../api/instance-files.ts')
      await deleteDataPack(instanceId, pack.fileName)
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
    onClick: () => openFolder(gameDir + '/datapacks').catch(() => notify(t('dialogs.common.openFailed'), 'error')),
  })

  if (pack.curseForgeId || pack.modrinthId) {
    const params = new URLSearchParams()
    params.set('source', pack.source || 'modrinth')
    params.set('category', 'datapack')
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
        {/* 复选框展开时由左侧 padding 让出空间，避免与图标重叠（同 Mod 卡片） */}
        <CardContent className={cn('flex items-center gap-4 relative transition-[padding] duration-200', selectMode || selected ? 'pl-10' : `${compact ? 'p-3' : 'p-4'} group-hover:pl-10 focus-within:pl-10`)}>
          <div className={cn('absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200', selected ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0')} />
          {/* 复选框：批量选择模式 / 已选中时常驻，否则 Hover 淡入；点击独立于卡片选中逻辑 */}
          {onSelect && (
            <div
              className={cn(
                'absolute left-2.5 top-1/2 z-10 -translate-y-1/2 transition-all duration-200',
                selectMode || selected
                  ? 'opacity-100 scale-100'
                  : 'pointer-events-none opacity-0 scale-90 group-hover:pointer-events-auto group-hover:opacity-100 group-hover:scale-100 focus-within:pointer-events-auto focus-within:opacity-100'
              )}
              onClick={(e) => {
                // 阻止冒泡避免触发卡片自身的 onClick 造成二次 toggle
                e.stopPropagation()
                // 构造「Ctrl+点击」语义的事件对象，复用 onSelect 的切换分支
                onSelect({ shiftKey: false, ctrlKey: true, stopPropagation: () => {}, preventDefault: () => {} } as unknown as React.MouseEvent)
              }}
            >
              <Checkbox checked={!!selected} aria-label={t('instanceDetail.mods.selectMod', { name: pack.name })} />
            </div>
          )}
          <div className={`flex ${compact ? 'h-10 w-10' : 'h-12 w-12'} shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden`}>
            {pack.iconBase64 ? (
              <img src={`data:image/png;base64,${pack.iconBase64}`} alt={pack.name} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <Database className="h-5 w-5 opacity-50" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">{pack.name}</h3>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              {pack.version && <span>{pack.version}</span>}
              {pack.version && pack.packFormat > 0 && <span className="text-border">·</span>}
              {pack.packFormat > 0 && <span>format {pack.packFormat}</span>}
            </div>
            {!compact && pack.description && (
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">
                <MinecraftText text={pack.description} />
              </p>
            )}
          </div>
          {sourceLabel && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              pack.source === 'curseforge' ? 'bg-orange-500/10 text-orange-500' : 'bg-green-500/10 text-green-500'
            }`}>
              {sourceLabel}
            </span>
          )}
          <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <Popover
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="end"
              contentClassName="min-w-[180px]"
              trigger={
                <button
                  type="button"
                  aria-label={t('instanceDetail.mods.moreActions')}
                  className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', menuOpen ? 'opacity-100' : 'opacity-0')}
                >
                  <Ellipsis className="h-4 w-4" />
                </button>
              }
            >
              <div className="flex flex-col">
                {contextItems.map((item, i) => (
                  <button
                    key={i}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => { item.onClick(); setMenuOpen(false) }}
                    className={cn(
                      'flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors',
                      item.danger ? 'text-destructive hover:bg-destructive/10' : 'text-popover-foreground hover:bg-accent',
                      item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </Popover>
          </div>
        </CardContent>
      </Card>
    </ContextMenu>
    <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
      <DialogHeader onClose={() => setConfirmOpen(false)}>
        <DialogTitle>{t('dialogs.confirmDelete.titleDataPack')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">{t('dialogs.confirmDelete.bodyDataPack', { name: pack.name })}</p>
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
