import gsap from 'gsap'

export interface AnimConfig {
  speed: number
  enabled: boolean
}

export function readAnimConfig(): AnimConfig {
  const attr = document.documentElement.getAttribute('data-anim-enabled')
  const speedStr = getComputedStyle(document.documentElement).getPropertyValue('--anim-duration-multiplier')
  const parsed = speedStr ? parseFloat(speedStr) : 1
  return { enabled: attr !== 'false', speed: Number.isFinite(parsed) && parsed > 0 ? parsed : 1 }
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
