// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand'
import { getAccounts, getDefaultAccount } from '../api/account.ts'
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
  replace: (accounts: Account[]) => void
}

let inflight: Promise<void> | null = null
/** 数据版本：请求期间若有 CRUD 补丁写入，旧快照必须丢弃。 */
let rev = 0

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
    const startRev = rev
    inflight = Promise.all([
      getAccounts(),
      // 无默认账户时后端返回 404：不是错误，落 null
      getDefaultAccount().catch(() => null),
    ])
      .then(([accounts, defaultAccount]) => {
        if (rev !== startRev) return
        set({ accounts, defaultAccount, status: 'ready' })
      })
      .catch((e) => {
        logError('accounts.store.refresh', e)
        set({ status: 'error' })
      })
      .finally(() => { inflight = null })
    return inflight
  },
  replace: (accounts) => { rev += 1; set({ accounts, status: 'ready' }) },
}))

export async function loadAccounts(force = false): Promise<Account[]> {
  const state = useAccountsStore.getState()
  if (force || state.status !== 'ready') await state.refresh()
  return useAccountsStore.getState().accounts
}

accountsChanged.subscribe((change) => {
  if (change.type === 'reload') {
    void useAccountsStore.getState().refresh()
    return
  }
  rev += 1
  useAccountsStore.setState({ ...patchAccounts(useAccountsStore.getState(), change), status: 'ready' })
})
