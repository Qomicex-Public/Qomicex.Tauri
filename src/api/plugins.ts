import type { PluginInfo } from '../plugins/types.ts'
import { API_BASE } from './client.ts'

// 惰性求值：API_BASE 是活绑定（IPC 探测后才切换），模块级常量会捕获旧值
const base = () => `${API_BASE}/plugins`

export async function fetchPlugins(): Promise<PluginInfo[]> {
  const res = await fetch(base())
  if (!res.ok) throw new Error(`Failed to fetch plugins: ${res.status}`)
  return res.json()
}

export async function fetchPlugin(id: string): Promise<PluginInfo> {
  const res = await fetch(`${base()}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Plugin ${id} not found`)
  return res.json()
}

export async function setPluginState(id: string, state: string): Promise<void> {
  const res = await fetch(`${base()}/${encodeURIComponent(id)}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
  if (!res.ok) throw new Error(`Failed to set plugin state: ${res.status}`)
  window.dispatchEvent(new CustomEvent('plugin:state-change', { detail: { id, state } }))
}

export async function rescanPlugins(): Promise<{ scanned: number }> {
  const res = await fetch(`${base()}/rescan`, { method: 'POST' })
  return res.json()
}
