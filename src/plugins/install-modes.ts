// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 插件贡献的「安装方式」（contributes.installModes）收集与调用。
//
// 入口在资源中心安装对话框：用户选中某个插件安装方式并确认后，启动器经插件
// 注册表调用该插件的 `installMode:{id}` 方法（插件需 registerMethod 注册），
// 附资源上下文 PluginInstallContext。后端进度统一走 InstallTracker → 下载中心。

import { usePluginStore } from '../stores/pluginStore.ts'

export interface PluginInstallMode {
  /** 贡献该方式的插件 id */
  pluginId: string
  /** 插件显示名（对话框标注来源用） */
  pluginName: string
  id: string
  label: string
  description?: string
  icon?: string
  resourceKinds?: string[]
}

/** 资源安装上下文（传给插件 `installMode:{id}` 方法的唯一实参）。 */
export interface PluginInstallContext {
  /** 资源类型：modpack / mod / resourcepack / shaderpack / datapack… */
  kind: string
  /** 来源：'modrinth' | 'curseforge' | 'technic' | …；本地文件为 'local' */
  source: string
  /** 在线资源的项目 id（本地文件时缺省） */
  projectId?: string
  /** 在线资源的版本 id */
  fileId?: string
  /** 资源名（建议作为安装名） */
  name: string
  /** 游戏 MC 版本（已知时） */
  gameVersion?: string
  /** 图标 URL（已知时） */
  iconUrl?: string
  /** 本地文件绝对路径（本地导入时） */
  path?: string
}

/** 收集当前激活插件声明的、匹配资源类型的安装方式（按插件加载顺序）。 */
export function collectInstallModes(kind: string): PluginInstallMode[] {
  const { plugins } = usePluginStore.getState()
  const out: PluginInstallMode[] = []
  for (const p of plugins) {
    if (p.state !== 'active') continue
    for (const m of p.manifest.contributes?.installModes ?? []) {
      if (m.resourceKinds && !m.resourceKinds.includes(kind)) continue
      out.push({
        pluginId: p.manifest.id,
        pluginName: p.manifest.name,
        id: m.id,
        label: m.label,
        description: m.description,
        icon: m.icon,
        resourceKinds: m.resourceKinds,
      })
    }
  }
  return out
}

/**
 * 把安装上下文交给插件处理。目标插件未激活或未注册 `installMode:{id}` 方法时
 * 抛错（调用方 toast 提示）；方法内部出错同样向上抛（对话框负责展示）。
 */
export async function invokeInstallMode(mode: PluginInstallMode, ctx: PluginInstallContext): Promise<void> {
  const registry = (window as unknown as { __pluginRegistry?: { has(id: string, method?: string): boolean; call(id: string, method: string, args: unknown[]): Promise<unknown> } }).__pluginRegistry
  const method = `installMode:${mode.id}`
  if (!registry || !registry.has(mode.pluginId, method)) {
    throw new Error(`插件 ${mode.pluginName} 未就绪（方法 ${method} 未注册），请启用插件后重试`)
  }
  await registry.call(mode.pluginId, method, [ctx])
}
