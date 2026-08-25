/**
 * `.qtheme` 颜色主题 schema v1：校验 + 归一化 + 转 CSS 变量。
 *
 * v1 只做「颜色主题」：读 `theme.json`（zod 不可用、红线禁新依赖，故手写校验）
 * → 产出 CSS 变量写入 `:root[data-theme="<id>"]`，组件/插件 UI 经 `var(--*)` 即时换肤。
 * 计算层 `theme.mjs` / 图标 / 字体贡献 = v2 之后，此处留 TODO。
 */

export const THEME_SCHEMA_VERSION = 1

/** 启动器 + plugin-ui 实际消费的标准组件级色板 token（key 与 index.css 平铺名一一对应）。 */
export const KNOWN_COLOR_KEYS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
] as const

/** 非色 token（v1 支持项）。 */
export const KNOWN_MISC_KEYS = ['radius', 'glass-blur'] as const

export interface ColorTheme {
  id: string
  name: string
  scheme?: 'dark' | 'light'
  colors: Record<string, string>
  misc: Partial<Record<(typeof KNOWN_MISC_KEYS)[number], string>>
}

/** 校验失败的友好错误，message 面向主题作者可读。 */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThemeError'
  }
}

/** `accent.foreground` → `accent-foreground`（点分命名归一化）。 */
export function normalizeVarName(key: string): string {
  return key.trim().replace(/\.+/g, '-')
}

export function isValidVarName(key: string): boolean {
  return /^[a-z][a-z0-9.-]*$/.test(key)
}

/**
 * 校验并归一化 theme.json。
 * @throws ThemeError 非法输入时抛友好错误。
 */
export function validateTheme(raw: unknown): ColorTheme {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ThemeError('theme.json 顶层必须是对象')
  }
  const o = raw as Record<string, unknown>

  if (o.schemaVersion !== THEME_SCHEMA_VERSION) {
    throw new ThemeError(`theme.json 的 schemaVersion 必须为 ${THEME_SCHEMA_VERSION}（当前仅支持颜色主题）`)
  }
  if (typeof o.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(o.id)) {
    throw new ThemeError('theme.json 缺少合法 id（小写字母/数字/连字符开头，非空）')
  }
  if (typeof o.name !== 'string' || !o.name.trim()) {
    throw new ThemeError('theme.json 缺少 name')
  }
  if (o.type !== undefined && o.type !== 'color') {
    throw new ThemeError('theme.json 的 type 当前仅支持 "color"')
  }
  const scheme = o.scheme
  if (scheme !== undefined && scheme !== 'dark' && scheme !== 'light') {
    throw new ThemeError('theme.json 的 scheme 只能为 "dark" 或 "light"')
  }

  const colors: Record<string, string> = {}
  const rawColors = o.colors
  if (rawColors !== undefined) {
    if (typeof rawColors !== 'object' || rawColors === null || Array.isArray(rawColors)) {
      throw new ThemeError('theme.json 的 colors 必须是对象')
    }
    for (const [k, v] of Object.entries(rawColors as Record<string, unknown>)) {
      if (!isValidVarName(k)) throw new ThemeError(`无效的 token 名 "${k}"`)
      if (typeof v !== 'string' || !v.trim()) throw new ThemeError(`token "${k}" 的值必须是非空字符串`)
      colors[normalizeVarName(k)] = v.trim()
    }
  }
  if (Object.keys(colors).length === 0) {
    throw new ThemeError('theme.json 至少需要一个颜色 token（colors 不能为空）')
  }

  const misc: ColorTheme['misc'] = {}
  if (o.radius !== undefined) {
    if (typeof o.radius !== 'number') throw new ThemeError('theme.json 的 radius 必须是数字')
    misc.radius = `${o.radius}rem`
  }
  if (o.glassBlur !== undefined) {
    if (typeof o.glassBlur !== 'number') throw new ThemeError('theme.json 的 glassBlur 必须是数字')
    misc['glass-blur'] = `${o.glassBlur}px`
  }

  return { id: o.id, name: o.name.trim(), scheme, colors, misc }
}

/** 主题 → { `--token`: value } 映射。 */
export function themeToCssVars(theme: ColorTheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(theme.colors)) out[`--${k}`] = v
  for (const [k, v] of Object.entries(theme.misc)) if (v) out[`--${k}`] = v
  return out
}

/** 主题 → 可注入的 CSS 规则块（作用于指定选择器）。 */
export function themeToCssBlock(theme: ColorTheme, selector: string): string {
  const vars = themeToCssVars(theme)
  const inner = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n  ')
  return `${selector} {\n  ${inner}\n}`
}
