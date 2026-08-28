import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "../lib/cn.js"
import { useTooltipPosition } from "../hooks/useFloatingPosition.js"

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  delay?: number
  className?: string
}

function Tooltip({ content, children, side = "top", delay = 300, className }: TooltipProps) {
  const [visible, setVisible] = React.useState(false)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const floating = useTooltipPosition(wrapperRef, side, visible)

  function show() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }

  function hide() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
  }

  return (
    <div ref={wrapperRef} className="inline-flex min-w-0 max-w-full" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && createPortal(
        <div
          className={cn(
            "pointer-events-none fixed z-[9999] rounded-md border border-border/50 bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md whitespace-nowrap animate-in zoom-in-95",
            className
          )}
          style={floating.style}
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  )
}

export { Tooltip }
