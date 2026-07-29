import type { PluginInfo } from '../plugins/types.ts'
import { PERMISSION_CATALOG } from '../plugins/types.ts'
import { Button } from './ui/button.tsx'
import { Badge } from './ui/badge.tsx'

interface PluginCardProps {
  plugin: PluginInfo
  onToggle: (id: string, active: boolean) => void
  onUninstall: (id: string) => void
}

export function PluginCard({ plugin, onToggle, onUninstall }: PluginCardProps) {
  const { manifest, state } = plugin
  const isActive = state === 'active'

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium">{manifest.name}</h3>
          <p className="text-sm text-muted-foreground">{manifest.id}@{manifest.version}</p>
        </div>
        <Badge variant={isActive ? 'default' : 'secondary'}>
          {isActive ? '已启用' : '已禁用'}
        </Badge>
      </div>

      {manifest.contributes?.menuItems && manifest.contributes.menuItems.length > 0 && (
        <p className="text-xs text-muted-foreground">
          扩展点: {manifest.contributes.menuItems.map(i => i.label).join(', ')}
        </p>
      )}

      <div className="flex flex-wrap gap-1">
        {manifest.layers.map(layer => (
          <Badge key={layer} variant="outline" className="text-xs">{layer.toUpperCase()}</Badge>
        ))}
      </div>

      {manifest.permissions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">权限 ({manifest.permissions.length})</p>
          <div className="flex flex-wrap gap-1">
            {manifest.permissions.map(p => {
              const info = PERMISSION_CATALOG[p]
              const colors: Record<string, string> = {
                normal: 'border-blue-500/30 text-blue-400',
                warning: 'border-yellow-500/30 text-yellow-400',
                danger: 'border-red-500/30 text-red-400',
              }
              return (
                <span key={p}
                  className={`text-xs px-1.5 py-0.5 rounded border ${colors[info?.risk ?? 'normal'] ?? ''}`}
                  title={info?.label ?? p}
                >
                  {info?.label ?? p}
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <Button
          size="sm"
          variant={isActive ? 'outline' : 'default'}
          onClick={() => onToggle(manifest.id, !isActive)}
        >
          {isActive ? '停用' : '启用'}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => onUninstall(manifest.id)}>
          卸载
        </Button>
      </div>
    </div>
  )
}
