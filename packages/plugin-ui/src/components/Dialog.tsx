import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "../lib/cn.js"
import gsap from "gsap"

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
  const [isVisible, setIsVisible] = React.useState(open)
  const [isAnimating, setIsAnimating] = React.useState(false)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  React.useEffect(() => {
    if (!open || !closeOnEsc) return
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, closeOnEsc])

  // GSAP 进入动画
  React.useEffect(() => {
    if (!open) return

    const backdrop = backdropRef.current
    const content = contentRef.current
    if (!backdrop || !content) return

    // 检查动画是否启用
    const animEnabled = document.documentElement.getAttribute('data-anim-enabled') !== 'false'
    if (!animEnabled) return

    const speedStr = getComputedStyle(document.documentElement).getPropertyValue('--anim-duration-multiplier')
    const speed = speedStr ? parseFloat(speedStr) : 1
    const duration = 0.2 / (speed || 1)

    gsap.fromTo(backdrop,
      { opacity: 0 },
      { opacity: 1, duration, ease: 'power2.out' }
    )

    gsap.fromTo(content,
      { opacity: 0, scale: 0.95, y: 8 },
      {
        opacity: 1,
        scale: 1,
        y: 0,
        duration,
        ease: 'power2.out'
      }
    )
  }, [open])

  // 处理关闭动画
  const handleClose = React.useCallback(() => {
    const backdrop = backdropRef.current
    const content = contentRef.current

    // 检查动画是否启用
    const animEnabled = document.documentElement.getAttribute('data-anim-enabled') !== 'false'
    if (!animEnabled || !backdrop || !content) {
      onCloseRef.current()
      return
    }

    setIsAnimating(true)

    const speedStr = getComputedStyle(document.documentElement).getPropertyValue('--anim-duration-multiplier')
    const speed = speedStr ? parseFloat(speedStr) : 1
    const duration = 0.15 / (speed || 1)

    gsap.to(backdrop, {
      opacity: 0,
      duration,
      ease: 'power2.in'
    })

    gsap.to(content, {
      opacity: 0,
      scale: 0.95,
      y: 8,
      duration,
      ease: 'power2.in',
      onComplete: () => {
        setIsAnimating(false)
        onCloseRef.current()
      }
    })
  }, [])

  // 同步 open 状态到 isVisible
  React.useEffect(() => {
    if (open) {
      setIsVisible(true)
    } else if (!isAnimating) {
      // 关闭动画完成后才隐藏
      setIsVisible(false)
    }
  }, [open, isAnimating])

  if (!isVisible) return null

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
