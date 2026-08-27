import type { ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

export function SettingSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-2 px-1 pb-2 pt-1">
        {icon && <span className="text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
        <h3 className="text-sm font-semibold text-foreground/90">{title}</h3>
      </div>
      <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-card/40">
        {children}
      </div>
    </section>
  )
}

export function SettingRow({ label, description, control, onClick, className }: {
  label: string
  description?: string
  control?: ReactNode
  onClick?: () => void
  className?: string
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-4 px-4 py-3 text-left',
        onClick && 'cursor-pointer transition-colors hover:bg-accent/50',
        className
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      {control && <div className="flex shrink-0 items-center">{control}</div>}
    </Comp>
  )
}
