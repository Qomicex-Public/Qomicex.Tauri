import { useEffect, useState, useCallback } from 'react'
import { PageHeader } from '../components/PageHeader.tsx'
import { PluginCard } from '../components/PluginCard.tsx'
import { Button } from '../components/ui/button.tsx'
import { usePluginStore } from '../stores/pluginStore.ts'
import { activatePlugin, deactivatePlugin } from '../plugins/plugin-loader.tsx'

export default function PluginManager() {
  const { plugins, loading, loadPlugins, setPluginState } = usePluginStore()
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => { loadPlugins() }, [loadPlugins])

  const handleToggle = useCallback(async (id: string, active: boolean) => {
    const plugin = plugins.find(p => p.manifest.id === id)
    if (!plugin) return
    if (active) {
      await activatePlugin(plugin)
    } else {
      deactivatePlugin(id)
    }
    setPluginState(id, active ? 'active' : 'disabled')
  }, [plugins, setPluginState])

  const handleUninstall = useCallback(async (id: string) => {
    if (!confirm('确定卸载此插件？')) return
    deactivatePlugin(id)
    try {
      const res = await fetch(`/api/plugins/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Uninstall failed')
      setMessage('插件已卸载')
      await loadPlugins()
    } catch {
      setMessage('卸载失败')
    }
  }, [loadPlugins])

  const handleInstall = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.qplugin,.zip'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const form = new FormData()
      form.append('plugin', file)
      try {
        const res = await fetch('/api/plugins/upload', { method: 'POST', body: form })
        if (!res.ok) throw new Error('Upload failed')
        setMessage('插件安装成功')
        await loadPlugins()
      } catch (e) {
        alert('安装失败: ' + (e instanceof Error ? e.message : 'Unknown'))
      }
    }
    input.click()
  }

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 3000)
    return () => clearTimeout(t)
  }, [message])

  return (
    <div className="flex flex-1 flex-col p-6 gap-6 overflow-auto">
      <PageHeader
        title="插件管理"
        subtitle={`已安装 ${plugins.length} 个插件`}
        actions={
          <Button onClick={handleInstall}>安装插件</Button>
        }
      />
      {message && (
        <div className="rounded bg-primary/10 text-primary px-4 py-2 text-sm">
          {message}
        </div>
      )}
      {loading ? (
        <p className="text-muted-foreground">加载中...</p>
      ) : plugins.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted-foreground">尚未安装任何插件</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plugins.map(p => (
            <PluginCard key={p.manifest.id} plugin={p} onToggle={handleToggle} onUninstall={handleUninstall} />
          ))}
        </div>
      )}
    </div>
  )
}
