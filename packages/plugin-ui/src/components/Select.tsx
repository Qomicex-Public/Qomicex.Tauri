import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn.js'
import gsap from 'gsap'

interface SelectOptionProps {
  value: string
  children: React.ReactNode
  disabled?: boolean
}

export function SelectOption({ children }: SelectOptionProps) {
  return <>{children}</>
}

export function SelectDivider() {
  return null
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
  className?: string
  placeholder?: string
  disabled?: boolean
}

export function Select({ value, onChange, children, className, placeholder, disabled }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const [search, setSearch] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const popupAnimRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef<() => void>(() => {})

  const options: { value: string; label: string; disabled: boolean; isDivider: boolean }[] = []
  let selectedLabel = placeholder || ''

  function collect(el: React.ReactNode) {
    React.Children.forEach(el, (child) => {
      if (!React.isValidElement(child)) return
      const p = child.props as Record<string, unknown>
      if (child.type === React.Fragment) {
        collect(p.children as React.ReactNode)
      } else if (child.type === SelectDivider) {
        options.push({ value: '', label: '', disabled: true, isDivider: true })
      } else if (child.type === SelectOption) {
        const label = React.Children.toArray(p.children as React.ReactNode).join('')
        options.push({ value: String(p.value), label, disabled: !!p.disabled, isDivider: false })
        if (String(p.value) === value && !p.disabled) {
          selectedLabel = label
        }
      }
    })
  }
  collect(children)

  const close = useCallback(() => {
    const popup = popupAnimRef.current
    if (!popup) {
      setOpen(false)
      setSearch('')
      return
    }

    // 检查动画是否启用
    const animEnabled = document.documentElement.getAttribute('data-anim-enabled') !== 'false'
    if (!animEnabled) {
      setOpen(false)
      setSearch('')
      return
    }

    setIsClosing(true)

    const speedStr = getComputedStyle(document.documentElement).getPropertyValue('--anim-duration-multiplier')
    const speed = speedStr ? parseFloat(speedStr) : 1
    const duration = 0.1 / (speed || 1)

    gsap.to(popup, {
      opacity: 0,
      scale: 0.9,
      y: -4,
      duration,
      ease: 'power2.in',
      onComplete: () => {
        setIsClosing(false)
        setOpen(false)
        setSearch('')
      }
    })
  }, [])

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (triggerRef.current?.contains(e.target as Node)) return
    if (popupRef.current?.contains(e.target as Node)) return
    close()
  }, [close])

  useEffect(() => {
    if (!open) return
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, handleClickOutside])

  useEffect(() => {
    if (!open) return
    function reposition() {
      if (!triggerRef.current) return
      const tr = triggerRef.current.getBoundingClientRect()
      setPos({ top: tr.bottom + 4, left: tr.left, width: tr.width })
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  // GSAP 弹出动画
  useEffect(() => {
    if (!open || !popupAnimRef.current) return

    const animEnabled = document.documentElement.getAttribute('data-anim-enabled') !== 'false'
    if (!animEnabled) return

    const speedStr = getComputedStyle(document.documentElement).getPropertyValue('--anim-duration-multiplier')
    const speed = speedStr ? parseFloat(speedStr) : 1
    const duration = 0.15 / (speed || 1)

    gsap.fromTo(popupAnimRef.current,
      { opacity: 0, scale: 0.9, y: -4 },
      {
        opacity: 1,
        scale: 1,
        y: 0,
        duration,
        ease: 'power2.out'
      }
    )
  }, [open])

  function openPopup() {
    if (!triggerRef.current) return
    const tr = triggerRef.current.getBoundingClientRect()
    setPos({ top: tr.bottom + 4, left: tr.left, width: tr.width })
    setOpen(true)
    requestAnimationFrame(() => searchRef.current?.focus())
  }

  const handleSelect = (optValue: string) => {
    onChange(optValue)
    close()
    triggerRef.current?.focus()
  }

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => open ? close() : openPopup()}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-1 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'ring-1 ring-ring',
          !value && 'text-muted-foreground'
        )}
      >
        <span className="truncate">{selectedLabel}</span>
        <svg className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>

      {(open || isClosing) && createPortal(
        <div
          ref={(el) => {
            popupRef.current = el
            popupAnimRef.current = el
          }}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: Math.max(pos.width, 180), zIndex: 9999 }}
          className="rounded-lg border border-border/50 bg-popover p-1 shadow-xl"
        >
          <div className="max-h-72 overflow-y-auto">
            {options.length > 6 && (
              <div className="relative mb-1">
                <svg className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder=""
                  className="h-8 w-full rounded-md border-0 bg-muted pl-7 pr-2 text-xs text-foreground outline-none ring-1 ring-inset ring-border focus:ring-primary"
                />
              </div>
            )}
            {(() => {
              const filtered = options.filter((o) => o.isDivider || !search || o.label.toLowerCase().includes(search.toLowerCase()))
              return filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground" />
              ) : (
                filtered.map((opt, i) =>
                  opt.isDivider ? (
                    <div key={`div-${i}`} className="my-1 border-t border-border" />
                  ) : (
                      <button
                          key={opt.value}
                          type="button"
                          disabled={opt.disabled}
                          onClick={() => !opt.disabled && handleSelect(opt.value)}
                          className={cn(
                            'flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors',
                            opt.disabled
                              ? 'cursor-not-allowed text-muted-foreground/50'
                              : opt.value === value
                                ? 'bg-primary/10 text-primary font-medium'
                                : 'text-foreground hover:bg-accent'
                          )}
                        >
                          {opt.label}
                        </button>
                  )
                )
              )
            })()}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
