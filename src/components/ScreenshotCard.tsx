import { useState, useCallback, useEffect, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTrashCan } from '@fortawesome/free-solid-svg-icons'
import { Tooltip } from './ui/tooltip.tsx'
import type { ScreenshotMetadata } from '../types/index.ts'

interface Props {
  screenshot: ScreenshotMetadata
  instanceId: string
  onRefresh: () => void
}

export default function ScreenshotCard({ screenshot, instanceId, onRefresh }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [preview, setPreview] = useState(false)
  const [imgSrc, setImgSrc] = useState('')
  const imgInited = useRef(false)

  useEffect(() => {
    if (imgInited.current) return
    imgInited.current = true
    const filePath = screenshot.filePath.replace(/\\/g, '/')
    const fallback = `file:///${filePath.replace(/^\//, '')}`
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
      <div className="group relative overflow-hidden rounded-lg border border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
        <div className="aspect-video flex items-center justify-center bg-muted cursor-pointer overflow-hidden" onClick={() => setPreview(true)}>
          <img src={imgSrc} alt={screenshot.fileName} className="h-full w-full object-cover" loading="lazy" />
        </div>
        <div className="p-2">
          <p className="truncate text-xs">{screenshot.fileName}</p>
          <p className="text-[11px] text-muted-foreground">
            {(screenshot.fileSize / 1024 / 1024).toFixed(1)} MB
          </p>
        </div>
        <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip content="删除">
            <button onClick={() => handleDelete()} disabled={deleting} className="flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground">
              <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(false)}>
          <img src={imgSrc} alt={screenshot.fileName} className="max-h-full max-w-full rounded-lg object-contain" />
          <button onClick={() => setPreview(false)} className="absolute top-4 right-4 h-8 w-8 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20">×</button>
        </div>
      )}
    </>
  )
}
