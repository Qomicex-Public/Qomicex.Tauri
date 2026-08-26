/**
 * 主题管理器：加载 / 切换 / 持久化自定义 `.qtheme` 颜色主题 + 图标主题。
 *
 * v1 能力：
 *  - 解析校验 theme.json（schema.ts）→ 注入 `<style>` 到 `:root[data-theme="<id>"]`；
 *  - 组件 / 插件 UI 只消费 `var(--*)` → 换主题 = 全量即时换肤，无需重建 plugin-ui dist；
 *  - 持久化当前主题 id 到 localStorage，启动时恢复；
 *  - `useTheme()` 订阅事件驱动重渲染（对应「事件驱动全组件换肤」）。
 *
 * 图标主题（v1.5）：
 *  - `registerTheme(raw, iconRaw?)` 可同时注册 icon-theme.json（icon-theme.ts 校验）；
 *  - `getActiveIconTheme()` / `useIconTheme()` 取当前主题的图标映射；
 *  - `PluginIcon` 渲染时优先查该映射（svg/char/url），未命中回退 FontAwesome。
 *
 * 内置 Catppuccin 预设以 `.qtheme` 迁移（themes/*.json），值同 index.css → 视觉零回归。
 * 计算层 theme.mjs / 字体贡献 UI = v2 之后（TODO）。
 */

import { useEffect, useState } from 'react'
import {
  validateTheme,
  themeToCssBlock,
  ThemeError,
  type ColorTheme,
} from './schema.ts'
import {
  validateIconTheme,
  type IconThemeDefinition,
} from './icon-theme.ts'

const STYLE_ID = 'qomicex-theme-custom'
const STORAGE_KEY = 'qomicex-active-theme'

/**
 * 主题选择器：裸 `:root`。既有 App 主题流会管理 `data-theme`（预设 latte 等），
 * 依赖 data-theme 选择器会被其 `delete root.dataset.theme` 抹掉；裸 :root 注入
 * 位于 head 末尾 → 源顺序胜出，覆盖 light/dark 基色，稳健且不自相矛盾。
 */
const SELECTOR = ':root'

type Listener = () => void
const listeners = new Set<Listener>()
let activeTheme: ColorTheme | null = null

/** 已注册的可选内置主题（id → theme）。 */
const registry = new Map<string, ColorTheme>()

/** 已注册的图标主题（theme id → icon-theme.json）。 */
const iconRegistry = new Map<string, IconThemeDefinition>()

function emit(): void {
  listeners.forEach((fn) => fn())
}

function applyToDom(theme: ColorTheme | null): void {
  const root = document.documentElement
  const el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!theme) {
    if (el) el.remove()
    root.style.colorScheme = ''
    return
  }
  const style = el ?? Object.assign(document.createElement('style'), { id: STYLE_ID })
  style.textContent = themeToCssBlock(theme, SELECTOR)
  if (!el) document.head.appendChild(style)
  root.style.colorScheme = theme.scheme ?? 'light dark'
}

/** 注册一个内置/打包的 `.qtheme`（值已校验），供按 id 应用。可携带同名 icon-theme.json。 */
export function registerTheme(raw: unknown, iconRaw?: unknown): ColorTheme {
  const theme = validateTheme(raw)
  registry.set(theme.id, theme)
  if (iconRaw !== undefined) registerIconTheme(theme.id, iconRaw)
  return theme
}

/** 注册某主题 id 的 icon-theme.json（单独注册，供 `applyTheme` 后补充）。 */
export function registerIconTheme(themeId: string, iconRaw: unknown): IconThemeDefinition {
  const def = validateIconTheme(iconRaw)
  iconRegistry.set(themeId, def)
  return def
}

/** 应用一个自定义主题。`json` 可为对象或 JSON 字符串；非法抛 ThemeError。 */
export function applyTheme(json: string | unknown): ColorTheme {
  let raw: unknown = json
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json)
    } catch {
      throw new ThemeError('theme.json 不是合法 JSON')
    }
  }
  const theme = validateTheme(raw)
  activeTheme = theme
  applyToDom(theme)
  try {
    localStorage.setItem(STORAGE_KEY, theme.id)
  } catch { /* 私有模式忽略 */ }
  emit()
  return theme
}

/** 清除自定义主题，回到设置层主题（light/dark/预设）。 */
export function clearTheme(): void {
  activeTheme = null
  applyToDom(null)
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* 忽略 */ }
  emit()
}

export function getActiveTheme(): ColorTheme | null {
  return activeTheme
}

/** 当前主题的 icon-theme.json（无则 null）。 */
export function getActiveIconTheme(): IconThemeDefinition | null {
  if (!activeTheme) return null
  return iconRegistry.get(activeTheme.id) ?? null
}

/** 启动时恢复持久化的自定义主题（仅对已注册主题生效；无则 no-op）。 */
export function restoreSavedTheme(): ColorTheme | null {
  const id = localStorage.getItem(STORAGE_KEY)
  if (!id) return null
  const theme = registry.get(id)
  if (!theme) {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch { /* 忽略 */ }
    return null
  }
  activeTheme = theme
  applyToDom(theme)
  return theme
}

export function subscribeThemeChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export interface UseThemeResult {
  theme: ColorTheme | null
  applyTheme: typeof applyTheme
  clearTheme: typeof clearTheme
}

/** 订阅主题变更并触发重渲染的 React Hook。 */
export function useTheme(): UseThemeResult {
  const [, force] = useState(0)
  useEffect(() => subscribeThemeChange(() => force((x) => x + 1)), [])
  return { theme: getActiveTheme(), applyTheme, clearTheme }
}

/** 订阅主题变更，返回当前主题的图标映射（icon-theme.json）。 */
export function useIconTheme(): IconThemeDefinition | null {
  const [, force] = useState(0)
  useEffect(() => subscribeThemeChange(() => force((x) => x + 1)), [])
  return getActiveIconTheme()
}
