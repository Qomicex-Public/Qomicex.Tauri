import { useState, useCallback, useEffect, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTrashCan, faCheck } from '@fortawesome/free-solid-svg-icons'
import { Tooltip } from './ui/tooltip.tsx'
import { Button } from './ui/button.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import type { ScreenshotMetadata } from '../types/index.ts'
import { cn } from '../lib/utils.ts'

interface Props {
  screenshot: ScreenshotMetadata
  instanceId: string
  onRefresh: () => void
  selected?: boolean
  onSelect?: React.MouseEventHandler
}

export default function ScreenshotCard({ screenshot, instanceId, onRefresh, selected, onSelect }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const [imgSrc, setImgSrc] = useState('')
  const imgInited = useRef(false)

  useEffect(() => {
    if (imgInited.current) return
    imgInited.current = true
    const filePath = screenshot.filePath.replace(/\\/g, '/')
    const fallback = 'file:///' + filePath.replace(/^\//, '')
    import('@tauri-apps/api/core').then(mod => setImgSrc(mod.convertFileSrc(filePath))).catch(() => setImgSrc(fallback))
  }, [screenshot.filePath])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteScreenshot } = await import('../api/instance-files.ts')
      await deleteScreenshot(instanceId, screenshot.fileName)
      onRefresh()
    } catch { setDeleting(false) }
  }, [instanceId, screenshot.fileName, onRefresh])

  return (
    <>
      <div className={cn('group relative overflow-hidden rounded-lg border border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm cursor-pointer', selected && 'border-primary/40 bg-primary/[0.03]')} onClick={onSelect}>
        <div className="flex items-center gap-3 p-4">
          <button
            onClick={(e) => { e.stopPropagation(); onSelect?.(e) }}
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30 hover:border-foreground/50'
            )}
          >
            {selected && <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />}
          </button>
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-muted cursor-pointer" onClick={(e) => { e.stopPropagation(); setPreview(true) }}>
            <img src={imgSrc} alt={screenshot.fileName} className="h-full w-full object-cover" loading="lazy" />
          </div>
          <div className="min-w-0 flex-1 cursor-pointer" onClick={(e) => { e.stopPropagation(); setPreview(true) }}>
            <p className="truncate text-sm font-medium">{screenshot.fileName}</p>
            <p className="text-xs text-muted-foreground">
              {(screenshot.fileSize / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
          <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip content="删除">
              <button onClick={(e) => { e.stopPropagation(); setConfirmOpen(true) }} disabled={deleting} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground">
                <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogHeader onClose={() => setConfirmOpen(false)}>
          <DialogTitle>删除截图</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">确定要删除截图「{screenshot.fileName}」吗？将被移至回收站。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>取消</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? '删除中...' : '删除'}
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
