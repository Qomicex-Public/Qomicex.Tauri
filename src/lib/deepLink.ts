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
  | { kind: 'launch'; target: string; dir?: string; raw: string }
  | { kind: 'open'; route: string }
  | { kind: 'join'; code: string }
  | { kind: 'installPlugin'; slug?: string; version?: string; url?: string }
  | { kind: 'installModpack'; source: ModpackSource; projectId: string; fileId: string; name?: string }

/**
 * `launch/` 后面那一段的解析结果。
 *
 * 两种写法：
 * - `launch/<实例名或ID>` → `dir` 为 undefined，`name` = 原串；
 * - `launch/<游戏目录>:<实例名>` → 同时给出 `dir` 与 `name`。
 */
export interface LaunchTarget {
  /** 原始 target（错误提示原样回显用）。 */
  raw: string
  /** 要匹配的名字（无目录时即原始串）。 */
  name: string
  /** 游戏目录；仅当 target 里含「有效的」冒号分隔时才有值。 */
  dir?: string
}

/**
 * 解析 `launch/` 的 target，**从右往左**按最后一个冒号切分。
 *
 * 为什么必须从右往左：Windows 绝对路径自带盘符（`C:\Users\x\.minecraft`），
 * 从左切会把 `C` 当成目录、`\Users\x\.minecraft` 当成实例名。
 */
export function splitLaunchTarget(raw: string): LaunchTarget {
  const trimmed = raw.trim()
  const idx = trimmed.lastIndexOf(':')
  if (idx < 0) return { raw: trimmed, name: trimmed }
  const dir = trimmed.slice(0, idx).trim()
  const name = trimmed.slice(idx + 1).trim()
  // `:name` / `dir:` 这类切出空半边的写法**不**当作目录形式：退化成纯名字匹配，
  // 最终由调用方走「找不到实例」提示，而不是拿空目录去比对出一个假的精确命中。
  if (!dir || !name) return { raw: trimmed, name: trimmed }
  // 兜底盘符：`C:\mc\inst`（只给了目录、没给实例名）的最后一个冒号就是盘符本身，
  // 会被切成 dir="C" + name="\mc\inst"。判定条件收紧到「单个字母 + 后半以路径分隔符
  // 开头」，避免误伤 `C:MyPack` 这类合法的「盘符 + 名字」写法。
  if (/^[A-Za-z]$/.test(dir) && /^[\\/]/.test(name)) return { raw: trimmed, name: trimmed }
  return { raw: trimmed, name, dir }
}

/** 实例匹配所需的最小结构（不依赖 GameInstance，便于独立测试）。 */
export interface LaunchCandidate {
  id: string
  name: string
  gameDir: string
}

export type LaunchMatch<T> =
  | { kind: 'matched'; instance: T }
  | { kind: 'notFound' }
  | { kind: 'ambiguous'; candidates: T[] }

function sameText(a: string, b: string, loose: boolean): boolean {
  return loose ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 路径比较前归一化：反斜杠转正斜杠、去掉尾部斜杠。 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 「精确命中唯一」才接受：先按原样比，无人命中再按大小写不敏感比。
 *
 * 为什么不用「大小写不敏感优先」：Linux 上 `DirA` 与 `dira` 是两个真实不同的目录，
 * 一律折叠会制造新的歧义。先精确、后宽松、且宽松必须唯一，才能同时照顾
 * Windows（大小写不敏感）与 Linux（敏感）。
 */
function pickUnique<T>(
  items: readonly T[],
  match: (item: T, loose: boolean) => boolean,
): LaunchMatch<T> {
  const exact = items.filter((item) => match(item, false))
  if (exact.length === 1) return { kind: 'matched', instance: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact }
  const loose = items.filter((item) => match(item, true))
  if (loose.length === 1) return { kind: 'matched', instance: loose[0] }
  if (loose.length > 1) return { kind: 'ambiguous', candidates: loose }
  return { kind: 'notFound' }
}

/**
 * 按 target 在实例列表里定位唯一实例。
 *
 * 匹配顺序：
 * 1. **实例 ID 精确命中**——ID 是后端生成的全局唯一串（`short_id()`），先判它可
 *    同时消除「名字撞车」与「用户把实例命名成别的实例 ID」两种情况。
 * 2. 带目录时按 `(gameDir, name)` 精确匹配。
 * 3. 退化到按**原始串**匹配名字——这样「名字里真带冒号」的旧链接仍然可用
 *    （带目录但没匹配上时也走这条兜底）。
 *
 * 关键约束：**同名多命中一律返回 ambiguous，绝不静默取第一个**。列表顺序在有扫描
 * 缓存时来自 `HashMap` 迭代（随机种子），实测同一份数据会从 idAAA 跳到 idCCC，
 * 静默取首等于「点同一个链接今天启动 A、明天启动 B」。
 */
export function matchLaunchTarget<T extends LaunchCandidate>(
  instances: readonly T[],
  target: LaunchTarget,
): LaunchMatch<T> {
  const byId = instances.filter((inst) => inst.id === target.raw)
  if (byId.length === 1) return { kind: 'matched', instance: byId[0] }
  if (byId.length > 1) return { kind: 'ambiguous', candidates: byId }

  if (target.dir !== undefined) {
    const dir = normalizePath(target.dir)
    const hit = pickUnique(
      instances,
      (inst, loose) =>
        sameText(normalizePath(inst.gameDir), dir, loose) && sameText(inst.name, target.name, loose),
    )
    // 目录形式**命中或歧义**都直接返回；只有「完全找不到」才继续兜底按原串找名字，
    // 否则一个笔误目录会静默落到同名的另一实例上。
    if (hit.kind !== 'notFound') return hit
  }

  return pickUnique(instances, (inst, loose) => sameText(inst.name, target.raw, loose))
}

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
  // `%FF` 这类非法编码会让 decodeURIComponent 抛 URIError：调用方按「不认识的链接」
  // 静默忽略是约定行为（任何网页都能构造），不能让异常冒出去打断整批处理。
  let segments: string[]
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  const first = segments[0] ?? ''

  switch (action) {
    case 'launch': {
      const raw = first.trim()
      if (!raw) return null
      const { name, dir } = splitLaunchTarget(raw)
      return { kind: 'launch', target: name, dir, raw }
    }
    case 'open': {
      // 先拒绝「解码后才出现的路径结构」，再拼路由过白名单。
      //
      // 不这样做的实际后果（已实测）：`open/settings/%2F..%2F..%2Fplugins%2Fp%2Fx` 会被
      // 解码成 `/settings//../../plugins/p/x`，凭 `/settings/` 前缀通过白名单；而
      // BrowserRouter 拿到该路径后会按 WHATWG 规则规范化成 `/plugins/p/x`，于是跳到
      // 白名单外的插件路由。判定必须发生在**拼路由之前**，且要看解码后的内容。
      if (hasPathEscape(segments)) return null
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

/**
 * 解码后的分段里是否含「路径结构」——分隔符或点段。
 *
 * `URL` 只折叠字面量的 `.`/`..` 段，`%2E%2E`、`%2F` 这类编码形态会原样留在 pathname 里，
 * 解码后才变回 `..`/`/`。路由拼接与白名单必须在**解码后**再做一次结构判定，
 * 否则前缀匹配会被构造出的路径穿越绕开（见 `parseDeepLink` 的 open 分支注释）。
 */
export function hasPathEscape(segments: readonly string[]): boolean {
  return segments.some(
    (segment) =>
      segment.includes('/') ||
      segment.includes('\\') ||
      segment === '.' ||
      segment === '..',
  )
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
