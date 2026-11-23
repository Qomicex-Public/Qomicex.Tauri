// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState, type ReactNode } from 'react'
import gsap from 'gsap'
import { getSettings } from '../api/settings.ts'

interface ContentTransitionProps {
  loading: boolean
  skeleton: ReactNode
  children: ReactNode
  className?: string
}

/**
 * 骨架图 → 内容的切换过渡。
 *
 * 骨架图和内容不能同时挂载（内容在数据没到时不该渲染），所以按阶段切：
 * loading 结束先把骨架图淡出并轻微缩小，动画结束再换成内容并让它淡入上移。
 * 直接用 `display` 在同一个渲染里切换会把退场动画吃掉 —— 节点那一刻已经不可见。
 */
export function ContentTransition({ loading, skeleton, children, className }: ContentTransitionProps) {
  const [showSkeleton, setShowSkeleton] = useState(loading)
  const skeletonRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    if (loading) {
      setShowSkeleton(true)
      return
    }
    const settings = getSettings()
    const el = skeletonRef.current
    if (!el || settings.animationsEnabled === false) {
      setShowSkeleton(false)
      return
    }
    const speed = settings.animationSpeed ?? 1
    const tween = gsap.to(el, {
      opacity: 0,
      scale: 0.98,
      duration: 0.12 / speed,
      ease: 'power2.in',
      onComplete: () => setShowSkeleton(false),
    })
    return () => { tween.kill() }
  }, [loading])

  useEffect(() => {
    const el = contentRef.current
    if (!el || showSkeleton) return
    const first = !mountedRef.current
    mountedRef.current = true
    // 首次挂载由页面自己的入场动画负责，这里只处理「骨架图换内容」这一次。
    if (first) return
    const settings = getSettings()
    if (settings.animationsEnabled === false) return
    const speed = settings.animationSpeed ?? 1
    gsap.fromTo(el,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.2 / speed, ease: 'power3.out', clearProps: 'transform' }
    )
  }, [showSkeleton])

  return (
    <div className={className}>
      {showSkeleton ? <div ref={skeletonRef}>{skeleton}</div> : <div ref={contentRef}>{children}</div>}
    </div>
  )
}
