import { get } from './client.ts'
import type { SkinProfile } from '../types/index.ts'

export async function getSkinProfile(uuid: string, type: string, server?: string | null): Promise<SkinProfile | null> {
  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  return get<SkinProfile | null>(`/skin/profile/${uuid}?${params}`)
}

export function getSkinTextureUrl(uuid: string, type: string, server?: string | null): string {
  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  return `/api/skin/texture/${uuid}?${params}`
}

export function getAvatarUrl(uuid: string, type: string, server?: string | null): string {
  const params = new URLSearchParams({ type, size: '64' })
  if (server) params.set('server', server)
  return `/api/skin/avatar/${uuid}?${params}`
}
