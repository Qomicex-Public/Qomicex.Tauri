import { useEffect, useState, useRef } from 'react'

export default function FpsOverlay() {
  const [fps, setFps] = useState(0)
  const frameCountRef = useRef(0)
  const lastTimeRef = useRef(performance.now())
  const rafRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    function tick() {
      if (cancelled) return
      frameCountRef.current++
      const now = performance.now()
      const elapsed = now - lastTimeRef.current
      if (elapsed >= 1000) {
        setFps(Math.round(frameCountRef.current * 1000 / elapsed))
        frameCountRef.current = 0
        lastTimeRef.current = now
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { cancelled = true; cancelAnimationFrame(rafRef.current) }
  }, [])

  return (
    <div
      className="fixed top-3 right-3 z-[9999] flex items-center gap-1.5 rounded-md bg-black/60 px-2.5 py-1 text-xs font-mono tabular-nums backdrop-blur-sm pointer-events-none select-none"
      style={{ color: fps < 30 ? '#ef4444' : fps < 55 ? '#f59e0b' : '#22c55e' }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: fps < 30 ? '#ef4444' : fps < 55 ? '#f59e0b' : '#22c55e' }} />
      {fps} FPS
    </div>
  )
}
