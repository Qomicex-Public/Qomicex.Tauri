// 权限目录（与 src/plugins/types.ts PERMISSION_CATALOG 保持一致，供 verify 使用）
export interface PermissionInfo {
  id: string
  risk: 'normal' | 'warning' | 'danger'
}

export const PERMISSION_CATALOG: Record<string, PermissionInfo> = {
  'instance:read':       { id: 'instance:read',       risk: 'normal' },
  'instance:write':      { id: 'instance:write',      risk: 'warning' },
  'account:read':        { id: 'account:read',        risk: 'normal' },
  'license:read':        { id: 'license:read',        risk: 'normal' },
  'config:read':         { id: 'config:read',         risk: 'normal' },
  'config:write':        { id: 'config:write',        risk: 'warning' },
  'cache:access':        { id: 'cache:access',        risk: 'normal' },
  'endpoint:discover':   { id: 'endpoint:discover',   risk: 'normal' },
  'page:list':           { id: 'page:list',           risk: 'normal' },
  'network:fetch':       { id: 'network:fetch',       risk: 'warning' },
  'network:cors_proxy':  { id: 'network:cors_proxy',  risk: 'warning' },
  'network:websocket':   { id: 'network:websocket',   risk: 'warning' },
  'network:proxy':       { id: 'network:proxy',       risk: 'warning' },
  'ui:inject_sidebar':   { id: 'ui:inject_sidebar',   risk: 'normal' },
  'ui:inject_settings':  { id: 'ui:inject_settings',  risk: 'normal' },
  'ui:picture_in_picture': { id: 'ui:picture_in_picture', risk: 'warning' },
  'ui:sub_window':       { id: 'ui:sub_window',       risk: 'warning' },
  'ui:context_menu':     { id: 'ui:context_menu',     risk: 'normal' },
  'ui:toast':            { id: 'ui:toast',            risk: 'normal' },
  'ui:navigate':         { id: 'ui:navigate',         risk: 'normal' },
  'system:info':         { id: 'system:info',         risk: 'normal' },
  'system:notification': { id: 'system:notification', risk: 'normal' },
  'clipboard:read':      { id: 'clipboard:read',      risk: 'warning' },
  'clipboard:write':     { id: 'clipboard:write',     risk: 'warning' },
  'wasm:execute':        { id: 'wasm:execute',        risk: 'warning' },
  'plugin:install':      { id: 'plugin:install',      risk: 'danger' },
  'plugin:list':         { id: 'plugin:list',         risk: 'normal' },
  'resource:read':       { id: 'resource:read',       risk: 'normal' },
  'resource:write':      { id: 'resource:write',      risk: 'warning' },
  'java:manage':         { id: 'java:manage',         risk: 'warning' },
  'download:manage':     { id: 'download:manage',     risk: 'warning' },
  'game:process':        { id: 'game:process',        risk: 'warning' },
  'game:log':            { id: 'game:log',            risk: 'normal' },
  'connector:host':      { id: 'connector:host',      risk: 'warning' },
  'connector:scan':      { id: 'connector:scan',      risk: 'normal' },
  'shell:execute':       { id: 'shell:execute',       risk: 'danger' },
  'filesystem:read':     { id: 'filesystem:read',     risk: 'warning' },
  'filesystem:write':    { id: 'filesystem:write',    risk: 'danger' },
}

// 桥方法 → 所需权限（与 src/plugins/sandbox.ts METHOD_PERMISSIONS 保持一致，供权限最小化扫描）
export const METHOD_PERMISSIONS: Record<string, string> = {
  getSettings: 'config:read', setSettings: 'config:write', setCache: 'cache:access', getCache: 'cache:access', callBackend: 'network:fetch', uploadPlugin: 'plugin:install', proxyFetch: 'network:cors_proxy', proxyFetchStream: 'network:cors_proxy',
  registerMethod: 'config:write', callPlugin: 'network:fetch', callWasm: 'wasm:execute', listWasmPlugins: 'wasm:execute',
  readText: 'filesystem:read', readBytes: 'filesystem:read', writeText: 'filesystem:write', writeBytes: 'filesystem:write', deleteFile: 'filesystem:write', execCommand: 'shell:execute',
  navigate: 'config:read', showToast: 'ui:toast', getSystemInfo: 'system:info', openUrl: 'system:notification', listPlugins: 'plugin:list',
  'overlay.create': 'ui:sub_window', 'overlay.show': 'ui:sub_window', 'overlay.hide': 'ui:sub_window',
  'overlay.destroy': 'ui:sub_window', 'overlay.setHtml': 'ui:sub_window', 'overlay.setPosition': 'ui:sub_window',
  'download.addTask': 'download:manage', 'download.progress': 'download:manage', 'download.cancel': 'download:manage', 'download.list': 'download:manage', 'download.registerInstall': 'instance:write',
  'modpack.install': 'instance:write',
}
