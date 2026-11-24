// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import gsap from 'gsap'
import { containsGlass, gpuVars, readMotion, sec } from '../lib/motion.ts'
import { queueGlassRepaint } from './useGlassRepaint.ts'
import { computeListDiff, type ListRectInput } from './listDiff.ts'

/** 单次最多逐项动画的条目数：覆盖首屏（网格 6 列 × 5~6 行） */
const MAX_ANIMATE_ITEMS = 35
/** 滚动后多久内不播动画（毫秒）：避免滚动与补间抢主线程 */
const SCROLL_QUIET_MS = 150

interface AnimatedListOptions {
  x?: number
  y?: number
  scale?: number
  /** 秒，未乘倍率 */
  stagger?: number
  /** 秒，未乘倍率 */
  duration?: number
  /** 秒，未乘倍率 */
  exitDuration?: number
}

interface SnapshotEntry {
  el: HTMLElement
  top: number
  left: number
  width: number
  height: number
}

function keyOf(el: Element, index: number): string {
  const own = (el as HTMLElement).dataset.key
  if (own) return own
  // 卡片常被 ContextMenu 之类的无 key 包装器裹一层：取第一个带 data-key 的后代，
  // 否则退化为下标 key，头/中插入时会误判成整组替换
  const nested = el.querySelector('[data-key]')?.getAttribute('data-key')
  return nested ?? `\u0000idx-${index}`
}

