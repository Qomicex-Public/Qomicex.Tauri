import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { useRef } from 'react'

gsap.registerPlugin(useGSAP)

function getAnimSettings() {
  try {
    const raw = localStorage.getItem('qomicex-settings')
    if (!raw) return { enabled: true, speed: 1 }
    const s = JSON.parse(raw)
    return { enabled: s.animationsEnabled !== false, speed: s.animationSpeed ?? 1 }
  } catch {
    return { enabled: true, speed: 1 }
  }
}

export function usePageAnimation() {
  const ref = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    const el = ref.current
    if (!el) return
    const { enabled, speed } = getAnimSettings()
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
    const { enabled, speed } = getAnimSettings()
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
