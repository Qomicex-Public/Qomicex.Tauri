import { useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faSun } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { useMessageBox } from './ui/message-box.tsx'
import { ApiError } from '../api/client.ts'
import { openFolder } from '../api/settings.ts'
import type { ShaderMetadata } from '../types/index.ts'

interface Props {
  shader: ShaderMetadata
  instanceId: string
  gameDir: string
  onDelete: (fileName: string) => void
  compact?: boolean
}

export default function ShaderCard({ shader, instanceId, gameDir, onDelete, compact }: Props) {
  const { notify } = useMessageBox()

  const handleDelete = useCallback(async () => {
    try {
      const { deleteShaderPack } = await import('../api/instance-files.ts')
      await deleteShaderPack(instanceId, shader.fileName)
      notify(`已删除「${shader.name}」`, 'success')
      onDelete(shader.fileName)
    } catch (e) {
      notify(`删除失败: ${e instanceof ApiError ? e.displayMessage : '未知错误'}`, 'error')
    }
  }, [instanceId, shader.fileName, shader.name, onDelete, notify])

  const contextItems: ContextMenuItem[] = []

  contextItems.push({
    label: '打开文件夹',
    onClick: () => openFolder(gameDir + '/shaderpacks').catch(() => notify('打开失败', 'error')),
  })

  if (shader.curseForgeId || shader.modrinthId) {
    const params = new URLSearchParams()
    params.set('source', shader.source || 'modrinth')
    params.set('category', 'shader')
    const id = shader.curseForgeId?.toString() ?? shader.modrinthId ?? ''
    contextItems.push({
      label: '查看详情',
      onClick: () => window.open(`#/resource-center/${encodeURIComponent(id)}?${params.toString()}`, '_blank'),
    })
  }

  contextItems.push({
    label: '删除',
    onClick: () => {
      if (window.confirm(`确定要删除「${shader.name}」吗？`)) handleDelete()
    },
    danger: true,
  })

  const sourceLabel = shader.source === 'curseforge' ? 'CurseForge' : shader.source === 'modrinth' ? 'Modrinth' : null

  return (
    <ContextMenu items={contextItems}>
      <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
        <CardContent className={`flex items-center gap-4 ${compact ? 'p-3' : 'p-4'}`}>
          <div className={`flex ${compact ? 'h-10 w-10' : 'h-12 w-12'} shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden`}>
            {shader.iconBase64 ? (
              <img src={`data:image/png;base64,${shader.iconBase64}`} alt={shader.name} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <FontAwesomeIcon icon={faSun} className="h-5 w-5 opacity-50" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">{shader.name}</h3>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              {shader.version && <span>{shader.version}</span>}
            </div>
            {shader.description && (
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{shader.description}</p>
            )}
          </div>
          {sourceLabel && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              shader.source === 'curseforge' ? 'bg-orange-500/10 text-orange-500' : 'bg-green-500/10 text-green-500'
            }`}>
              {sourceLabel}
            </span>
          )}
        </CardContent>
      </Card>
    </ContextMenu>
  )
}
