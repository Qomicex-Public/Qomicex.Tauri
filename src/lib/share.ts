// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 分享页（share.qomicex.cn）链接构造。
 *
 * 参数名与分享页 `src/lib/share.ts` 的解析保持一致（`/r/{source}/{projectId}[/{fileId}]`、
 * `/room?code=…`），改动任一侧都要同步核对分享页仓库的 `docs/launcher-integration.md`。
 */

export const SHARE_BASE = 'https://share.qomicex.cn'

export type ShareResourceSource = 'modrinth' | 'curseforge' | 'ftb' | 'technic'

export interface ResourceShareInput {
  source: ShareResourceSource
  projectId: string
  fileId?: string
  /** 分享页的 typeHint（modpack / mod / resourcepack / shader / datapack）。 */
  type?: string
  name?: string
  icon?: string
  summary?: string
  link?: string
}

export interface RoomShareInput {
  code: string
  host?: string
  gameVersion?: string
  loader?: string
  loaderVersion?: string
  mods?: number
  motd?: string
  expiresAt?: string
  instance?: string
}

/**
 * 分享页 `/r/{source}/{projectId}` 里的 projectId 取哪个字段。
 *
 * CurseForge / FTB 的分享页只按数字 ID 解析（slug 需要额外请求代理），
 * Modrinth / Technic 用 slug 更可读；缺失时回退到调用方给的 id。
 */
export function shareProjectId(source: string, id: string, slug?: string): string {
  const s = source.trim().toLowerCase()
  if (s === 'curseforge' || s === 'ftb') return id
  return slug?.trim() || id
}

/** 分享页能识别的资源源；`save` 等启动器独有分类返回 null（不支持分享）。 */
export function normalizeShareSource(source: string): ShareResourceSource | null {
  switch (source.trim().toLowerCase()) {
    case 'modrinth':
      return 'modrinth'
    case 'curseforge':
      return 'curseforge'
    case 'ftb':
      return 'ftb'
    case 'technic':
      return 'technic'
    default:
      return null
  }
}

function appendQuery(q: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value == null) return
  const text = String(value).trim()
  if (!text) return
  q.set(key, text)
}

export function buildResourceShareUrl(input: ResourceShareInput): string {
  const path = `/r/${input.source}/${encodeURIComponent(input.projectId)}${
    input.fileId ? `/${encodeURIComponent(input.fileId)}` : ''
  }`
  const q = new URLSearchParams()
  appendQuery(q, 'type', input.type)
  appendQuery(q, 'name', input.name)
  appendQuery(q, 'icon', input.icon)
  appendQuery(q, 'summary', input.summary)
  appendQuery(q, 'link', input.link)
  const qs = q.toString()
  return `${SHARE_BASE}${path}${qs ? `?${qs}` : ''}`
}

export function buildRoomShareUrl(input: RoomShareInput): string {
  const q = new URLSearchParams()
  appendQuery(q, 'code', input.code)
  appendQuery(q, 'host', input.host)
  appendQuery(q, 'gv', input.gameVersion)
  appendQuery(q, 'loader', input.loader)
  appendQuery(q, 'loaderver', input.loaderVersion)
  appendQuery(q, 'mods', input.mods)
  appendQuery(q, 'motd', input.motd)
  appendQuery(q, 'exp', input.expiresAt)
  appendQuery(q, 'instance', input.instance)
  return `${SHARE_BASE}/room?${q.toString()}`
}
