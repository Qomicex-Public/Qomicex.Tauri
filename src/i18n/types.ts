// i18n 类型定义：zh-CN 为基准 schema，en 必须结构一致（satisfies 编译期校验）
import type zhCN from './zh-CN/index'

export type Lang = 'zh-CN' | 'en'

/** 把叶子值放宽为 string（翻译值本身因语言而异，只校验 key 结构） */
type DeepStringify<T> = T extends object ? { [K in keyof T]: DeepStringify<T[K]> } : string

/** 完整翻译资源树类型（以 zh-CN 的 key 结构为基准） */
export type TranslationSchema = DeepStringify<typeof zhCN>

// 递归生成嵌套 key 联合类型：'common.ok' | 'layout.sidebar.home' | ...
export type DeepKeys<T> = T extends object
  ? { [K in keyof T]-?: K extends string ? `${K}` | `${K}.${DeepKeys<T[K]>}` : never }[keyof T]
  : never
