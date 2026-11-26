// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import gsap from 'gsap'
import { cn } from '../lib/utils.ts'
import { containsGlass, gpuVars, readMotion, sec } from '../lib/motion.ts'
import { queueGlassRepaint } from '../hooks/useGlassRepaint.ts'
import { useDelayedFlag } from '../hooks/useDelayedFlag.ts'

type Phase = 'loading' | 'leaving' | 'ready'

interface ContentTransitionProps {
  /** 真实加载态（不要传延迟后的值） */
  loading: boolean
  /**
   * 骨架是否已到显示时机。不传时内部按 400ms 延迟 + 300ms 最短停留处理；
   * 已经自己算过 useDelayedFlag 的调用点可以显式传入。
   */
  skeletonVisible?: boolean
  skeleton: ReactNode
  children: ReactNode
  className?: string
  /**
   * sequence（默认）：骨架先淡出 120ms，再挂载内容淡入 240ms。
   * 高度不固定的容器用这个——不重叠就没有高度跳变。
   *
   * overlay：骨架绝对定位覆盖，内容同时淡入（固定高度容器专用）。
   */
  mode?: 'sequence' | 'overlay'
  /** 内容出现时叠一层背景色渐变遮罩淡出（「沙画浮现」，列表页用） */
  veil?: boolean
}

/**
 * 骨架 → 内容溶解。
 *
 * 现状问题：页面里都是 `loading ? 骨架 : 内容` 的硬三元，加载完成时骨架整棵
 * 移除、内容同一帧出现，没有任何过渡。这里用三段式状态机补上：
 *
 *   loading ─120ms 骨架淡出→ leaving ─→ ready（内容 240ms 淡入）
 *
 * 玻璃卡只做 opacity（祖先 transform 会让 backdrop-filter 停止采样，ADR-141 5.1）。
 * 动画结束统一 clearProps 并补一次玻璃重采样，避免合成层残留（issue #327）。
 */
