/**
 * `qomicex-launcher://` OS 级深链（issue #127）的解析与动作分发。
 *
 * # 与 `src/api/ipc.ts` 的 `qomicex://` 无关
 *
 * `ipc.ts` 里的 `qomicex` 是 webview **内部**自定义协议（前后端 QIPC 管道传输，
 * ADR-040）；本模块处理的是**操作系统级** URL 协议，由浏览器等外部程序唤起启动器。
 * 两者同名会在 macOS/Linux 上产生真实歧义，故 OS 协议名取 `qomicex-launcher`
 * （见 ADR-087），内部协议零改动。
 *
 * # 支持的动作
 *
 * ```
 * qomicex-launcher://launch/<实例名或ID>
 * qomicex-launcher://open/<route>                      // 仅白名单路由
 * qomicex-launcher://join/<房间码>
 * qomicex-launcher://install/plugin?slug=<slug>&version=<v>
 * qomicex-launcher://install/plugin?url=<https://….qplugin>
 * qomicex-launcher://install/modpack?type=modrinth|curseforge&projectId=<p>&fileId=<f>[&name=<实例名>]
 * ```
 *
 * `install/modpack` 的 `projectId`+`fileId` 是**后端硬要求**（`/modpack/install-direct`
 * 在线分支两者缺一即 400 `MODPACK_SOURCE_REQUIRED`），`name` 缺省时由解析出的包名兜底。
 * 不支持 `path=`（本地任意路径）：那条分支等于让网页指定磁盘文件，不做。
 *
 * # 安全
 *
 * 深链可被任意网页触发，因此**凡是要落地代码的动作都必须经用户确认**：
 * 只有来源主机命中 `AUTO_INSTALL_HOSTS`（官方域）时才免确认，其余一律弹窗。
 * `open` 只接受白名单内的内部路由，避免任意路径注入。
 */

/** OS 协议名（不含 `://`）。 */
export const DEEP_LINK_SCHEME = 'qomicex-launcher'

/** Rust 侧转发深链的事件名（`src-tauri/src/deep_link.rs` 的 EVENT_NAME）。 */
export const DEEP_LINK_EVENT = 'deep-link://action'

/**
 * 免确认安装的官方主机白名单。
 *
 * 只有这里列出的主机才允许「点链接即装」；其余（含任意第三方 CDN）必须弹窗确认。
 * 注意这是**主机**精确匹配，不做后缀匹配——`evil-qomicex.top` 不应因后缀相同而放行。
 */
export const AUTO_INSTALL_HOSTS: readonly string[] = ['api.qomicex.top', 'qomicex.top']

/** `open` 允许跳转的内部路由前缀白名单。 */
const ALLOWED_ROUTES: readonly string[] = [
  '/',
  '/instances',
  '/downloads',
  '/accounts',
  '/resource-center',
  '/connect',
  '/settings',
  '/running',
  '/log-analysis',
]

export type DeepLinkAction =
  | { kind: 'launch'; target: string }
  | { kind: 'open'; route: string }
  | { kind: 'join'; code: string }
  | { kind: 'installPlugin'; slug?: string; version?: string; url?: string }
  | { kind: 'installModpack'; source: ModpackSource; projectId: string; fileId: string; name?: string }

/** 后端 `install-direct` 在线分支接受的来源标识（见 `modpack.rs` 的 source 匹配）。 */
export type ModpackSource = 'modrinth' | 'curseforge' | 'ftb'

function normalizeModpackSource(raw: string | null): ModpackSource | null {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'mr':
    case 'modrinth':
      return 'modrinth'
    case 'cf':
    case 'curseforge':
      return 'curseforge'
    case 'ftb':
      return 'ftb'
    default:
      return null
  }
}

/**
 * 解析一条深链 URL。
 *
 * 注意 `URL` 会把 host 小写化（`//Launch/` → host `launch`），因此动作名比较统一用小写；
 * 参数值（实例名等）不受影响。返回 `null` 表示不是本应用的深链或参数不合法——
 * 调用方应静默忽略，不要抛错打扰用户（任何网页都能伪造该协议）。
 */
export function parseDeepLink(raw: string): DeepLinkAction | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null

  // 形如 `qomicex-launcher://launch/foo` 时动作在 host、参数在 pathname。
  const action = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const first = segments[0] ?? ''

  switch (action) {
    case 'launch': {
      const target = first.trim()
      return target ? { kind: 'launch', target } : null
    }
    case 'open': {
      const route = `/${segments.join('/')}`
      return isAllowedRoute(route) ? { kind: 'open', route } : null
    }
    case 'join': {
      const code = first.trim()
      return code ? { kind: 'join', code } : null
    }
    case 'install': {
      const what = first.toLowerCase()
      if (what === 'plugin') {
        const slug = url.searchParams.get('slug')?.trim() || undefined
        const version = url.searchParams.get('version')?.trim() || undefined
        const link = url.searchParams.get('url')?.trim() || undefined
        // slug 与 url 二选一：都没有就是无效深链。
        if (!slug && !link) return null
        return { kind: 'installPlugin', slug, version, url: link }
      }
      if (what === 'modpack') {
        const source = normalizeModpackSource(url.searchParams.get('type'))
        if (!source) return null
        const projectId = url.searchParams.get('projectId')?.trim()
        const fileId = url.searchParams.get('fileId')?.trim()
        if (!projectId || !fileId) return null
        const name = url.searchParams.get('name')?.trim() || undefined
        return { kind: 'installModpack', source, projectId, fileId, name }
      }
      return null
    }
    default:
      return null
  }
}

/** 路由必须在白名单内（含其子路径，如 `/instances/abc`）。 */
export function isAllowedRoute(route: string): boolean {
  const normalized = route.startsWith('/') ? route : `/${route}`
  return ALLOWED_ROUTES.some((allowed) => {
    if (allowed === '/') return normalized === '/'
    return normalized === allowed || normalized.startsWith(`${allowed}/`)
  })
}

/**
 * 该 URL 是否来自官方域（免确认安装）。
 *
 * 协议必须是 https：http 上的同主机名可被中间人替换为任意包，不能免确认。
 */
export function isTrustedInstallUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'https:' && AUTO_INSTALL_HOSTS.includes(url.hostname.toLowerCase())
}
