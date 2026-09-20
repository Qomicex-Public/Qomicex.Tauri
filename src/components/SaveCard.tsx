import { useState, useCallback } from 'react'
import { Copy, Map as MapIcon, Pen, Play, Save, Settings, Trash2 } from 'lucide-react'
import { Card, CardContent, Checkbox } from './ui'
import { Tooltip } from './ui'
import { Input } from './ui'
import { Button } from './ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { ContextMenu, type ContextMenuItem } from './ContextMenu.tsx'
import SaveSettingsDialog from './SaveSettingsDialog.tsx'
import WorldPreviewDialog from './WorldPreviewDialog.tsx'
import type { SaveMetadata } from '../types/index.ts'
import { cn } from '../lib/utils.ts'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  save: SaveMetadata
  instanceId: string
  onRefresh: () => void
  selected?: boolean
  onSelect?: React.MouseEventHandler
  /** 批量选择模式：true 时常驻显示复选框（由工具栏多选按钮 / Ctrl+点击 / Ctrl+A 置位） */
  selectMode?: boolean
  onQuickJoin?: () => void
  /** 实例是否运行中（存档设置弹窗内提示写入会被游戏覆盖） */
  running?: boolean
}

export default function SaveCard({ save, instanceId, onRefresh, selected, onSelect, selectMode, onQuickJoin, running }: Props) {
  const { t, lang } = useI18n()
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(save.name)
  const [backingUp, setBackingUp] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  /** 存档目录名（= filePath 末段，API 路径用；与 handleDelete 一致） */
  const folderName = save.filePath.replace(/\\/g, '/').split('/').pop() ?? save.name

  const handleBackup = useCallback(async () => {
    setBackingUp(true)
    try {
      const { backupSave } = await import('../api/instance-files.ts')
      await backupSave(instanceId, save.name)
      onRefresh()
    } catch { }
    setBackingUp(false)
  }, [instanceId, save.name, onRefresh])

  const handleRename = useCallback(async () => {
    if (!renameValue.trim() || renameValue === save.name) { setRenaming(false); return }
    try {
      const { renameSave } = await import('../api/instance-files.ts')
      await renameSave(instanceId, save.name, renameValue.trim())
      onRefresh()
    } catch { }
    setRenaming(false)
  }, [instanceId, save.name, renameValue, onRefresh])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteSave } = await import('../api/instance-files.ts')
      const folderName = save.filePath.replace(/\\/g, '/').split('/').pop() ?? save.name
      await deleteSave(instanceId, folderName)
      onRefresh()
    } catch { setDeleting(false) }
  }, [instanceId, save.name, save.filePath, onRefresh])

  const contextItems: ContextMenuItem[] = [
    { label: t('dialogs.save.worldPreview'), onClick: () => setPreviewOpen(true) },
    { label: t('dialogs.save.settings'), onClick: () => setSettingsOpen(true) },
    { label: t('dialogs.save.backup'), onClick: () => handleBackup() },
    { label: t('dialogs.save.rename'), onClick: () => { setRenameValue(save.name); setRenaming(true) } },
    ...(onQuickJoin ? [{ label: t('dialogs.save.quickJoin'), onClick: onQuickJoin }] : []),
    { label: t('common.delete'), onClick: () => setConfirmOpen(true), danger: true },
  ]

  return (
    <ContextMenu items={contextItems}>
    <Card className={cn('group cursor-pointer border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm', selected && 'border-primary/40 bg-primary/[0.03]')} onClick={onSelect}>
      {/* 复选框展开时由左侧 padding 让出空间，避免与图标重叠（同 Mod 卡片） */}
      <CardContent className={cn('flex items-center gap-4 relative transition-[padding] duration-200', selectMode || selected ? 'pl-10' : 'p-4 group-hover:pl-10 focus-within:pl-10')}>
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
              // 鼠标点击后移除焦点：Radix 复选框是 <button>，点击会留下 DOM 焦点，而容器用
              // focus-within 保持可见（键盘可达性）——不清焦点的话，最后操作的那个复选框
              // 在取消选中、退出多选后仍常显（移开鼠标也不消失）。
              // 仅对真实指针点击（detail > 0）失焦；键盘激活（detail === 0）保留焦点。
              if (e.detail > 0) {
                const focused = document.activeElement
                if (focused instanceof HTMLElement && e.currentTarget.contains(focused)) focused.blur()
              }
              // 构造「Ctrl+点击」语义的事件对象，复用 onSelect 的切换分支
              onSelect({ shiftKey: false, ctrlKey: true, stopPropagation: () => {}, preventDefault: () => {} } as unknown as React.MouseEvent)
            }}
          >
            <Checkbox checked={!!selected} aria-label={t('instanceDetail.mods.selectMod', { name: save.name })} />
          </div>
        )}
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
          {save.iconBase64 ? (
            <img src={`data:image/png;base64,${save.iconBase64}`} alt={save.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <Save className="h-5 w-5 opacity-50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false) }}
                className="h-7 text-sm"
                autoFocus
              />
              <Button size="sm" onClick={handleRename} className="h-7 text-xs">{t('common.confirm')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(false)} className="h-7 text-xs">{t('common.cancel')}</Button>
            </div>
          ) : (
            <>
              <h3 className="truncate text-sm font-semibold text-foreground">{save.name}</h3>
              {save.lastPlayed > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">{t('dialogs.save.lastPlayed', { date: new Date(save.lastPlayed).toLocaleDateString(lang) })}</p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip content={t('dialogs.save.worldPreview')}>
            <button aria-label={t('dialogs.save.worldPreview')} onClick={(e) => { e.stopPropagation(); setPreviewOpen(true) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary">
              <MapIcon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={t('dialogs.save.settings')}>
            <button onClick={(e) => { e.stopPropagation(); setSettingsOpen(true) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary">
              <Settings className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={t('dialogs.save.backup')}>
            <button onClick={(e) => { e.stopPropagation(); handleBackup() }} disabled={backingUp} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Copy className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={t('dialogs.save.rename')}>
            <button onClick={(e) => { e.stopPropagation(); setRenameValue(save.name); setRenaming(true) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Pen className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          {onQuickJoin && (
            <Tooltip content={t('dialogs.save.quickJoin')}>
              <button onClick={(e) => { e.stopPropagation(); onQuickJoin() }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary">
                <Play className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          <Tooltip content={t('common.delete')}>
            <button onClick={(e) => { e.stopPropagation(); setConfirmOpen(true) }} disabled={deleting} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </CardContent>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogHeader onClose={() => setConfirmOpen(false)}>
          <DialogTitle>{t('dialogs.confirmDelete.titleSave')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('dialogs.confirmDelete.bodySave', { name: save.name })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? t('dialogs.common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
      <SaveSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        instanceId={instanceId}
        saveName={save.name}
        folderName={folderName}
        running={running ?? false}
        onSaved={onRefresh}
      />
      <WorldPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        instanceId={instanceId}
        saveName={folderName}
        savePath={save.filePath}
      />
    </Card>
    </ContextMenu>
  )
}
