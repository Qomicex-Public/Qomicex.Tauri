import { useRef, useEffect, Fragment, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'

export interface Tab {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  /** 右侧计数（如筛选结果数量）。仅在有值时渲染。 */
  count?: number
  /**
   * 分组名。与上一个 tab 的分组不同时，在本 tab 之前渲染分组标题。
   * 仅 `orientation="vertical"` 生效（横向栏用分组会挤成两行）。
   */
  group?: string
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
  const vertical = orientation === 'vertical'

  useEffect(() => {
    const activeEl = tabsRef.current.get(activeTab)
    const indicator = indicatorRef.current
    if (activeEl && indicator) {
      // offsetTop/Left 相对 offsetParent（本容器，已 relative），故竖排/横排共用；
      // 分组标题会推低后续按钮，offsetTop 自动包含该偏移。
      indicator.style.top = `${activeEl.offsetTop}px`
      indicator.style.left = `${activeEl.offsetLeft}px`
      indicator.style.width = `${activeEl.offsetWidth}px`
      indicator.style.height = `${activeEl.offsetHeight}px`
    }
  }, [activeTab, tabs])

  return (
    <div className={cn(
      'relative flex gap-0.5',
      vertical ? 'flex-col' : 'flex-row',
      className
    )}>
      <div
        ref={indicatorRef}
        className="absolute bg-primary/10 rounded-lg transition-all duration-200"
        style={{ top: 0, left: 0, width: 0, height: 0 }}
      />
      {tabs.map((tab, i) => {
        // 竖排且分组名变化时插入分组标题（首个分组用 pt-0，避免顶部多余留白）
        const showGroup = vertical && !!tab.group && tab.group !== tabs[i - 1]?.group
        const isActive = activeTab === tab.id
        return (
          <Fragment key={tab.id}>
            {showGroup && (
              <div className={cn(
                'px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/60',
                i === 0 ? 'pt-0' : 'pt-3'
              )}>
                {tab.group}
              </div>
            )}
            <button
              disabled={tab.disabled}
              ref={(el) => { if (el) tabsRef.current.set(tab.id, el) }}
              onClick={() => onChange(tab.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left text-sm transition-all duration-200 relative z-10',
                isActive
                  ? 'font-medium text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                tab.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground'
              )}
            >
              {tab.icon}
              {tab.label}
              {typeof tab.count === 'number' && (
                <span className={cn(
                  'text-xs tabular-nums',
                  isActive ? 'text-primary/70' : 'text-muted-foreground/60'
                )}>
                  {tab.count}
                </span>
              )}
            </button>
          </Fragment>
        )
      })}
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
    <div className={cn(justMounted ? '' : 'animate-slide-in-right', className)}>
      {children}
    </div>
  )
}
