import * as React from "react"
import { createPortal } from "react-dom"
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
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const posRef = React.useRef({ top: 0, left: 0 })
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  function show() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (wrapperRef.current) {
        const r = wrapperRef.current.getBoundingClientRect()
        posRef.current = { top: r.top, left: r.left }
      }
      setVisible(true)
    }, delay)
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
            "pointer-events-none fixed z-[9999] rounded-md border border-border/50 bg-popover/90 backdrop-blur-lg px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md whitespace-nowrap animate-in fade-in",
            className
          )}
          style={
            side === "right"
              ? { top: posRef.current.top + 22, left: posRef.current.left + 64 }
              : side === "left"
              ? { top: posRef.current.top + 22, right: window.innerWidth - posRef.current.left + 8 }
              : side === "bottom"
              ? { top: posRef.current.top + 44, left: posRef.current.left + 32 }
              : { top: posRef.current.top - 8, left: posRef.current.left + 32 }
          }
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  )
}

export { Tooltip }
