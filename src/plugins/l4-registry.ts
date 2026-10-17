// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { L4HostBridge, L4NodeBridge } from './l4-registry-bridge.ts'

/**
 * l4 注册表桥的持有者。
 *
 * 单独成模块只为打断依赖环：`plugin-registry.ts` 需要在 `call()` 里查 l4 桥，
 * 而桥的实现（`webview-bridge.ts`）依赖 Tauri 事件与 sandbox，两者互相 import 会
 * 在模块初始化期形成未定义引用。这里只存引用，不做任何 I/O。
 */

let hostBridge: L4HostBridge | null = null
let nodeBridge: L4NodeBridge | null = null

export function setL4HostBridge(bridge: L4HostBridge | null) {
  hostBridge = bridge
}

export function getL4HostBridge(): L4HostBridge | null {
  return hostBridge
}

export function setL4NodeBridge(bridge: L4NodeBridge | null) {
  nodeBridge = bridge
}

export function getL4NodeBridge(): L4NodeBridge | null {
  return nodeBridge
}

/**
 * 当前窗口是否是 l4 插件独立窗口。
 *
 * 不能用 `window !== window.top` 判断：l4 窗口是独立的 WebviewWindow，它自己就是
 * top，注册表会在该窗口里按 host 安装，方法只留在本地（issue #260 的第二处缺口）。
 */
export function isL4Window(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('pluginWebview') === '1'
  } catch {
    return false
  }
}
