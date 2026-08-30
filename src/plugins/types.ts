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
}

/** 一个可 hook 的方法声明：`method` 为启动器 hookable 方法名，如 `"launchInstance"`。 */
export interface PluginHookDecl {
  method: string
  /** 执行顺序优先级：数字越小越先执行（默认 100）。同优先级按注册先后。 */
  priority?: number
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

export interface PermissionInfo {
  id: string
  /** i18n key under plugins.permission.* */
  key: string
  risk: 'normal' | 'warning' | 'danger'
}

export const PERMISSION_CATALOG: Record<string, PermissionInfo> = {
  'instance:read':       { id: 'instance:read',       key: 'plugins.permission.instanceRead',       risk: 'normal' },
  'instance:write':      { id: 'instance:write',      key: 'plugins.permission.instanceWrite',      risk: 'warning' },
  'account:read':        { id: 'account:read',        key: 'plugins.permission.accountRead',        risk: 'normal' },
  'license:read':        { id: 'license:read',        key: 'plugins.permission.licenseRead',        risk: 'normal' },
  'config:read':         { id: 'config:read',         key: 'plugins.permission.configRead',         risk: 'normal' },
  'config:write':        { id: 'config:write',        key: 'plugins.permission.configWrite',        risk: 'warning' },
  'cache:access':        { id: 'cache:access',        key: 'plugins.permission.cacheAccess',        risk: 'normal' },
  'endpoint:discover':   { id: 'endpoint:discover',   key: 'plugins.permission.endpointDiscover',   risk: 'normal' },
  'page:list':           { id: 'page:list',           key: 'plugins.permission.pageList',           risk: 'normal' },
  'network:fetch':       { id: 'network:fetch',       key: 'plugins.permission.networkFetch',       risk: 'warning' },
  'network:cors_proxy':  { id: 'network:cors_proxy',  key: 'plugins.permission.networkCorsProxy',  risk: 'warning' },
  'network:websocket':   { id: 'network:websocket',   key: 'plugins.permission.networkWebsocket',   risk: 'warning' },
  'network:proxy':       { id: 'network:proxy',       key: 'plugins.permission.networkProxy',       risk: 'warning' },
  'ui:inject_sidebar':   { id: 'ui:inject_sidebar',   key: 'plugins.permission.uiInjectSidebar',   risk: 'normal' },
  'ui:inject_settings':  { id: 'ui:inject_settings',  key: 'plugins.permission.uiInjectSettings',  risk: 'normal' },
  'ui:picture_in_picture': { id: 'ui:picture_in_picture', key: 'plugins.permission.uiPictureInPicture', risk: 'warning' },
  'ui:sub_window':       { id: 'ui:sub_window',       key: 'plugins.permission.uiSubWindow',       risk: 'warning' },
  'ui:context_menu':     { id: 'ui:context_menu',     key: 'plugins.permission.uiContextMenu',     risk: 'normal' },
  'ui:toast':            { id: 'ui:toast',            key: 'plugins.permission.uiToast',            risk: 'normal' },
  'ui:navigate':         { id: 'ui:navigate',         key: 'plugins.permission.uiNavigate',         risk: 'normal' },
  'system:info':         { id: 'system:info',         key: 'plugins.permission.systemInfo',         risk: 'normal' },
  'system:notification': { id: 'system:notification', key: 'plugins.permission.systemNotification', risk: 'normal' },
  'clipboard:read':      { id: 'clipboard:read',      key: 'plugins.permission.clipboardRead',      risk: 'warning' },
  'clipboard:write':     { id: 'clipboard:write',     key: 'plugins.permission.clipboardWrite',     risk: 'warning' },
  'wasm:execute':        { id: 'wasm:execute',        key: 'plugins.permission.wasmExecute',        risk: 'warning' },
  'plugin:install':      { id: 'plugin:install',      key: 'plugins.permission.pluginInstall',      risk: 'danger' },
  'plugin:list':         { id: 'plugin:list',         key: 'plugins.permission.pluginList',         risk: 'normal' },
  'plugin:log':          { id: 'plugin:log',          key: 'plugins.permission.pluginLog',          risk: 'normal' },
  'resource:read':       { id: 'resource:read',       key: 'plugins.permission.resourceRead',       risk: 'normal' },
  'resource:write':      { id: 'resource:write',      key: 'plugins.permission.resourceWrite',      risk: 'warning' },
  'java:manage':         { id: 'java:manage',         key: 'plugins.permission.javaManage',         risk: 'warning' },
  'download:manage':     { id: 'download:manage',     key: 'plugins.permission.downloadManage',     risk: 'warning' },
  'game:process':        { id: 'game:process',        key: 'plugins.permission.gameProcess',        risk: 'warning' },
  'game:log':            { id: 'game:log',            key: 'plugins.permission.gameLog',            risk: 'normal' },
  'connector:host':      { id: 'connector:host',      key: 'plugins.permission.connectorHost',      risk: 'warning' },
  'connector:scan':      { id: 'connector:scan',      key: 'plugins.permission.connectorScan',      risk: 'normal' },
  'hook:register':       { id: 'hook:register',       key: 'plugins.permission.hookRegister',       risk: 'danger' },
  'shell:execute':       { id: 'shell:execute',       key: 'plugins.permission.shellExecute',       risk: 'danger' },
  'filesystem:read':     { id: 'filesystem:read',     key: 'plugins.permission.filesystemRead',     risk: 'warning' },
  'filesystem:write':    { id: 'filesystem:write',    key: 'plugins.permission.filesystemWrite',    risk: 'danger' },
}
