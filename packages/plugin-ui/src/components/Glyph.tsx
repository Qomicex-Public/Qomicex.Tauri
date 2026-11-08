// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// <Glyph> 刻意不 import catalog：它是「渲染一个已导入的字形」的纯展示组件。
// 若在这里 import catalog，任何用 <Glyph> 的插件都会被拖进整张 160KB 图标表
// （tree-shaking 失效）。按名字查表的能力在 <Icon> 里（见 Icon.tsx）。
import * as React from 'react'
import { cn } from '../lib/cn.js'
import type { IconGlyph } from '../icons/catalog.js'

export interface GlyphProps extends Omit<React.SVGProps<SVGSVGElement>, 'ref'> {
  /** 从 `@qomicex/plugin-ui/icons/<name>` 静态导入的字形。 */
  icon: IconGlyph
  /** 无障碍名。给出时图标有语义（role="img"），否则视为装饰性。 */
  label?: string
}

/**
 * 渲染一个已经导入好的字形（推荐用法）。
 *
 * 单图标从子路径静态导入，打包器只留用到的 path —— 零 IPC，也不背包内其它图标：
 * ```tsx
 * import { Glyph } from '@qomicex/plugin-ui'
 * import { ServerIcon } from '@qomicex/plugin-ui/icons/server'
 *
 * <Glyph icon={ServerIcon} className="h-4 w-4" />
 * ```
 */
export const Glyph = React.forwardRef<SVGSVGElement, GlyphProps>(
  ({ icon, label, className, ...props }, ref) => {
    const [width, height, path] = icon
    return (
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        fill="currentColor"
        className={cn('shrink-0', className)}
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        {...props}
      >
        <path d={path} />
      </svg>
    )
  },
)
Glyph.displayName = 'Glyph'
