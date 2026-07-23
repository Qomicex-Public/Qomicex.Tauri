import type { ReactNode } from 'react'
import { cn } from '../lib/utils.ts'

export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col animate-in slide-up', className)}>
      {children}
    </div>
  )
}
