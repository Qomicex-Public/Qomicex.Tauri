import type { JavaRuntime } from '../types/index.ts'
import { searchJava, getCustomJavaRuntimes, type JavaSearchMode } from '../api/java.ts'

const SCANNED_KEY = 'qomicex-java-scanned'
const CUSTOM_KEY = 'qomicex-java-custom'

type Listener = () => void

let scannedRuntimes: JavaRuntime[] = []
let customRuntimes: JavaRuntime[] = []
let scanMode: JavaSearchMode | null = null
let listeners: Listener[] = []
let scanPromise: Promise<JavaRuntime[]> | null = null
let customLoaded = false

function load(key: string): JavaRuntime[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveScanned() {
  try {
    localStorage.setItem(SCANNED_KEY, JSON.stringify(scannedRuntimes))
  } catch (e) {
    // localStorage 在无痕/隐私上下文或被禁用时抛异常，超配额时抛 QuotaExceededError。
    // 失败只意味着缓存没写进去（刷新后需重扫），不阻断调用方，但不能无声——
    // 否则表现为「扫描结果莫名不见了」且无从排查。
    console.warn('保存 Java 扫描缓存失败：', e)
  }
}

function saveCustom() {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customRuntimes))
  } catch (e) {
    // 同上：自定义 Java 运行时会因此不落盘，重启后从界面消失；留日志以便定位。
    console.warn('保存自定义 Java 运行时缓存失败：', e)
  }
}

function emitChange() {
  listeners.forEach((fn) => fn())
}

export function getRuntimes(): JavaRuntime[] {
  const map = new Map<string, JavaRuntime>()
  for (const j of scannedRuntimes) map.set(j.path, j)
  for (const j of customRuntimes) map.set(j.path, j)
  return [...map.values()]
}

// 仅返回可用（state === 'Valid'）的 Java，供所有选择/列表界面过滤不可用项。
export function getValidRuntimes(): JavaRuntime[] {
  return getRuntimes().filter((r) => r.state === 'Valid')
}

export function getScanMode(): JavaSearchMode | null {
  return scanMode
}

export function hasAnyRuntimes(): boolean {
  return scannedRuntimes.length > 0 || customRuntimes.length > 0
}

export function setScannedRuntimes(list: JavaRuntime[], mode: JavaSearchMode | null = null) {
  const map = new Map<string, JavaRuntime>()
  for (const j of scannedRuntimes) map.set(j.path, j)
  for (const j of list) map.set(j.path, j)
  scannedRuntimes = [...map.values()]
  if (mode) scanMode = mode
  saveScanned()
  emitChange()
}

export function addRuntime(runtime: JavaRuntime) {
  if (customRuntimes.some((j) => j.path === runtime.path)) return
  customRuntimes = [...customRuntimes, runtime]
  saveCustom()
  emitChange()
}

export function removeRuntime(path: string) {
  customRuntimes = customRuntimes.filter((j) => j.path !== path)
  saveCustom()
  emitChange()
}

export function clearRuntimes() {
  scannedRuntimes = []
  customRuntimes = []
  scanMode = null
  try {
    localStorage.removeItem(SCANNED_KEY)
    localStorage.removeItem(CUSTOM_KEY)
  } catch (e) {
    // 清不掉则重启后旧的 Java 运行时又会回来，用户看到「清除了却仍在」；
    // 不阻断内存中的清理结果，但必须留下线索。
    console.warn('清除 Java 运行时缓存失败：', e)
  }
  emitChange()
}

export async function scanRuntimes(mode: JavaSearchMode): Promise<JavaRuntime[]> {
  if (scanPromise) return scanPromise
  scanPromise = searchJava(mode).finally(() => { scanPromise = null })
  const result = await scanPromise
  setScannedRuntimes(result, mode)
  return result
}

export async function loadCustomRuntimes(): Promise<JavaRuntime[]> {
  if (customLoaded) return customRuntimes
  customLoaded = true
  try {
    const list = await getCustomJavaRuntimes()
    customRuntimes = [...list]
    saveCustom()
    emitChange()
  } catch (e) {
    // 不 rethrow：调用方（DownloadCenter.tsx:181/193/317）以无 catch 的方式调用
    // refreshCustomRuntimes()，抛出去会变成 unhandled rejection 并触发全局错误处理。
    // 失败时 customRuntimes 保持为空，与「本来就没有自定义运行时」在 UI 上无法区分，
    // 因此这里必须留下日志。注意 customLoaded 已被置 true，本次启动内不会自动重试。
    console.error('加载自定义 Java 运行时失败：', e)
  }
  return customRuntimes
}

export async function refreshCustomRuntimes(): Promise<JavaRuntime[]> {
  customLoaded = false
  return loadCustomRuntimes()
}

export function subscribe(fn: Listener): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

scannedRuntimes = load(SCANNED_KEY)
customRuntimes = load(CUSTOM_KEY)
