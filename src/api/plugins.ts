import type { PluginInfo } from '../plugins/types.ts'
import { API_BASE } from './client.ts'

const BASE = `${API_BASE}/plugins`

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

export async function setPluginState(id: string, state: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
  if (!res.ok) throw new Error(`Failed to set plugin state: ${res.status}`)
}

export async function rescanPlugins(): Promise<{ scanned: number }> {
  const res = await fetch(`${BASE}/rescan`, { method: 'POST' })
  return res.json()
}
