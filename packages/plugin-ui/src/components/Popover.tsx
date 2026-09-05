import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn.js'
import gsap from 'gsap'
import { readAnimConfig, EASE_IN, EASE_OUT, withGpu } from '../lib/anim.js'
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
  // 响应式退出：open 翻 false 后先播退出动画再卸载
  const [isClosing, setIsClosing] = useState(false)
  const [mounted, setMounted] = useState(false)
  const closeAnimRef = useRef<gsap.core.Tween | null>(null)

  const isOpen = controlledOpen ?? internalOpen
  const setOpen = useCallback((v: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(v)
    onOpenChange?.(v)
  }, [controlledOpen, onOpenChange])

  const floating = useFloatingPosition(triggerRef, { maxHeight: 300, side, align }, isOpen || isClosing)

  // 挂载/卸载编排：open 翻 false → 先播退出动画再卸载（所有关闭路径统一）
  useEffect(() => {
    if (isOpen) {
      closeAnimRef.current?.kill()
      setMounted(true)
      setIsClosing(false)
      return
    }
    if (!mounted) return
    const { enabled, speed } = readAnimConfig()
    if (!enabled) {
      setMounted(false)
      return
    }
    setIsClosing(true)
    const el = contentRef.current
    if (!el) {
      setIsClosing(false)
      setMounted(false)
      return
    }
    closeAnimRef.current = gsap.to(el, {
      opacity: 0,
      scale: 0.94,
      y: -4,
      duration: 0.12 / speed,
      ease: EASE_OUT,
      ...withGpu({}),
      onComplete: () => {
        setIsClosing(false)
        setMounted(false)
      }
    })
  }, [isOpen])

  // 进入动画：DOM 挂载后执行
  useEffect(() => {
    if (!isOpen || isClosing || !contentRef.current) return
    const { enabled, speed } = readAnimConfig()
    if (!enabled) return
    gsap.fromTo(contentRef.current,
      { opacity: 0, scale: 0.94, y: -4 },
      { opacity: 1, scale: 1, y: 0, duration: 0.15 / speed, ease: EASE_IN, ...withGpu({}) }
    )
  }, [isOpen, isClosing, mounted])

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
      {(isOpen || isClosing) && createPortal(
        <div
          ref={contentRef}
          style={floating.style}
          className={cn(
            'rounded-lg border border-border/50 bg-popover p-1 shadow-xl',
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
