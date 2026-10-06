import { get, put, post, setDefaultRequestTimeout } from './client.ts'

interface CustomJavaEntry {
  name: string
  path: string
  version: string
  versionID: number
  type: string
  arch: string
  state: string
}

export interface AppSettings {
  dataDir: string
  gameDir: string
  downloadThreads: number
  fileChunkThreads: number
  versionIsolation: boolean
  closeAfterLaunch: boolean
  memoryMode: 'auto' | 'custom'
  defaultMaxMemory: number
  jvmArgs: string
  language: string
  defaultJavaPath: string
  downloadSource: number
  autoSelectDownloadSource: boolean
  modMirror: number
  autoSelectModMirror: boolean
  /**
   * 文件下载源（mod 文件 CDN）：0 = 官方源（直连原 CDN）；1 = 镜像源
   * （MCIM 优先，MCIM 不覆盖的域名走 QML Mirror；运行期失败自动回退 QML 节点、
   * 官方 CDN 兜底）。国内时区默认 1。
   */
  fileDownloadSource: number
  /** 自动选择文件下载源 */
  autoSelectFileDownloadSource: boolean
  /** 镜像源改版一次性迁移标记（true = 已处理，防止覆盖用户后续选择） */
  fileDownloadSourceMigrated?: boolean
  downloadTimeout: number
  theme: 'dark' | 'light' | 'system'
  themePreset: 'default' | 'latte' | 'frappe' | 'macchiato' | 'mocha'
  animationsEnabled: boolean
  animationSpeed: number
  /** GPU 硬件加速动画（force3D）：缺失 = 开启（默认开） */
  gpuAcceleration?: boolean
  maxFrameRate: number
  backgroundImage: string
  backgroundRandom: boolean
  /** 播放背景动图（GIF/APNG/动态 WebP）；缺失 = 开启（默认开），false = 只显示首帧 */
  backgroundAnimationsEnabled?: boolean
  /** 播放背景视频（MP4/WebM）；缺失 = 关闭（默认关） */
  backgroundVideoEnabled?: boolean
  bgOverlayOpacity: number
  bgBlur: number
  watermarkEnabled: boolean
  watermarkText: string
  watermarkSubtext: string
  directories?: string[]
  customJavaRuntimes?: CustomJavaEntry[]
  logLevel: string
  translationProvider: string
  bingApiKey?: string
  cornerRadius: number
  windowCorners: boolean
  curseforgeVersionFetchConcurrency: number
  curseforgeVersionCacheTtlSeconds: number
  /** 全局 UI 自定义字体家族名；空/缺失 = 系统默认字体 */
  fontFamily?: string
  /** 全局主题强调色（hex，如 `#22c55e`）；空/缺失 = 使用默认配色（绿） */
  themeColor?: string
  /** 组件材质：'default' 默认 / 'frosted' 毛玻璃 / 'acrylic' 亚克力玻璃 / 'aero' Aero / 'liquid' 液态玻璃 */
  componentMaterial?: 'default' | 'frosted' | 'acrylic' | 'aero' | 'liquid'
  /** 毛玻璃/亚克力玻璃/液态玻璃模糊强度（px，默认 18）；材质为 default 时不生效 */
  glassBlur?: number
  /** 默认材质卡片透明度（0-100，100 = 不透明，默认 50）；材质为 default 时生效 */
  cardOpacity?: number
  /** 默认材质卡片边框颜色（hex，如 `#333333`）；空/缺失 = 使用主题边框色 */
  cardBorderColor?: string
  /** 默认材质卡片边框厚度（px，0 = 无边框，默认 1） */
  cardBorderWidth?: number
  /** 对话框透明度（0-100，100 = 不透明，默认 75）；所有组件材质通用 */
  dialogOpacity?: number
  /** 是否已完成首次启动初始化向导；false/缺失 = 显示向导 */
  initialized?: boolean
  /** 自动上报严重错误日志（崩溃类恶性 bug）；缺失 = 开启（默认开） */
  autoReportErrors?: boolean
  /** 匿名插件错误遥测（opt-in，默认关闭）：仅上报插件 id+版本+error_type 白名单，无路径/堆栈/隐私数据 */
  telemetryEnabled?: boolean
  /** 启用 HTTP/3 文件下载（实验性）；缺失 = 关闭（默认走 HTTP/2） */
  enableHttp3?: boolean
  /**
   * 自定义联机（EasyTier）中继节点列表（issue #112）。
   *
   * 语义：**自定义节点在前、官方节点在后**。空/缺失 = 只用官方节点（默认）。
   * 每项须为 `tcp://host:port` 形式（tcp/udp/quic/wss/ws）；后端保存前强校验，
   * 非法条目会被拒绝（`CONNECTOR_RELAY_INVALID`）。
   */
  relayNodes?: string[] | null
  /** 代理模式：'off' = 不使用代理；'system' = 使用系统代理；'http' = 自定义 HTTP(S) 代理；'socks5' = SOCKS5 代理 */
  proxyMode: 'off' | 'system' | 'http' | 'socks5'
  /** 代理地址（host:port，如 127.0.0.1:7890）；proxyMode 为 http/socks5 时生效 */
  proxyHost: string
  /** 忽略 SSL 证书校验；true = 不校验（仅用于自签/内网代理等场景） */
  ignoreSslCert?: boolean
  /** 强制所有下载用 HTTP/1.1 并行连接；false（默认）= 按来源自动（Modrinth 用并行，其余用 HTTP/2） */
  http1Parallel: boolean
  /** 跳过实例扫描的 JAR 级探测；false（默认）= mode=full 会打开 jar 读版本号（最准）。
   *  true = 一律按 JSON 链推断，不再打开任何 jar（大实例目录冷扫更快，但 JSON 缺字段的
   *  整合包 gameVersion 可能退化成 inheritsFrom/目录名）。仅影响 /versions/scan。 */
  scanSkipJarProbe?: boolean
  /**
   * 自动下载并安装更新。缺失/true = 开启（默认）：后台发现更新后
   * **自动下载**，下载完成弹可点击的 Toast，用户不点击则下次启动自动安装完成。
   * false = 关闭，恢复原有「发现新版本 → 弹更新对话框等用户点『立即更新』」行为。
   *
   * 只对普通更新生效：强制更新（required）与跨通道切换（channelSwitch）一律仍走对话框。
   */
  updateAutoInstall?: boolean
  /** 资源文件下载命名格式（ENH-10）：cn-name-ver / name-cn-ver / cn-name / name-ver / name */
  fileNaming?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  dataDir: '',
  gameDir: '.minecraft',
  downloadThreads: 64,
  fileChunkThreads: 0,
  versionIsolation: true,
  closeAfterLaunch: false,
  memoryMode: 'auto',
  defaultMaxMemory: 4096,
  jvmArgs: '',
  language: 'zh-CN',
  defaultJavaPath: '',
  downloadSource: 0,
  autoSelectDownloadSource: false,
  modMirror: 0,
  autoSelectModMirror: false,
  fileDownloadSource: 0,
  autoSelectFileDownloadSource: false,
  fileDownloadSourceMigrated: true,
  downloadTimeout: 60,
  theme: 'dark',
  themePreset: 'default',
  animationsEnabled: true,
  animationSpeed: 1,
  gpuAcceleration: true,
  maxFrameRate: 0,
  backgroundImage: '',
  backgroundRandom: false,
  backgroundAnimationsEnabled: true,
  backgroundVideoEnabled: false,
  bgOverlayOpacity: 78,
  bgBlur: 0,
  watermarkEnabled: true,
  watermarkText: 'Qomicex',
  watermarkSubtext: 'Launcher',
  logLevel: 'info',
  translationProvider: 'mymemory',
  bingApiKey: '',
  cornerRadius: 8,
  windowCorners: true,
  curseforgeVersionFetchConcurrency: 10,
  curseforgeVersionCacheTtlSeconds: 300,
  fontFamily: '',
  themeColor: '',
  componentMaterial: 'default',
  glassBlur: 18,
  cardOpacity: 50,
  cardBorderColor: '',
  cardBorderWidth: 1,
  dialogOpacity: 75,
  initialized: false,
  autoReportErrors: true,
  telemetryEnabled: false,
  enableHttp3: false,
  relayNodes: null,
  proxyMode: 'system',
  proxyHost: '',
  ignoreSslCert: false,
  http1Parallel: false,
  updateAutoInstall: true,
}

