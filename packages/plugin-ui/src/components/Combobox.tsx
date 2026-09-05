import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn.js'
import gsap from 'gsap'
import { readAnimConfig, EASE_IN, EASE_OUT, withGpu } from '../lib/anim.js'
import { useFloatingPosition } from '../hooks/useFloatingPosition.js'

interface ComboboxProps {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  emptyText?: string
  className?: string
}

export function Combobox({ value, onChange, options, placeholder, emptyText = '', className }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [input, setInput] = useState(value)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const popupAnimRef = useRef<HTMLDivElement>(null)
  const closeAnimRef = useRef<gsap.core.Tween | null>(null)
  const floating = useFloatingPosition(inputRef, { maxHeight: 240 }, open || isClosing)

  useEffect(() => { setInput(value) }, [value])

  const filtered = useMemo(() => {
    if (!input) return options
    const q = input.toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, input])

  const close = useCallback(() => {
    // 防重入：退出动画进行中再次 close 直接忽略
    if (closeAnimRef.current) return

    const popup = popupAnimRef.current
    const { enabled, speed } = readAnimConfig()
    if (!popup || !enabled) {
      setOpen(false)
      return
    }

    setIsClosing(true)

    const duration = 0.12 / speed
    closeAnimRef.current = gsap.to(popup, {
      opacity: 0,
      scale: 0.94,
      y: -4,
      duration,
      ease: EASE_OUT,
      ...withGpu({}),
      onComplete: () => {
        closeAnimRef.current = null
        setIsClosing(false)
        setOpen(false)
      }
    })
  }, [])

  const commit = useCallback((v: string) => {
    onChange(v)
    setInput(v)
    close()
  }, [onChange, close])

  // 重开（退出动画中重新聚焦）：终止退出动画并播进入动画
  const reopen = useCallback(() => {
    if (closeAnimRef.current) {
      closeAnimRef.current.kill()
      closeAnimRef.current = null
    }
    setIsClosing(false)
    setOpen(true)
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (containerRef.current?.contains(e.target as Node)) return
      if (popupRef.current?.contains(e.target as Node)) return
      commit(input)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, commit, input])

  // GSAP 弹出动画
  useEffect(() => {
    if (!open || isClosing || !popupAnimRef.current) return

    const { enabled, speed } = readAnimConfig()
    if (!enabled) return

    const duration = 0.15 / speed

    gsap.fromTo(popupAnimRef.current,
      { opacity: 0, scale: 0.94, y: -4 },
      {
        opacity: 1,
        scale: 1,
        y: 0,
        duration,
        ease: EASE_IN,
        ...withGpu({})
      }
    )
  }, [open, isClosing])

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => { if (!open) reopen() }}
          onBlur={() => commit(input)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { close(); inputRef.current?.blur() }
            if (e.key === 'Enter') { if (filtered.length > 0) commit(filtered[0].value); else commit(input); inputRef.current?.blur() }
          }}
          placeholder={placeholder}
          className={cn(
            'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pr-8 text-sm shadow-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'placeholder:text-muted-foreground'
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => { if (open) { commit(input) } else { reopen() } }}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <svg className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      {(open || isClosing) && createPortal(
        <div
          ref={(el) => {
            popupRef.current = el
            popupAnimRef.current = el
          }}
          style={floating.style}
          className="rounded-lg border border-border/50 bg-popover p-1 shadow-xl"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="max-h-60 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">{emptyText}</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onMouseDown={() => commit(opt.value)}
                  className={cn(
                    'flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors',
                    opt.value === value ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-accent'
                  )}
                >
                  {opt.label}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
