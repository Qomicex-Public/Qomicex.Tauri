import { get, put, post } from './client.ts'

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
  /** 资源下载源（mod 文件 CDN）：0 = 官方源（直连原 CDN）；1 = QML Mirror（下载域名重写到镜像） */
  fileDownloadSource: number
  /** 自动选择资源（文件 CDN）下载源 */
  autoSelectFileDownloadSource: boolean
  downloadTimeout: number
  theme: 'dark' | 'light'
  animationsEnabled: boolean
  animationSpeed: number
  maxFrameRate: number
  backgroundImage: string
  backgroundRandom: boolean
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
  /** 是否已完成首次启动初始化向导；false/缺失 = 显示向导 */
  initialized?: boolean
  /** 自动上报严重错误日志（崩溃类恶性 bug）；缺失 = 开启（默认开） */
  autoReportErrors?: boolean
  /** 启用 HTTP/3 文件下载（实验性）；缺失 = 关闭（默认走 HTTP/2） */
  enableHttp3?: boolean
  /** 代理模式：'off' = 不使用代理；'system' = 使用系统代理；'http' = 自定义 HTTP(S) 代理；'socks5' = SOCKS5 代理 */
  proxyMode: 'off' | 'system' | 'http' | 'socks5'
  /** 代理地址（host:port，如 127.0.0.1:7890）；proxyMode 为 http/socks5 时生效 */
  proxyHost: string
  /** 忽略 SSL 证书校验；true = 不校验（仅用于自签/内网代理等场景） */
  ignoreSslCert?: boolean
  /** 强制所有下载用 HTTP/1.1 并行连接；false（默认）= 按来源自动（Modrinth 用并行，其余用 HTTP/2） */
  http1Parallel: boolean
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
  downloadTimeout: 15,
  theme: 'dark',
  animationsEnabled: true,
  animationSpeed: 1,
  maxFrameRate: 0,
  backgroundImage: '',
  backgroundRandom: false,
  bgOverlayOpacity: 78,
  bgBlur: 0,
  watermarkEnabled: true,
  watermarkText: 'Qomicex',
  watermarkSubtext: '启动器',
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
  initialized: false,
  autoReportErrors: true,
  enableHttp3: false,
  proxyMode: 'system',
  proxyHost: '',
  ignoreSslCert: false,
  http1Parallel: false,
}

let cached: AppSettings = { ...DEFAULT_SETTINGS }
let loaded = false
const listeners = new Set<(s: AppSettings) => void>()

export async function loadSettings(): Promise<AppSettings> {
  try {
    const [data, { path: dataDir }] = await Promise.all([
      get<Partial<AppSettings>>('/settings'),
      get<{ path: string }>('/settings/data-dir'),
    ])
    cached = { ...DEFAULT_SETTINGS, ...data, dataDir, theme: data.theme ?? cached.theme ?? DEFAULT_SETTINGS.theme }
  } catch {
    cached = { ...DEFAULT_SETTINGS }
  }
  loaded = true
  listeners.forEach(fn => fn(cached))
  return cached
}

export function getSettings(): AppSettings {
  return cached
}

export function isSettingsLoaded(): boolean {
  return loaded
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  cached = settings
  try {
    await put('/settings', settings as unknown as Record<string, unknown>)
  } catch {
    // ponytail: silent fail, cache still updated locally
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


