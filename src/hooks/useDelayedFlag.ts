// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'

/**
 * 延迟显示 + 最短停留。
 *
 * 用于骨架屏：
 * - `delayMs` 内结束的加载不显示骨架（避免闪一下）
 * - 一旦显示，至少保留 `minVisibleMs`，避免「刚出现就消失」的抖动
 */
export function useDelayedFlag(active: boolean, delayMs = 400, minVisibleMs = 300): boolean {
  const [visible, setVisible] = useState(false)
  const visibleRef = useRef(false)
  const shownAtRef = useRef(0)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }

    if (active) {
      if (visibleRef.current) return
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined
        visibleRef.current = true
        shownAtRef.current = performance.now()
        setVisible(true)
      }, delayMs)
    } else if (visibleRef.current) {
      const remain = Math.max(0, minVisibleMs - (performance.now() - shownAtRef.current))
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined
        visibleRef.current = false
        setVisible(false)
      }, remain)
    }

    return () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
  }, [active, delayMs, minVisibleMs])

  return visible
}
