// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getInstances, setDefaultInstance as apiSetDefaultInstance } from '../../../api/instance.ts'
import { loadSettings, openFolder } from '../../../api/settings.ts'
import { openExternalUrl } from '../../../api/system.ts'
import { NAV_PATHS, isSafeHttpsUrl, type NavTarget } from './schema.ts'
import { actionArguments } from './script/functions.ts'
import type { ActionSpec } from './types.ts'
import type { GameInstance } from '../../../types/index.ts'

export interface WidgetActionContext {
  defaultInstance: GameInstance | null
  launch: (instance: GameInstance) => Promise<void>
  refreshDashboard: () => void
  selectAccount: () => Promise<void>
  refreshWidget: () => void
  notify: (message: string) => void
  navigateTo: (path: string) => void
  runFunction: (name: string, action: ActionSpec) => Promise<void>
  runCommand: (command: string, workingDirectory?: string, timeout?: number) => Promise<void>
  callPlugin: (pluginId: string, method: string, args: unknown) => Promise<void>
  scope: Record<string, unknown>
  t: (key: string) => string
}

async function findInstance(ref: string): Promise<GameInstance> {
  const list = await getInstances()
  const lower = ref.toLowerCase()
  const found = list.find((item) => item.id === ref) ?? list.find((item) => item.name.toLowerCase() === lower)
  if (!found) throw new Error(ref)
  return found
}

const INSTALL_SOURCE: Record<string, string> = {
  Curseforge: 'curseforge',
  Modrinth: 'modrinth',
  Ftb: 'ftb',
}

const INSTALL_CATEGORY: Record<string, string> = {
  Mod: 'mod',
  Modpack: 'modpack',
  Shader: 'shader',
  Resourcepack: 'resourcepack',
  Datapack: 'datapack',
  Save: 'save',
}

export async function runWidgetAction(action: ActionSpec, ctx: WidgetActionContext): Promise<void> {
  const args = action.args
  switch (action.name) {
    case 'Launch': {
      const instance = args.Instance ? await findInstance(args.Instance) : ctx.defaultInstance
      if (!instance) throw new Error(ctx.t('dashboard.noPinnedInstance'))
      await ctx.launch(instance)
      return
    }
    case 'SetDefaultInstance': {
      const instance = await findInstance(args.Instance)
      await apiSetDefaultInstance(instance.id)
      ctx.refreshDashboard()
      ctx.notify(ctx.t('dashboard.custom.actionDone'))
      return
    }
    case 'OpenInstance': {
      const instance = await findInstance(args.Instance)
      ctx.navigateTo(`/instances/${encodeURIComponent(instance.id)}`)
      return
    }
    case 'Navigate': {
      const path = NAV_PATHS[args.To as NavTarget]
      if (!path) throw new Error(args.To)
      ctx.navigateTo(path)
      return
    }
    case 'OpenUrl': {
      if (!isSafeHttpsUrl(args.Url ?? '')) throw new Error(ctx.t('dashboard.custom.error.invalidUrl'))
      await openExternalUrl(args.Url ?? '')
      return
    }
    case 'OpenFolder': {
      const settings = await loadSettings()
      const base = settings.gameDir.replace(/[/\\]+$/, '')
      const path = args.Folder === 'Data'
        ? settings.dataDir
        : args.Folder === 'Logs'
          ? `${base}/logs`
          : args.Folder === 'Screenshots'
            ? `${base}/screenshots`
            : base
      await openFolder(path)
      return
    }
    case 'Copy': {
      await navigator.clipboard.writeText(args.Value ?? '')
      ctx.notify(ctx.t('dashboard.custom.actionDone'))
      return
    }
    case 'SelectAccount': {
      await ctx.selectAccount()
      return
    }
    case 'Install': {
      const source = INSTALL_SOURCE[args.Source ?? ''] ?? 'modrinth'
      const category = INSTALL_CATEGORY[args.Category ?? 'Mod'] ?? 'mod'
      ctx.navigateTo(
        `/resource-center/${encodeURIComponent(args.ProjectId)}?source=${source}&category=${category}`,
      )
      return
    }
    case 'Refresh': {
      ctx.refreshWidget()
      return
    }
    case 'CallFunction': {
      await ctx.runFunction(args.Function, action)
      return
    }
    case 'RunCommand': {
      const timeout = args.Timeout ? Number(args.Timeout) : undefined
      await ctx.runCommand(args.Command, args.WorkingDirectory, timeout)
      return
    }
    case 'PluginApi': {
      const payload = actionArguments(action, ctx.scope)
      await ctx.callPlugin(args.PluginId, args.Method, payload)
      return
    }
    default:
      throw new Error(String(action.name))
  }
}
