// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import { useMessageBox } from './ui'
import { usePluginStore } from '../stores/pluginStore.ts'
import { getSlotContent, registerSlot } from '../plugins/slots.tsx'
import { NavItem } from './Sidebar.tsx'
import { PluginIcon } from './PluginIcon.tsx'

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
    /**
     * 插件运行时追加侧边栏入口（addMenuItem）。
     *
     * 复用激活期已有的 slot 机制（`registerSlot`，push 语义，同一插件可注册多条）：
     * - 只接受插件给自己加入口（`detail.pluginId` 由桥注入，插件无法伪造他人身份）
     * - 去重以**注册表当前内容**为准，不额外维护「已见」集合：插件停用时
     *   `unregisterPluginSlots` 会清空其条目，重新启用后再次调用自然能恢复
     * - `registerSlot` 会触发订阅版本，侧边栏立刻重渲染
     */
    function handleAddMenuItem(e: Event) {
      const detail = (e as CustomEvent<{ pluginId?: string; item?: { path?: string; label?: string; icon?: string } }>).detail
      const pluginId = detail?.pluginId
      const item = detail?.item
      if (!pluginId || !item?.label) return
      const plugin = plugins.find((p) => p.manifest.id === pluginId)
      if (!plugin || plugin.state !== 'active') return
      const path = item.path ?? `/plugins/p/${pluginId}`
      const label = item.label
      const dedupeKey = `menu:${path}|${label}`
      // 以注册表为准去重：同一插件同类入口已存在就不再追加
      const exists = getSlotContent('sidebar:bottom').some(
        (reg) => reg.pluginId === pluginId && reg.dedupeKey === dedupeKey,
      )
      if (exists) return
      registerSlot(
        pluginId,
        'sidebar:bottom',
        () => (
          <NavItem
            to={path}
            label={label}
            icon={<PluginIcon pluginId={pluginId} icon={item.icon ?? ''} fallback={label[0]} />}
          />
        ),
        dedupeKey,
      )
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
    window.addEventListener('plugin:add-menu-item', handleAddMenuItem)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('plugin:navigate', handleNavigate)
      window.removeEventListener('plugin:open-settings', handleOpenSettings)
      window.removeEventListener('plugin:show-toast', handleToast)
      window.removeEventListener('plugin:add-menu-item', handleAddMenuItem)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [navigate, notify, plugins])

  return null
}
