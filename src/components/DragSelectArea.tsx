import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface BoxRect {
  left: number
  top: number
  width: number
  height: number
}

/** 判定为「拖动」的最小位移（像素）：小于该值视为点击，放行卡片 onClick */
const DRAG_THRESHOLD = 5
/** 边缘自动滚动触发区高度（像素） */
const EDGE_SCROLL_ZONE = 40
/** 边缘滚动速度系数 */
const EDGE_SCROLL_FACTOR = 0.6

function intersects(a: { left: number; top: number; right: number; bottom: number }, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** 最近的垂直滚动祖先（找不到则用页面滚动元素） */
function getScrollParent(el: HTMLElement | null): HTMLElement {
  let node = el?.parentElement ?? null
  while (node) {
    const style = getComputedStyle(node)
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement
}

/**
 * 拖动框选容器：按住左键（任意位置，含卡片上）拖动拉出选择框，松开后选中框内所有
 * `[data-select-item]` 元素（data-select-item 值为条目 key）。
 * - 位移 < DRAG_THRESHOLD 视为点击，不拦截卡片自身 onClick
 * - Shift 拖动 → 追加到现有选择；普通拖动 → 替换选择
 * - 拖动到容器上下边缘自动滚动列表
 * - 按钮/输入框上按下不启动框选
 */
export default function DragSelectArea({ children, onSelect }: {
  children: ReactNode
  onSelect: (names: string[], mode: 'replace' | 'add') => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const draggingRef = useRef(false)
  const [box, setBox] = useState<BoxRect | null>(null)

  const stop = useCallback(() => {
    startRef.current = null
    draggingRef.current = false
    setBox(null)
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, textarea, [role="button"]')) return
    startRef.current = { x: e.clientX, y: e.clientY }
    draggingRef.current = false
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!startRef.current) return
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    // 位移未达阈值：视为点击，放行卡片 onClick
    if (!draggingRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!draggingRef.current) {
      draggingRef.current = true
      // 阻止拖动期间的文本选择
      e.preventDefault()
    }
    const container = containerRef.current!
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const sx = startRef.current.x - rect.left
    const sy = startRef.current.y - rect.top
    setBox({
      left: Math.min(sx, x),
      top: Math.min(sy, y),
      width: Math.abs(x - sx),
      height: Math.abs(y - sy),
    })

    // 边缘自动滚动（拖动到容器顶部/底部触发区时滚动最近的滚动祖先）
    const scroller = getScrollParent(container)
    const sRect = scroller.getBoundingClientRect()
    if (e.clientY < sRect.top + EDGE_SCROLL_ZONE) {
      scroller.scrollTop -= (sRect.top + EDGE_SCROLL_ZONE - e.clientY) * EDGE_SCROLL_FACTOR
    } else if (e.clientY > sRect.bottom - EDGE_SCROLL_ZONE) {
      scroller.scrollTop += (e.clientY - (sRect.bottom - EDGE_SCROLL_ZONE)) * EDGE_SCROLL_FACTOR
    }
  }, [])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!startRef.current) return
    // 未达拖动阈值 = 点击：清状态放行 click
    if (!draggingRef.current) {
      stop()
      return
    }
    const container = containerRef.current!
    const cRect = container.getBoundingClientRect()
    const sel = box ?? { left: 0, top: 0, width: 0, height: 0 }
    const area = {
      left: cRect.left + sel.left,
      top: cRect.top + sel.top,
      right: cRect.left + sel.left + sel.width,
      bottom: cRect.top + sel.top + sel.height,
    }
    const names: string[] = []
    container.querySelectorAll<HTMLElement>('[data-select-item]').forEach(el => {
      if (intersects(area, el.getBoundingClientRect())) {
        const key = el.dataset.selectItem
        if (key) names.push(key)
      }
    })
    if (names.length > 0) onSelect(names, e.shiftKey ? 'add' : 'replace')
    stop()
    // 保持 draggingRef=true 到 click 捕获阶段，拦截被框选卡片的 onClick
    draggingRef.current = true
  }, [box, onSelect, stop])

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (draggingRef.current) {
      e.stopPropagation()
      e.preventDefault()
      draggingRef.current = false
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="relative select-none"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={stop}
      onClickCapture={onClickCapture}
    >
      {children}
      {box && (
        <div
          className="pointer-events-none absolute z-10 rounded-sm border border-primary/70 bg-primary/10"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </div>
  )
}
