import { create } from 'zustand'
import type { PluginInfo, PluginState } from '../plugins/types.ts'
import { fetchPlugins, rescanPlugins } from '../api/plugins.ts'

export interface PluginOverlay {
  id: string
  pluginId: string
  title: string
  html: string
  x: number
  y: number
  width: number
  height: number
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

  overlays: PluginOverlay[]
  createOverlay: (pluginId: string, opts: { title: string; html: string; x?: number; y?: number; width?: number; height?: number }) => string
  showOverlay: (id: string) => void
  hideOverlay: (id: string) => void
  destroyOverlay: (id: string) => void
  destroyPluginOverlays: (pluginId: string) => void
  setOverlayPosition: (id: string, x: number, y: number) => void
  setOverlayHtml: (id: string, html: string) => void
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  loading: false,
  error: null,

  loadPlugins: async () => {
    set({ loading: true, error: null })
    try {
      const plugins = await fetchPlugins()
      set(s => {
        const active = new Set(s.plugins.filter(p => p.state === 'active').map(p => p.manifest.id))
        return { plugins: plugins.map(p => active.has(p.manifest.id) ? { ...p, state: 'active' as const } : p), loading: false }
      })
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

  setOverlayHtml: (id, html) => {
    set(s => ({
      overlays: s.overlays.map(o => o.id === id ? { ...o, html } : o)
    }))
  },
}))
