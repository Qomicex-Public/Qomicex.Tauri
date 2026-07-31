export interface PluginManifest {
  id: string
  name: string
  version: string
  minLauncherVersion: string
  layers: PluginLayer[]
  permissions: string[]
  entry: PluginEntry
  contributes?: PluginContributes
}

export type PluginLayer = 'l0' | 'l1' | 'l2' | 'l3'

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
}

export type PluginState = 'installed' | 'active' | 'disabled'

export interface PermissionInfo {
  id: string
  label: string
  risk: 'normal' | 'warning' | 'danger'
}

export const PERMISSION_CATALOG: Record<string, PermissionInfo> = {
  'instance:read':       { id: 'instance:read',       label: '读取实例列表',           risk: 'normal' },
  'instance:write':      { id: 'instance:write',      label: '创建/修改/删除实例',     risk: 'warning' },
  'account:read':        { id: 'account:read',        label: '读取账号列表',           risk: 'normal' },
  'license:read':        { id: 'license:read',        label: '读取许可证信息',         risk: 'normal' },
  'config:read':         { id: 'config:read',         label: '读取启动器配置',         risk: 'normal' },
  'config:write':        { id: 'config:write',        label: '修改启动器配置',         risk: 'warning' },
  'endpoint:discover':   { id: 'endpoint:discover',   label: '获取后端 API 端点',     risk: 'normal' },
  'page:list':           { id: 'page:list',            label: '获取页面列表',           risk: 'normal' },
  'network:fetch':       { id: 'network:fetch',       label: '发送 HTTP 请求',         risk: 'warning' },
  'network:websocket':   { id: 'network:websocket',   label: 'WebSocket 连接',         risk: 'warning' },
  'network:proxy':       { id: 'network:proxy',       label: '修改代理设置',           risk: 'warning' },
  'ui:inject_sidebar':   { id: 'ui:inject_sidebar',   label: '注入侧边栏菜单',        risk: 'normal' },
  'ui:inject_settings':  { id: 'ui:inject_settings',  label: '注入设置页',             risk: 'normal' },
  'ui:picture_in_picture': { id: 'ui:picture_in_picture', label: '画中画窗口',         risk: 'warning' },
  'ui:sub_window':       { id: 'ui:sub_window',        label: '独立子窗口',             risk: 'warning' },
  'ui:context_menu':     { id: 'ui:context_menu',     label: '注入右键菜单',           risk: 'normal' },
  'ui:toast':            { id: 'ui:toast',             label: '应用内通知',             risk: 'normal' },
  'ui:navigate':         { id: 'ui:navigate',          label: '跳转页面',               risk: 'normal' },
  'system:info':         { id: 'system:info',          label: '读取系统和启动器信息',   risk: 'normal' },
  'system:notification': { id: 'system:notification',  label: '发送系统通知',           risk: 'normal' },
  'clipboard:read':      { id: 'clipboard:read',       label: '读取剪贴板',             risk: 'warning' },
  'clipboard:write':     { id: 'clipboard:write',      label: '写入剪贴板',             risk: 'warning' },
  'wasm:execute':        { id: 'wasm:execute',         label: '执行 WASM 模块',         risk: 'warning' },
  'plugin:install':      { id: 'plugin:install',       label: '安装/卸载/更新插件',     risk: 'danger' },
  'resource:read':       { id: 'resource:read',        label: '读取游戏资源文件',       risk: 'normal' },
  'resource:write':      { id: 'resource:write',       label: '写入游戏资源文件',       risk: 'warning' },
  'java:manage':         { id: 'java:manage',          label: '管理 Java 运行时',       risk: 'warning' },
  'game:process':        { id: 'game:process',         label: '启停游戏进程',           risk: 'warning' },
  'game:log':            { id: 'game:log',             label: '检测游戏日志',           risk: 'normal' },
  'connector:host':      { id: 'connector:host',       label: '启停联机',               risk: 'warning' },
  'connector:scan':      { id: 'connector:scan',       label: '扫描局域网联机',         risk: 'normal' },
  'shell:execute':       { id: 'shell:execute',        label: '执行系统命令',           risk: 'danger' },
  'filesystem:read':     { id: 'filesystem:read',      label: '读取文件系统',           risk: 'warning' },
  'filesystem:write':    { id: 'filesystem:write',     label: '写入文件系统',           risk: 'danger' },
}
