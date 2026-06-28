import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { cn } from '../../lib/utils.ts'

interface ComboboxProps {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  className?: string
}

export function Combobox({ value, onChange, options, placeholder, className }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState(value)
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

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (containerRef.current?.contains(e.target as Node)) return
      commit(input)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, commit, input])

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setOpen(true)}
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
          onClick={() => { if (open) { commit(input) } else { setOpen(true); inputRef.current?.focus() } }}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <FontAwesomeIcon icon={faChevronDown} className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div
          ref={popupRef}
          className="absolute left-0 top-full z-50 mt-1 w-full min-w-[180px] rounded-lg border border-border/50 bg-popover/90 backdrop-blur-lg p-1 shadow-xl animate-in fade-in zoom-in-95"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="max-h-60 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">无匹配</div>
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
        </div>
      )}
    </div>
  )
}
