// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 插件 iframe window → pluginId 的反查表。
 *
 * 沙箱桥收到 postMessage 时用它确认消息确实来自声明的插件，避免 A 插件冒充 B
 * 注册 hook / 方法。WeakMap 随 iframe 销毁自动回收，不需要显式清理。
 */
const sources = new WeakMap<Window, string>()

/** 登记 iframe 的归属；重复调用以最后一次为准。 */
export function registerPluginSource(win: Window | null | undefined, pluginId: string): void {
  if (win) sources.set(win, pluginId)
}

/** 反查消息来源的插件；未登记返回 undefined（调用方应拒绝）。 */
export function pluginIdForSource(win: Window | null | undefined): string | undefined {
  return win ? sources.get(win) : undefined
}
