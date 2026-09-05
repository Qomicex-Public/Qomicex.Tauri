import { useEffect, useMemo, useRef, useState } from 'react'
import { Tabs } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { usePluginStore } from '../stores/pluginStore.ts'
import { consumePluginSettings } from '../plugins/pluginSettingsNav.ts'
import { createSlotSandbox } from '../plugins/sandbox.ts'
import { PluginSlot } from '../plugins/PluginSlot.tsx'
import type { SandboxInstance } from '../plugins/sandbox.ts'

/**
 * 插件设置：聚合所有贡献了 `contributes.settingsPages` 的 active 插件，
 * 左侧纵向 tab 逐插件列出，右侧以 iframe 沙箱渲染插件包内设置 HTML。
 * 沙箱经 createSlotSandbox 注入完整 __PLUGIN_API__ 桥（getSettings/setSettings 等），
 * 插件停用/卸载时由 deactivation 流程与 prune 逻辑自动销毁。
 */
export default function PluginSettingsTab() {
  const { t } = useI18n()
  const plugins = usePluginStore((s) => s.plugins)
  // active 可为完整 tab key（`${pluginId}:${file}`）或插件 id（openPluginSettings 跳转），两段匹配
  const [active, setActive] = useState(() => consumePluginSettings() ?? '')
  const [, bump] = useState(0)
  const sandboxesRef = useRef(new Map<string, SandboxInstance>())

  const entries = useMemo(() => plugins.flatMap((p) => {
    if (p.state !== 'active') return []
    const pages = p.manifest.contributes?.settingsPages ?? []
    return pages.map((file, i) => ({
      key: `${p.manifest.id}:${file}`,
      label: pages.length > 1 ? `${p.manifest.name} ${i + 1}` : p.manifest.name,
      plugin: p,
      file,
    }))
  }), [plugins])

  const current = entries.find((e) => e.key === active)
    ?? entries.find((e) => e.key.startsWith(`${active}:`))
    ?? entries[0]

  // openPluginSettings：挂载后收到事件定位到目标插件（挂载前由 pending 初始化兜底）
  useEffect(() => {
    const open = () => {
      const id = consumePluginSettings()
      if (id) setActive(id)
    }
    window.addEventListener('plugin:open-settings', open)
    return () => window.removeEventListener('plugin:open-settings', open)
  }, [])

  useEffect(() => {
    const map = sandboxesRef.current
    const valid = new Set(entries.map((e) => e.key))
    for (const k of [...map.keys()]) {
      if (!valid.has(k)) {
        map.get(k)!.destroy()
        map.delete(k)
      }
    }
    if (current && !map.has(current.key)) {
      try {
        map.set(current.key, createSlotSandbox(current.plugin, current.file))
        bump((v) => v + 1)
      } catch (e) {
        console.error('[plugin-settings] 挂载失败', current.key, e)
      }
    }
  }, [entries, current])

  if (entries.length === 0) {
    return <div className="text-sm text-muted-foreground">{t('settings.plugins.store.tabSettingsEmpty')}</div>
  }

  return (
    <div className="flex gap-4">
      <div className="w-40 shrink-0 self-start">
        <Tabs
          tabs={entries.map((e) => ({ id: e.key, label: e.label }))}
          activeTab={current?.key ?? ''}
          onChange={setActive}
          orientation="vertical"
        />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border bg-background">
        {current && sandboxesRef.current.has(current.key) && (
          <PluginSlot
            key={current.key}
            slotId={`plugin-settings:${current.key}`}
            sandbox={sandboxesRef.current.get(current.key)!}
            height={560}
          />
        )}
      </div>
    </div>
  )
}
