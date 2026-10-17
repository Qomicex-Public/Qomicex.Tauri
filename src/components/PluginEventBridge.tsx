// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import { useMessageBox } from './ui'
import { usePluginStore } from '../stores/pluginStore.ts'
import { registerSlot } from '../plugins/slots.tsx'
import { NavItem } from './Sidebar.tsx'
import { PluginIcon } from './PluginIcon.tsx'

const COMMAND_KEY_MAP: Record<string, (e: KeyboardEvent) => boolean> = {
  'devtools:toggle': (e) => e.ctrlKey && e.shiftKey && e.key === 'I',
}

export function PluginEventBridge() {
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const plugins = usePluginStore(s => s.plugins)
  /** 运行时追加的菜单项去重键（跨 effect 重建保持）。 */
  const dynamicMenuSeen = useRef(new Set<string>())

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
     * 复用激活期已有的 slot 机制（`registerSlot`），不新增 store 状态：
     * - 只接受插件给自己加入口（`detail.pluginId` 由桥注入，插件无法伪造他人身份）
     * - 按 pluginId + path 去重，避免反复调用堆积重复条目
     * - 插件停用时 `unregisterPluginSlots` 会一并清掉
     *
     * TODO(#264): 当前 registerSlot 以 pluginId 为 key 覆盖式注册，同一插件追加第二个
     * 入口会顶掉第一个。manifest 静态 menuItems 是逐个 registerSlot 的，运行时追加需要
     * slot 层支持多条目，改动面较大，留待专门处理。
     */
    function handleAddMenuItem(e: Event) {
      const detail = (e as CustomEvent<{ pluginId?: string; item?: { path?: string; label?: string; icon?: string } }>).detail
      const pluginId = detail?.pluginId
      const item = detail?.item
      if (!pluginId || !item?.label) return
      const plugin = plugins.find((p) => p.manifest.id === pluginId)
      if (!plugin || plugin.state !== 'active') return
      if (dynamicMenuSeen.current.has(`${pluginId}|${item.path ?? ''}|${item.label}`)) return
      dynamicMenuSeen.current.add(`${pluginId}|${item.path ?? ''}|${item.label}`)
      registerSlot(pluginId, 'sidebar:bottom', () => (
        <NavItem
          to={item.path ?? `/plugins/p/${pluginId}`}
          label={item.label!}
          icon={<PluginIcon pluginId={pluginId} icon={item.icon ?? ''} fallback={item.label![0]} />}
        />
      ))
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
