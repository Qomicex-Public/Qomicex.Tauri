// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

export type SlotId =
  | 'sidebar:bottom'
  | 'settings:pages'
  | 'instance:actions'
  | 'header:right'
  | 'dashboard:widgets'

interface SlotRegistration {
  slotId: SlotId
  pluginId: string
  render: () => ReactNode
  /** 可选的去重键：运行时追加的条目据此避免重复注册（停用后随注册表一并清除）。 */
  dedupeKey?: string
}

const slotRegistry = new Map<SlotId, SlotRegistration[]>()

/**
 * 版本号订阅：`registerSlot` 只写内存注册表，React 无从感知。
 *
 * 插件在已 active 状态下运行时追加入口（`addMenuItem`）需要侧边栏立刻出现，
 * 因此把「注册表变了」暴露成可订阅的快照（`useSyncExternalStore`），
 * 由 `useSlotContent` 消费。
 */
let version = 0
const listeners = new Set<() => void>()

function bump() {
  version += 1
  for (const fn of [...listeners]) fn()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

export function registerSlot(
  pluginId: string,
  slotId: SlotId,
  render: () => ReactNode,
  dedupeKey?: string,
) {
  if (!slotRegistry.has(slotId)) {
    slotRegistry.set(slotId, [])
  }
  slotRegistry.get(slotId)!.push({ slotId, pluginId, render, dedupeKey })
  bump()
}

export function getSlotContent(slotId: SlotId): SlotRegistration[] {
  return slotRegistry.get(slotId) || []
}

/** React 侧读取槽位内容：注册表每次变更都会触发重渲染。 */
export function useSlotContent(slotId: SlotId): SlotRegistration[] {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )
  return getSlotContent(slotId)
}

export function unregisterPluginSlots(pluginId: string) {
  let changed = false
  for (const [slotId, registrations] of slotRegistry.entries()) {
    const filtered = registrations.filter(r => r.pluginId !== pluginId)
    if (filtered.length === registrations.length) continue
    changed = true
    if (filtered.length === 0) {
      slotRegistry.delete(slotId)
    } else {
      slotRegistry.set(slotId, filtered)
    }
  }
  if (changed) bump()
}
