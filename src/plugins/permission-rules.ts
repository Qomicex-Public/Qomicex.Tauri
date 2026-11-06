// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { DEFAULT_PLUGIN_PERMISSION_CONFIG } from './types.ts'
import type { PluginPermissionConfig } from './types.ts'

/**
 * 会改变 manifest 静态贡献或注册表的权限：这些权限变更后必须重载插件，
 * 其余权限在调用时即时生效。
 */
export const CONTRIBUTION_PERMISSIONS = [
  'ui:inject_sidebar',
  'ui:inject_settings',
  'ui:sub_window',
  'hook:register',
] as const

/** 两次配置之间的贡献类权限是否发生变化（变化需要重载插件）。 */
export function contributionPermissionsChanged(
  before: PluginPermissionConfig | undefined,
  after: PluginPermissionConfig | undefined,
): boolean {
  if (!before && !after) return false
  // 一侧缺失（新装/配置被删除）按默认配置（无禁用项）补齐，否则会漏判
  // 「从禁用恢复成默认」这种需要重载的情况。
  const b = before ?? DEFAULT_PLUGIN_PERMISSION_CONFIG
  const a = after ?? DEFAULT_PLUGIN_PERMISSION_CONFIG
  return CONTRIBUTION_PERMISSIONS.some(
    (permission) => b.disabled.includes(permission) !== a.disabled.includes(permission),
  )
}

/** 找出贡献类权限发生变化、需要重载的插件 id（合并两侧键集）。 */
export function changedContributionPlugins(
  before: Record<string, PluginPermissionConfig>,
  after: Record<string, PluginPermissionConfig>,
): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...ids].filter((id) => contributionPermissionsChanged(before[id], after[id]))
}
