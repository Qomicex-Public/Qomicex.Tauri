// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import gsap from 'gsap'
import { cn } from '../lib/utils.ts'
import { containsGlass, gpuVars, readMotion, sec } from '../lib/motion.ts'
import { queueGlassRepaint } from '../hooks/useGlassRepaint.ts'

/** 一块入场动画的最大数量（超出直接落终态，避免长页面掉帧） */
const MAX_REVEAL_BLOCKS = 8
/** 块间错位，封顶 200ms */
const STAGGER_MS = 25
const STAGGER_CAP_MS = 200

interface PageShellProps {
  children: ReactNode
  className?: string
}

/**
 * 页面根容器：独占页面入场动画。
 *
 * 子元素用 `data-reveal="1|2|3"` 标记参与分层的区块：
 * - 1 / 2：位移 + 淡入（仅限不含玻璃的区块）
 * - 3：只淡入（含玻璃的区块、正文）
 * 未标记时整页只做 opacity 淡入（不动 transform：滚动容器的 transform 会
 * 改变 sticky/fixed 的参照系）。
 *
 * 两层页面入场（Layout + PageShell + usePageAnimation 各播一次）已在本批
 * 收敛到此一处；动画结束清理内联样式并补一次玻璃重采样（issue #327）。
 */
export function PageShell({ children, className }: PageShellProps) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return

    const m = readMotion()
    if (!m.enabled) return

    // 目标发现：顶层块按 DOM 顺序参与；标了 data-reveal 的用自身的 level，
    // 其余块按 level 3（只淡入）兜底。这样页面不必逐个加标记也有分层，
    // 同时含玻璃的块不会被位移。
    const rootChildren = Array.from(root.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    )
    const targets: { el: HTMLElement; level: number }[] = []
    for (const child of rootChildren) {
      // 含 SettingSection 的区块交给各 section 自己错开：外层再淡一次会让所有
      // 玻璃卡片逐帧重采样 backdrop，正好和侧栏导航动画抢帧（表现为导航卡顿）。
      if (child.querySelector('[data-setting-section]')) continue
      const marked = child.matches('[data-reveal]')
        ? [child]
        : Array.from(child.querySelectorAll<HTMLElement>('[data-reveal]'))
      if (marked.length > 0) {
        marked.forEach((el) => targets.push({ el, level: Number(el.dataset.reveal ?? 3) }))
      } else {
        targets.push({ el: child, level: 3 })
      }
    }
    if (targets.length === 0) targets.push({ el: root, level: 3 })

    const items = targets.slice(0, MAX_REVEAL_BLOCKS)
    if (items.length === 0) return

    const tl = gsap.timeline({
      onComplete: () => {
        gsap.set(items.map((item) => item.el), { clearProps: 'transform,opacity' })
        queueGlassRepaint()
      },
    })

    items.forEach(({ el, level }, i) => {
      const delay = Math.min(i * STAGGER_MS, STAGGER_CAP_MS) / 1000 * m.multiplier
      const canMove = level <= 2 && !containsGlass(el)

      if (!canMove) {
        tl.fromTo(el,
          { opacity: 0 },
          { opacity: 1, duration: sec(180, m), ease: 'power2.out' },
          delay)

        // 玻璃块不能整体位移，退一步让「卡片内容」上滑：卡片淡入 + 文字/图标位移，
        // 既有层次感，又不会打断 backdrop 采样。
        const glassCards = (el.matches('.glass-surface')
          ? [el]
          : Array.from(el.querySelectorAll<HTMLElement>('.glass-surface'))).slice(0, 3)
        const contents = glassCards.flatMap((card) =>
          Array.from(card.children)
            .filter((child): child is HTMLElement => child instanceof HTMLElement && !containsGlass(child))
            .slice(0, 3),
        )
        // SettingSection 自带逐块错开，块级这里不再重复推内容
        const handledBySections = !!el.querySelector('[data-setting-section]')
        if (contents.length > 0 && !handledBySections) {
          tl.fromTo(contents,
            { y: 12 },
            {
              y: 0,
              duration: sec(280, m),
              stagger: sec(15, m),
              ease: 'power3.out',
              ...gpuVars(m),
              onComplete: () => gsap.set(contents, { clearProps: 'transform' }),
            },
            delay)
        }
        return
      }

      // 两段改一段：此前 -16→-5（250ms）再接 -5→0（350ms backout），两段速度不连续，
      // 首屏长任务下看起来像「卡一下」。单段 420ms power3.out 更顺。
      tl.fromTo(el,
        { opacity: 0, y: -16 },
        { opacity: 1, y: 0, duration: sec(420, m), ease: 'power3.out', ...gpuVars(m) },
        delay)
    })

    return () => {
      tl.kill()
      gsap.set(items.map((item) => item.el), { clearProps: 'transform,opacity' })
    }
  }, [])

  return (
    <div ref={ref} className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {children}
    </div>
  )
}
