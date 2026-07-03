import { useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBox } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import type { ResourcePackMetadata } from '../types/index.ts'
import { ApiError } from '../api/client.ts'
import { useMessageBox } from './ui/message-box.tsx'

interface Props {
  pack: ResourcePackMetadata
  instanceId: string
  onDelete: (fileName: string) => void
}

export default function ResourcePackCard({ pack, instanceId, onDelete }: Props) {
  const [deleting, setDeleting] = useState(false)
  const { notify } = useMessageBox()

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteResourcePack } = await import('../api/instance-files.ts')
      await deleteResourcePack(instanceId, pack.fileName)
      notify(`已删除「${pack.name}」`, 'success')
      onDelete(pack.fileName)
    } catch (e) {
      setDeleting(false)
      notify(`删除失败: ${e instanceof ApiError ? e.displayMessage : '未知错误'}`, 'error')
    }
  }, [instanceId, pack.fileName, onDelete, notify])

  return (
    <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
          {pack.iconBase64 ? (
            <img src={`data:image/png;base64,${pack.iconBase64}`} alt={pack.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <FontAwesomeIcon icon={faBox} className="h-5 w-5 opacity-50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{pack.name}</h3>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {pack.version && <span>{pack.version}</span>}
            {pack.version && pack.packFormat > 0 && <span className="text-border">·</span>}
            {pack.packFormat > 0 && <span>format {pack.packFormat}</span>}
          </div>
          {pack.description && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{pack.description}</p>
          )}
        </div>
        <Tooltip content="删除">
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete() }}
            disabled={deleting}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </Tooltip>
      </CardContent>
    </Card>
  )
}
