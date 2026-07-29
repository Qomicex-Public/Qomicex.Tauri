import { useParams } from 'react-router-dom'
import { usePluginStore } from '../stores/pluginStore.ts'
import { activatePlugin, getSandbox } from '../plugins/plugin-loader.tsx'
import { useEffect, useRef } from 'react'

export default function PluginPage() {
  const { pluginId } = useParams<{ pluginId: string }>()
  const plugin = usePluginStore(s => s.plugins.find(p => p.manifest.id === pluginId))
  const activated = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!plugin || activated.current) return
    activated.current = true
    activatePlugin(plugin)
  }, [plugin])

  useEffect(() => {
    if (!pluginId) return
    const sb = getSandbox(pluginId)
    if (sb && containerRef.current && !sb.iframe.parentElement) {
      containerRef.current.appendChild(sb.iframe)
    }
  }, [pluginId, plugin])

  if (!plugin) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">插件未找到</p>
      </div>
    )
  }

  if (!plugin.manifest.entry.frontend) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
        <p className="text-lg font-medium">{plugin.manifest.name}</p>
        <p className="text-sm text-muted-foreground">该插件没有前端界面</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border/50 px-6 py-3">
        <h2 className="text-sm font-medium">{plugin.manifest.name}</h2>
        <span className="text-xs text-muted-foreground">v{plugin.manifest.version}</span>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="flex flex-1" />
      </div>
    </div>
  )
}
