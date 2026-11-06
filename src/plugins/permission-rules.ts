// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
  if (!before || !after) return false
  return CONTRIBUTION_PERMISSIONS.some(
    (permission) => before.disabled.includes(permission) !== after.disabled.includes(permission),
  )
}

/** 找出贡献类权限发生变化、需要重载的插件 id。 */
export function changedContributionPlugins(
  before: Record<string, PluginPermissionConfig>,
  after: Record<string, PluginPermissionConfig>,
): string[] {
  return Object.keys(after).filter((id) => contributionPermissionsChanged(before[id], after[id]))
}
