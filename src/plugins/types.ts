// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export interface PluginManifest {
  id: string
  name: string
  version: string
  minLauncherVersion: string
  layers: PluginLayer[]
  permissions: string[]
  dependencies?: PluginDependency[]
  entry: PluginEntry
  render?: 'inline' | 'iframe' | 'webview'
  contributes?: PluginContributes
  icon?: string
  /** 插件自持 i18n 目录（包内相对路径，如 `"l10n"`）：内含 bundle.json（默认
   * 语言）+ bundle.<locale>.json；manifest 显示字符串用 `%key%` 引用词条，
   * 宿主按启动器 locale 解析；运行时经 `call('getPluginStrings')` 取包。 */
  l10n?: string
}

export interface PluginDependency {
  id: string
  version?: string
  optional?: boolean
}

export type PluginLayer = 'l0' | 'l1' | 'l2' | 'l3' | 'l4'

export interface PluginEntry {
  backend?: string
  frontend?: string
  theme?: string
}

export interface PluginContributes {
  downloadSources?: string[]
  commands?: string[]
  settingsPages?: string[]
  menuItems?: PluginMenuItem[]
  overlay?: { file: string; title?: string; width?: number; height?: number; minimizable?: boolean; resizable?: boolean }
  /** 图标主题：`.qtheme` 包内 icon-theme.json 的相对路径（如 `"dist/icon-theme.json"`）。 */
  iconTheme?: string
  /** 字体/连字贡献：激活时注入 `<link rel="stylesheet">` 的 CSS/CDN URL 列表。 */
  fontLinks?: string[]
  /** 声明可被本插件 hook 的启动器方法（配合运行时 `registerHook` 注册处理函数）。 */
  hooks?: PluginHookDecl[]
  /** UI 槽位注入：激活时把 slot 对应的 HTML 文件以独立 iframe 沙箱挂载到主界面槽位。 */
  slots?: PluginSlotContribution[]
  /** 安装方式贡献：出现在资源中心安装对话框的安装方式选项里（如「安装为服务端」）。
   * 用户选中并确认后，启动器经插件注册表调用 `installMode:{id}` 方法，附资源上下文。 */
  installModes?: PluginInstallModeDecl[]
}

/** 插件贡献的安装方式（资源中心安装对话框）。 */
export interface PluginInstallModeDecl {
  /** 稳定 id（插件内唯一）；启动器调用方法名 = `installMode:{id}` */
  id: string
  /** 选项显示名（如「安装为服务端」） */
  label: string
  /** 选项说明（对话框内 hover / 副标题） */
  description?: string
  /** emoji 或图标文本 */
  icon?: string
  /** 匹配的资源类型；缺省 = 所有类型。modpack 资源传 `['modpack']` */
  resourceKinds?: string[]
}

/** 一个可 hook 的方法声明：`method` 为启动器 hookable 方法名，如 `"launchInstance"`。 */
export interface PluginHookDecl {
  method: string
  /** 执行顺序优先级：数字越小越先执行（默认 100）。同优先级按注册先后。 */
  priority?: number
}

/** 主界面槽位。 */
export type PluginSlotId = 'header:right' | 'dashboard:widgets'

export interface PluginSlotContribution {
  /** 目标槽位：标题栏右侧（控制钮左侧）/ 主页右侧卡片区 */
  slot: PluginSlotId
  /** 槽位 HTML 文件（`.qplugin` 内相对路径，如 `dist/weather.html`） */
  file: string
  /** iframe 尺寸约束（可选）：height 固定高度（px），width 固定宽度（px） */
  width?: number
  height?: number
}

export interface PluginMenuItem {
  path: string
  label: string
  icon?: string
  action?: 'page' | 'overlay'
}

export interface PluginInfo {
  /** 生效清单（manifest 的 `%key%` 已按当前 locale 解析，供 UI 直接消费）。 */
  manifest: PluginManifest
  /** 后端返回的**未解析**原始清单。语言切换时以此重新解析——已解析结果里的
   * 文案不含 `%key%` 模板，无法反推回其它语言。 */
  rawManifest?: PluginManifest
  dir: string
  state: PluginState
  installedAt: string
  hasRollback?: boolean
}

export type PluginState = 'installed' | 'active' | 'disabled'

// 权限目录（40 项）与 PermissionInfo 的唯一事实源在 `@qomicex/plugin-ui`（插件包与
// 启动器共用同一份契约）。此前这里维护了一份逐项拷贝，两份已漂移到**顺序不同**
// （内容仍一致），且任何新增权限都要记得改两处 —— 漏一处就是静默的行为分叉（#238）。
// 类型与常量都从这里 re-export，调用方 import 路径保持不变。
export type { PermissionInfo } from '@qomicex/plugin-ui'
export { PERMISSION_CATALOG } from '@qomicex/plugin-ui'

