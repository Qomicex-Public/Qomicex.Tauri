import type { JavaRuntime } from '../types/index.ts'
import { getJavaList, type JavaSearchMode } from '../api/java.ts'

const STORAGE_KEY = 'qomicex-java-runtimes'

type Listener = () => void

let runtimes: JavaRuntime[] = []
let scanMode: JavaSearchMode | null = null
let listeners: Listener[] = []
let scanPromise: Promise<JavaRuntime[]> | null = null

function loadRuntimes(): JavaRuntime[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRuntimes() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runtimes))
  } catch {}
}

function emitChange() {
  listeners.forEach((fn) => fn())
}

export function getRuntimes(): JavaRuntime[] {
  return runtimes
}

export function getScanMode(): JavaSearchMode | null {
  return scanMode
}

export function setRuntimes(list: JavaRuntime[], mode: JavaSearchMode | null = null) {
  runtimes = [...list]
  if (mode) scanMode = mode
  saveRuntimes()
  emitChange()
}

export function addRuntime(runtime: JavaRuntime) {
  if (runtimes.some((j) => j.path === runtime.path)) return
  runtimes = [...runtimes, runtime]
  saveRuntimes()
  emitChange()
}

export function removeRuntime(path: string) {
  runtimes = runtimes.filter((j) => j.path !== path)
  saveRuntimes()
  emitChange()
}

export function clearRuntimes() {
  runtimes = []
  scanMode = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
  emitChange()
}

export async function scanRuntimes(mode: JavaSearchMode): Promise<JavaRuntime[]> {
  if (scanPromise) return scanPromise
  scanPromise = getJavaList(mode).finally(() => { scanPromise = null })
  const result = await scanPromise
  setRuntimes(result, mode)
  return result
}

export function subscribe(fn: Listener): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

runtimes = loadRuntimes()
