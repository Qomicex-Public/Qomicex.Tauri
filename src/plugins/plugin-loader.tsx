import { Tooltip } from '../components/ui/index.ts'
import type { PluginInfo, PluginMenuItem, PluginContributes } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createSandbox, renderInline, getInstance } from './sandbox.ts'
import { registerSlot, unregisterPluginSlots } from './slots.tsx'
import { NavItem } from '../components/Sidebar.tsx'
import { API_BASE } from '../api/client.ts'

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

    const { menuItems, overlay } = plugin.manifest.contributes ?? {}
    if (menuItems) {
      for (const item of menuItems) {
        if (item.action === 'overlay' && overlay) {
          registerSlot(
            plugin.manifest.id,
            'sidebar:bottom',
            () => <OverlaySidebarButton pluginId={plugin.manifest.id} item={item} overlay={overlay} />
          )
        } else {
          registerSlot(
            plugin.manifest.id,
            'sidebar:bottom',
            () => <NavItem to={`/plugins/p/${plugin.manifest.id}`} label={item.label} icon={<span className="text-sm">{item.icon ?? item.label[0]}</span>} />
          )
        }
      }
    }

    usePluginStore.getState().setPluginState(plugin.manifest.id, 'active')
  }

  if (plugin.manifest.entry.theme) {
    try {
      const res = await fetch(`${API_BASE}/plugins/${plugin.manifest.id}/files/${plugin.manifest.entry.theme}`)
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

function OverlaySidebarButton({ pluginId, item, overlay }: { pluginId: string; item: PluginMenuItem; overlay: NonNullable<PluginContributes['overlay']> }) {
  const store = usePluginStore()

  const handleClick = async () => {
    const res = await fetch(`${API_BASE}/plugins/${pluginId}/files/${overlay.file}`)
    if (!res.ok) return
    const html = await res.text()
    store.createOverlay(pluginId, {
      title: overlay.title ?? item.label,
      html,
      width: overlay.width ?? 380,
      height: overlay.height ?? 500,
      minimizable: overlay.minimizable ?? true,
      resizable: overlay.resizable ?? false,
      x: 120,
      y: 80,
    })
  }

  return (
    <li className="w-full flex justify-center relative">
      <Tooltip content={item.label} side="right">
        <button
          onClick={handleClick}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-lg transition-all duration-200 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span className="text-sm">{item.icon ?? item.label[0]}</span>
        </button>
      </Tooltip>
    </li>
  )
}
