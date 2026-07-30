import type { PluginInfo } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createSandbox, renderInline, getInstance } from './sandbox.ts'
import { registerSlot, unregisterPluginSlots } from './slots.tsx'
import { NavItem } from '../components/Sidebar.tsx'

const activeThemes = new Map<string, HTMLStyleElement>()

export async function activatePlugin(plugin: PluginInfo) {
  if (getInstance(plugin.manifest.id)) return

  const useInline = true

  if (plugin.manifest.entry.frontend) {
    if (useInline) {
      renderInline(plugin)
    } else {
      createSandbox(plugin)
    }

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
  const inst = getInstance(pluginId)
  if (inst) inst.destroy()
  unregisterPluginSlots(pluginId)
  const themeStyle = activeThemes.get(pluginId)
  if (themeStyle) {
    themeStyle.remove()
    activeThemes.delete(pluginId)
  }
  usePluginStore.getState().destroyPluginOverlays(pluginId)
  usePluginStore.getState().setPluginState(pluginId, 'disabled')
}

export function isPluginActive(pluginId: string): boolean {
  return !!getInstance(pluginId)
}
