// 全局主题强调色工具。
//
// 主题色（accent）本质是 index.css 里的 `--primary` / `--ring` / `--primary-foreground`
// 三组 HSL/CSS 变量。这里把「当前主题色设定」转成 CSS 变量并覆盖到 `<html>` 行内样式。
//
// 三种取值：
//   - 空字符串 / undefined：使用 CSS 定义的默认配色（绿），不做覆盖；
//   - 合法 hex：把它转成 HSL 覆盖 --primary/--ring，并按 WCAG 相对亮度自动选黑/白前景；
//   - 'background'（哨兵值）：使用莫奈式取色从当前背景图提取主色；无背景/取色失败回退默认。
//
// 深浅主题共用同一强调色。背景 URL 由 Layout 通过 `setThemeBackground` 上报；当模式为
// 'background' 且背景变化时自动重取色。

import { extractAccentFromImageUrl } from './monet.ts'

/** 表示「跟随背景」的哨兵值。 */
export const THEME_COLOR_MODE_BACKGROUND = 'background'

/**
 * 把任意合法 hex（`#rgb` / `#rrggbb`）规范成 `#rrggbb`；非法输入返回 null。
 */
export function normalizeHex(input: string): string | null {
  let hex = input.trim()
  if (!/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(hex)) return null
  hex = hex.replace(/^#/, '')
  if (hex.length === 3) {
    hex = hex.split('').map((c) => c + c).join('')
  }
  return `#${hex.toLowerCase()}`
}

/** hex → [r, g, b]（0-255）。 */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(normalizeHex(hex)!.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** WCAG 相对亮度（0-1）。 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** hex → { h, s, l }，h∈[0,360)，s/l∈[0,100]。 */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break
      case g: h = ((b - r) / d + 2) * 60; break
      default: h = ((r - g) / d + 4) * 60
    }
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

let currentMode = '' // '' | hex | 'background'
let currentBgUrl = ''
let renderSeq = 0

function setVars(hex: string): void {
  const { h, s, l } = hexToHsl(hex)
  const primary = `${h} ${s}% ${l}%`
  // 按对比度在黑白之间选前景：亮度高于 ≈0.179 时黑暗文字对比更强，否则白字。
  const foreground = relativeLuminance(hex) > 0.179
    ? '230 20% 6%'
    : '0 0% 100%'
  const root = document.documentElement
  root.style.setProperty('--primary', primary)
  root.style.setProperty('--ring', primary)
  root.style.setProperty('--primary-foreground', foreground)
}

function clearVars(): void {
  const root = document.documentElement
  root.style.removeProperty('--primary')
  root.style.removeProperty('--ring')
  root.style.removeProperty('--primary-foreground')
}

async function render(): Promise<void> {
  const mySeq = ++renderSeq
  if (currentMode === THEME_COLOR_MODE_BACKGROUND) {
    if (!currentBgUrl) { clearVars(); return }
    const hex = await extractAccentFromImageUrl(currentBgUrl)
    if (mySeq !== renderSeq) return // 取色期间设置/背景又变了，丢弃过时结果
    if (hex) setVars(hex); else clearVars()
    return
  }
  if (currentMode) setVars(currentMode)
  else clearVars()
}

/**
 * 应用（或清除）主题强调色。`color` 为 hex / 空（默认）/ `'background'`（跟随背景）。
 * 取色是异步的，最终在完成后落盘到 CSS 变量。
 */
export async function applyThemeColor(color?: string | null): Promise<void> {
  if (color === THEME_COLOR_MODE_BACKGROUND) currentMode = THEME_COLOR_MODE_BACKGROUND
  else currentMode = (color && normalizeHex(color)) || ''
  await render()
}

/**
 * 上报当前背景图 URL。模式为「跟随背景」且背景发生变化时会自动重取色。
 * 传空表示当前无背景（回退默认主题色）。
 */
export function setThemeBackground(url?: string | null): void {
  currentBgUrl = url || ''
  if (currentMode === THEME_COLOR_MODE_BACKGROUND) void render()
}

