// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand'
import { getDefaultInstance, getInstances } from '../api/instance.ts'
import { instancesChanged } from '../lib/entityEvents.ts'
import { patchInstances, stampDefaultInstance } from '../lib/entityPatch.ts'
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
/** 列表版本：请求期间若有更权威的写入（syncScan / CRUD 补丁），旧列表必须丢弃。 */
let listRev = 0
/** 默认实例版本：与列表分开判断，旧默认不得覆盖请求期间的新默认。 */
let defaultRev = 0
/** 丢弃旧快照且首轮完整加载仍未成功时，结束后补一次。 */
let restart = false

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
    const startListRev = listRev
    const startDefaultRev = defaultRev
    inflight = (async () => {
      let list: GameInstance[]
      try {
        list = await getInstances()
      } catch (e) {
        // 列表拿不到才是失败；保留上一次的列表继续展示
        logError('instances.store.refresh', e)
        set({ status: 'error' })
        return
      }
      // 默认实例单独失败只影响默认项，不能连带丢弃已拿到的列表
      let fetchedDefault = get().defaultInstance
      try {
        fetchedDefault = (await getDefaultInstance()) ?? null
      } catch (e) {
        logError('instances.store.default', e)
      }
      const nextDefault = defaultRev === startDefaultRev ? fetchedDefault : get().defaultInstance
      if (listRev === startListRev) {
        set({
          instances: stampDefaultInstance(list, nextDefault),
          defaultInstance: nextDefault,
          status: 'ready',
        })
      } else {
        // 列表被更权威的写入取代：只采纳默认项；首轮未完成则补一次
        set({ defaultInstance: nextDefault })
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
  replace: (instances) => {
    listRev += 1
    const def = get().defaultInstance
    set({ instances: stampDefaultInstance(instances, def), status: 'ready' })
  },
}))

/** 一次读取：供深链、安装对话框等需要在同一次调用里拿到列表的入口。
 * 无任何缓存且加载失败时抛错——否则调用方会把「请求失败」显示成「没有实例」。 */
export async function loadInstances(force = false): Promise<GameInstance[]> {
  const state = useInstancesStore.getState()
  if (force || state.status !== 'ready') {
    await state.refresh()
    const after = useInstancesStore.getState()
    if (after.status === 'error' && after.instances.length === 0) throw new Error('instances.load.failed')
  }
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
    void reloadInstances()
    return
  }
  if (change.type === 'default') {
    defaultRev += 1
  } else {
    listRev += 1
    // 更新默认实例本身也改变默认对象：在途 refresh 不得用旧默认覆盖
    if (change.type === 'upsert' && useInstancesStore.getState().defaultInstance?.id === change.instance.id) {
      defaultRev += 1
    }
  }
  useInstancesStore.setState(patchInstances(useInstancesStore.getState(), change))
})

/** reload 不排队复用写入前的请求：等它结束后再拉一次，保证读到写入后的列表。 */
async function reloadInstances(): Promise<void> {
  if (inflight) await inflight.catch(() => {})
  await useInstancesStore.getState().refresh()
}
