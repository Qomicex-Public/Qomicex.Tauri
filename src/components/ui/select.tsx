import React, { useState, useRef, useEffect, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronDown, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { cn } from '../../lib/utils.ts'

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
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const [search, setSearch] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const options: { value: string; label: string; disabled: boolean; isDivider: boolean }[] = []
  let selectedLabel = placeholder || '选择...'

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

  const close = useCallback(() => { setOpen(false); setSearch('') }, [])

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
      if (!triggerRef.current || !containerRef.current) return
      const tr = triggerRef.current.getBoundingClientRect()
      const cr = containerRef.current.getBoundingClientRect()
      setPos({ top: tr.bottom - cr.top, left: tr.left - cr.left, width: tr.width })
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  function openPopup() {
    if (!triggerRef.current || !containerRef.current) return
    const tr = triggerRef.current.getBoundingClientRect()
    const cr = containerRef.current.getBoundingClientRect()
    setPos({ top: tr.bottom - cr.top + 4, left: tr.left - cr.left, width: tr.width })
    setOpen(true)
    requestAnimationFrame(() => searchRef.current?.focus())
  }

  const handleSelect = (optValue: string) => {
    onChange(optValue)
    close()
    triggerRef.current?.focus()
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
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
        <span className="truncate">{value ? selectedLabel : placeholder || '选择...'}</span>
        <FontAwesomeIcon icon={faChevronDown} className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          ref={popupRef}
          style={{ position: 'absolute', top: pos.top, left: pos.left, width: Math.max(pos.width, 180) }}
          className="z-50 rounded-lg border border-border/50 bg-popover/90 backdrop-blur-lg p-1 shadow-xl animate-in fade-in zoom-in-95"
        >
          <div className="max-h-72 overflow-y-auto">
            {options.length > 6 && (
              <div className="relative mb-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索..."
                  className="h-8 w-full rounded-md border-0 bg-muted pl-7 pr-2 text-xs text-foreground outline-none ring-1 ring-inset ring-border focus:ring-primary"
                />
              </div>
            )}
            {(() => {
              const filtered = options.filter((o) => o.isDivider || !search || o.label.toLowerCase().includes(search.toLowerCase()))
              return filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">无匹配</div>
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
        </div>
      )}
    </div>
  )
}
