import type { PluginInfo } from '../plugins/types.ts'
import { cn } from '../lib/utils.ts'

interface PluginCardProps {
  plugin: PluginInfo
  onToggle: (id: string, active: boolean) => void
  onUninstall: (id: string) => void
  onClick: () => void
}

export function PluginCard({ plugin, onToggle, onUninstall, onClick }: PluginCardProps) {
  const { manifest, state } = plugin
  const isActive = state === 'active'

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary cursor-pointer select-none"
        onClick={onClick}
      >
        {(manifest.contributes?.menuItems?.[0]?.icon) || manifest.name[0]}
      </div>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        <div className="font-medium text-sm truncate">{manifest.name}</div>
        <div className="text-xs text-muted-foreground truncate">{manifest.id}@{manifest.version}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={isActive}
        onClick={(e) => { e.stopPropagation(); onToggle(manifest.id, !isActive) }}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          isActive ? 'bg-primary' : 'bg-input'
        )}
      >
        <span className={cn('pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform', isActive ? 'translate-x-4' : 'translate-x-0')} />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onUninstall(manifest.id) }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>
      </button>
    </div>
  )
}
