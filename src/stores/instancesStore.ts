// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand'
import { getDefaultInstance, getInstances } from '../api/instance.ts'
import { instancesChanged } from '../lib/entityEvents.ts'
import { patchInstances } from '../lib/entityPatch.ts'
import { logError } from '../lib/frontendLog.ts'
import type { GameInstance } from '../types/index.ts'

interface InstancesState {
  instances: GameInstance[]
  defaultInstance: GameInstance | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 首次读取：已有数据直接返回，切页不再重复请求。 */
  load: () => Promise<void>
  /** 强制重拉；并发调用共享同一请求。 */
  refresh: () => Promise<void>
  /** 扫描结果直接落库：`syncScan` 已把磁盘状态同步给后端，无需再拉一次。 */
  replace: (instances: GameInstance[]) => void
}

let inflight: Promise<void> | null = null
/** 数据版本：请求期间若有更权威的写入（syncScan / CRUD 补丁），旧快照必须丢弃。 */
let rev = 0

export const useInstancesStore = create<InstancesState>((set, get) => ({
  instances: [],
  defaultInstance: null,
  status: 'idle',
  load: async () => {
    if (get().status === 'ready') return
    await get().refresh()
  },
  refresh: () => {
    if (inflight) return inflight
    if (get().status === 'idle') set({ status: 'loading' })
    const startRev = rev
    inflight = Promise.all([getInstances(), getDefaultInstance()])
      .then(([instances, defaultInstance]) => {
        // 慢请求期间 scan/CRUD 已写入新数据：列表保留新值，只采纳默认实例
        if (rev !== startRev) {
          set({ defaultInstance, status: 'ready' })
          return
        }
        set({ instances, defaultInstance, status: 'ready' })
      })
      .catch((e) => {
        logError('instances.store.refresh', e)
        set({ status: 'error' })
      })
      .finally(() => { inflight = null })
    return inflight
  },
  replace: (instances) => { rev += 1; set({ instances, status: 'ready' }) },
}))

/** 一次读取：供深链、安装对话框等需要在同一次调用里拿到列表的入口。 */
export async function loadInstances(force = false): Promise<GameInstance[]> {
  const state = useInstancesStore.getState()
  if (force || state.status !== 'ready') await state.refresh()
  return useInstancesStore.getState().instances
}

/** 默认实例的读入口（需要时先加载）：资源详情、仪表盘等只关心默认实例的页面用。 */
export async function loadDefaultInstance(): Promise<GameInstance | null> {
  const state = useInstancesStore.getState()
  if (state.status !== 'ready') await state.refresh()
  return useInstancesStore.getState().defaultInstance
}

instancesChanged.subscribe((change) => {
  if (change.type === 'reload') {
    void useInstancesStore.getState().refresh()
    return
  }
  rev += 1
  useInstancesStore.setState({ ...patchInstances(useInstancesStore.getState(), change), status: 'ready' })
})
