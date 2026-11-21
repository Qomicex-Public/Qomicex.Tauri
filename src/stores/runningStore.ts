// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand'
import type { ProcessResourceUsage } from '../api/system.ts'

/** 运行中的游戏实例。资源占用另存 `usage`，避免 1s 级遥测把低频列表拖成新引用。 */
export interface RunningInstance {
  instanceId: string
  name: string
  startedAt: number
  stage: string
  processId?: number | null
}

interface RunningState {
  instances: RunningInstance[]
  usage: Record<string, ProcessResourceUsage>
  /** 幂等：已存在时保留原 `startedAt`，重复轮询不会重置运行时长。 */
  upsert: (inst: RunningInstance) => void
  remove: (instanceId: string) => void
  setUsage: (instanceId: string, usage: ProcessResourceUsage) => void
  clearUsage: (instanceId: string) => void
}

export const useRunningStore = create<RunningState>((set) => ({
  instances: [],
  usage: {},
  upsert: (inst) => set((s) =>
    s.instances.some((r) => r.instanceId === inst.instanceId)
      ? s
      : { instances: [...s.instances, inst] }),
  remove: (instanceId) => set((s) => {
    if (!s.instances.some((r) => r.instanceId === instanceId) && !(instanceId in s.usage)) return s
    const usage = { ...s.usage }
    delete usage[instanceId]
    return { instances: s.instances.filter((r) => r.instanceId !== instanceId), usage }
  }),
  setUsage: (instanceId, usage) => set((s) => ({ usage: { ...s.usage, [instanceId]: usage } })),
  clearUsage: (instanceId) => set((s) => {
    if (!(instanceId in s.usage)) return s
    const usage = { ...s.usage }
    delete usage[instanceId]
    return { usage }
  }),
}))

export function useRunningInstances(): RunningInstance[] {
  return useRunningStore((s) => s.instances)
}

/** 侧边栏等只关心「有没有在跑」的消费者：布尔值不变就不重渲染。 */
export function useHasRunningInstances(): boolean {
  return useRunningStore((s) => s.instances.length > 0)
}

export function useInstanceResourceUsage(instanceId: string): ProcessResourceUsage | null {
  return useRunningStore((s) => s.usage[instanceId] ?? null)
}
