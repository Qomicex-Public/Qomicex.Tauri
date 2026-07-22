import { useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faSave, faCopy, faPen, faTrashCan, faCheck } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import { Input } from './ui/input.tsx'
import { Button } from './ui/button.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import type { SaveMetadata } from '../types/index.ts'
import { cn } from '../lib/utils.ts'

interface Props {
  save: SaveMetadata
  instanceId: string
  onRefresh: () => void
  selected?: boolean
  onSelect?: React.MouseEventHandler
}

export default function SaveCard({ save, instanceId, onRefresh, selected, onSelect }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(save.name)
  const [backingUp, setBackingUp] = useState(false)

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
      await deleteSave(instanceId, save.name)
      onRefresh()
    } catch { setDeleting(false) }
  }, [instanceId, save.name, onRefresh])

  return (
    <Card className={cn('group cursor-pointer border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm', selected && 'border-primary/40 bg-primary/[0.03]')} onClick={onSelect}>
      <CardContent className="flex items-center gap-4 p-4">
        <button
          onClick={(e) => { e.stopPropagation(); onSelect?.(e) }}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30 hover:border-foreground/50'
          )}
        >
          {selected && <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />}
        </button>
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
          {save.iconBase64 ? (
            <img src={`data:image/png;base64,${save.iconBase64}`} alt={save.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <FontAwesomeIcon icon={faSave} className="h-5 w-5 opacity-50" />
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
              <Button size="sm" onClick={handleRename} className="h-7 text-xs">确定</Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(false)} className="h-7 text-xs">取消</Button>
            </div>
          ) : (
            <>
              <h3 className="truncate text-sm font-semibold text-foreground">{save.name}</h3>
              {save.lastPlayed > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">上次游玩: {new Date(save.lastPlayed).toLocaleDateString('zh-CN')}</p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip content="备份">
            <button onClick={(e) => { e.stopPropagation(); handleBackup() }} disabled={backingUp} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="重命名">
            <button onClick={(e) => { e.stopPropagation(); setRenameValue(save.name); setRenaming(true) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="删除">
            <button onClick={(e) => { e.stopPropagation(); setConfirmOpen(true) }} disabled={deleting} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </CardContent>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogHeader onClose={() => setConfirmOpen(false)}>
          <DialogTitle>删除存档</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">确定要删除存档「{save.name}」吗？将被移至回收站。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>取消</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? '删除中...' : '删除'}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  )
}
