export const ICON_THEME_SCHEMA_VERSION = 1

export interface IconThemeEntry {
  type: 'svg' | 'char' | 'url'
  path?: string
  codepoint?: string
  fontFamily?: string
  url?: string
}

export interface IconThemeDefinition {
  schemaVersion: number
  fonts?: string[]
  icons: Record<string, IconThemeEntry>
}

export class IconThemeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IconThemeError'
  }
}

export function validateIconTheme(raw: unknown): IconThemeDefinition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new IconThemeError('icon-theme.json 顶层必须是对象')

  const o = raw as Record<string, unknown>
  if (o.schemaVersion !== ICON_THEME_SCHEMA_VERSION)
    throw new IconThemeError(`icon-theme.json 的 schemaVersion 必须为 ${ICON_THEME_SCHEMA_VERSION}`)

  const icons: Record<string, IconThemeEntry> = {}
  const rawIcons = o.icons
  if (typeof rawIcons !== 'object' || rawIcons === null || Array.isArray(rawIcons))
    throw new IconThemeError('icon-theme.json 的 icons 必须是对象')
  if (Object.keys(rawIcons).length === 0)
    throw new IconThemeError('icon-theme.json 至少需要一个图标（icons 不能为空）')

  for (const [key, val] of Object.entries(rawIcons as Record<string, unknown>)) {
    if (typeof val !== 'object' || val === null)
      throw new IconThemeError(`icons["${key}"] 必须是对象`)
    const entry = val as Record<string, unknown>
    if (entry.type !== 'svg' && entry.type !== 'char' && entry.type !== 'url')
      throw new IconThemeError(`icons["${key}"] 的 type 必须为 "svg"、"char" 或 "url"`)
    const result: IconThemeEntry = { type: entry.type }
    if (entry.type === 'svg') {
      if (typeof entry.path !== 'string' || !entry.path.trim())
        throw new IconThemeError(`icons["${key}"] type=svg 需要 path`)
      result.path = entry.path.trim()
    } else if (entry.type === 'char') {
      if (typeof entry.codepoint !== 'string' || !entry.codepoint.trim())
        throw new IconThemeError(`icons["${key}"] type=char 需要 codepoint`)
      result.codepoint = entry.codepoint.trim()
      if (entry.fontFamily !== undefined) {
        if (typeof entry.fontFamily !== 'string')
          throw new IconThemeError(`icons["${key}"] 的 fontFamily 必须是字符串`)
        result.fontFamily = entry.fontFamily
      }
    } else if (entry.type === 'url') {
      if (typeof entry.url !== 'string' || !entry.url.trim())
        throw new IconThemeError(`icons["${key}"] type=url 需要 url`)
      result.url = entry.url.trim()
    }
    icons[key] = result
  }

  const fonts = Array.isArray(o.fonts) ? (o.fonts as unknown[]).filter((f): f is string => typeof f === 'string') : undefined

  return { schemaVersion: ICON_THEME_SCHEMA_VERSION, fonts: fonts?.length ? fonts : undefined, icons }
}