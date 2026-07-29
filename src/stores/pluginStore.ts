import { create } from 'zustand'
import type { PluginInfo, PluginState } from '../plugins/types.ts'
import { fetchPlugins, rescanPlugins } from '../api/plugins.ts'

interface PluginStore {
  plugins: PluginInfo[]
  loading: boolean
  error: string | null

  loadPlugins: () => Promise<void>
  getPlugin: (id: string) => PluginInfo | undefined
  setPluginState: (id: string, state: PluginState) => void
  rescan: () => Promise<void>
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  loading: false,
  error: null,

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
  }
}))
