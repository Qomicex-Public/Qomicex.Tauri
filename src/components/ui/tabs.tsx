import { useRef, useEffect, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

export interface Tab {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
}

export function Tabs({ tabs, activeTab, onChange, className, orientation = 'horizontal' }: {
  tabs: Tab[]
  activeTab: string
  onChange: (id: string) => void
  className?: string
  orientation?: 'horizontal' | 'vertical'
}) {
  const indicatorRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map())

  useEffect(() => {
    const activeEl = tabsRef.current.get(activeTab)
    const indicator = indicatorRef.current
    if (activeEl && indicator) {
      indicator.style.top = `${activeEl.offsetTop}px`
      indicator.style.left = `${activeEl.offsetLeft}px`
      indicator.style.width = `${activeEl.offsetWidth}px`
      indicator.style.height = `${activeEl.offsetHeight}px`
    }
  }, [activeTab, tabs])

  return (
    <div className={cn(
      'relative flex gap-0.5',
      orientation === 'vertical' ? 'flex-col' : 'flex-row',
      className
    )}>
      <div
        ref={indicatorRef}
        className="absolute bg-primary/10 rounded-lg transition-all duration-200"
        style={{ top: 0, left: 0, width: 0, height: 0 }}
      />
      {tabs.map((tab) => (
          <button
            key={tab.id}
            disabled={tab.disabled}
            ref={(el) => { if (el) tabsRef.current.set(tab.id, el) }}
            onClick={() => onChange(tab.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left text-sm transition-all duration-200 relative z-10',
              activeTab === tab.id
                ? 'font-medium text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              tab.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground'
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
      ))}
    </div>
  )
}

export function TabContent({ activeTab, tabId, children, className }: {
  activeTab: string
  tabId: string
  children: ReactNode
  className?: string
}) {
  const prevRef = useRef(activeTab)
  const mountedRef = useRef(false)

  useEffect(() => {
    prevRef.current = activeTab
    if (!mountedRef.current) mountedRef.current = true
  }, [activeTab])

  const justMounted = !mountedRef.current

  if (activeTab !== tabId) return null

  return (
    <div className={cn(justMounted ? '' : 'animate-in slide-in-right', className)}>
      {children}
    </div>
  )
}
