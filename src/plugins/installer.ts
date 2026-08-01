import type { PluginInfo } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { API_BASE } from '../api/client.ts'

export interface InstallOptions {
  sourceDir: string
  onProgress?: (msg: string) => void
}

export async function installPlugin(options: InstallOptions): Promise<PluginInfo> {
  // Phase 1: 复制插件目录到 PLUGINS_DIR
  // Phase 3: 实现完整安装流程 + 权限确认对话框
  const { sourceDir, onProgress } = options
  onProgress?.('安装中...')

  const res = await fetch(`${API_BASE}/plugins/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceDir })
  })
  if (!res.ok) throw new Error(`Install failed: ${res.statusText}`)
  const plugin: PluginInfo = await res.json()

  await usePluginStore.getState().rescan()
  return plugin
}

export async function uninstallPlugin(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/plugins/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
  if (!res.ok) throw new Error(`Uninstall failed: ${res.statusText}`)
  await usePluginStore.getState().rescan()
}
