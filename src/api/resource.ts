import { get } from './client.ts'
import type { ResourceSearchResponse, ResourceDetail, ResourceFile, ResourceVersion } from '../types/index.ts'

export function searchResources(params: {
  category?: string
  keyword?: string
  page?: number
  pageSize?: number
  sort?: string
  source?: string
  gameVersion?: string
  loader?: string
}): Promise<ResourceSearchResponse> {
  const q = new URLSearchParams()
  if (params.category) q.set('category', params.category)
  if (params.keyword) q.set('keyword', params.keyword)
  if (params.page) q.set('page', String(params.page))
  if (params.pageSize) q.set('pageSize', String(params.pageSize))
  if (params.sort) q.set('sort', params.sort)
  if (params.source) q.set('source', params.source)
  if (params.gameVersion) q.set('gameVersion', params.gameVersion)
  if (params.loader) q.set('loader', params.loader)
  return get<ResourceSearchResponse>(`/resources/search?${q}`)
}

export function getResourceDetail(id: string, source?: string): Promise<ResourceDetail> {
  const q = source ? `?source=${source}` : ''
  return get<ResourceDetail>(`/resources/${encodeURIComponent(id)}${q}`)
}

export function getResourceVersions(id: string, source?: string, gameVersion?: string, loader?: string): Promise<ResourceVersion[]> {
  const q = new URLSearchParams()
  if (source) q.set('source', source)
  if (gameVersion) q.set('gameVersion', gameVersion)
  if (loader) q.set('loader', loader)
  const qs = q.toString()
  return get<ResourceVersion[]>(`/resources/${encodeURIComponent(id)}/versions${qs ? `?${qs}` : ''}`)
}

export function getResourceVersionDownloads(id: string, versionId: string, source?: string): Promise<ResourceFile[]> {
  const q = new URLSearchParams()
  if (source) q.set('source', source)
  const qs = q.toString()
  return get<ResourceFile[]>(`/resources/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/downloads${qs ? `?${qs}` : ''}`)
}
