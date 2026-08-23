import { get, API_BASE, ApiError } from './client.ts'
import { uploadFile } from './ipc.ts'
import type { SkinProfile, McCape } from '../types/index.ts'
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

export async function uploadSkin(uuid: string, file: File, type: string, server?: string | null, model?: string | null): Promise<void> {
  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  if (model) params.set('model', model)
  const resp = await uploadFile(`/skin/upload/${uuid}?${params.toString()}`, file)
  if (!resp.ok) throw new ApiError({ code: 'SKIN_UPLOAD_FAILED', message: '上传失败', detail: null, traceId: '', timestamp: new Date().toISOString(), status: resp.status })
}

export async function saveSkinTo(uuid: string, path: string, type: string, server?: string | null): Promise<void> {
  const resp = await fetch(`${API_BASE}/skin/save-to`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, uuid, type, server }),
  })
  if (!resp.ok) throw new ApiError({ code: 'SKIN_SAVE_FAILED', message: '保存失败', detail: null, traceId: '', timestamp: new Date().toISOString(), status: resp.status })
}

export async function resetSkin(uuid: string, type: string, server?: string | null): Promise<void> {
  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  const resp = await fetch(`${API_BASE}/skin/upload/${uuid}?${params.toString()}`, { method: 'DELETE' })
  if (!resp.ok) throw new ApiError({ code: 'SKIN_RESET_FAILED', message: '重置失败', detail: null, traceId: '', timestamp: new Date().toISOString(), status: resp.status })
}

/**
 * 披风图源 URL：桌面端直接返回后端 URL（同源，loadCape 可加载）。
 * 无披风返回 null。
 */
export async function getCapeBlobUrl(uuid: string, type: string, server?: string | null): Promise<string | null> {
  const params = new URLSearchParams({ type })
  if (server) params.set('server', server)
  const url = `${API_BASE}/skin/cape/${uuid}?${params.toString()}`
  const resp = await fetch(url)
  return resp.ok ? url : null
}

// ---------- 微软披风管理（仅 Microsoft 账户；桌面端需要后端实现 /skin/mc-capes） ----------

/** 微软披风列表。 */
export async function getMcCapes(uuid: string): Promise<McCape[]> {
  const data = await get<{ capes: McCape[] }>(`/skin/mc-capes/${uuid}`)
  return data?.capes ?? []
}

/**
 * 披风缩略图：后端返回完整 PNG，这里裁剪左上 64×32（标准披风纹理区域），
 * 与移动端后端 cropCape 语义一致。返回 blob URL；失败返回 null。
 */
export async function getMcCapeImageUrl(uuid: string, capeId: string): Promise<string | null> {
  const url = `${API_BASE}/skin/mc-cape/${uuid}/${capeId}`
  let blob: Blob
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    blob = await resp.blob()
  } catch {
    return null
  }
  try {
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bmp.close()
      return null
    }
    const w = Math.min(64, bmp.width)
    const h = Math.min(32, bmp.height)
    ctx.drawImage(bmp, 0, 0, w, h, 0, 0, w, h)
    bmp.close()
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    return out ? URL.createObjectURL(out) : null
  } catch {
    return URL.createObjectURL(blob)
  }
}

/** 装备披风。 */
export async function equipMcCape(uuid: string, capeId: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/skin/mc-capes/${uuid}/${capeId}`, { method: 'PUT' })
  if (!resp.ok) throw new Error(`装备失败 (${resp.status})`)
}

/** 卸下披风。 */
export async function unequipMcCape(uuid: string, capeId: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/skin/mc-capes/${uuid}/${capeId}`, { method: 'DELETE' })
  if (!resp.ok) throw new Error(`卸下失败 (${resp.status})`)
}
