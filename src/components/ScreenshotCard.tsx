import { useState, useCallback, useEffect, useRef } from 'react'
import { Expand, Trash2, Ellipsis } from 'lucide-react'
import { Tooltip, Popover } from './ui'
import { Button } from './ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { ScreenshotMetadata } from '../types/index.ts'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { cn } from '../lib/utils.ts'

interface Props {
  screenshot: ScreenshotMetadata
  instanceId: string
  onRefresh: () => void
  selected?: boolean
  onSelect?: React.MouseEventHandler
}

export default function ScreenshotCard({ screenshot, instanceId, onRefresh, selected, onSelect }: Props) {
  const { t } = useI18n()
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const [imgSrc, setImgSrc] = useState('')
  const imgInited = useRef(false)

  useEffect(() => {
    if (imgInited.current) return
    imgInited.current = true
    import('../api/client.ts').then(mod => setImgSrc(`${mod.API_BASE}/instance/${instanceId}/files/screenshots/${encodeURIComponent(screenshot.fileName)}`))
  }, [screenshot.filePath, screenshot.fileName, instanceId])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteScreenshot } = await import('../api/instance-files.ts')
      await deleteScreenshot(instanceId, screenshot.fileName)
      onRefresh()
    } catch { setDeleting(false) }
  }, [instanceId, screenshot.fileName, onRefresh])

  const contextItems: ContextMenuItem[] = [
    {
      label: t('instanceDetail.schematics.preview'),
      onClick: () => setPreview(true),
    },
    {
      label: t('common.delete'),
      onClick: () => setConfirmOpen(true),
      danger: true,
    },
  ]

  return (
    <>
      <ContextMenu items={contextItems}>
      <div className={cn('group glass-surface relative overflow-hidden rounded-lg border bg-card transition-all hover:shadow-md hover:border-primary/20 cursor-pointer', selected && 'border-primary/40 ring-1 ring-primary/30')} onClick={onSelect}>
        <div className="aspect-[4/3] overflow-hidden bg-muted" onClick={(e) => { e.stopPropagation(); setPreview(true) }}>
          {imgSrc && <img src={imgSrc} alt={screenshot.fileName} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy" />}
        </div>
        <div className={cn('absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200 z-10', selected ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0')} />
        <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip content={t('common.delete')}>
            <button onClick={(e) => { e.stopPropagation(); setConfirmOpen(true) }} disabled={deleting} className="flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{screenshot.fileName}</p>
            <p className="text-[11px] text-muted-foreground">{(screenshot.fileSize / 1024 / 1024).toFixed(1)} MB</p>
          </div>
          <button onClick={(e) => { e.stopPropagation(); setPreview(true) }} className="shrink-0 text-muted-foreground hover:text-foreground transition-colors">
            <Expand className="h-3.5 w-3.5" />
          </button>
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
        </div>
      </div>
      </ContextMenu>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogHeader onClose={() => setConfirmOpen(false)}>
          <DialogTitle>{t('dialogs.confirmDelete.titleScreenshot')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('dialogs.confirmDelete.bodyScreenshot', { name: screenshot.fileName })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? t('dialogs.common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(false)}>
          <img src={imgSrc} alt={screenshot.fileName} className="max-h-full max-w-full rounded-lg object-contain" />
          <button onClick={() => setPreview(false)} className="absolute top-4 right-4 h-8 w-8 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20">&times;</button>
        </div>
      )}
    </>
  )
}
