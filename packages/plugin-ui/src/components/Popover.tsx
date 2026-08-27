import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn.js'

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

const VIEWPORT_MARGIN = 8

export function Popover({ open: controlledOpen, onOpenChange, trigger, children, align = 'start', side, className, contentClassName }: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [resolvedSide, setResolvedSide] = useState<'bottom' | 'top'>(side ?? 'bottom')
  const triggerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const isOpen = controlledOpen ?? internalOpen
  const setOpen = useCallback((v: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(v)
    onOpenChange?.(v)
  }, [controlledOpen, onOpenChange])

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const tr = triggerRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    const DEFAULT_MAX_HEIGHT = 300
    let chosenSide = side ?? 'bottom'
    if (side === undefined) {
      const spaceBelow = vh - tr.bottom - VIEWPORT_MARGIN
      const spaceAbove = tr.top - VIEWPORT_MARGIN
      if (spaceBelow < DEFAULT_MAX_HEIGHT && spaceAbove > spaceBelow) chosenSide = 'top'
    }

    let top: number
    if (chosenSide === 'top') {
      top = tr.top - VIEWPORT_MARGIN
    } else {
      top = tr.bottom + VIEWPORT_MARGIN
    }

    let left: number
    if (align === 'end') {
      left = tr.right
    } else {
      left = tr.left
    }

    if (left + 200 > vw) left = Math.max(VIEWPORT_MARGIN, vw - 200 - VIEWPORT_MARGIN)
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN

    setPos({ top, left })
    setResolvedSide(chosenSide)
  }, [side, align])

  useEffect(() => {
    if (!isOpen) return
    updatePos()
    const onScroll = () => updatePos()
    const onResize = () => updatePos()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [isOpen, updatePos])

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
          style={{
            position: 'fixed',
            top: resolvedSide === 'top' ? undefined : pos.top,
            ...(resolvedSide === 'top' ? { bottom: `${window.innerHeight - pos.top}px` } : {}),
            left: pos.left,
            zIndex: 9999,
          }}
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
