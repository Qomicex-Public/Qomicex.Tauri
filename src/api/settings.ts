import { get, put } from './client.ts'

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
  gameDir: string
  downloadThreads: number
  versionIsolation: boolean
  closeAfterLaunch: boolean
  memoryMode: 'auto' | 'custom'
  defaultMaxMemory: number
  jvmArgs: string
  language: string
  defaultJavaPath: string
  downloadSource: number
  downloadTimeout: number
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  gameDir: '.minecraft',
  downloadThreads: 4,
  versionIsolation: true,
  closeAfterLaunch: false,
  memoryMode: 'auto',
  defaultMaxMemory: 4096,
  jvmArgs: '',
  language: 'zh-CN',
  defaultJavaPath: '',
  downloadSource: 0,
  downloadTimeout: 15,
  animationsEnabled: true,
  animationSpeed: 1,
  backgroundImage: '',
  backgroundRandom: false,
  bgOverlayOpacity: 78,
  bgBlur: 0,
  watermarkEnabled: true,
  watermarkText: 'Qomicex',
  watermarkSubtext: '启动器',
}

let cached: AppSettings = { ...DEFAULT_SETTINGS }
let loaded = false
const listeners = new Set<(s: AppSettings) => void>()

export async function loadSettings(): Promise<AppSettings> {
  try {
    const data = await get<Partial<AppSettings>>('/settings')
    cached = { ...DEFAULT_SETTINGS, ...data }
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