function measure(el: HTMLElement): SnapshotEntry {
  const rect = el.getBoundingClientRect()
  return { el, top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

function inViewport(entry: SnapshotEntry): boolean {
  return entry.top < window.innerHeight && entry.top + entry.height > 0
}

function findScrollParent(start: HTMLElement | null): HTMLElement | null {
  let node = start?.parentElement ?? null
  while (node) {
    const style = getComputedStyle(node)
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return node
    node = node.parentElement
  }
  return null
}

/**
 * 列表动效：DOM 变更驱动（MutationObserver）+ 位置快照 FLIP。
 *
 * 与旧实现的区别（ADR 见 docs/juni-dev-docs/6-UI/UI动画优化方案.md 3.5.1）：
 * - 不再依赖调用方手写 deps：任何子节点增删都会重新差分，忘记声明依赖不会再丢动画
 * - 头/中/尾插入都播；已有条目用 FLIP 让位，不再瞬移
 * - 删除是逐项退场（按旧位置克隆），不是整块重播
 * - 新旧 key 交集 < 35% 判为整组替换，改为快淡入，避免几十条 tween 打架
 * - 玻璃卡只做 opacity（祖先 transform 会让 backdrop-filter 停止采样，见 ADR-141 5.1）
 *
 * `deps` 参数保留只为兼容现有调用点，已不再参与判定。
 */
export function useAnimatedList<T extends HTMLElement>(
  _deps: unknown[] = [],
  options?: AnimatedListOptions,
): RefObject<T | null> {
  const ref = useRef<T>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const snapshotRef = useRef<Map<string, SnapshotEntry>>(new Map())
  const targetRef = useRef<HTMLElement | null>(null)
  const observerRef = useRef<MutationObserver | null>(null)
  const animatedRef = useRef<Set<HTMLElement>>(new Set())
  const clonesRef = useRef<Set<HTMLElement>>(new Set())
  const lastScrollAtRef = useRef(0)
  const detachRef = useRef<() => void>(() => {})

  const animate = useCallback((el: HTMLElement) => {
    const motion = readMotion()
    const opts = optionsRef.current ?? {}

    const children = Array.from(el.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    )
    const next = new Map<string, SnapshotEntry>()
    children.forEach((child, index) => next.set(keyOf(child, index), measure(child)))

    const prevSnapshot = snapshotRef.current
    snapshotRef.current = next

    // 关闭动画 / reduced-motion：不写任何内联样式，直接落终态
    if (!motion.enabled) return
    if (children.length === 0 && prevSnapshot.size === 0) return

    // 滚动期间的变更不播动画：与滚动抢帧只会更卡。
    // 首屏例外：页面挂载时浏览器可能因滚动锚定补发一次 scroll，若一并跳过，
    // 进场动画会随机丢失（现象就是「有时候没有逐个进入」）。
    const initial = prevSnapshot.size === 0
    if (!initial && performance.now() - lastScrollAtRef.current < SCROLL_QUIET_MS) return

    const prevRects: ListRectInput[] = [...prevSnapshot.entries()].map(([key, entry]) => ({
      key, top: entry.top, left: entry.left,
    }))
    const nextRects: ListRectInput[] = [...next.entries()].map(([key, entry]) => ({
      key, top: entry.top, left: entry.left,
    }))
    const diff = computeListDiff(prevRects, nextRects)

    const staggerBase = opts.stagger ?? 0.05
    const enterDuration = sec((opts.duration ?? 0.25) * 1000, motion)
    const exitDuration = sec((opts.exitDuration ?? 0.23) * 1000, motion)
    const replaceDuration = sec(140, motion)
    const moveDuration = sec(220, motion)

    // ---- 整组替换：不做逐项位移/退场，只把新内容淡进来 ----
    if (diff.replace) {
      const targets = [...next.values()].filter(inViewport).slice(0, MAX_ANIMATE_ITEMS)
      targets.forEach((entry) => {
        const node = entry.el
        animatedRef.current.add(node)
        gsap.killTweensOf(node)
        gsap.fromTo(node,
          { opacity: 0 },
          {
            opacity: 1,
            duration: replaceDuration,
            ease: 'power2.out',
            overwrite: 'auto',
            onComplete: () => {
              gsap.set(node, { clearProps: 'opacity' })
              animatedRef.current.delete(node)
              queueGlassRepaint()
            },
          })
      })
      return
    }

    // ---- 逐项退场：按旧位置克隆到 body，播完移除 ----
    // 搜索/筛选会让大量条目同时消失，逐条克隆会飞出几十块碎片：
    // 只有「少量删除」才播退场，大量消失交给 replace/静默处理。
    const animatedExitLimit = Math.max(3, Math.round(prevSnapshot.size * 0.3))
    const exitTargets = diff.exit.length <= animatedExitLimit
      ? diff.exit
        .map((key) => prevSnapshot.get(key))
        .filter((entry): entry is SnapshotEntry => !!entry && inViewport(entry))
        .slice(0, MAX_ANIMATE_ITEMS)
      : []

    for (const entry of exitTargets) {
      const clone = entry.el.cloneNode(true) as HTMLElement
      clone.removeAttribute('id')
      clone.style.position = 'fixed'
      clone.style.left = `${entry.left}px`
      clone.style.top = `${entry.top}px`
      clone.style.width = `${entry.width}px`
      clone.style.height = `${entry.height}px`
      clone.style.margin = '0'
      clone.style.transform = 'none'
      clone.style.opacity = '1'
      clone.style.pointerEvents = 'none'
      clone.style.zIndex = '9999'
      clone.dataset.animClone = ''
      clonesRef.current.add(clone)
      document.body.appendChild(clone)
      gsap.to(clone, {
        opacity: 0,
        y: -8,
        scale: 0.96,
        duration: exitDuration,
        ease: 'power2.in',
        force3D: motion.gpu,
        onComplete: () => {
          clone.remove()
          clonesRef.current.delete(clone)
          queueGlassRepaint()
        },
      })
    }

    // ---- 逐项入场：新增 key，按 DOM 顺序错位 ----
    const enterKeys = diff.enter.slice(0, MAX_ANIMATE_ITEMS)
    enterKeys.forEach((key, index) => {
      const entry = next.get(key)
      if (!entry || !inViewport(entry)) return
      const node = entry.el
      const glass = containsGlass(node)
      const delay = Math.min(staggerBase, 0.5 / Math.max(enterKeys.length, 1)) * index * motion.multiplier

      animatedRef.current.add(node)
      gsap.killTweensOf(node)

      const from: gsap.TweenVars = { opacity: 0 }
      const to: gsap.TweenVars = {
        opacity: 1,
        duration: enterDuration,
        delay,
        ease: 'power3.out',
        overwrite: 'auto',
        ...gpuVars(motion),
        onComplete: () => {
          gsap.set(node, { clearProps: 'transform,opacity' })
          animatedRef.current.delete(node)
          queueGlassRepaint()
        },
      }
      if (!glass) {
        if (opts.x !== undefined) { from.x = opts.x; to.x = 0 }
        if (opts.y !== undefined) { from.y = opts.y; to.y = 0 }
        if (opts.scale !== undefined) { from.scale = opts.scale; to.scale = 1 }
      }
      gsap.fromTo(node, from, to)
    })

    // ---- FLIP：位置变化的旧条目补间到新位置 ----
    for (const move of diff.move) {
      const entry = next.get(move.key)
      if (!entry || !inViewport(entry)) continue
      const node = entry.el
      animatedRef.current.add(node)
      gsap.killTweensOf(node)
      gsap.fromTo(node,
        { x: move.dx, y: move.dy },
        {
          x: 0,
          y: 0,
          duration: moveDuration,
          ease: 'power3.out',
          overwrite: 'auto',
          ...gpuVars(motion),
          onComplete: () => {
            gsap.set(node, { clearProps: 'transform' })
            animatedRef.current.delete(node)
            queueGlassRepaint()
          },
        })
    }
  }, [])

  const attach = useCallback((el: HTMLElement) => {
    if (targetRef.current === el) return
    detachRef.current()

    targetRef.current = el
    snapshotRef.current = new Map()

    const scroller = findScrollParent(el)
    const onScroll = () => { lastScrollAtRef.current = performance.now() }
    scroller?.addEventListener('scroll', onScroll, { passive: true })

    // DOM 变更即差分：mutation 回调在 paint 前执行，不会先闪一帧终态
    const observer = new MutationObserver(() => animate(el))
    observer.observe(el, { childList: true })
    observerRef.current = observer

    detachRef.current = () => {
      observer.disconnect()
      observerRef.current = null
      scroller?.removeEventListener('scroll', onScroll)
      for (const node of animatedRef.current) gsap.killTweensOf(node)
      animatedRef.current.clear()
      for (const clone of clonesRef.current) clone.remove()
      clonesRef.current.clear()
      targetRef.current = null
      snapshotRef.current = new Map()
    }

    // 首屏：把已有子节点当作一次「全部新增」，播放入场（不播退场）
    animate(el)
  }, [animate])

  // 每次渲染后确保已挂载（条件渲染的列表在数据到达后才出现）
  useLayoutEffect(() => {
    const el = ref.current
    if (el) attach(el)
  })

  // 卸载时断开观察者、终止补间、清掉残留克隆
  useLayoutEffect(() => () => detachRef.current(), [])

  return ref
}

/**
 * 展开/折叠：先测内容高度，再动画自身高度。
 *
 * 修复：旧实现未 killTweensOf，快速连点时上一轮的 onComplete 会把
 * `display/height` 写成相反的终态。现在每轮先终止旧补间，并在结束时统一
 * 复位四个内联值；动画关闭时直接落终值。
 */
export function useExpandAnimation(
  isExpanded: boolean,
  options?: { duration?: number },
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)
  const prevExpandedRef = useRef(isExpanded)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const settle = (expanded: boolean) => {
      el.style.overflow = ''
      el.style.opacity = expanded ? '1' : '0'
      el.style.height = expanded ? 'auto' : ''
      el.style.display = expanded ? 'block' : 'none'
    }

    // 首次挂载只落终态，不播动画（否则进入设置页时所有折叠面板会先展开一次）
    if (!mountedRef.current) {
      mountedRef.current = true
      prevExpandedRef.current = isExpanded
      settle(isExpanded)
      return
    }

    if (prevExpandedRef.current === isExpanded) return
    prevExpandedRef.current = isExpanded

    const motion = readMotion()
    const durationMs = (options?.duration ?? 0.25) * 1000

    gsap.killTweensOf(el)

    if (!motion.enabled) {
      settle(isExpanded)
      return
    }

    el.style.overflow = 'hidden'

    if (isExpanded) {
      el.style.display = 'block'
      const height = el.scrollHeight
      gsap.fromTo(el,
        { height: 0, opacity: 0 },
        {
          height,
          opacity: 1,
          duration: sec(durationMs * 0.88, motion),
          ease: 'power4.out',
          overwrite: 'auto',
          onComplete: () => {
            el.style.height = 'auto'
            el.style.overflow = ''
          },
        })
      return
    }

    gsap.to(el, {
      height: 0,
      opacity: 0,
      duration: sec(durationMs * 0.64, motion),
      ease: 'power3.in',
      overwrite: 'auto',
      onComplete: () => {
        el.style.display = 'none'
        el.style.height = ''
        el.style.overflow = ''
      },
    })
  }, [isExpanded, options?.duration])

  return ref
}
