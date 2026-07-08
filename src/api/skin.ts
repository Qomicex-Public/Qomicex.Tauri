import { get, API_BASE } from './client.ts'
import type { SkinProfile } from '../types/index.ts'
import { cropHeadFromSkin } from '../lib/skin-avatar.ts'

// ponytail: global in-memory avatar blob cache, cleared on manual refresh
const avatarCache = new Map<string, string>()

export function tryGetCachedAvatar(uuid: string): string | null {
  return avatarCache.get(uuid) ?? null
}

export async function fetchAndCacheAvatar(uuid: string, type: string, server?: string | null): Promise<string> {
  const cached = avatarCache.get(uuid)
  if (cached) return cached

  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  const resp = await fetch(`${API_BASE}/skin/texture/${uuid}?${params}`)
  if (!resp.ok) throw new Error('Failed to fetch skin texture')
  const skinBlob = await resp.blob()
  const headBlob = await cropHeadFromSkin(skinBlob, 64)
  const blobUrl = URL.createObjectURL(headBlob)
  avatarCache.set(uuid, blobUrl)
  return blobUrl
}

export function invalidateAvatarCache(): void {
  for (const url of avatarCache.values()) URL.revokeObjectURL(url)
  avatarCache.clear()
}

export async function getSkinProfile(uuid: string, type: string, server?: string | null): Promise<SkinProfile | null> {
  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  return get<SkinProfile | null>(`/skin/profile/${uuid}?${params}`)
}

export function getSkinTextureUrl(uuid: string, type: string, server?: string | null): string {
  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  return `${API_BASE}/skin/texture/${uuid}?${params}`
}

export async function uploadSkin(uuid: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(`${API_BASE}/skin/upload/${uuid}`, { method: 'POST', body: form })
  if (!resp.ok) throw new Error('上传失败')
}

export async function resetSkin(uuid: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/skin/upload/${uuid}`, { method: 'DELETE' })
  if (!resp.ok) throw new Error('重置失败')
}
