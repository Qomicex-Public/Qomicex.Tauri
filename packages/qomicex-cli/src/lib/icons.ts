// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 图标名校验（issue #300）。启动器只在 `getIconSvg`/`PluginIcon` 里认
// `BuiltinIcons.tsx` 表内的类名，表外一律渲染空白 —— 而且是静默的。
// 这类缺陷在人工测试里几乎碰不到（要恰好看到那个按钮），必须在打包前静态拦截。
//
// 校验两个来源：
//   1. manifest 的图标字段（顶层 icon / menuItems[].icon / installModes[].icon）
//   2. 源码里以字面量形式出现的 `fa-solid fa-*` / `fa-brands fa-*`
//
// 判为「没问题」的写法（不报）：
//   - emoji / 纯文本 / 包内相对路径 / 绝对 URL（manifest 允许的另两种写法）
//   - 插件自带 iconTheme 声明过的私有键（必须同时声明 contributes.iconTheme）
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ICON_NAMES, ICON_NAME_LIST } from './icon-catalog.ts'
import { collectSourceFiles, type ScanFinding } from './scan.ts'

/** 源码里的 FA 类名（`fa-solid fa-x` / `fa-brands fa-x`，可只写 `fa-solid fa-x`）。 */
const FA_CLASS_RE = /\bfa-(?:solid|brands)\s+fa-[a-z0-9-]+\b/g

/** manifest 图标字段是否为「FA 类名」形态（其余形态交回启动器的图片/文本分支）。 */
function isFaClass(value: string): boolean {
  return /^fa-(?:solid|brands)\s+fa-[a-z0-9-]+$/.test(value.trim())
}

/** 读插件 iconTheme 里声明的键（未声明 contributes.iconTheme 时返回空集）。 */
function iconThemeKeys(root: string, contributes: Record<string, unknown> | undefined): Set<string> {
  const keys = new Set<string>()
  const themePath = contributes?.iconTheme
  if (typeof themePath !== 'string' || !themePath) return keys
  const candidates = [
    join(root, themePath),
    join(root, themePath.replace(/^dist\//, '')),
    join(root, 'dist', themePath),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { icons?: Record<string, unknown> }
      for (const key of Object.keys(raw.icons ?? {})) keys.add(key)
    } catch {
      /* 非法 JSON 由别处报错，这里静默 */
    }
    break
  }
  return keys
}

/** 给未知图标名挑几个「看起来像」的建议（同前缀 / 子串匹配），最多 3 个。 */
function suggest(name: string): string[] {
  const token = name.replace(/^fa-(?:solid|brands)\s+/, '')
  const words = token.split('-').filter(Boolean)
  const scored = ICON_NAME_LIST
    .filter((n) => n.startsWith('fa-solid fa-'))
    .map((n) => {
      const t = n.replace('fa-solid fa-', '')
      let score = 0
      if (t === token) score += 100
      if (t.includes(token) || token.includes(t)) score += 50
      for (const w of words) if (t.includes(w)) score += 10
      return { n, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, 3).map((x) => x.n)
}

function describeUnknown(name: string, where: string): string {
  const hints = suggest(name)
  const tail = hints.length ? `；相近的内置图标：${hints.join('、')}` : ''
  return `${where} 使用了启动器内置表里没有的图标 ${JSON.stringify(name)}（渲染为空）${tail}`
}

export interface IconCheckOptions {
  manifest: Record<string, unknown>
}

/**
 * 检查 manifest 图标字段与源码里的 FA 字面量。
 *
 * 严重级：
 * - error：FA 类名不在内置表（保证是渲染空白，必错）
 * - warning：`fa-solid fa-` 前缀但语法不像合法类名（可能是拼接出来的字符串）
 */
export function checkIcons(root: string, opts: IconCheckOptions): ScanFinding[] {
  const findings: ScanFinding[] = []
  const contributes = opts.manifest.contributes as Record<string, unknown> | undefined
  const themes = iconThemeKeys(root, contributes)

  const known = (name: string): boolean => ICON_NAMES.has(name) || themes.has(name)

  // ---- 1. manifest 里的图标字段 ----
  const fields: Array<[string, unknown]> = [['icon', opts.manifest.icon]]
  const menuItems = Array.isArray(contributes?.menuItems) ? (contributes!.menuItems as Record<string, unknown>[]) : []
  menuItems.forEach((item, i) => fields.push([`contributes.menuItems[${i}].icon`, item.icon]))
  const installModes = Array.isArray(contributes?.installModes) ? (contributes!.installModes as Record<string, unknown>[]) : []
  installModes.forEach((item, i) => fields.push([`contributes.installModes[${i}].icon`, item.icon]))
  const settingsPages = Array.isArray(contributes?.settingsPages) ? (contributes!.settingsPages as Record<string, unknown>[]) : []
  settingsPages.forEach((item, i) => fields.push([`contributes.settingsPages[${i}].icon`, item.icon]))

  for (const [path, raw] of fields) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const value = raw.trim()
    if (!isFaClass(value)) continue // emoji / 文本 / 路径 / URL 都合法
    if (known(value)) continue
    findings.push({ severity: 'error', message: describeUnknown(value, `manifest ${path}`), file: 'manifest.json' })
  }

  // ---- 2. 源码里的 FA 字面量 ----
  for (const file of collectSourceFiles(root)) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const seen = new Set<string>()
    for (const m of content.matchAll(FA_CLASS_RE)) {
      const name = m[0]
      if (seen.has(name) || known(name)) continue
      seen.add(name)
      const lineNo = content.slice(0, m.index).split('\n').length
      findings.push({
        severity: 'error',
        message: describeUnknown(name, '源码'),
        file: `${relative(root, file)}:${lineNo}`,
      })
    }
  }

  return findings
}
