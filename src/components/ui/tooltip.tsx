import * as React from "react"
import { cn } from "../../lib/utils.ts"

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  delay?: number
  className?: string
}

function Tooltip({ content, children, side = "top", delay = 300, className }: TooltipProps) {
  const [visible, setVisible] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const sideStyles: Record<string, string> = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  }

  function show() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }

  function hide() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
  }

  return (
    <div className="relative inline-flex min-w-0 max-w-full" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && (
        <div
          className={cn(
            "pointer-events-none absolute z-50 rounded-md border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md whitespace-nowrap animate-in fade-in",
            sideStyles[side],
            className
          )}
        >
          {content}
        </div>
      )}
    </div>
  )
}

export { Tooltip }
