// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import * as React from 'react'
import { cn } from '../lib/cn.js'
import type { IconGlyph } from '../icons/catalog.js'

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'ref'> {
  /** 启动器内置图标类名，如 `fa-solid fa-server`。合法集合见 `ICON_NAMES`。 */
  name: string
  /** 无障碍名。给出时图标有语义（role="img"），否则视为装饰性。 */
  label?: string
  /** 查表未完成（首帧）时渲染什么。默认 null（不留空档）；给 `true` 渲染占位方块。 */
  placeholder?: boolean
}

/**
 * 按类名渲染内置图标（动态查表）。
 *
 * ⚠️ `name` 是运行期字符串，打包器无法 tree-shake —— 整张图标表（约 160KB）会随
 * 这个组件进包。因此 catalog 走**动态 import**：只在真的渲染了 `<Icon>` 时才加载，
 * 完全不用的插件不受影响。图标名在编译期已知时，请改用单图标子路径 + `<Glyph>`：
 *
 * ```tsx
 * import { Glyph } from '@qomicex/plugin-ui'
 * import { ServerIcon } from '@qomicex/plugin-ui/icons/server'
 * <Glyph icon={ServerIcon} className="h-4 w-4" />
 * ```
 *
 * 未登记的类名渲染 `null` 并在开发构建告警；`qomicex lint` 会在打包前拦成 error。
 */
export const Icon = React.forwardRef<SVGSVGElement, IconProps>(
  ({ name, className, label, placeholder, ...props }, ref) => {
    const [glyph, setGlyph] = React.useState<IconGlyph | null>(null)

    React.useEffect(() => {
      let cancelled = false
      void import('../icons/catalog.js').then(({ resolveIconGlyph }) => {
        if (cancelled) return
        const found = resolveIconGlyph(name)
        if (!found && isDev()) {
          console.warn(
            `[Icon] 图标不在启动器内置目录内: ${JSON.stringify(name)}。` +
              `运行 qomicex lint 定位，或用 contributes.iconTheme 自带图标。`,
          )
        }
        setGlyph(found)
      })
      return () => { cancelled = true }
    }, [name])

    if (!glyph) {
      // 首帧/未命中：不留空档，但给调用方选择占位的余地
      return placeholder ? <span ref={ref as never} className={cn('inline-block shrink-0', className)} aria-hidden="true" /> : null
    }

    const [width, height, path] = glyph
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
Icon.displayName = 'Icon'

/** 开发构建判定：`process.env.NODE_ENV` 由打包器静态替换；沙箱里没有 process 时静默。 */
declare const process: { env?: { NODE_ENV?: string } } | undefined
function isDev(): boolean {
  return typeof process !== 'undefined' && process?.env?.NODE_ENV !== 'production'
}
