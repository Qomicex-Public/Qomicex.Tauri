import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "../lib/cn.js"
import gsap from "gsap"
import { readAnimConfig, EASE_IN, EASE_OUT, withGpu } from "../lib/anim.js"

interface DialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  className?: string
  closeOnBackdrop?: boolean
  closeOnEsc?: boolean
}

function Dialog({ open, onClose, children, className, closeOnBackdrop = true, closeOnEsc = true }: DialogProps) {
  const backdropRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  // 是否正处于"open=false 但还在播退出动画"状态；动画结束才真正卸载
  const [isClosing, setIsClosing] = React.useState(false)
  // open 一直为 false 时不渲染任何东西
  const [mounted, setMounted] = React.useState(open)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose
  const closeTimerRef = React.useRef<gsap.core.Tween | null>(null)

  React.useEffect(() => {
    if (!open || !closeOnEsc) return
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, closeOnEsc])

  // 挂载/卸载编排：open 翻 true → 挂载；open 翻 false → 先播退出动画再卸载
  React.useEffect(() => {
    if (open) {
      // 快速关闭又重开：取消未完的退出动画，恢复可见
      closeTimerRef.current?.kill()
      setMounted(true)
      setIsClosing(false)
    } else {
      // 所有关闭路径（按钮/Esc/backdrop/调用方 setState）都走这里，统一有退出动画
      const { enabled, speed } = readAnimConfig()
      if (!mounted || !enabled) {
        setMounted(false)
        return
      }
      setIsClosing(true)
      const backdrop = backdropRef.current
      const content = contentRef.current
      const duration = 0.15 / speed
      if (backdrop) {
        gsap.to(backdrop, { opacity: 0, duration, ease: EASE_OUT })
      }
      if (content) {
        closeTimerRef.current = gsap.to(content, {
          opacity: 0,
          scale: 0.95,
          y: 8,
          duration,
          ease: EASE_OUT,
          ...withGpu({}),
          onComplete: () => {
            setIsClosing(false)
            setMounted(false)
          },
        })
      } else {
        setIsClosing(false)
        setMounted(false)
        return
      }
    }
  }, [open])

  // 进入动画：DOM 挂载后执行（refs 已就绪），修复常驻 Dialog 首开无动画
  React.useLayoutEffect(() => {
    if (!open || isClosing || !mounted) return
    const backdrop = backdropRef.current
    const content = contentRef.current
    if (!backdrop || !content) return

    const { enabled, speed } = readAnimConfig()
    if (!enabled) return

    const duration = 0.2 / speed
    gsap.fromTo(
      backdrop,
      { opacity: 0 },
      { opacity: 1, duration, ease: EASE_IN }
    )
    gsap.fromTo(
      content,
      { opacity: 0, scale: 0.95, y: 8 },
      { opacity: 1, scale: 1, y: 0, duration, ease: EASE_IN, ...withGpu({}) }
    )
  }, [mounted, isClosing])

  const handleClose = React.useCallback(() => {
    onCloseRef.current()
  }, [])

  if (!mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        ref={backdropRef}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={closeOnBackdrop ? handleClose : undefined}
      />
      <div
        ref={contentRef}
        className={cn(
          "relative z-10 w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border bg-popover/90 backdrop-blur-lg p-0 shadow-2xl glass-surface",
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}

interface DialogHeaderProps {
  children: React.ReactNode
  className?: string
  onClose?: () => void
}

function DialogHeader({ children, className, onClose }: DialogHeaderProps) {
  return (
    <div data-tauri-drag-region className={cn("flex items-center justify-between border-b border-border px-6 py-4", className)}>
      <div className="flex-1">{children}</div>
      {onClose && (
        <button onClick={onClose} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-base font-semibold leading-none tracking-tight", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 py-4", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 border-t border-border px-6 py-4", className)} {...props} />
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter }
