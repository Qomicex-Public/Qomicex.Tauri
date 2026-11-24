// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import gsap from 'gsap'

export interface AnimConfig {
  /** 时长倍率：与 CSS 的 --anim-duration-multiplier 同源，越大越慢（>1 慢，<1 快） */
  multiplier: number
  enabled: boolean
}

export function readAnimConfig(): AnimConfig {
  const attr = document.documentElement.getAttribute('data-anim-enabled')
  const speedStr = getComputedStyle(document.documentElement).getPropertyValue('--anim-duration-multiplier')
  const parsed = speedStr ? parseFloat(speedStr) : 1
  // 宿主不会把 prefers-reduced-motion 写进 data-anim-enabled（只作用于 CSS），
  // 这里补上，保证 GSAP 驱动的组件同样尊重系统偏好。
  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  // 倍率 0 表示动画关闭（见 index.css [data-anim-enabled="false"]），保持 >0 以免 GSAP 时长为 0 卡住
  return {
    enabled: attr !== 'false' && !reduced,
    multiplier: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
  }
}

/** 缓动：入场 power3.out（干脆），离场 power2.in（利落收尾） */
export const EASE_IN = 'power3.out'
export const EASE_OUT = 'power2.in'

/** GPU 加速开关开启时注入 force3D，否则不加（由 data-anim-gpu 控制） */
export function gpuVars(enabled: boolean): gsap.TweenVars {
  return enabled ? { force3D: true } : {}
}

/** GPU 加速是否开启（App.tsx 在 data-anim-gpu 上写入设置） */
export function isGpuEnabled(): boolean {
  return document.documentElement.getAttribute('data-anim-gpu') !== 'false'
}

export function withGpu(vars: gsap.TweenVars): gsap.TweenVars {
  if (isGpuEnabled()) return { ...vars, force3D: true }
  return vars
}
