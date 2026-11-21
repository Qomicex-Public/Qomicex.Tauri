// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand'
import { getAccounts, getDefaultAccount } from '../api/account.ts'
import { ApiError } from '../api/client.ts'
import { accountsChanged } from '../lib/entityEvents.ts'
import { patchAccounts } from '../lib/entityPatch.ts'
import { logError } from '../lib/frontendLog.ts'
import type { Account } from '../types/index.ts'

interface AccountsState {
  accounts: Account[]
  defaultAccount: Account | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  load: () => Promise<void>
  refresh: () => Promise<void>
}

let inflight: Promise<void> | null = null
/** 列表版本：请求期间的 CRUD 补丁必须让旧列表快照作废。 */
let listRev = 0
/** 默认账户版本：与列表分开判断，旧默认不得覆盖新默认。 */
let defaultRev = 0
let restart = false

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  defaultAccount: null,
  status: 'idle',
  load: async () => {
    if (get().status === 'ready') return
    await get().refresh()
  },
  refresh: () => {
    if (inflight) return inflight
    if (get().status === 'idle') set({ status: 'loading' })
    const startListRev = listRev
    const startDefaultRev = defaultRev
    inflight = (async () => {
      let list: Account[]
      try {
        list = await getAccounts()
      } catch (e) {
        // 列表拿不到才是失败；保留上一次的列表继续展示
        logError('accounts.store.refresh', e)
        set({ status: 'error' })
        return
      }
      let fetchedDefault = get().defaultAccount
      try {
        fetchedDefault = (await getDefaultAccount()) ?? null
      } catch (e) {
        // 无默认账户时后端返回 404：这不是错误，落 null；
        // 网络/服务端错误则保留已知默认，不能发布「没有默认账户」的成功快照
        if (e instanceof ApiError && e.status === 404) fetchedDefault = null
        else logError('accounts.store.default', e)
      }
      const nextDefault = defaultRev === startDefaultRev ? fetchedDefault : get().defaultAccount
      if (listRev === startListRev) {
        set({ accounts: list, defaultAccount: nextDefault, status: 'ready' })
      } else {
        set({ defaultAccount: nextDefault })
        if (get().status !== 'ready') restart = true
      }
    })().finally(() => {
      inflight = null
      if (restart) {
        restart = false
        void get().refresh()
      }
    })
    return inflight
  },
}))

/** 一次读取：无任何缓存且加载失败时抛错——调用方据此区分「请求失败」与「没有账户」。 */
export async function loadAccounts(force = false): Promise<Account[]> {
  const state = useAccountsStore.getState()
  if (force || state.status !== 'ready') {
    await state.refresh()
    const after = useAccountsStore.getState()
    if (after.status === 'error' && after.accounts.length === 0) throw new Error('accounts.load.failed')
  }
  return useAccountsStore.getState().accounts
}

accountsChanged.subscribe((change) => {
  if (change.type === 'reload') {
    void reloadAccounts()
    return
  }
  if (change.type === 'default') defaultRev += 1
  else listRev += 1
  useAccountsStore.setState(patchAccounts(useAccountsStore.getState(), change))
})

/** reload 不排队复用写入前的请求：等它结束后再拉一次，保证读到写入后的账户。 */
async function reloadAccounts(): Promise<void> {
  if (inflight) await inflight.catch(() => {})
  await useAccountsStore.getState().refresh()
}
