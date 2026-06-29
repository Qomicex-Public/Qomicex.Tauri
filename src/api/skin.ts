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

export async function uploadSkin(uuid: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(`/api/skin/upload/${uuid}`, { method: 'POST', body: form })
  if (!resp.ok) throw new Error('上传失败')
}

export async function resetSkin(uuid: string): Promise<void> {
  const resp = await fetch(`/api/skin/upload/${uuid}`, { method: 'DELETE' })
  if (!resp.ok) throw new Error('重置失败')
}
