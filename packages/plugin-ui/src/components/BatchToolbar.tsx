// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
  // 水平居中相对内容区而非视口：--sidebar-w 由 Sidebar 按展开态写入
  // documentElement（收起 4rem / 展开 13rem）；left 动画时长与侧边栏
  // .sidebar-expand-transition 保持一致，切换时工具栏平滑跟随。
  // 回退值取 0：--sidebar-w 未定义时（组件被独立使用）不加偏移，保持视口居中。
  // 两条「减弱动效」路径各由一处负责，互不重叠：
  //   · host 的「界面动画」开关把 --anim-duration-multiplier 置 0，duration 的 calc 随之归零；
  //   · prefers-reduced-motion 用 Tailwind 的 motion-reduce 变体自足兜住 —— 本包不产出 CSS，
  //     不能依赖 host 的 .anim-transition 规则，否则独立消费者下该过渡仍会播放。
  return createPortal(
    <div className={cn('motion-reduce:transition-none fixed bottom-8 z-50 -translate-x-1/2 left-[calc(50%+var(--sidebar-w,0rem)/2)] transition-[left] duration-[calc(var(--anim-duration,150ms)*var(--anim-duration-multiplier,1))] ease-[cubic-bezier(0.16,1,0.3,1)]', className)}>
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