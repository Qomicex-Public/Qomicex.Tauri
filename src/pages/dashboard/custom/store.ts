// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { create } from 'zustand'
import { WIDGET_LIMITS } from './schema.ts'
import type { BinaryValue } from './types.ts'

export interface CustomWidgetDef {
  id: string
  name: string
  xml: string
  /** 在线导入来源；存在时按 TTL 检查更新。 */
  sourceUrl?: string
  /** 本地导入的 .qwidget 路径；相对路径以它所在目录为基准。 */
  sourcePath?: string
  /** 用户已确认的可自动出网域名。 */
  hosts: string[]
  /** 远程组件最近一次确认的可执行内容指纹。 */
  executableHash?: string
  /** 用户按命令哈希信任过的动态命令。 */
  trustedCommands?: string[]
  lastChecked?: number
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
  setData: (widgetKey: string, name: string, json: unknown) => void
  clearData: (widgetKey: string) => void
}

const DEFS_KEY = 'qomicex.dashboard.customWidgets.v2'
const CACHE_KEY = 'qomicex.dashboard.customWidgetData.v2'

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
    /* 配额满时保留内存状态 */
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

/** 总量裁剪：按写入时间从旧到新丢弃，直到低于上限。 */
export function pruneDataCache(cache: DataCache): DataCache {
  const entries: Array<{ widgetKey: string; name: string; at: number; size: number }> = []
  for (const [widgetKey, sources] of Object.entries(cache)) {
    if (!sources || typeof sources !== 'object') continue
    for (const [name, entry] of Object.entries(sources)) {
      if (!entry || typeof entry !== 'object') continue
      entries.push({
        widgetKey,
        name,
        at: entry.at,
        size: JSON.stringify(entry.json)?.length ?? 0,
      })
    }
  }
  if (entries.reduce((sum, entry) => sum + entry.size, 0) <= WIDGET_LIMITS.maxCacheBytes) return cache
  entries.sort((a, b) => a.at - b.at)
  const next: DataCache = {}
  let remaining = entries.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of entries) {
    if (remaining > WIDGET_LIMITS.maxCacheBytes) {
      remaining -= entry.size
      continue
    }
    const sources = next[entry.widgetKey] ?? (next[entry.widgetKey] = {})
    const original = cache[entry.widgetKey]?.[entry.name]
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
const initialCache = (() => {
  try {
    return pruneDataCache(loadCache())
  } catch {
    return {}
  }
})()

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
    clearBinaries(id)
    set({ defs, dataCache })
  },

  setData: (widgetKey, name, json) => {
    const dataCache = pruneDataCache({
      ...get().dataCache,
      [widgetKey]: {
        ...(get().dataCache[widgetKey] ?? {}),
        [name]: { at: Date.now(), json },
      },
    })
    persistCache(dataCache)
    set({ dataCache })
  },

  clearData: (widgetKey) => {
    const dataCache = { ...get().dataCache }
    delete dataCache[widgetKey]
    persistCache(dataCache)
    clearBinaries(widgetKey)
    set({ dataCache })
  },
}))

// 远程嵌套组件 XML 缓存（内存）。按 URL + 6h TTL 复用。
const remoteWidgets = new Map<string, { xml: string; at: number }>()

export function getRemoteWidget(url: string, ttlMs: number = WIDGET_LIMITS.updateTtlMs): string | null {
  const hit = remoteWidgets.get(url)
  if (!hit) return null
  if (Date.now() - hit.at > ttlMs) return null
  return hit.xml
}

export function setRemoteWidget(url: string, xml: string): void {
  remoteWidgets.set(url, { xml, at: Date.now() })
}

// 二进制只放内存，避免 base64 撑爆 localStorage。
const binaryCache = new Map<string, BinaryValue>()

export function getBinary(key: string): BinaryValue | undefined {
  return binaryCache.get(key)
}

export function setBinary(key: string, value: BinaryValue): void {
  binaryCache.set(key, value)
}

export function clearBinaries(widgetKey: string): void {
  const prefix = `${widgetKey}:`
  for (const key of binaryCache.keys()) {
    if (key.startsWith(prefix)) binaryCache.delete(key)
  }
}
