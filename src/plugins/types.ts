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
  manifest: PluginManifest
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

