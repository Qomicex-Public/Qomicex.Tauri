// 轻量 i18n：I18nProvider + useI18n。零依赖，TS 强类型 key。
// 语言持久化：localStorage('qomicex-language') 即时生效；与后端 settings.language 双向同步。
import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import zhCN from './zh-CN/index'
import en from './en/index'
import type { Lang, DeepKeys, TranslationSchema } from './types'
import { onSettingsChange } from '../api/settings.ts'
import { setApiErrorTranslator } from '../api/client.ts'
import { translateApiError } from './errors.ts'

const RESOURCES: Record<Lang, TranslationSchema> = { 'zh-CN': zhCN, en }

export const LANGS: { value: Lang; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

const STORAGE_KEY = 'qomicex-language'

export type TranslationKey = DeepKeys<TranslationSchema>

interface I18nContextValue {
  lang: Lang
  /** 取翻译；{name} 形式占位符可用 params 替换 */
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
  setLanguage: (lang: Lang) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

function resolveLang(raw: string | null | undefined): Lang {
  return raw === 'en' ? 'en' : 'zh-CN'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => resolveLang(localStorage.getItem(STORAGE_KEY)))

  const setLanguage = useCallback((l: Lang) => {
    localStorage.setItem(STORAGE_KEY, l)
    setLang(l)
  }, [])

  // 后端持久化的 settings.language 变化时同步（含启动 loadSettings 完成后的广播）
  useEffect(() => {
    return onSettingsChange((s) => {
      setLang((cur) => {
        const next = resolveLang(s.language)
        if (cur === next) return cur
        localStorage.setItem(STORAGE_KEY, next)
        return next
      })
    })
  }, [])

  // 语言变化时刷新 ApiError 翻译器（后端错误消息前端映射）
  useEffect(() => {
    setApiErrorTranslator((e) => translateApiError(e, lang))
    return () => setApiErrorTranslator(null)
  }, [lang])

  const t = useCallback((key: TranslationKey, params?: Record<string, string | number>) => {
    const dict = RESOURCES[lang] as unknown as Record<string, unknown>
    let val: unknown = dict
    for (const part of String(key).split('.')) {
      if (val && typeof val === 'object' && part in val) {
        val = (val as Record<string, unknown>)[part]
      } else {
        if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${String(key)} (${lang})`)
        return String(key)
      }
    }
    if (typeof val !== 'string') {
      if (import.meta.env.DEV) console.warn(`[i18n] non-string value for key: ${String(key)} (${lang})`)
      return String(key)
    }
    if (!params) return val
    return val.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
  }, [lang])

  const value = useMemo(() => ({ lang, t, setLanguage }), [lang, t, setLanguage])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
