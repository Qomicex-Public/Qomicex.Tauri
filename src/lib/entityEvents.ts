// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 实体变更信号：api 层写成功后广播变更内容，读方（stores）就地打补丁。
// 反向依赖会成环（store → api → store），所以信号本身不依赖任何模块。
// 只给「无法从返回值推导」的变更用 `reload`——它会让 store 重拉整个列表。
import type { AccountsChange, InstancesChange } from './entityPatch.ts'

type Listener<T> = (change: T) => void

function createSignal<T>() {
  const listeners = new Set<Listener<T>>()
  return {
    subscribe(fn: Listener<T>): () => void {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    emit(change: T): void {
      for (const fn of [...listeners]) fn(change)
    },
  }
}

export const instancesChanged = createSignal<InstancesChange>()
export const accountsChanged = createSignal<AccountsChange>()
