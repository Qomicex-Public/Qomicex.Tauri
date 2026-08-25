import { create } from 'zustand'
import type { PluginInfo, PluginState } from '../plugins/types.ts'
import { fetchPlugins, rescanPlugins } from '../api/plugins.ts'
import type { StoreUpdateEntry } from '../api/pluginStore.ts'

/** 一条可升级信息：slug 为 store 侧标识（install 用），latestVersion 用于 badge/确认提示 */
export interface PluginUpdateEntry {
  slug: string
  latestVersion: string
}

/** 商店 slug ↔ 本地 manifest.id 匹配（与浏览子 tab 同规则） */
export function matchesLocalId(slug: string, localId: string): boolean {
  return localId === slug || localId.toLowerCase().endsWith(`.${slug.toLowerCase()}`)
}

/** 收集已安装插件清单（slug + 版本），供 /store/check-updates 轮询使用 */
export function collectInstalledPlugins(plugins: PluginInfo[]): { slug: string; version: string }[] {
  const seen = new Set<string>()
  const installed: { slug: string; version: string }[] = []
  for (const p of plugins) {
    const id = p.manifest.id
    for (const slug of [id, id.includes('.') ? id.split('.').pop()! : '']) {
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      installed.push({ slug, version: p.manifest.version })
    }
  }
  return installed
}

/**
 * 灰度放量判定：按 `slug + latestVersion` 的稳定 hash 把客户端确定性映射到
 * [0,100)，`< rolloutPercent` 才进入可升级列表。同一用户/同一版本结果恒定，
 * 不随轮询波动；后续换真灰度平台（按 launcherId 等）只需替换本函数。
 */
function rolloutHit(slug: string, latestVersion: string, percent: number): boolean {
  const s = `${slug}@${latestVersion}`
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return (h % 100) < percent
}

/** 把 store 返回的更新列表按本地插件 id 建索引（含灰度过滤） */
export function buildUpdatesMap(entries: StoreUpdateEntry[], plugins: PluginInfo[]): Record<string, PluginUpdateEntry> {
  const map: Record<string, PluginUpdateEntry> = {}
  for (const u of entries ?? []) {
    const percent = u.rolloutPercent ?? 100
    // 灰度未命中（rolloutPercent < 100 且 hash 落在放量之外）→ 不提示升级
    if (percent < 100 && !rolloutHit(u.slug, u.latestVersion, percent)) continue
    for (const p of plugins) {
      if (matchesLocalId(u.slug, p.manifest.id)) {
        map[p.manifest.id] = { slug: u.slug, latestVersion: u.latestVersion }
        break
      }
    }
  }
  return map
}

export interface PluginOverlay {
  id: string
  pluginId: string
  title: string
  html: string
  x: number
  y: number
  width: number
  height: number
  minimizable: boolean
  resizable: boolean
  visible: boolean
  ordering: number
}

let nextOrder = 100

interface PluginStore {
  plugins: PluginInfo[]
  loading: boolean
  error: string | null

  loadPlugins: () => Promise<void>
  getPlugin: (id: string) => PluginInfo | undefined
  setPluginState: (id: string, state: PluginState) => void
  rescan: () => Promise<void>

  /** localId → 可升级信息（启动静默轮询 + 管理 tab 检查更新共用） */
  updates: Record<string, PluginUpdateEntry>
  setUpdates: (updates: Record<string, PluginUpdateEntry> | ((prev: Record<string, PluginUpdateEntry>) => Record<string, PluginUpdateEntry>)) => void

  overlays: PluginOverlay[]
  createOverlay: (pluginId: string, opts: { title: string; html: string; x?: number; y?: number; width?: number; height?: number; minimizable?: boolean; resizable?: boolean }) => string
  showOverlay: (id: string) => void
  hideOverlay: (id: string) => void
  destroyOverlay: (id: string) => void
  destroyPluginOverlays: (pluginId: string) => void
  setOverlayPosition: (id: string, x: number, y: number) => void
  setOverlaySize: (id: string, width: number, height: number) => void
  setOverlayHtml: (id: string, html: string) => void
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  loading: false,
  error: null,

  updates: {},
  setUpdates: (updates) =>
    set(typeof updates === 'function' ? (s) => ({ updates: updates(s.updates) }) : { updates }),

  loadPlugins: async () => {
    set({ loading: true, error: null })
    try {
      const plugins = await fetchPlugins()
      set({ plugins, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Unknown error', loading: false })
    }
  },

  getPlugin: (id) => {
    return get().plugins.find(p => p.manifest.id === id)
  },

  setPluginState: (id, state) => {
    set(s => ({
      plugins: s.plugins.map(p =>
        p.manifest.id === id ? { ...p, state } : p
      )
    }))
  },

  rescan: async () => {
    await rescanPlugins()
    await get().loadPlugins()
  },

  overlays: [],

  createOverlay: (pluginId, opts) => {
    const id = `${pluginId}__${Math.random().toString(36).slice(2, 8)}`
    const o: PluginOverlay = {
      id,
      pluginId,
      title: opts.title,
      html: opts.html,
      x: opts.x ?? 100,
      y: opts.y ?? 80,
      width: opts.width ?? 320,
      height: opts.height ?? 240,
      minimizable: opts.minimizable ?? true,
      resizable: opts.resizable ?? false,
      visible: true,
      ordering: nextOrder++,
    }
    set(s => ({ overlays: [...s.overlays, o] }))
    return id
  },

  showOverlay: (id) => {
    set(s => ({
      overlays: s.overlays.map(o => o.id === id ? { ...o, visible: true, ordering: nextOrder++ } : o)
    }))
  },

  hideOverlay: (id) => {
    set(s => ({
      overlays: s.overlays.map(o => o.id === id ? { ...o, visible: false } : o)
    }))
  },

  destroyOverlay: (id) => {
    set(s => ({
      overlays: s.overlays.filter(o => o.id !== id)
    }))
  },

  destroyPluginOverlays: (pluginId) => {
    set(s => ({
      overlays: s.overlays.filter(o => o.pluginId !== pluginId)
    }))
  },

  setOverlayPosition: (id, x, y) => {
    set(s => ({
      overlays: s.overlays.map(o => o.id === id ? { ...o, x, y } : o)
    }))
  },

  setOverlaySize: (id, width, height) => {
    set(s => ({
      overlays: s.overlays.map(o => o.id === id ? { ...o, width, height } : o)
    }))
  },

  setOverlayHtml: (id, html) => {
    set(s => ({
      overlays: s.overlays.map(o => o.id === id ? { ...o, html } : o)
    }))
  },
}))
