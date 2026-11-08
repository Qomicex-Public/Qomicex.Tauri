// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { cn } from '../lib/utils.ts'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { resolveFaIcon } from './BuiltinIcons.tsx'
import { resolvePluginIcon, type IconThemeEntry } from '../theme/index.ts'

function isImageUrl(s: string): boolean {
  return /^(https?:\/\/|data:)/i.test(s) || /^[\w.-]+\/.+\.\w+$/.test(s)
}

/** 文档承诺的第三种写法：emoji / 纯文本（如 "🏆"、"A"）。 */
function isTextIcon(s: string): boolean {
  if (!s) return false
  if (s.startsWith('fa-')) return false
  // 单个字形（含 emoji 组合序列）或极短文本才按文本图标渲染；
  // 再长就不是图标而是数据写错了。
  return [...s].length <= 4
}

function FaIcon({ cls, className }: { cls: string; className?: string }) {
  const icon = resolveFaIcon(cls)
  if (!icon) return null
  return <FontAwesomeIcon icon={icon} className={className} />
}

function ThemeEntryIcon({ entry, className }: { entry: IconThemeEntry; className?: string }) {
  if (entry.type === 'svg') {
    return (
      <svg viewBox="0 0 512 512" fill="currentColor" className={className} aria-hidden="true">
        <path d={entry.path} />
      </svg>
    )
  }
  if (entry.type === 'char') {
    return (
      <span className={className} style={entry.fontFamily ? { fontFamily: entry.fontFamily } : undefined}>
        {entry.codepoint}
      </span>
    )
  }
  return <img src={entry.url} alt="" className={cn('object-contain', className)} />
}

/**
 * 插件图标渲染：manifest 里 `icon` 字段的三种合法写法都在这里落地
 * （见 docs/plugins/manifest 的「icon 字段规范」）：
 *
 * 1. Font Awesome 类名（`fa-solid fa-server`）—— 必须在启动器 BuiltinIcons 表内；
 * 2. 包内相对路径 / 绝对 URL（`dist/icon.svg`、`https://…`）—— 按图片渲染；
 * 3. emoji / 纯文本（`🏆`、`A`）—— 按字形渲染。
 *
 * 查找顺序：插件 iconTheme → 颜色主题 iconTheme → 上述三种写法。
 * 全都不命中时渲染 `fallback`（调用方给的兜底字形/字符），**不再返回 null**：
 * 旧实现直接 return null，会让「写了但写错」的图标变成可见的空白位，
 * 且没有任何诊断信息（issue #300）。
 */
export function PluginIcon({ icon, fallback, pluginId, className }: { icon?: string; fallback: string; pluginId?: string; className?: string }) {
  const src = icon || fallback

  if (pluginId && src) {
    const entry = resolvePluginIcon(pluginId, src)
    if (entry) return <ThemeEntryIcon entry={entry} className={className} />
  }

  if (src && isImageUrl(src)) {
    return <img src={src} alt="" className={cn('object-contain', className)} />
  }

  if (src?.startsWith('fa-')) {
    if (resolveFaIcon(src)) return <FaIcon cls={src} className={className} />
    // 表外的 fa-* 类名：报出来再降级到兜底字形，避免静默空白
    console.warn(
      `[PluginIcon] 图标不在启动器内置表内: ${JSON.stringify(src)}` +
        `${pluginId ? `（插件 ${pluginId}）` : ''}。` +
        `可用 qomicex lint 定位，或在 contributes.iconTheme 里声明私有图标。`,
    )
  } else if (src && isTextIcon(src)) {
    return (
      <span className={cn('inline-flex items-center justify-center leading-none', className)} aria-hidden="true">
        {src}
      </span>
    )
  }

  return fallback ? (
    <span className={cn('inline-flex items-center justify-center leading-none', className)} aria-hidden="true">
      {fallback}
    </span>
  ) : null
}
