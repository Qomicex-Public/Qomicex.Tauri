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
  maxConnectionsPerServer: number
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
  downloadTimeout: number
  theme: 'dark' | 'light'
  animationsEnabled: boolean
  animationSpeed: number
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  dataDir: '',
  gameDir: '.minecraft',
  downloadThreads: 64,
  fileChunkThreads: 0,
  maxConnectionsPerServer: 64,
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
  downloadTimeout: 15,
  theme: 'dark',
  animationsEnabled: true,
  animationSpeed: 1,
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
  latencyMs: number
  available: boolean
}

export async function pingDownloadSources(): Promise<DownloadSourcePing[]> {
  return get<DownloadSourcePing[]>('/settings/download-sources/ping')
}

export interface ModSourcePing {
  id: number
  name: string
  modrinthUrl: string
  modrinthOk: boolean
  modrinthLatency: number
  available: boolean
}

export async function pingModSources(): Promise<ModSourcePing[]> {
  return get<ModSourcePing[]>('/settings/mod-sources/ping')
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


