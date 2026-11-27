// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 游戏窗口 → 启动参数的换算。
 *
 * 小/中/大按主屏物理分辨率的 50%/70%/90% 取宽度，高度保持 16:9；
 * 超出屏幕高度时按高度反算，保证整个窗口可见。
 */

export type GameWindowMode = 'default' | 'small' | 'medium' | 'large' | 'fullscreen' | 'custom'

export interface GameWindowSource {
  /** null/undefined = 未设置（全局=不指定，实例=跟随全局） */
  mode?: string | null
  /** 仅 mode === 'custom' 时使用 */
  width?: number | null
  height?: number | null
}

export interface GameWindowLaunchArgs {
  windowWidth?: number
  windowHeight?: number
  windowFullscreen?: boolean
}

const DEFAULT_WIDTH = 854
const DEFAULT_HEIGHT = 480
const RATIOS: Record<string, number> = { small: 0.5, medium: 0.7, large: 0.9 }

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** 16:9 适配：先按宽度比例取，超高时按高度收窄。 */
export function fitSixteenByNine(
  screenWidth: number,
  screenHeight: number,
  ratio: number,
): { width: number; height: number } {
  let width = Math.max(1, Math.round(screenWidth * ratio))
  let height = Math.max(1, Math.round((width * 9) / 16))
  if (height > screenHeight) {
    height = Math.max(1, Math.round(screenHeight))
    width = Math.max(1, Math.round((height * 16) / 9))
  }
  return { width, height }
}

/** 实例未单独设置时沿用全局；实例显式选了自定义就只用它自己的宽高，缺一项时不传参数。 */
export function pickGameWindow(
  instance: GameWindowSource,
  global: GameWindowSource,
): GameWindowSource {
  const mode = instance.mode ?? global.mode ?? null
  if (!mode) return { mode: null }
  if (mode !== 'custom') return { mode }

  // 实例明确选了 custom：缺一项就当作「不传窗口参数」，不能拿全局宽高兜底。
  const source = instance.mode === 'custom' ? instance : global
  const width = positive(source.width)
  const height = positive(source.height)
  return width !== null && height !== null ? { mode, width, height } : { mode: null }
}

/** 纯换算：屏幕尺寸显式传入，方便单测。 */
export function gameWindowArgs(
  source: GameWindowSource,
  screen: { width: number; height: number },
): GameWindowLaunchArgs {
  const mode = source.mode
  if (!mode) return {}
  if (mode === 'fullscreen') return { windowFullscreen: true }
  if (mode === 'default') return { windowWidth: DEFAULT_WIDTH, windowHeight: DEFAULT_HEIGHT }

  if (mode === 'custom') {
    const width = positive(source.width)
    const height = positive(source.height)
    if (width === null || height === null) return {}
    return { windowWidth: width, windowHeight: height }
  }

  const ratio = RATIOS[mode]
  if (!ratio) return {}
  const { width, height } = fitSixteenByNine(screen.width, screen.height, ratio)
  return { windowWidth: width, windowHeight: height }
}

/** WebView 的 screen 是 CSS 像素，乘 DPR 得到游戏窗口使用的物理像素。 */
function screenPhysicalPixels(): { width: number; height: number } {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const screen = typeof window === 'undefined' ? undefined : window.screen
  return {
    width: Math.round((screen?.width || DEFAULT_WIDTH) * dpr),
    height: Math.round((screen?.height || DEFAULT_HEIGHT) * dpr),
  }
}

/** 启动时调用：实例跟随全局，最终换算成后端/游戏可用的像素参数。 */
export function resolveGameWindowArgs(
  instance: GameWindowSource,
  global: GameWindowSource,
): GameWindowLaunchArgs {
  return gameWindowArgs(pickGameWindow(instance, global), screenPhysicalPixels())
}
