import { useRef, useEffect, ReactNode } from 'react'
import gsap from 'gsap'
import { getSettings } from '../api/settings.ts'

interface ContentTransitionProps {
  isLoading: boolean
  skeleton: ReactNode
  children: ReactNode
  className?: string
}

/**
 * 骨架图→内容切换过渡组件
 * 当从骨架图切换到实际内容时，提供平滑的高度和透明度过渡
 */
export function ContentTransition({
  isLoading,
  skeleton,
  children,
  className
}: ContentTransitionProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const skeletonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    const skeletonEl = skeletonRef.current
    if (!container || !content || !skeletonEl) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const duration = 0.3 / speed

    if (isLoading) {
      // 切换到骨架图
      gsap.to(content, {
        opacity: 0,
        scale: 0.98,
        duration: duration / 2,
        ease: 'power2.in'
      })
      gsap.fromTo(skeletonEl,
        { opacity: 0, scale: 0.98 },
        {
          opacity: 1,
          scale: 1,
          duration: duration / 2,
          ease: 'power3.out',
          force3D: settings.gpuAcceleration !== false,
        }
      )
    } else {
      // 切换到实际内容
      gsap.to(skeletonEl, {
        opacity: 0,
        scale: 0.98,
        duration: duration / 2,
        ease: 'power2.in'
      })
      gsap.fromTo(content,
        { opacity: 0, scale: 0.98 },
        {
          opacity: 1,
          scale: 1,
          duration,
          ease: 'power3.out',
          force3D: settings.gpuAcceleration !== false,
        }
      )
    }
  }, [isLoading])

  return (
    <div ref={containerRef} className={className}>
      <div
        ref={skeletonRef}
        style={{ display: isLoading ? 'block' : 'none' }}
      >
        {skeleton}
      </div>
      <div
        ref={contentRef}
        style={{ display: isLoading ? 'none' : 'block' }}
      >
        {children}
      </div>
    </div>
  )
}
