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
      const exists = state.instances.some((i) => i.id === change.instance.id)
      return {
        instances: exists
          ? state.instances.map((i) => (i.id === change.instance.id ? change.instance : i))
          : [...state.instances, change.instance],
        defaultInstance: state.defaultInstance,
      }
    }
    case 'remove':
      return {
        instances: state.instances.filter((i) => i.id !== change.id),
        defaultInstance: state.defaultInstance?.id === change.id ? null : state.defaultInstance,
      }
    case 'default':
      return { instances: state.instances, defaultInstance: change.instance }
    case 'reload':
      return state
  }
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
