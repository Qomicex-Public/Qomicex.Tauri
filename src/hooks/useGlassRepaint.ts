// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from 'react'

const REPAINT_CLASS = 'glass-repaint'

/**
 * 强制玻璃表面重新采样背景（WebView2/Chromium 的 backdrop-filter 首帧问题）。
 *
 * 症状：`.glass-surface` 首帧/动态插入时不显示 blur，鼠标移入触发一次重绘才恢复。
 * 这里把 `backdrop-filter` 临时设为 none 再恢复，强制合成器重建 backdrop 效果
 * ——等价于 hover 触发的那次重绘，但只在少数时机执行一次。
 */
function repaintGlass(): void {
  const root = document.documentElement
  // 默认材质本来就没有 blur，跳过。
  if ((root.dataset.material ?? 'default') === 'default') return
  root.classList.add(REPAINT_CLASS)
  // 读取布局强制样式重算；add/remove 在同一任务内完成，不会实际画出一帧无 blur 的状态。
  void document.body.offsetHeight
  root.classList.remove(REPAINT_CLASS)
}

/**
 * 在 Layout 调用：路由切换、背景媒体加载、玻璃表面动态插入、材质切换后
 * 各补一次重采样。不依赖具体页面的动画实现，覆盖所有页面的卡片。
 */
export function useGlassRepaint(routeKey: string): void {
  // 路由切换：入场动画期间（约 150-300ms）合成层在变，动画结束后再补一次。
  useEffect(() => {
    const first = window.setTimeout(repaintGlass, 0)
    const settled = window.setTimeout(repaintGlass, 450)
    return () => {
      clearTimeout(first)
      clearTimeout(settled)
    }
  }, [routeKey])

  useEffect(() => {
    let scheduled = 0
    const schedule = () => {
      if (scheduled) return
      scheduled = window.requestAnimationFrame(() => {
        scheduled = 0
        repaintGlass()
      })
    }

    // 背景图/视频异步加载完成后，已绘制的玻璃表面需要重新采样。
    const onMediaLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement || e.target instanceof HTMLVideoElement) schedule()
    }
    document.addEventListener('load', onMediaLoad, true)

    // 动态插入的卡片（搜索/加载更多/对话框）与材质切换。
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          schedule()
          return
        }
        for (const node of Array.from(mutation.addedNodes)) {
          if (
            node instanceof Element &&
            (node.matches('.glass-surface') || node.querySelector('.glass-surface'))
          ) {
            schedule()
            return
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-material'],
    })

    return () => {
      document.removeEventListener('load', onMediaLoad, true)
      observer.disconnect()
      if (scheduled) cancelAnimationFrame(scheduled)
    }
  }, [])
}
