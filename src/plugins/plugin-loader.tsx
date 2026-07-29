import type { PluginInfo } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createSandbox, type SandboxInstance } from './sandbox.ts'
import { registerSlot, unregisterPluginSlots } from './slots.tsx'
import { NavItem } from '../components/Sidebar.tsx'

const activeSandboxes = new Map<string, SandboxInstance>()
const activeThemes = new Map<string, HTMLStyleElement>()

export async function activatePlugin(plugin: PluginInfo) {
  if (activeSandboxes.has(plugin.manifest.id)) return

  if (plugin.manifest.layers.includes('l2') && plugin.manifest.entry.frontend) {
    const sandbox = createSandbox(plugin)
    activeSandboxes.set(plugin.manifest.id, sandbox)

    const { menuItems } = plugin.manifest.contributes ?? {}
    if (menuItems) {
      for (const item of menuItems) {
        registerSlot(
          plugin.manifest.id,
          'sidebar:bottom',
          () => <NavItem to={`/plugins/p/${plugin.manifest.id}`} label={item.label} icon={<span className="text-sm">{item.icon ?? item.label[0]}</span>} />
        )
      }
    }

    usePluginStore.getState().setPluginState(plugin.manifest.id, 'active')
  }

  if (plugin.manifest.entry.theme) {
    try {
      const res = await fetch(`/api/plugins/${plugin.manifest.id}/files/${plugin.manifest.entry.theme}`)
      if (res.ok) {
        const css = await res.text()
        const style = document.createElement('style')
        style.textContent = css
        style.setAttribute('data-plugin-theme', plugin.manifest.id)
        document.head.appendChild(style)
        activeThemes.set(plugin.manifest.id, style)
      }
    } catch { /* theme CSS not available */ }
  }
}

export function deactivatePlugin(pluginId: string) {
  const sandbox = activeSandboxes.get(pluginId)
  if (sandbox) {
    sandbox.destroy()
    activeSandboxes.delete(pluginId)
    unregisterPluginSlots(pluginId)
  }
  const themeStyle = activeThemes.get(pluginId)
  if (themeStyle) {
    themeStyle.remove()
    activeThemes.delete(pluginId)
  }
  usePluginStore.getState().setPluginState(pluginId, 'disabled')
}

export function isPluginActive(pluginId: string): boolean {
  return activeSandboxes.has(pluginId)
}

export function getSandbox(pluginId: string): SandboxInstance | undefined {
  return activeSandboxes.get(pluginId)
}
