import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn.js'

const defaultMessages = { selected: '{count} selected', selectAll: 'Select all', clear: 'Clear selection' }

export function BatchToolbar({ selectedCount, onClear, onSelectAll, children, className, messages = defaultMessages }: {
  selectedCount: number
  onClear: () => void
  onSelectAll?: () => void
  children?: ReactNode
  className?: string
  messages?: { selected: string; selectAll: string; clear: string }
}) {
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [animKey, setAnimKey] = useState(0)

  useEffect(() => {
    if (selectedCount > 0) {
      if (!visible) setVisible(true)
      setAnimKey(k => k + 1)
      setExiting(false)
    } else if (visible) {
      setExiting(true)
      const timer = setTimeout(() => {
        setVisible(false)
        setExiting(false)
      }, 200)
      return () => clearTimeout(timer)
    }
  }, [selectedCount])

  if (!visible && selectedCount === 0) return null

  // Portal 到 body：fixed 悬浮层不依赖祖先链。祖先若带 transform/filter/
  // will-change/contain 会劫持 fixed 的 containing block（如实例详情 tab 滚动
  // 容器的 translateZ(0)），导致工具栏随列表滚动而离开视口。
  return createPortal(
    <div className={cn('fixed bottom-8 left-1/2 z-50 -translate-x-1/2', className)}>
      <div
        key={exiting ? undefined : animKey}
        className={cn(
          'flex items-center gap-3 rounded-xl border bg-card px-5 py-3 shadow-lg shadow-black/10',
          exiting ? 'pop-out' : 'pop-in',
        )}
        onAnimationEnd={() => exiting && setVisible(false)}
      >
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {messages.selected.replace('{count}', String(selectedCount))}
        </span>
        <div className="h-5 w-px bg-border" />
        {onSelectAll && (
          <button
            onClick={onSelectAll}
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {messages.selectAll}
          </button>
        )}
        <button
          onClick={onClear}
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {messages.clear}
        </button>
        {children}
      </div>
    </div>,
    document.body,
  )
}