import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "../../lib/utils.ts"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faXmark } from "@fortawesome/free-solid-svg-icons"

interface DialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  className?: string
  closeOnBackdrop?: boolean
  closeOnEsc?: boolean
}

function Dialog({ open, onClose, children, className, closeOnBackdrop = true, closeOnEsc = true }: DialogProps) {
  React.useEffect(() => {
    if (!open || !closeOnEsc) return
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, closeOnEsc, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        className={cn(
          "relative z-10 w-full max-w-lg rounded-xl border bg-popover p-0 shadow-2xl animate-in zoom-in-95",
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
    <div className={cn("flex items-center justify-between border-b border-border px-6 py-4", className)}>
      <div className="flex-1">{children}</div>
      {onClose && (
        <button onClick={onClose} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
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
