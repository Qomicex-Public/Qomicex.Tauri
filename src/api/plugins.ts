import type { PluginInfo } from '../plugins/types.ts'

const BASE = '/api/plugins'

export async function fetchPlugins(): Promise<PluginInfo[]> {
  const res = await fetch(BASE)
  if (!res.ok) throw new Error(`Failed to fetch plugins: ${res.status}`)
  return res.json()
}

export async function fetchPlugin(id: string): Promise<PluginInfo> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Plugin ${id} not found`)
  return res.json()
}

export async function rescanPlugins(): Promise<{ scanned: number }> {
  const res = await fetch(`${BASE}/rescan`, { method: 'POST' })
  return res.json()
}
