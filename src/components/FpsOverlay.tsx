// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { getSettings, onSettingsChange } from '../api/settings.ts'

/**
 * 右上角帧率读数：测的是 rAF 的真实投递频率（`lib/fps-limiter.ts` 已把上限钳进去）。
 * 以前每个组件自带节流器，读数只是"节流器自己的频率"，与界面实际渲染无关。
 */
export default function FpsOverlay() {
  const [fps, setFps] = useState(0)
  const [cap, setCap] = useState(() => getSettings().maxFrameRate ?? 0)

  useEffect(() => onSettingsChange(s => setCap(s.maxFrameRate ?? 0)), [])

  useEffect(() => {
    let raf = 0
    let frames = 0
    let last = performance.now()
    const tick = () => {
      frames++
      const now = performance.now()
      const elapsed = now - last
      if (elapsed >= 1000) {
        setFps(Math.round((frames * 1000) / elapsed))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

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
