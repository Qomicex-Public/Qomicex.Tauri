// 把设置映射到 DOM（CSS 变量 / dataset）的唯一实现。
//
// 此前这段逻辑在 `App.tsx`（onSettingsChange 回调）与 `pages/Settings.tsx`
// （saveSettings）各写一份，`components/Layout.tsx` 还另有第三处 `--radius`。
// 三份必须同步演进，否则会出现「改完设置当场生效、重启后又不同」这类难查的不一致
// （#238）。更实际的是它们**已经漂移**：`dataset.animGpu` 只有 App.tsx 设了，
// Settings.tsx 漏设 —— 在设置页关闭 GPU 加速后，必须等重启（或别的设置变更触发
// App 的回调）才生效。
//
// 约定：所有「裸设置值 → CSS 变量」的转换只在本文档里做一次；调用方只管在
// 设置变更时调用 [`applySettingsToDom`]。

import type { AppSettings } from '../api/settings.ts'

/**
 * 把一份设置应用到 `<html>`（CSS 变量 + dataset）。
 *
 * 幂等：可重复调用；未提供的可选字段按各自默认值回退（与设置页默认一致）。
 * 不处理主题色（`applyThemeColor` 是异步取色，由调用方单独调用）与主题
 * dark/light 解析（依赖系统偏好，由调用方解析后 `classList.toggle`）。
 */
export function applySettingsToDom(s: AppSettings): void {
  const root = document.documentElement

  // ---- 动画 ----
  const enabled = s.animationsEnabled !== false
  const speed = s.animationSpeed ?? 1
  const maxFps = s.maxFrameRate ?? 0
  const fpsScale = maxFps > 0 ? 60 / maxFps : 1
  root.dataset.animEnabled = String(enabled)
  // 缺失 = 开启（默认开）。这一项此前只在 App.tsx 设置，设置页改动不会即时生效。
  root.dataset.animGpu = String(s.gpuAcceleration !== false)
  root.dataset.maxFps = String(maxFps)
  root.style.setProperty('--anim-duration-multiplier', String((1 / speed) * fpsScale))

  // ---- 字体 ----
  applyFont(s.fontFamily)

  // ---- 圆角 ----
  root.style.setProperty('--radius', `${s.cornerRadius ?? 8}px`)

  // ---- 组件材质 ----
  root.dataset.material = s.componentMaterial ?? 'default'
  root.style.setProperty('--glass-blur', `${Math.max(0, s.glassBlur ?? 18)}px`)

  // ---- 默认材质卡片样式 ----
  // 透明度：0-100 → 0-1；默认 50（半透明）
  const cardOpacity = Math.min(100, Math.max(0, s.cardOpacity ?? 50))
  root.style.setProperty('--card-opacity', String(cardOpacity / 100))
  // 边框颜色：合法 hex 才覆盖，否则回退主题边框色
  const borderColor = s.cardBorderColor?.trim()
  if (borderColor && /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(borderColor)) {
    root.style.setProperty('--card-border-color', borderColor)
  } else {
    root.style.removeProperty('--card-border-color')
  }
  // 边框厚度：默认 1px 时移除变量回退；其余（含 0）覆盖
  const borderWidth = Math.max(0, s.cardBorderWidth ?? 1)
  if (borderWidth === 1) root.style.removeProperty('--card-border-width')
  else root.style.setProperty('--card-border-width', `${borderWidth}px`)

  // ---- 对话框透明度 ----
  // 0-100 → 0-1；默认 75（半透明，独立于卡片材质）
  const dialogOpacity = Math.min(100, Math.max(0, s.dialogOpacity ?? 75))
  root.style.setProperty('--dialog-opacity', String(dialogOpacity / 100))
}

/**
 * 应用自定义字体（`--app-font`）。空/缺失 = 移除变量，回退系统默认字体。
 * 单引号与双引号一并剥掉，避免用户输入破坏 CSS 值。
 */
export function applyFont(family: string | undefined): void {
  const root = document.documentElement
  if (family && family.trim()) {
    root.style.setProperty('--app-font', `'${family.replace(/['"]/g, '')}', sans-serif`)
  } else {
    root.style.removeProperty('--app-font')
  }
}

/**
 * 应用主题预设（`data-theme`）。
 *
 * 后端缺 `themePreset`（旧后端丢弃该字段）时回退到前端本地存储，
 * 避免切页即回默认。
 */
export function applyThemePreset(preset: AppSettings['themePreset'] | undefined): void {
  const root = document.documentElement
  const effective =
    preset ?? (localStorage.getItem('qomicex-theme-preset') as AppSettings['themePreset'] | null) ?? 'default'
  if (effective && effective !== 'default') root.dataset.theme = effective
  else delete root.dataset.theme
}
