import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { useRef } from 'react'
import { getSettings } from '../api/settings.ts'

gsap.registerPlugin(useGSAP)

export function usePageAnimation() {
  const ref = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    const el = ref.current
    if (!el) return
    const s = getSettings()
    const enabled = s.animationsEnabled !== false
    const speed = s.animationSpeed ?? 1
    if (!enabled) return

    gsap.from(el, {
      autoAlpha: 0,
      y: 12,
      duration: 0.35 / speed,
      ease: 'power2.out',
      clearProps: 'y',
    })
  }, { scope: ref })

  return ref
}

export function useStaggerAnimation(deps: unknown[] = []) {
  const ref = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    const el = ref.current
    if (!el) return
    const s = getSettings()
    const enabled = s.animationsEnabled !== false
    const speed = s.animationSpeed ?? 1
    if (!enabled) return

    const children = el.children
    if (children.length === 0) return

    gsap.from(children, {
      autoAlpha: 0,
      y: 8,
      scale: 0.97,
      duration: 0.3 / speed,
      stagger: Math.min(0.06, 0.3 / children.length) / speed,
      ease: 'power2.out',
      clearProps: 'all',
    })
  }, { scope: ref, dependencies: deps })

  return ref
}
