// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 实体补丁的纯函数：api 写操作广播变更 → store 就地打补丁。
// 不依赖 React/zustand，便于单测（scripts/test-entity-stores.mjs）。
import type { Account, GameInstance } from '../types/index.ts'

export type InstancesChange =
  | { type: 'upsert'; instance: GameInstance }
  | { type: 'remove'; id: string }
  | { type: 'default'; instance: GameInstance | null }
  | { type: 'reload' }

export type AccountsChange =
  | { type: 'upsert'; account: Account }
  | { type: 'remove'; uuid: string }
  | { type: 'default'; account: Account | null }
  | { type: 'reload' }

export interface InstancesSnapshot {
  instances: GameInstance[]
  defaultInstance: GameInstance | null
}

export interface AccountsSnapshot {
  accounts: Account[]
  defaultAccount: Account | null
}

/** 同 id 原位替换（保持列表顺序，分页/排序不受影响），否则追加。 */
export function patchInstances(state: InstancesSnapshot, change: InstancesChange): InstancesSnapshot {
  switch (change.type) {
    case 'upsert': {
      const isDefaultInstance = state.defaultInstance?.id === change.instance.id
      // 后端列表不带 isDefault 语义：默认实例的补丁要保住标记
      const incoming = isDefaultInstance && !change.instance.isDefault
        ? { ...change.instance, isDefault: true }
        : change.instance
      const exists = state.instances.some((i) => i.id === incoming.id)
      return {
        instances: exists
          ? state.instances.map((i) => (i.id === incoming.id ? incoming : i))
          : [...state.instances, incoming],
        // 默认实例被更新（改 Java/内存/目录）时，启动链路读到必须是新对象
        defaultInstance: isDefaultInstance ? incoming : state.defaultInstance,
      }
    }
    case 'remove':
      return {
        instances: state.instances.filter((i) => i.id !== change.id),
        defaultInstance: state.defaultInstance?.id === change.id ? null : state.defaultInstance,
      }
    case 'default': {
      // 列表标记与默认实例保持一致：安装对话框按 isDefault 预选目标实例
      const defaultId = change.instance?.id
      return {
        instances: state.instances.map((i) => {
          const isDefault = i.id === defaultId
          return i.isDefault === isDefault ? i : { ...i, isDefault }
        }),
        defaultInstance: change.instance,
      }
    }
    case 'reload':
      return state
  }
}

/** 把默认实例标记压到列表上：后端列表不带该语义，store 是唯一真相。 */
export function stampDefaultInstance(
  instances: GameInstance[],
  defaultInstance: GameInstance | null,
): GameInstance[] {
  return instances.map((i) => {
    const isDefault = i.id === defaultInstance?.id
    return i.isDefault === isDefault ? i : { ...i, isDefault }
  })
}

export function patchAccounts(state: AccountsSnapshot, change: AccountsChange): AccountsSnapshot {
  switch (change.type) {
    case 'upsert': {
      const exists = state.accounts.some((a) => a.uuid === change.account.uuid)
      return {
        accounts: exists
          ? state.accounts.map((a) => (a.uuid === change.account.uuid ? change.account : a))
          : [...state.accounts, change.account],
        defaultAccount: state.defaultAccount,
      }
    }
    case 'remove':
      return {
        accounts: state.accounts.filter((a) => a.uuid !== change.uuid),
        defaultAccount: state.defaultAccount?.uuid === change.uuid ? null : state.defaultAccount,
      }
    case 'default':
      return {
        accounts: state.accounts.map((a) => ({ ...a, isDefault: a.uuid === change.account?.uuid })),
        defaultAccount: change.account,
      }
    case 'reload':
      return state
  }
}
