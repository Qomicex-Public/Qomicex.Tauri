// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { usePluginStore } from '../stores/pluginStore.ts'

/**
 * 有效权限 = manifest 声明 − 用户禁用项。
 *
 * 只收窄不提权：manifest 没声明的权限永远不会因为本地配置而出现，所以安装时
 * 的授权弹窗仍是唯一提权入口。所有桥方法校验都必须走这里，不要直接读
 * `manifest.permissions`，否则用户关掉的权限会被绕过。
 */
export function isPermissionGranted(pluginId: string, permission: string): boolean {
  if (!permission) return true
  const { getPlugin, permissionConfigs, permissionUnavailable } = usePluginStore.getState()
  if (permissionUnavailable[pluginId]) return false
  const plugin = getPlugin(pluginId)
  if (!plugin || !plugin.manifest.permissions.includes(permission)) return false
  return !(permissionConfigs[pluginId]?.disabled.includes(permission) ?? false)
}

/**
 * manifest 静态贡献（侧栏菜单/设置页/悬浮窗）是否应随权限隐藏。
 *
 * 方法与贡献项共用同一套权限 id：关掉 `ui:inject_sidebar` 却仍能点开插件页，
 * 会让「已禁用」看起来没生效。
 */
export function isContributionEnabled(pluginId: string, permission: string): boolean {
  return isPermissionGranted(pluginId, permission)
}