export function ContentTransition({
  loading,
  skeletonVisible,
  skeleton,
  children,
  className,
  mode = 'sequence',
  veil = false,
}: ContentTransitionProps) {
  const [phase, setPhase] = useState<Phase>(loading ? 'loading' : 'ready')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const prevLoadingRef = useRef(loading)
  // 未显式传入时内部做「400ms 延迟 + 300ms 最短停留」
  const autoSkeletonVisible = useDelayedFlag(loading)
  const resolvedSkeletonVisible = skeletonVisible ?? autoSkeletonVisible
  // 骨架是否已经真正出现在屏幕上（用于加载结束后的淡出判定）。
  // 不能直接读 skeletonVisible：useDelayedFlag 可能在 loading 翻转的同一帧把
  // 它置回 false，骨架会先被卸载，淡出根本没机会播。
  const everShownRef = useRef(false)
  useLayoutEffect(() => {
    if (phase === 'ready') everShownRef.current = false
    else if (resolvedSkeletonVisible) everShownRef.current = true
  })

  const [enterTick, setEnterTick] = useState(0)

  const wrapRef = useRef<HTMLDivElement>(null)
  const skeletonRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)

  const animsRef = useRef<gsap.core.Tween[]>([])
  const contentAnimatedRef = useRef(false)
  const track = (tw: gsap.core.Tween) => { animsRef.current.push(tw) }
  const stopAll = () => {
    for (const tw of animsRef.current) tw.kill()
    animsRef.current.length = 0
    contentAnimatedRef.current = false
  }

  const showSkeleton = phase !== 'ready' && (resolvedSkeletonVisible || everShownRef.current)
  const showContent = phase !== 'loading'

  // loading 翻转：进入 loading，或开始骨架退场
  useEffect(() => {
    const wasLoading = prevLoadingRef.current
    prevLoadingRef.current = loading

    if (loading) {
      // 仅骨架可见性变化（loading 未翻）时跳过重置：否则会杀掉布局效果刚启动的入场补间
      if (wasLoading) return
      stopAll()
      const skeletonEl = skeletonRef.current
      if (skeletonEl) {
        // 退场中断后重新加载：清掉上一轮写入的内联状态，避免骨架变暗/保持绝对定位
        gsap.set(skeletonEl, { clearProps: 'opacity,transform,position,inset,zIndex,pointerEvents' })
      }
      if (phaseRef.current !== 'loading') setPhase('loading')
      return
    }

    // 已加载完但仍停在 loading：等骨架最短停留结束后退场。
    // 不能在这里用 wasLoading 提前返回：resolvedSkeletonVisible 变化也会触发本 effect，
    // 那时 prevLoadingRef 早已翻成 false，会把真正的退场永久挡掉。
    if (phaseRef.current === 'loading') {
      if (resolvedSkeletonVisible) return

      const motion = readMotion()
      if (!motion.enabled) {
        setPhase('ready')
        return
      }

      // 骨架从未显示过：没有可退场的对象，直接切内容
      if (!everShownRef.current) {
        setPhase('ready')
        return
      }

      if (mode === 'overlay') {
        // 内容与骨架同时在 DOM 里，由下面的 phase 效果同时播
        setPhase('leaving')
        return
      }

      const skeletonEl = skeletonRef.current
      if (!skeletonEl) {
        setPhase('ready')
        return
      }

      track(gsap.to(skeletonEl, {
        opacity: 0,
        // 骨架里的玻璃占位卡也不做祖先 transform
        ...(containsGlass(skeletonEl) ? {} : { scale: 0.995 }),
        duration: sec(120, motion),
        ease: 'power2.in',
        overwrite: 'auto',
        onComplete: () => setPhase('ready'),
      }))
      return
    }

    // 加载 <400ms、骨架从未出现：直接给内容补一次入场，避免「瞬间出现」
    if (wasLoading && phaseRef.current === 'ready') {
      setEnterTick((tick) => tick + 1)
    }
  }, [loading, mode, resolvedSkeletonVisible])

  // 过渡表现：overlay 同时进退场；sequence 只负责内容入场
  useLayoutEffect(() => {
    const motion = readMotion()

    if (phase === 'leaving' && mode === 'overlay') {
      const skeletonEl = skeletonRef.current
      const contentEl = contentRef.current
      if (!motion.enabled) {
        setPhase('ready')
        return
      }

      if (skeletonEl) {
        skeletonEl.style.position = 'absolute'
        skeletonEl.style.inset = '0'
        skeletonEl.style.zIndex = '10'
        track(gsap.to(skeletonEl, {
          opacity: 0,
          duration: sec(120, motion),
          ease: 'power2.in',
          overwrite: 'auto',
          onComplete: () => setPhase('ready'),
        }))
      } else {
        setPhase('ready')
      }

      if (contentEl) {
        const glass = containsGlass(contentEl)
        const listOwned = !!contentEl.querySelector('[data-key]')
        if (!listOwned) {
          contentAnimatedRef.current = true
          track(gsap.fromTo(contentEl,
            { opacity: 0, ...(glass ? {} : { y: 6 }) },
            {
              opacity: 1,
              ...(glass ? {} : { y: 0 }),
              duration: sec(240, motion),
              ease: 'power3.out',
              overwrite: 'auto',
              ...gpuVars(motion),
              onComplete: () => {
                gsap.set(contentEl, { clearProps: 'transform,opacity' })
                queueGlassRepaint()
              },
            }))
        }
      }
      return
    }

    if (phase !== 'ready') return
    const contentEl = contentRef.current
    if (!contentEl || !motion.enabled) return

    gsap.killTweensOf(contentEl)
    const glass = containsGlass(contentEl)
    // 列表自己有条目级 stagger：容器再淡一次会与条目 opacity 相乘，前 200ms 发灰
    const listOwned = !!contentEl.querySelector('[data-key]')
    // overlay 分支已经在 leaving 阶段播过内容淡入，这里不再重播（否则会二次消失）
    if (!listOwned && !contentAnimatedRef.current) {
      track(gsap.fromTo(contentEl,
        { opacity: 0, ...(glass ? {} : { y: 6 }) },
        {
          opacity: 1,
          ...(glass ? {} : { y: 0 }),
          duration: sec(glass ? 200 : 240, motion),
          ease: 'power3.out',
          overwrite: 'auto',
          ...gpuVars(motion),
          onComplete: () => {
            gsap.set(contentEl, { clearProps: 'transform,opacity' })
            queueGlassRepaint()
          },
        }))
    } else {
      queueGlassRepaint()
    }
    contentAnimatedRef.current = false

    const veilEl = veilRef.current
    if (veilEl) {
      track(gsap.fromTo(veilEl,
        { opacity: 1 },
        {
          opacity: 0,
          duration: sec(260, motion),
          ease: 'power2.out',
          overwrite: 'auto',
          onComplete: () => gsap.set(veilEl, { clearProps: 'opacity' }),
        }))
    }
  }, [phase, mode, enterTick])

  // 骨架入场：按「骨架是否显示」而非可见性标志触发，重新挂载时也能淡入。
  // 只做 opacity——骨架里的玻璃占位卡不能有祖先 transform，否则 backdrop-filter 停止采样（ADR-141 5.1）。
  useLayoutEffect(() => {
    if (!showSkeleton) return
    const skeletonEl = skeletonRef.current
    if (!skeletonEl) return
    const motion = readMotion()
    if (!motion.enabled) return
    track(gsap.fromTo(skeletonEl,
      { opacity: 0 },
      {
        opacity: 1,
        duration: sec(200, motion),
        ease: 'power2.out',
        overwrite: 'auto',
        onComplete: () => {
          gsap.set(skeletonEl, { clearProps: 'opacity' })
          if (containsGlass(skeletonEl)) queueGlassRepaint()
        },
      }))
  }, [showSkeleton])

  useEffect(() => () => {
    stopAll()
  }, [])

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      {showSkeleton && (
        <div
          ref={skeletonRef}
          data-skeleton
          className={mode === 'overlay' && phase === 'leaving' ? 'pointer-events-none absolute inset-0 z-10' : undefined}
        >
          {skeleton}
        </div>
      )}
      {showContent && (
        <>
          <div ref={contentRef}>{children}</div>
          {veil && (
            <div
              ref={veilRef}
              aria-hidden
              data-content-veil
              className="pointer-events-none absolute inset-0 z-20 opacity-0"
              style={{ background: 'linear-gradient(to bottom, hsl(var(--background) / 0.55), transparent 62%)' }}
            />
          )}
        </>
      )}
    </div>
  )
}
