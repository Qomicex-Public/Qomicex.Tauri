import { useEffect, useLayoutEffect, useRef, RefObject } from 'react'
import gsap from 'gsap'
import { getSettings } from '../api/settings.ts'

/**
 * 页面入场动画 Hook
 * 在路由切换时触发目标元素的淡入+上滑动画
 */
export function usePageTransition<T extends HTMLElement>(options?: {
  duration?: number
  y?: number
}): RefObject<T | null> {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const duration = (options?.duration ?? 0.25) / speed
    const y = options?.y ?? 12

    gsap.fromTo(el,
      { opacity: 0, y },
      { opacity: 1, y: 0, duration, ease: 'power3.out', ...(settings.gpuAcceleration !== false ? { force3D: true } : {}) }
    )
  }, [options?.duration, options?.y])

  return ref
}

/**
 * 子元素交错入场动画 Hook
 * 用于列表/网格的子元素依次入场
 */
export function useStaggerAnimation<T extends HTMLElement>(options?: {
  stagger?: number
  duration?: number
  y?: number
  scale?: number
}): RefObject<T | null> {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const stagger = Math.min(options?.stagger ?? 0.05, 0.4) / speed
    const duration = (options?.duration ?? 0.3) / speed
    const y = options?.y ?? 8
    const scale = options?.scale ?? 0.97

    const children = el.children
    if (children.length === 0) return

    gsap.fromTo(children,
      { opacity: 0, y, scale },
      {
        opacity: 1, y: 0, scale: 1,
        duration,
        stagger,
        ease: 'power3.out',
        ...(settings.gpuAcceleration !== false ? { force3D: true } : {})
      }
    )
  }, [options?.stagger, options?.duration, options?.y, options?.scale])

  return ref
}

/**
 * 展开/折叠动画 Hook
 * 用于可折叠面板、手风琴等
 */
export function useExpandAnimation(
  isExpanded: boolean,
  options?: {
    duration?: number
  }
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const settings = getSettings()
    if (!settings.animationsEnabled) {
      el.style.height = isExpanded ? 'auto' : '0px'
      el.style.opacity = isExpanded ? '1' : '0'
      el.style.overflow = 'hidden'
      return
    }

    const speed = settings.animationSpeed ?? 1
    const duration = (options?.duration ?? 0.25) / speed

    el.style.overflow = 'hidden'

    if (isExpanded) {
      el.style.display = 'block'
      const height = el.scrollHeight
      gsap.fromTo(el,
        { height: 0, opacity: 0 },
        {
          height,
          opacity: 1,
          duration,
          ease: 'power2.out',
          onComplete: () => {
            el.style.height = 'auto'
            el.style.overflow = ''
          }
        }
      )
    } else {
      const height = el.scrollHeight
      el.style.height = `${height}px`
      gsap.to(el, {
        height: 0,
        opacity: 0,
        duration,
        ease: 'power2.in',
        onComplete: () => {
          el.style.display = 'none'
          el.style.overflow = ''
        }
      })
    }
  }, [isExpanded, options?.duration])

  return ref
}

/**
 * 对话框进入动画
 * 用于 Dialog 组件的进入/退出动画
 */
export function useDialogAnimation(open: boolean): {
  backdropRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
} {
  const backdropRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const duration = 0.2 / speed

    if (backdropRef.current) {
      gsap.fromTo(backdropRef.current,
        { opacity: 0 },
        { opacity: 1, duration, ease: 'power3.out' }
      )
    }

    if (contentRef.current) {
      gsap.fromTo(contentRef.current,
        { opacity: 0, scale: 0.95, y: 8 },
        {
          opacity: 1,
          scale: 1,
          y: 0,
          duration,
          ease: 'power3.out',
          ...(settings.gpuAcceleration !== false ? { force3D: true } : {})
        }
      )
    }
  }, [open])

  return { backdropRef, contentRef }
}

/**
 * 下拉框弹出动画
 * 用于 Select/Combobox 的弹出层
 */
export function usePopupAnimation(open: boolean): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !ref.current) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const duration = 0.15 / speed

    gsap.fromTo(ref.current,
      { opacity: 0, scale: 0.94, y: -4 },
      {
        opacity: 1,
        scale: 1,
        y: 0,
        duration,
        ease: 'power3.out',
        ...(settings.gpuAcceleration !== false ? { force3D: true } : {})
      }
    )
  }, [open])

  return ref
}

/** 一次最多交错动画的条目数：覆盖首屏约 35 个（网格 6 列 × 5~6 行），
 *  避免几百个 backdrop-filter 卡片同时进 tween 造成主线程卡顿 */
const MAX_ANIMATE_ITEMS = 35

/**
 * 交错列表动画（性能优化版）
 * 用于列表/网格子元素的入场/退场动画：
 * 1. 只动画前 MAX_ANIMATE_ITEMS 个（视口量），其余立即显示——避免几百个
 *    backdrop-filter 卡片同时进 tween，合成器每帧重采样 N 次背景导致卡顿。
 * 2. 滚动期间暂停本列表自身的动画（局部 timeline，不影响全局），停止 200ms 后恢复。
 * 3. 用 useLayoutEffect 保证骨架图→内容切换时动画必播（deps 变化 + 容器挂载）。
 * 4. 被移除的项（deps 变化后消失的 data-key）克隆到容器内 absolute 定位，播淡出+收缩后删除。
 *
 * 调用方必须给子元素加 `data-key` 才能启用退出动画。
 */
