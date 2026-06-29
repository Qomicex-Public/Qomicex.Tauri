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
  } catch {}
}

function saveCustom() {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customRuntimes))
  } catch {}
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
  } catch {}
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
  } catch {}
  return customRuntimes
}

export function subscribe(fn: Listener): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

scannedRuntimes = load(SCANNED_KEY)
customRuntimes = load(CUSTOM_KEY)
