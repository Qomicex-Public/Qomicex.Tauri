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
    const maxFps = s.maxFrameRate ?? 0
    const fpsScale = maxFps > 0 ? 60 / maxFps : 1
    if (!enabled) return

    gsap.from(el, {
      autoAlpha: 0,
      y: 12,
      duration: 0.35 / speed * fpsScale,
      ease: 'power3.out',
      force3D: s.gpuAcceleration !== false,
      clearProps: 'y',
    })
  }, { scope: ref })

  return ref
}

