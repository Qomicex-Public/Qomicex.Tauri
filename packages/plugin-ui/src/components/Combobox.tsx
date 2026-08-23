import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn.js'

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
  const [input, setInput] = useState(value)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setInput(value) }, [value])

  const filtered = useMemo(() => {
    if (!input) return options
    const q = input.toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, input])

  const close = useCallback(() => { setOpen(false) }, [])

  const commit = useCallback((v: string) => {
    onChange(v)
    setInput(v)
    close()
  }, [onChange, close])

  // 下拉经 portal 渲染到 body（fixed 定位）：液态玻璃材质下卡片容器带
  // overflow:hidden，absolute 弹层会被裁剪；portal 同时规避一切祖先裁剪。
  const updatePos = useCallback(() => {
    if (!inputRef.current) return
    const tr = inputRef.current.getBoundingClientRect()
    setPos({ top: tr.bottom + 4, left: tr.left, width: tr.width })
  }, [])

  const openPopup = useCallback(() => {
    updatePos()
    setOpen(true)
  }, [updatePos])

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (containerRef.current?.contains(e.target as Node)) return
      if (popupRef.current?.contains(e.target as Node)) return
      commit(input)
    }
    document.addEventListener('mousedown', handler)
    window.addEventListener('scroll', updatePos, true)
    window.addEventListener('resize', updatePos)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('scroll', updatePos, true)
      window.removeEventListener('resize', updatePos)
    }
  }, [open, commit, input, updatePos])

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={openPopup}
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
          onClick={() => { if (open) { commit(input) } else { openPopup(); inputRef.current?.focus() } }}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <svg className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      {open && createPortal(
        <div
          ref={popupRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: Math.max(pos.width, 180), zIndex: 9999 }}
          className="rounded-lg border border-border/50 bg-popover p-1 shadow-xl animate-in fade-in zoom-in-95"
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
