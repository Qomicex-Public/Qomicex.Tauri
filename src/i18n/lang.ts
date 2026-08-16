// 语言解析纯函数（无 React 依赖，供 I18nProvider 与插件桥共用）
import type { Lang } from './types.ts'

/** 可选项 = 具体语言 + 'system'（跟随系统，每次启动解析） */
export type LangChoice = Lang | 'system'

export const LANGS: { value: Lang; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文（台灣）' },
  { value: 'zh-HK', label: '繁體中文（香港）' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ru-RU', label: 'Русский' },
]

const SUPPORTED: Lang[] = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ru-RU']

/** 跟随系统：按浏览器/OS 语言映射到最近支持的语言 */
export function detectSystemLang(): Lang {
  const loc = (navigator.language || '').toLowerCase()
  if (loc.startsWith('zh')) {
    if (/zh-hk/.test(loc)) return 'zh-HK'
    if (/zh-(tw|mo)/.test(loc) || loc.includes('hant')) return 'zh-TW'
    return 'zh-CN'
  }
  if (loc.startsWith('en')) {
    return loc.includes('gb') || loc.includes('uk') ? 'en-GB' : 'en-US'
  }
  if (loc.startsWith('ja')) {
    return 'ja-JP'
  }
  if (loc.startsWith('ru')) {
    return 'ru-RU'
  }
  return 'en-US'
}

/** 存储值 → 具体语言；旧值 'en' 兼容映射到 'en-US'，'system' 动态解析，未知回退默认 */
export function resolveLang(raw: string | null | undefined): Lang {
  if (raw === 'system') return detectSystemLang()
  const v = raw === 'en' ? 'en-US' : raw
  return (SUPPORTED as string[]).includes(v ?? '') ? (v as Lang) : 'en-US'
}