let cached: AppSettings = { ...DEFAULT_SETTINGS }
let loaded = false
const listeners = new Set<(s: AppSettings) => void>()

/**
 * 把 `downloadTimeout`（秒，0 = 不限）应用到前端全局请求超时。
 *
 * 唯一咽喉点：loadSettings / saveSettings 都经过这里，用户在设置页改动即时生效。
 * 超时语义与 UI 文案一致（0 = 不超时），故 0 转成 0 传给 client（= 不设总超时）。
 */
function applyDownloadTimeoutSetting(s: AppSettings) {
  const secs = Number(s.downloadTimeout)
  const ms = Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 0
  setDefaultRequestTimeout(ms)
}

export async function loadSettings(): Promise<AppSettings> {
  // 失败时不更新 cached、不置 loaded：backend 未就绪时若把 DEFAULT_SETTINGS
  // （initialized:false）当成已加载的真实设置，会让 App 误判"未初始化"而弹向导。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [data, { path: dataDir }] = await Promise.all([
        get<Partial<AppSettings>>('/settings'),
        get<{ path: string }>('/settings/data-dir'),
      ])
      cached = {
        ...DEFAULT_SETTINGS,
        ...data,
        dataDir,
        theme: data.theme ?? cached.theme ?? DEFAULT_SETTINGS.theme,
        themePreset:
          data.themePreset ??
          (localStorage.getItem('qomicex-theme-preset') as AppSettings['themePreset'] | null) ??
          DEFAULT_SETTINGS.themePreset,
        animationSpeed: data.animationSpeed ?? cached.animationSpeed ?? DEFAULT_SETTINGS.animationSpeed,
        animationsEnabled: data.animationsEnabled ?? cached.animationsEnabled ?? DEFAULT_SETTINGS.animationsEnabled,
        gpuAcceleration: data.gpuAcceleration ?? cached.gpuAcceleration ?? DEFAULT_SETTINGS.gpuAcceleration,
      }
      loaded = true
      applyDownloadTimeoutSetting(cached)
      listeners.forEach(fn => fn(cached))
      break
    } catch (e) {
      if (attempt === 2) console.error('[settings] load failed after retries', e)
      else await new Promise(r => setTimeout(r, 1000))
    }
  }
  return cached
}

