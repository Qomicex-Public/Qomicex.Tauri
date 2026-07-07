// ponytail: global in-memory cache, invalidate on mutations, no eviction — LRU if memory matters
const store = new Map<string, { data: unknown; timestamp: number }>()
const FRESH_TTL = 30_000

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry) return null
  return entry.data as T
}

export function cacheFresh<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry || Date.now() - entry.timestamp > FRESH_TTL) return null
  return entry.data as T
}

export function cacheSet<T>(key: string, data: T): void {
  store.set(key, { data, timestamp: Date.now() })
}

export function cacheInvalidate(pattern?: string): void {
  if (!pattern) { store.clear(); return }
  for (const k of store.keys()) {
    if (k.startsWith(pattern)) store.delete(k)
  }
}
