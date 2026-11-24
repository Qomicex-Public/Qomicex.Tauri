// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils.ts'
import { readMotion } from '../lib/motion.ts'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

export interface ContextMenuProps {
  items: ContextMenuItem[]
  children: React.ReactNode
}

const MENU_MAX_H = 320
const EDGE_MARGIN = 8

export function ContextMenu({ items, children }: ContextMenuProps) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0, flipY: false })
  const menuRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | undefined>(undefined)

  const close = useCallback(() => {
    if (!open) return
    const motion = readMotion()
    if (!motion.enabled) {
      setOpen(false)
      return
    }
    // 先取消上一次的关闭定时器：连续两次外部点击会各排一个定时器，
    // 重开菜单时旧句柄已经丢失，会在新菜单上误触发关闭。
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
    }
    // 先播 120ms 退场再卸载：右键菜单此前是直接消失，与下拉/对话框手感不一致
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined
      setClosing(false)
      setOpen(false)
    }, 120 * motion.multiplier)
  }, [open])

  useEffect(() => () => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current)
  }, [])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
    }
    setClosing(false)
    const vh = window.innerHeight
    const flipY = e.clientY + MENU_MAX_H > vh && e.clientY - MENU_MAX_H > 0
    setPos({ x: e.clientX, y: e.clientY, flipY })
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, close])

  useEffect(() => {
    if (!open || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    let { x, y } = pos
    // 水平夹紧
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - EDGE_MARGIN
    if (x < EDGE_MARGIN) x = EDGE_MARGIN
    // 垂直：flipY 时从 y 向上展开，否则向下
    if (pos.flipY) {
      y = y - rect.height
    }
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - EDGE_MARGIN
    if (y < EDGE_MARGIN) y = EDGE_MARGIN
    menuRef.current.style.left = `${x}px`
    menuRef.current.style.top = `${y}px`
  }, [open, pos])

  return (
    <>
      <div onContextMenu={onContextMenu}>{children}</div>
      {(open || closing) && createPortal(
        <div
          ref={menuRef}
          className={cn(
            'fixed z-50 min-w-[160px] max-h-[min(320px,calc(100vh-16px))] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg',
            closing ? 'animate-zoom-fade-out pointer-events-none' : 'animate-zoom-fade-in'
          )}
          style={{ left: pos.x, top: pos.y }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => { item.onClick(); close() }}
              disabled={item.disabled}
              className={cn(
                'animate-zoom-fade-in flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                item.danger
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'text-popover-foreground hover:bg-accent',
                item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
              style={{ animationDelay: `${Math.min(i * 15, 120)}ms`, animationFillMode: 'both' }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
