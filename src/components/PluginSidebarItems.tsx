// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Fragment } from 'react'
import { usePluginStore } from '../stores/pluginStore.ts'
import { getSlotContent } from '../plugins/slots.tsx'

export function PluginSidebarItems() {
  usePluginStore(s => s.plugins)
  const items = getSlotContent('sidebar:bottom')

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
