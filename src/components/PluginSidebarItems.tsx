// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Fragment } from 'react'
import { usePluginStore } from '../stores/pluginStore.ts'
import { useSlotContent } from '../plugins/slots.tsx'

export function PluginSidebarItems() {
  usePluginStore(s => s.plugins)
  // 槽位注册表可能被运行时追加（addMenuItem），必须订阅注册表版本而不仅是插件 store
  const items = useSlotContent('sidebar:bottom')

  if (items.length === 0) return null

  return (
    <>
      {items.map((reg, i) => (
        <Fragment key={`plugin-${reg.pluginId}-${i}`}>
          {reg.render()}
        </Fragment>
      ))}
    </>
  )
}