export function useAnimatedList<T extends HTMLElement>(
  deps: unknown[] = [],
  options?: {
    x?: number
    y?: number
    scale?: number
    stagger?: number
    duration?: number
    exitDuration?: number
  }
): RefObject<T | null> {
  const ref = useRef<T>(null)
  const tlRef = useRef<gsap.core.Timeline | null>(null)
  const prevChildrenRef = useRef<HTMLElement[]>([])
  // 上一批 children 每个 data-key 的视口坐标（旧节点卸载后 getBoundingClientRect 归零，
  // 必须在挂载时提前记录，退出克隆才能定位到原位置而不是左上角）
  const prevRectsRef = useRef<Map<string, { left: number; top: number; width: number; height: number }>>(new Map())

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const allChildren = Array.from(el.children) as HTMLElement[]
    if (allChildren.length === 0) return

    // 基线兜底：首次渲染（或上一次渲染容器未就绪导致 prev 为空）时，
    // 先记录当前 children 作为 diff 基线，不触发退出动画。
    if (prevChildrenRef.current.length === 0) {
      prevChildrenRef.current = allChildren
      const rects = new Map<string, { left: number; top: number; width: number; height: number }>()
      allChildren.forEach((c) => {
        const key = c.dataset.key
        if (!key) return
        const r = c.getBoundingClientRect()
        rects.set(key, { left: r.left, top: r.top, width: r.width, height: r.height })
      })
      prevRectsRef.current = rects
    }

    // 退出动画：diff 出上一批存在、本次消失的 data-key 项，克隆播淡出
    // 克隆不能 append 到 React 管理的容器（会被下一次 reconciliation 清除），
    // 因此挂到 body 层用 fixed 定位（视口坐标），播完再移除。
    // 只给前 MAX_ANIMATE_ITEMS 个被移除项做退出动画（避免大量 blur 卡片同时进 tween）。
    const newKeys = new Set(allChildren.map((c) => c.dataset.key))
    const removed = prevChildrenRef.current.filter(
      (n): n is HTMLElement & { dataset: { key: string } } =>
        !!n.dataset.key && !newKeys.has(n.dataset.key)
    )
    removed.slice(0, MAX_ANIMATE_ITEMS).forEach((node) => {
        const recorded = prevRectsRef.current.get(node.dataset.key)
        const left = recorded?.left ?? 0
        const top = recorded?.top ?? 0
        const width = recorded?.width ?? node.offsetWidth
        const height = recorded?.height ?? node.offsetHeight
        const clone = node.cloneNode(true) as HTMLElement
        clone.removeAttribute('id')
        clone.style.position = 'fixed'
        clone.style.left = `${left}px`
        clone.style.top = `${top}px`
        clone.style.width = `${width}px`
        clone.style.height = `${height}px`
        clone.style.margin = '0'
        clone.style.transform = 'none'
        clone.style.opacity = '1'
        clone.style.pointerEvents = 'none'
        clone.style.zIndex = '9999'
        document.body.appendChild(clone)
        gsap.to(clone, {
          opacity: 0,
          y: -8,
          scale: 0.92,
          duration: (options?.exitDuration ?? 0.23) / speed,
          ease: 'power2.in',
          force3D: true,
          onComplete: () => clone.remove(),
        })
      })

    // 进入动画：只动画前 MAX_ANIMATE_ITEMS 个，其余保持最终态
    const children = allChildren.slice(0, MAX_ANIMATE_ITEMS)

    const from: gsap.TweenVars = { opacity: 0 }
    const to: gsap.TweenVars = {
      opacity: 1,
      duration: (options?.duration ?? 0.25) / speed,
      ease: 'power3.out',
      ...(settings.gpuAcceleration !== false ? { force3D: true } : {}),
    }
    if (options?.x !== undefined) {
      from.x = options.x
      to.x = 0
    }
    if (options?.y !== undefined) {
      from.y = options.y
      to.y = 0
    }
    if (options?.scale !== undefined) {
      from.scale = options.scale
      to.scale = 1
    }
    to.stagger = Math.min(options?.stagger ?? 0.05, 0.5 / children.length) / speed

    tlRef.current = gsap.timeline()
    tlRef.current.fromTo(children, from, to)

    // 记录本批 children 及其视口坐标（在挂载期间记录，供下次退出克隆定位）
    prevChildrenRef.current = allChildren
    const rects = new Map<string, { left: number; top: number; width: number; height: number }>()
    allChildren.forEach((c) => {
      const key = c.dataset.key
      if (!key) return
      const r = c.getBoundingClientRect()
      rects.set(key, { left: r.left, top: r.top, width: r.width, height: r.height })
    })
    prevRectsRef.current = rects
  }, deps)

  // 滚动期间暂停本列表自身的动画 timeline，停止后恢复
  // 自动向上查找最近的滚动祖先，无需页面单独传滚动容器 ref
  useLayoutEffect(() => {
    const findScrollContainer = (start: HTMLElement | null): HTMLElement | null => {
      let node = start?.parentElement ?? null
      while (node) {
        const style = getComputedStyle(node)
        if (/(auto|scroll|overlay)/.test(style.overflowY)) return node
        node = node.parentElement
      }
      return null
    }

    const container = findScrollContainer(ref.current)
    if (!container) return

    let resumeTimer: ReturnType<typeof setTimeout> | null = null
    const onScroll = () => {
      tlRef.current?.pause()
      if (resumeTimer) clearTimeout(resumeTimer)
      resumeTimer = setTimeout(() => tlRef.current?.resume(), 200)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (resumeTimer) clearTimeout(resumeTimer)
      tlRef.current?.resume()
    }
  }, deps)

  return ref
}
