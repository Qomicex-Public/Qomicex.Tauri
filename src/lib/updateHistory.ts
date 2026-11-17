// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/updateHistory.ts
//
// 更新日志（changelog markdown）→ 结构化条目。
//
// 输入是 `scripts/generate-changelog.mjs` 的固定产物：
//
//     ## Qomicex Launcher 1.2.0-beta1.0
//
//     **Beta 版本**
//
//     ---
//
//     #### ✨ 新增功能
//
//     - 某条改动 (#123)
//     - 另一条改动
//
//     #### 🐛 修复
//
//     - 修了点什么
//
// 分类名来自生成器的 `CATEGORIES`（新增功能/修复/重构/性能优化）。**不在这里
// 硬编码中文以外的东西**：老版本或上游改了文案时，`parse` 返回 null，调用方
// 退回「整段 markdown 直接渲染」——降级路径保证最坏情况只是少了分类标签，
// 不会出现空列表。

/** 条目分类。`other` 用于无法识别的分类段（内容仍然展示）。 */
export type UpdateCategory = 'feat' | 'fix' | 'refactor' | 'perf' | 'other'

export interface UpdateEntry {
  category: UpdateCategory
  text: string
}

export interface ParsedNotes {
  entries: UpdateEntry[]
}

/**
 * 分类标题 → 分类。键是 `#### ` 之后的完整标题（去 emoji 后比较）。
 *
 * 同时接受带 emoji 与不带 emoji 的写法，避免上游哪天去掉 emoji 就全部
 * 落进 `other`。
 */
const CATEGORY_TITLES: Array<[string, UpdateCategory]> = [
  ['新增功能', 'feat'],
  ['修复', 'fix'],
  ['重构', 'refactor'],
  ['性能优化', 'perf'],
]

/** 去掉开头的 emoji / 变体选择符 / 空白，只留文字部分。 */
function stripLeadingSymbols(raw: string): string {
  // \p{Extended_Pictographic} 覆盖 ✨🐛🔧⚡；\uFE0F 是变体选择符。
  return raw.replace(/^[\s\p{Extended_Pictographic}\uFE0F\u200D]+/u, '').trim()
}

/** `#### 标题` 行 → 分类；不是分类标题返回 null。 */
function categoryOfHeading(line: string): UpdateCategory | null {
  const text = stripLeadingSymbols(line)
  for (const [title, category] of CATEGORY_TITLES) {
    if (text === title) return category
  }
  return null
}

/**
 * 解析一个版本的 notes。
 *
 * 任何一段 `#### ` 之后都算该分类的条目区；`- ` 开头的行是条目，缩进的续行
 * 并回上一条（生成器不产续行，但手写的 release body 可能有）。
 *
 * 返回 `null` = 这段 notes 不符合生成器格式（没有识别出任何分类），
 * 调用方应退回 markdown 原文渲染。
 */
export function parseNotes(notes: string): ParsedNotes | null {
  if (!notes.trim()) return null

  const entries: UpdateEntry[] = []
  let current: UpdateCategory | null = null
  let sawCategory = false

  for (const rawLine of notes.split('\n')) {
    const line = rawLine.trimEnd()

    if (line.startsWith('#### ')) {
      const category = categoryOfHeading(line.slice(5))
      // 无法识别的分类段：内容仍要展示，归到 other 而不是丢弃。
      current = category ?? 'other'
      sawCategory = true
      continue
    }

    if (current === null) continue

    if (line.startsWith('- ')) {
      const text = line.slice(2).trim()
      if (text) entries.push({ category: current, text })
      continue
    }

    // 缩进续行：并回上一条，保留原文（含其中的 markdown 语法）。
    if (line.startsWith('  ') && entries.length > 0) {
      const last = entries[entries.length - 1]
      last.text = `${last.text}\n${line.trim()}`
    }
  }

  if (!sawCategory || entries.length === 0) return null
  return { entries }
}

/** 分类 → i18n key（标签文字）。 */
export function categoryLabelKey(category: UpdateCategory): string {
  switch (category) {
    case 'feat':
      return 'dialogs.update.category.feat'
    case 'fix':
      return 'dialogs.update.category.fix'
    case 'refactor':
      return 'dialogs.update.category.refactor'
    case 'perf':
      return 'dialogs.update.category.perf'
    case 'other':
      return 'dialogs.update.category.other'
  }
}

/**
 * 默认展开几个版本段。
 *
 * 单个 beta 的 notes 常有 30-40 条，全部展开会让弹窗首屏极长；参考设计里
 * 也只展开最近的几个，其余折叠成「还有 N 个更早的版本」。
 */
export const DEFAULT_VISIBLE_VERSIONS = 3

/**
 * 把版本列表切成「默认展开」与「折叠区」两段。
 *
 * 返回值 `older` 为空时，调用方不渲染折叠入口（少一个可点的死循环）。
 */
export function splitVisibleVersions<T>(
  versions: T[],
  visible = DEFAULT_VISIBLE_VERSIONS,
): { visible: T[]; older: T[] } {
  if (versions.length <= visible) return { visible: versions, older: [] }
  return { visible: versions.slice(0, visible), older: versions.slice(visible) }
}

/**
 * 版本号 → 展示文本。去 `v` 前缀后重新加一个，避免上游给 `v1.2.0` 时
 * 显示成 `vv1.2.0`。
 */
export function displayVersion(version: string): string {
  const clean = (version || '').trim().replace(/^v+/, '')
  return clean ? `v${clean}` : ''
}

/** 判定「该不该走跨版本视图」所需的最小数据结构（避免依赖 api 层的完整类型）。 */
export interface SpanningInput {
  spanning: boolean
  entries: Array<{ version: string }>
}

/**
 * 本次该用「跨版本视图」还是退回单块 changelog。
 *
 * 判据不是「有没有 entries」，而是两条都必须成立：
 *
 * 1. `spanning` —— 真的跨了多个版本。上游只命中一条时（单次小版本升级），
 *    该走原来的单块渲染：跨版本视图为一条内容套版本段头与折叠入口是噪音，
 *    而且它会用上游的 notes 取代 `plan.changelog`，两者内容可能不同源。
 * 2. **目标版本在列表里** —— 上游历史可能滞后（新版本刚发布还没 sync 到，
 *    或 `per_page=50` 窗口已滑过目标版本）。此时若照旧切到跨版本视图，用户
 *    看不到「他要装的那一版改了什么」——而这正是弹窗的核心信息。
 *
 * 返回 `null` 表示该退回单块 changelog 渲染。
 */
export function pickSpanningEntries<T extends { version: string }>(
  history: SpanningInput & { entries: T[] },
  targetVersion: string | undefined,
): T[] | null {
  if (!history.spanning || history.entries.length === 0) return null
  if (!targetVersion) return history.entries
  const wanted = targetVersion.trim().replace(/^v+/, '')
  const hasTarget = history.entries.some(
    (e) => e.version.trim().replace(/^v+/, '') === wanted,
  )
  return hasTarget ? history.entries : null
}
