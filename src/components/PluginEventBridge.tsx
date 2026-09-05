import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import { useMessageBox } from './ui'
import { usePluginStore } from '../stores/pluginStore.ts'

const COMMAND_KEY_MAP: Record<string, (e: KeyboardEvent) => boolean> = {
  'devtools:toggle': (e) => e.ctrlKey && e.shiftKey && e.key === 'I',
}

export function PluginEventBridge() {
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const plugins = usePluginStore(s => s.plugins)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<string[]>('file-drop', (event) => {
      const paths = event.payload
      if (!paths?.length) return
      const registry = (window as any).__pluginRegistry
      if (registry?.call) {
        registry.call('top.qomicex.assistant', 'handleFileDrop', [paths]).catch(() => {})
      }
    }).then((fn) => { unlisten = fn }).catch(() => {})
    return () => { unlisten?.() }
  }, [])

  useEffect(() => {
    function handleNavigate(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail?.path) return
      const plugin = plugins.find(p => p.manifest.id === detail.pluginId)
      if (plugin) {
        navigate(`/plugins/p/${detail.pluginId}`)
      } else {
        navigate(detail.path)
      }
    }
    function handleOpenSettings() {
      navigate('/settings?tab=plugins')
    }
    function handleToast(e: Event) {
      const detail = (e as CustomEvent).detail
      if (detail?.message) notify(detail.message, detail.type ?? 'info')
    }
    function handleKeyDown(e: KeyboardEvent) {
      const activePlugins = plugins.filter(p => p.state === 'active')
      for (const plugin of activePlugins) {
        const commands = plugin.manifest.contributes?.commands ?? []
        for (const cmd of commands) {
          const match = COMMAND_KEY_MAP[cmd]
          if (match && match(e)) {
            e.preventDefault()
            window.dispatchEvent(new CustomEvent('plugin:command', { detail: { pluginId: plugin.manifest.id, command: cmd } }))
            return
          }
        }
      }
    }
    window.addEventListener('plugin:navigate', handleNavigate)
    window.addEventListener('plugin:open-settings', handleOpenSettings)
    window.addEventListener('plugin:show-toast', handleToast)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('plugin:navigate', handleNavigate)
      window.removeEventListener('plugin:open-settings', handleOpenSettings)
      window.removeEventListener('plugin:show-toast', handleToast)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [navigate, notify, plugins])

  return null
}
