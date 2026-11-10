// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand'
import { WIDGET_LIMITS } from './schema.ts'

export interface PendingUpdate {
  xml: string
  version: string
  hosts: string[]
}

export interface CustomWidgetDef {
  id: string
  name: string
  xml: string
  /** 在线导入来源；存在时按 TTL 静默检查更新。 */
  sourceUrl?: string
  /** 用户已确认的可自动出网域名（数据源 / 更新源 / 静态图片）。 */
  hosts: string[]
  lastChecked?: number
  pendingUpdate?: PendingUpdate
}

interface DataEntry {
  at: number
  json: unknown
}

type WidgetData = Record<string, DataEntry>
export type DataCache = Record<string, WidgetData>

interface CustomWidgetState {
  defs: CustomWidgetDef[]
  dataCache: DataCache
  addDef: (def: CustomWidgetDef) => void
  updateDef: (id: string, patch: Partial<CustomWidgetDef>) => void
  removeDef: (id: string) => void
  setData: (widgetId: string, name: string, json: unknown) => void
  clearData: (widgetId: string) => void
}

const DEFS_KEY = 'qomicex.dashboard.customWidgets.v1'
const CACHE_KEY = 'qomicex.dashboard.customWidgetData.v1'

function loadDefs(): CustomWidgetDef[] {
  try {
    const raw = localStorage.getItem(DEFS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as CustomWidgetDef[]) : []
  } catch {
    return []
  }
}

function persistDefs(defs: CustomWidgetDef[]): void {
  try {
    localStorage.setItem(DEFS_KEY, JSON.stringify(defs))
  } catch {
    /* 配额满时保留内存状态，下次写入再试 */
  }
}

function loadCache(): DataCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as DataCache) : {}
  } catch {
    return {}
  }
}

/** 总量裁剪：按写入时间从旧到新丢弃，直到序列化长度低于上限。 */
export function pruneDataCache(cache: DataCache): DataCache {
  const entries: Array<{ widgetId: string; name: string; at: number; size: number }> = []
  for (const [widgetId, sources] of Object.entries(cache)) {
    for (const [name, entry] of Object.entries(sources)) {
      entries.push({
        widgetId,
        name,
        at: entry.at,
        size: JSON.stringify(entry.json)?.length ?? 0,
      })
    }
  }
  const total = entries.reduce((sum, e) => sum + e.size, 0)
  if (total <= WIDGET_LIMITS.maxCacheBytes) return cache

  entries.sort((a, b) => a.at - b.at)
  const next: DataCache = {}
  let remaining = total
  for (const entry of entries) {
    if (remaining > WIDGET_LIMITS.maxCacheBytes) {
      remaining -= entry.size
      continue
    }
    const sources = next[entry.widgetId] ?? (next[entry.widgetId] = {})
    const original = cache[entry.widgetId]?.[entry.name]
    if (original) sources[entry.name] = original
  }
  return next
}

function persistCache(cache: DataCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      /* ignore */
    }
  }
}

const initialDefs = loadDefs()
const initialCache = pruneDataCache(loadCache())

export const useCustomWidgetStore = create<CustomWidgetState>((set, get) => ({
  defs: initialDefs,
  dataCache: initialCache,

  addDef: (def) => {
    const defs = [...get().defs, def]
    persistDefs(defs)
    set({ defs })
  },

  updateDef: (id, patch) => {
    const defs = get().defs.map((def) => (def.id === id ? { ...def, ...patch } : def))
    persistDefs(defs)
    set({ defs })
  },

  removeDef: (id) => {
    const defs = get().defs.filter((def) => def.id !== id)
    persistDefs(defs)
    const dataCache = { ...get().dataCache }
    delete dataCache[id]
    persistCache(dataCache)
    set({ defs, dataCache })
  },

  setData: (widgetId, name, json) => {
    const dataCache = pruneDataCache({
      ...get().dataCache,
      [widgetId]: {
        ...(get().dataCache[widgetId] ?? {}),
        [name]: { at: Date.now(), json },
      },
    })
    persistCache(dataCache)
    set({ dataCache })
  },

  clearData: (widgetId) => {
    const dataCache = { ...get().dataCache }
    delete dataCache[widgetId]
    persistCache(dataCache)
    set({ dataCache })
  },
}))
