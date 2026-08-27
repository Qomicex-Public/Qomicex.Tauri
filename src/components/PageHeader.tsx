import type { ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft } from '@fortawesome/free-solid-svg-icons'

export function PageHeader({ title, subtitle, actions, onBack }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; onBack?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        {onBack && (
          <button onClick={onBack} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-95">
            <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 space-y-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
