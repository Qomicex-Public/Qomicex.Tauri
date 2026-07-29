import { usePluginStore } from '../stores/pluginStore.ts'
import { getSlotContent } from '../plugins/slots.tsx'

export function PluginSidebarItems() {
  usePluginStore(s => s.plugins)
  const items = getSlotContent('sidebar:bottom')

  if (items.length === 0) return null

  return (
    <>
      {items.map((reg, i) => (
        <li key={`plugin-${reg.pluginId}-${i}`} className="w-full flex justify-center">
          {reg.render()}
        </li>
      ))}
    </>
  )
}
