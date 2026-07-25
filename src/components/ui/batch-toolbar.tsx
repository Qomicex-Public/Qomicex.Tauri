import { type ReactNode, useEffect, useState } from 'react'
import { cn } from '../../lib/utils.ts'

export function BatchToolbar({ selectedCount, onClear, onSelectAll, children, className }: {
  selectedCount: number
  onClear: () => void
  onSelectAll?: () => void
  children?: ReactNode
  className?: string
}) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (selectedCount > 0 && !visible) setVisible(true)
    else if (selectedCount === 0 && visible) {
      const timer = setTimeout(() => setVisible(false), 200)
      return () => clearTimeout(timer)
    }
  }, [selectedCount, visible])

  if (!visible && selectedCount === 0) return null

  return (
    <div
      className={cn(
        'fixed bottom-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-card px-5 py-3 shadow-lg shadow-black/10 transition-all duration-200',
        selectedCount > 0 ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-4 opacity-0 scale-95 pointer-events-none',
        className
      )}
    >
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        已选 <span className="font-semibold text-foreground">{selectedCount}</span> 个
      </span>
      <div className="h-5 w-px bg-border" />
      {onSelectAll && (
        <button
          onClick={onSelectAll}
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          全选
        </button>
      )}
      <button
        onClick={onClear}
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        取消选择
      </button>
      {children}
    </div>
  )
}