export function getSettings(): AppSettings {
  return cached
}

export function isSettingsLoaded(): boolean {
  return loaded
}

/**
 * 保存设置。
 *
 * 默认**静默吞掉**落盘错误（本地缓存已更新，UI 保持可用）——这是既有约定，多数
 * 设置项改错也不该弹错。调用方需要「落盘失败必须知道」时传 `throwOnError: true`
 * （联机节点区：保存失败却继续 reload 会读到旧 settings.json 并谎报成功）。
 */
export async function saveSettings(
  settings: AppSettings,
  opts?: { throwOnError?: boolean },
): Promise<void> {
  cached = settings
  applyDownloadTimeoutSetting(cached)
  try {
    await put('/settings', settings as unknown as Record<string, unknown>)
  } catch (e) {
    // ponytail: silent fail, cache still updated locally
    if (opts?.throwOnError) {
      listeners.forEach(fn => fn(cached))
      throw e
    }
  }
  listeners.forEach(fn => fn(cached))
}

export function onSettingsChange(fn: (s: AppSettings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export interface DownloadSourcePing {
  id: number
  name: string
  url: string
  /** 后端字段名：latency（serde camelCase 对单词不变形） */
  latency: number
  /** 后端字段名：ok */
  ok: boolean
}

export async function pingDownloadSources(): Promise<DownloadSourcePing[]> {
  return get<DownloadSourcePing[]>('/settings/download-sources/ping')
}

export interface ModSourcePing {
  id: number
  name: string
  url: string
  ok: boolean
  latency: number
  canConnect: boolean
}

export async function pingModSources(): Promise<ModSourcePing[]> {
  return get<ModSourcePing[]>('/settings/mod-sources/ping')
}

export async function pingFileDownloadSources(): Promise<DownloadSourcePing[]> {
  return get<DownloadSourcePing[]>('/settings/file-download-sources/ping')
}

export async function autoSelectModSource(): Promise<{ id: number; latencyMs: number }> {
  const result = await get<{ id: number; latencyMs: number }>('/settings/mod-source/auto-select')
  cached = { ...cached, modMirror: result.id }
  return result
}

export async function autoSelectDownloadSource(): Promise<{ id: number; latencyMs: number }> {
  const result = await get<{ id: number; latencyMs: number }>('/settings/download-source/auto-select')
  cached = { ...cached, downloadSource: result.id }
  return result
}

export async function getDataDir(): Promise<string> {
  try {
    const { path } = await get<{ path: string }>('/settings/data-dir')
    return path
  } catch {
    return DEFAULT_SETTINGS.dataDir
  }
}

/** 系统已安装字体家族名列表（去重、排序），供外观设置选择。 */
export async function getSystemFonts(): Promise<string[]> {
  try {
    return await get<string[]>('/settings/fonts')
  } catch {
    return []
  }
}

export async function setDataDir(path: string): Promise<string> {
  const { path: result } = await put<{ path: string }>('/settings/data-dir', { path })
  return result
}

export function openFolder(path: string): Promise<void> {
  return post('/settings/open-folder', { path })
}

export async function clearCache(): Promise<{ deleted: number }> {
  return post<{ deleted: number }>('/settings/clear-cache', {})
}

export async function clearCurseForgeCache(): Promise<{ deleted: number }> {
  return post<{ deleted: number }>('/settings/clear-curseforge-cache', {})
}

export async function clearNeoForgeCache(): Promise<{ deleted: number }> {
  return post<{ deleted: number }>('/settings/clear-neoforge-cache', {})
}

export async function clearFtbCache(): Promise<{ deleted: number }> {
  return post<{ deleted: number }>('/settings/clear-ftb-cache', {})
}

export async function clearModsListCache(): Promise<{ deleted: number }> {
  return post<{ deleted: number }>('/settings/clear-mods-list-cache', {})
}

export async function clearModUpdatesCache(): Promise<{ deleted: number }> {
  return post<{ deleted: number }>('/settings/clear-mod-updates-cache', {})
}

export async function clearModpackTemp(): Promise<{ deleted: number }> {
  return post<{ deleted: number }>('/settings/clear-modpack-temp', {})
}

export interface CacheDirStats {
  files: number
  bytes: number
}

export interface CacheStats {
  forgeVersions: CacheDirStats
  neoforge: CacheDirStats
  ftb: CacheDirStats
  modsList: CacheDirStats
  modUpdates: CacheDirStats
  modpackTemp: CacheDirStats
}

export function getCacheStats(): Promise<CacheStats> {
  return get<CacheStats>('/settings/cache-stats')
}


