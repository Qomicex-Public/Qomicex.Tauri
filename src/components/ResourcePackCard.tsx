import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, Ellipsis } from 'lucide-react'
import { MinecraftText } from './MinecraftText.tsx'
import { Card, CardContent, Popover, Checkbox, Tooltip } from './ui'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { useMessageBox } from './ui'
import { ApiError } from '../api/client.ts'
import { openFolder } from '../api/settings.ts'
import { Button } from './ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { ResourcePackMetadata } from '../types/index.ts'
import { cn } from '../lib/utils.ts'
import type { ModViewMode } from './ModCard.tsx'

interface Props {
  pack: ResourcePackMetadata
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

export default function ResourcePackCard({ pack, instanceId, gameDir, gameVersion, loader, onDelete, viewMode = 'compact', selected, onSelect, selectMode }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const compact = viewMode === 'compact'

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

  // 信息语义（资源类型定制）：名称 | 版本 + format N | 来源。无值的字段不渲染。
  // 规则（spec 六 / 十）：「组件视觉统一，信息语义按资源类型变化」，不为填充空间添加无意义文本。
  const formatText = pack.packFormat > 0 ? t('instanceDetail.resourcepacks.format', { version: pack.packFormat }) : ''
  const compactMeta = [pack.version, formatText].filter(Boolean).join(' · ')
  const detailedMeta = [pack.version, formatText].filter(Boolean)

  return (
    <>
    <ContextMenu items={contextItems}>
      <Card
        className={cn(
          'group cursor-pointer select-none border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm',
          compact ? 'mod-row-compact rounded-lg' : 'mod-row-detailed',
          selected && 'border-primary/40 bg-primary/[0.03]'
        )}
        onClick={onSelect}
      >
        <CardContent className={cn(
          'relative flex items-center transition-[padding] duration-200',
          compact ? 'gap-2.5 px-2.5 py-2' : 'gap-4 p-4',
          (selectMode || selected)
            ? (compact ? 'pl-9' : 'pl-10')
            : (compact ? 'group-hover:pl-9 focus-within:pl-9' : 'group-hover:pl-10 focus-within:pl-10')
        )}>
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
          <div className={cn('flex shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground', compact ? 'h-7 w-7 rounded-md' : 'h-12 w-12 rounded-xl')}>
            {pack.iconBase64 ? (
              <img src={`data:image/png;base64,${pack.iconBase64}`} alt={pack.name} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <Package className={cn('opacity-50', compact ? 'h-3.5 w-3.5' : 'h-5 w-5')} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {compact ? (
              // 固定列轨道：名称 + 元信息右对齐轨道（与 Mod 紧凑行同策略，规避行末空白）
              <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
                <h3 className="truncate text-xs font-medium text-foreground">{pack.name}</h3>
                {compactMeta ? (
                  <Tooltip content={compactMeta}>
                    <span className="truncate text-right text-[11px] tabular-nums text-muted-foreground">{compactMeta}</span>
                  </Tooltip>
                ) : (
                  <span className="truncate text-[11px] tabular-nums text-muted-foreground" />
                )}
              </div>
            ) : (
              <>
                <h3 className="truncate text-sm font-semibold text-foreground">{pack.name}</h3>
                {detailedMeta.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {detailedMeta.map((item, i) => (
                      <span key={i} className="flex items-center gap-2">
                        {i > 0 && <span className="text-border">·</span>}
                        {item}
                      </span>
                    ))}
                  </div>
                )}
                {pack.description && (
                  <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">
                    <MinecraftText text={pack.description} />
                  </p>
                )}
              </>
            )}
          </div>
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