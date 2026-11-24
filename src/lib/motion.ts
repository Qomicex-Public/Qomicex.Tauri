// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 动效配置与工具的唯一入口（宿主侧）。
 *
 * 与 `packages/plugin-ui/src/lib/anim.ts` 同源：都从 `<html>` 的
 * `data-anim-*` 与 `--anim-duration-multiplier` 读取，而不是读 settings 对象。
 * 这样「界面动画」开关、速度、GPU、系统 reduced-motion 在运行中改动立即生效，
 * 也不会出现「CSS 与 GSAP 时长方向相反」的口径漂移（ADR-069）。
 */

export interface Motion {
  /** 用户开关 && !prefers-reduced-motion */
  enabled: boolean
  /** 时长倍率：1 = 基准，>1 更慢（与 CSS 变量同义） */
  multiplier: number
  /** GPU 合成层开关（force3D） */
  gpu: boolean
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function readMotion(): Motion {
  const root = document.documentElement
  const raw = getComputedStyle(root).getPropertyValue('--anim-duration-multiplier')
  const parsed = Number.parseFloat(raw)
  return {
    // 关闭时 CSS 变量被置 0，这里仍返回 >0 的倍率：调用方在 enabled=false 时直接短路落终值
    multiplier: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    enabled: root.dataset.animEnabled !== 'false' && !prefersReducedMotion(),
    gpu: root.dataset.animGpu !== 'false',
  }
}

/** 毫秒 → GSAP 秒，已乘倍率 */
export function sec(ms: number, m: Motion = readMotion()): number {
  return (ms / 1000) * m.multiplier
}

/** GPU 开关打开时注入 force3D */
export function gpuVars(m: Motion = readMotion()): { force3D?: boolean } {
  return m.gpu ? { force3D: true } : {}
}

/**
 * 是否包含玻璃表面（持有 backdrop-filter 的元素）。
 *
 * 玻璃元素或它的任意祖先被 transform / 祖先 opacity 提升为独立合成层后，
 * WebView2 会停止重采样 backdrop-filter（issue #327）。所以：
 * - 含玻璃的区块只做自身 opacity，不做位移；
 * - 玻璃元素自身可以淡入，但祖先进场不能带 transform。
 */
export function containsGlass(el: Element | null): boolean {
  if (!el) return false
  return el.matches('.glass-surface, [data-liquid-glass]') ||
    !!el.querySelector('.glass-surface, [data-liquid-glass]')
}
