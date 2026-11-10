// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getInstances, setDefaultInstance as apiSetDefaultInstance } from '../../../api/instance.ts'
import { loadSettings, openFolder } from '../../../api/settings.ts'
import { openExternalUrl } from '../../../api/system.ts'
import { NAV_PATHS, isSafeHttpsUrl, type NavTarget } from './schema.ts'
import type { WidgetAction } from './types.ts'
import type { GameInstance } from '../../../types/index.ts'

export interface WidgetActionContext {
  defaultInstance: GameInstance | null
  launch: (instance: GameInstance) => Promise<void>
  refreshDashboard: () => void
  selectAccount: () => Promise<void>
  refreshWidget: () => void
  notify: (message: string) => void
  navigateTo: (path: string) => void
  t: (key: string) => string
}

async function findInstance(ref: string): Promise<GameInstance> {
  const list = await getInstances()
  const lower = ref.toLowerCase()
  const found = list.find((item) => item.id === ref) ?? list.find((item) => item.name.toLowerCase() === lower)
  if (!found) throw new Error(ref)
  return found
}

export async function runWidgetAction(action: WidgetAction, ctx: WidgetActionContext): Promise<void> {
  const args = action.args
  switch (action.name) {
    case 'launch': {
      const instance = args.instance ? await findInstance(args.instance) : ctx.defaultInstance
      if (!instance) throw new Error(ctx.t('dashboard.noPinnedInstance'))
      await ctx.launch(instance)
      return
    }
    case 'setDefaultInstance': {
      const instance = await findInstance(args.instance)
      await apiSetDefaultInstance(instance.id)
      ctx.refreshDashboard()
      ctx.notify(ctx.t('dashboard.custom.actionDone'))
      return
    }
    case 'openInstance': {
      const instance = await findInstance(args.instance)
      ctx.navigateTo(`/instances/${encodeURIComponent(instance.id)}`)
      return
    }
    case 'navigate': {
      const target = args.to as NavTarget
      const path = NAV_PATHS[target]
      if (!path) throw new Error(args.to)
      ctx.navigateTo(path)
      return
    }
    case 'openUrl': {
      if (!isSafeHttpsUrl(args.url)) throw new Error(ctx.t('dashboard.custom.error.invalidUrl'))
      await openExternalUrl(args.url)
      return
    }
    case 'openFolder': {
      const settings = await loadSettings()
      const base = settings.gameDir.replace(/[/\\]+$/, '')
      const path = args.target === 'data'
        ? settings.dataDir
        : args.target === 'logs'
          ? `${base}/logs`
          : args.target === 'screenshots'
            ? `${base}/screenshots`
            : base
      await openFolder(path)
      return
    }
    case 'copy': {
      await navigator.clipboard.writeText(args.value)
      ctx.notify(ctx.t('dashboard.custom.actionDone'))
      return
    }
    case 'selectAccount': {
      await ctx.selectAccount()
      return
    }
    case 'install': {
      const category = args.category || 'mod'
      ctx.navigateTo(
        `/resource-center/${encodeURIComponent(args.projectId)}?source=${encodeURIComponent(args.source)}&category=${encodeURIComponent(category)}`,
      )
      return
    }
    case 'refresh': {
      ctx.refreshWidget()
      return
    }
    default:
      throw new Error(String(action.name))
  }
}
