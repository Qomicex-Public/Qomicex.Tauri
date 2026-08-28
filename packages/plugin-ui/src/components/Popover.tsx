import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn.js'
import { useFloatingPosition } from '../hooks/useFloatingPosition.js'

interface PopoverProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  className?: string
  contentClassName?: string
}

export function Popover({ open: controlledOpen, onOpenChange, trigger, children, align = 'start', side, className, contentClassName }: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const isOpen = controlledOpen ?? internalOpen
  const setOpen = useCallback((v: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(v)
    onOpenChange?.(v)
  }, [controlledOpen, onOpenChange])

  const floating = useFloatingPosition(triggerRef, { maxHeight: 300, side, align }, isOpen)

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (contentRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen, setOpen])

  return (
    <div ref={triggerRef} className={cn('inline-flex', className)}>
      <div onClick={() => setOpen(!isOpen)}>{trigger}</div>
      {isOpen && createPortal(
        <div
          ref={contentRef}
          style={floating.style}
          className={cn(
            'rounded-lg border border-border/50 bg-popover p-1 shadow-xl animate-in fade-in zoom-in-95',
            contentClassName
          )}
          onMouseDown={(e) => e.preventDefault()}
        >
          {children}
        </div>,
        document.body
      )}
    </div>
  )
}
