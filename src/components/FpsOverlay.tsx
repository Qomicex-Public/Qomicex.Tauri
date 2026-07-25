import { useEffect, useState, useRef } from 'react'
import { getSettings, onSettingsChange } from '../api/settings.ts'
import { createRafThrottle } from '../lib/fps-limiter.ts'

export default function FpsOverlay() {
  const [fps, setFps] = useState(0)
  const [cap, setCap] = useState(() => getSettings().maxFrameRate ?? 0)
  const frameCountRef = useRef(0)
  const lastUpdateRef = useRef(performance.now())

  useEffect(() => {
    const unsub = onSettingsChange(s => setCap(s.maxFrameRate ?? 0))
    return unsub
  }, [])

  useEffect(() => {
    let cancelled = false
    const { throttle, rafId } = createRafThrottle(cap)

    function tick() {
      if (cancelled) return
      frameCountRef.current++
      const now = performance.now()
      const elapsed = now - lastUpdateRef.current
      if (elapsed >= 1000) {
        setFps(Math.round(frameCountRef.current * 1000 / elapsed))
        frameCountRef.current = 0
        lastUpdateRef.current = now
      }
      throttle(tick)
    }
    throttle(tick)
    return () => { cancelled = true; cancelAnimationFrame(rafId.current) }
  }, [cap])

  return (
    <div
      className="fixed top-3 right-3 z-[9999] flex items-center gap-1.5 rounded-md bg-black/60 px-2.5 py-1 text-xs font-mono tabular-nums backdrop-blur-sm pointer-events-none select-none"
      style={{ color: fps < 30 ? '#ef4444' : fps < 55 ? '#f59e0b' : '#22c55e' }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: fps < 30 ? '#ef4444' : fps < 55 ? '#f59e0b' : '#22c55e' }} />
      {fps}<span className="text-white/40">/{cap > 0 ? cap : '∞'}</span> FPS
    </div>
  )
}
