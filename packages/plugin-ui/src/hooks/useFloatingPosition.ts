import { useState, useRef, useEffect, useCallback, type RefObject, type CSSProperties } from 'react'

interface FloatingOptions {
  maxHeight?: number
  margin?: number
  side?: 'bottom' | 'top'
  align?: 'start' | 'end'
  triggerWidth?: number
}

interface FloatingResult {
  style: CSSProperties
  resolvedSide: 'bottom' | 'top'
}

export function useFloatingPosition<T extends HTMLElement>(
  triggerRef: RefObject<T | null>,
  options: FloatingOptions = {},
  enabled = true
): FloatingResult {
  const { maxHeight = 300, margin = 4, side, align = 'start' } = options
  const [state, setState] = useState<FloatingResult>({
    style: { position: 'fixed' },
    resolvedSide: side ?? 'bottom',
  })

  const update = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const tr = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    // 垂直碰撞检测
    const spaceBelow = vh - tr.bottom - margin
    const spaceAbove = tr.top - margin
    let resolvedSide = side ?? 'bottom'
    if (side === undefined) {
      if (spaceBelow < maxHeight && spaceAbove > spaceBelow) {
        resolvedSide = 'top'
      }
    }

    const availableH = resolvedSide === 'top'
      ? Math.min(spaceAbove, maxHeight)
      : Math.min(spaceBelow, maxHeight)

    let top: number
    if (resolvedSide === 'top') {
      top = tr.top - margin
    } else {
      top = tr.bottom + margin
    }

    // 水平碰撞检测
    const ddWidth = Math.max(tr.width, 180)
    let left: number
    if (align === 'end') {
      left = tr.right - ddWidth
    } else {
      left = tr.left
    }
    if (left + ddWidth > vw - 8) left = Math.max(8, vw - ddWidth - 8)
    if (left < 8) left = 8

    const style: CSSProperties = {
      position: 'fixed',
      left,
      width: ddWidth,
      maxWidth: `calc(100vw - 16px)`,
      zIndex: 9999,
    }

    if (resolvedSide === 'top') {
      style.bottom = vh - top
    } else {
      style.top = top
    }

    setState({ style, resolvedSide })
  }, [triggerRef, maxHeight, margin, side, align])

  useEffect(() => {
    if (!enabled) return
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [enabled, update])

  return state
}

/** Tooltip 专用：从鼠标位置/元素边缘定位，4 方向碰撞检测 */
export function useTooltipPosition(
  triggerRef: RefObject<HTMLElement | null>,
  side: 'top' | 'bottom' | 'left' | 'right' = 'top',
  enabled = true
): { style: CSSProperties; resolvedSide: typeof side } {
  const [state, setState] = useState<{ style: CSSProperties; resolvedSide: typeof side }>({
    style: { position: 'fixed' },
    resolvedSide: side,
  })

  const update = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const tr = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const GAP = 8

    let resolved = side
    const spaceAbove = tr.top - GAP
    const spaceBelow = vh - tr.bottom - GAP
    const spaceLeft = tr.left - GAP
    const spaceRight = vw - tr.right - GAP

    // 空间不足时翻转
    if (side === 'top' && spaceAbove < 30) resolved = 'bottom'
    else if (side === 'bottom' && spaceBelow < 30) resolved = 'top'
    else if (side === 'left' && spaceLeft < 60) resolved = 'right'
    else if (side === 'right' && spaceRight < 60) resolved = 'left'

    let top: number, left: number
    if (resolved === 'top') {
      top = tr.top - GAP
      left = tr.left + tr.width / 2
    } else if (resolved === 'bottom') {
      top = tr.bottom + GAP
      left = tr.left + tr.width / 2
    } else if (resolved === 'left') {
      top = tr.top + tr.height / 2
      left = tr.left - GAP
    } else {
      top = tr.top + tr.height / 2
      left = tr.right + GAP
    }

    const style: CSSProperties = { position: 'fixed', zIndex: 9999, top, left }

    // 水平/垂直夹紧
    if (resolved === 'top' || resolved === 'bottom') {
      style.left = Math.max(8, Math.min(left, vw - 8))
      if (resolved === 'top') style.transform = 'translateX(-50%)'
      else style.transform = 'translateX(-50%)'
    } else {
      style.top = Math.max(8, Math.min(top, vh - 8))
      if (resolved === 'left') style.transform = 'translateY(-50%)'
      else style.transform = 'translateY(-50%)'
    }

    setState({ style, resolvedSide: resolved })
  }, [triggerRef, side])

  useEffect(() => {
    if (!enabled) return
    update()
  }, [enabled, update])

  return state
}
