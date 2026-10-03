import { get, post, put, del } from './client.ts'
import type { ResourceSearchResponse, ResourceDetail, ResourceFile, ResourceVersion, ResolvedDependency, ResourceItem, ResourceFavorite, ResourceFavoriteFolder } from '../types/index.ts'

export function searchResources(params: {
  category?: string
  keyword?: string
  page?: number
  pageSize?: number
  sort?: string
  source?: string
  gameVersion?: string
  loader?: string
  tags?: string
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
  if (params.tags) q.set('tags', params.tags)
  return get<ResourceSearchResponse>(`/resources/search?${q}`)
}

export interface ResourceCategory {
  slug: string
  name: string
}

export function getResourceCategories(source: string, category: string): Promise<ResourceCategory[]> {
  return get<ResourceCategory[]>(`/resources/categories?source=${encodeURIComponent(source)}&category=${encodeURIComponent(category)}`)
}

/**
 * 某「来源 + 资源类型」组合下可用的加载器选项（#163）。
 *
 * 加载器与资源类型强相关（光影包是 iris/optifine、资源包是 minecraft、整合包是
 * forge/fabric/neoforge/quilt），故由后端按类型下发而不是前端写死一份列表——
 * 写死会让光影包也列出 Forge，选中后上游 facet 命中 0 条（列表空白）。
 */
export function getResourceLoaders(source: string, category: string): Promise<ResourceCategory[]> {
  return get<ResourceCategory[]>(`/resources/loaders?source=${encodeURIComponent(source)}&category=${encodeURIComponent(category)}`)
}

export function getResourceDetail(id: string, source?: string, category?: string): Promise<ResourceDetail> {
  const q = new URLSearchParams()
  if (source) q.set('source', source)
  if (category) q.set('category', category)
  const qs = q.toString()
  return get<ResourceDetail>(`/resources/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`)
}

/** 远程版本列表 / 依赖解析：CurseForge 侧可达数十秒（分页 + 逐项查询），
 * 用长超时避免全局默认超时在慢网络上误报「请求超时」（issue #133）。 */
const REMOTE_LOOKUP_TIMEOUT_MS = 90_000

export function getResourceVersions(id: string, source?: string, gameVersion?: string, loader?: string): Promise<ResourceVersion[]> {
  const q = new URLSearchParams()
  if (source) q.set('source', source)
  if (gameVersion) q.set('gameVersion', gameVersion)
  if (loader) q.set('loader', loader)
  const qs = q.toString()
  return get<ResourceVersion[]>(`/resources/${encodeURIComponent(id)}/versions${qs ? `?${qs}` : ''}`, { timeoutMs: REMOTE_LOOKUP_TIMEOUT_MS })
}

export function startCurseForgeVersionFetch(id: string, gameVersion?: string, loader?: string): Promise<{ taskId: string; totalVersionCount: number; loadedVersionCount: number }> {
  const q = new URLSearchParams()
  if (gameVersion) q.set('gameVersion', gameVersion)
  if (loader) q.set('loader', loader)
  return post<{ taskId: string; totalVersionCount: number; loadedVersionCount: number }>(
    `/resources/${encodeURIComponent(id)}/versions/start-fetch${q.toString() ? `?${q}` : ''}`,
    {},
  )
}

export interface CurseForgeFetchProgress {
  loadedVersionCount: number
  totalVersionCount: number
  done: boolean
  /** Non-null when the fetch failed: the result is unusable and must not be read
   *  as "this resource has no versions". */
  error?: string | null
}

export function getCurseForgeVersionFetchProgress(taskId: string): Promise<CurseForgeFetchProgress> {
  return get<CurseForgeFetchProgress>(`/resources/versions/fetch-progress/${taskId}`)
}

export function getCurseForgeVersionFetchResult(taskId: string): Promise<ResourceVersion[]> {
  return get<ResourceVersion[]>(`/resources/versions/fetch-result/${taskId}`)
}

export function getResourceVersionDownloads(id: string, versionId: string, source?: string): Promise<ResourceFile[]> {
  const q = new URLSearchParams()
  if (source) q.set('source', source)
  const qs = q.toString()
  return get<ResourceFile[]>(`/resources/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/downloads${qs ? `?${qs}` : ''}`)
}

export function getResourceDependencies(id: string, source: string, versionId: string, gameVersion: string, loader?: string): Promise<ResolvedDependency[]> {
  const q = new URLSearchParams()
  q.set('source', source)
  if (versionId) q.set('versionId', versionId)
  if (gameVersion) q.set('gameVersion', gameVersion)
  if (loader) q.set('loader', loader)
  return get<ResolvedDependency[]>(`/resources/${encodeURIComponent(id)}/dependencies?${q}`, { timeoutMs: REMOTE_LOOKUP_TIMEOUT_MS })
}

// =====================================================================
// 收藏（favorites）：服务端按 `source + id + category` 唯一键持久化
// =====================================================================

export function listResourceFavorites(): Promise<ResourceFavorite[]> {
  return get<ResourceFavorite[]>('/resource-favorites')
}

export function addResourceFavorite(favorite: ResourceFavorite): Promise<ResourceFavorite> {
  return post<ResourceFavorite>('/resource-favorites', favorite)
}

export function removeResourceFavorite(source: string, id: string, category: string): Promise<{ removed: boolean }> {
  const q = new URLSearchParams({ source, id, category })
  return del<{ removed: boolean }>(`/resource-favorites?${q}`)
}

// ---- 收藏夹（P2）：实体单独存 resource_favorite_folders.json ----

export function listFavoriteFolders(): Promise<ResourceFavoriteFolder[]> {
  return get<ResourceFavoriteFolder[]>('/resource-favorite-folders')
}

export function createFavoriteFolder(name: string): Promise<ResourceFavoriteFolder> {
  return post<ResourceFavoriteFolder>('/resource-favorite-folders', { name })
}

export function renameFavoriteFolder(id: string, name: string): Promise<ResourceFavoriteFolder> {
  return put<ResourceFavoriteFolder>(`/resource-favorite-folders/${encodeURIComponent(id)}`, { name })
}

/**
 * 删除收藏夹 —— 服务端**只解除关联**（`detachedFavorites` 为受影响的收藏条数）。
 *
 * P3 起一条收藏可归属多个夹子，故不再级联删除条目：被解除关联的收藏若没有其他
 * 夹子则落到「未分组」，条目本身保留。
 */
export function deleteFavoriteFolder(id: string): Promise<{ removed: boolean; detachedFavorites: number }> {
  return del<{ removed: boolean; detachedFavorites: number }>(`/resource-favorite-folders/${encodeURIComponent(id)}`)
}

/**
 * `ResourceItem` + 当前页面分类 → 收藏条目（资源快照）。
 *
 * 资源本身没有 `type` 字段，分类只在页面状态/URL 中，所以必须由调用方传入。
 * `createdAt` 由服务端生成；这里给乐观更新一个本地时间戳，服务端返回后会被替换。
 */
export function toResourceFavorite(item: ResourceItem, category: string): ResourceFavorite {
  return {
    source: item.source,
    id: item.id,
    category,
    title: item.title,
    description: item.description,
    author: item.author,
    iconUrl: item.iconUrl,
    downloadCount: item.downloadCount,
    categories: item.categories,
    projectUrl: item.projectUrl,
    slug: item.slug,
    latestVersion: item.latestVersion ?? '',
    folderIds: [],
    note: null,
    tags: [],
    createdAt: new Date().toISOString(),
  }
}

/** 收藏条目 → `ResourceItem`，让收藏视图复用 `ResourceCard`（缺字段安全降级）。 */
export function toResourceItem(favorite: ResourceFavorite): ResourceItem {
  return {
    id: favorite.id,
    title: favorite.title,
    description: favorite.description,
    author: favorite.author,
    iconUrl: favorite.iconUrl,
    downloadCount: favorite.downloadCount,
    source: favorite.source,
    categories: favorite.categories ?? [],
    projectUrl: favorite.projectUrl,
    slug: favorite.slug,
    latestVersion: favorite.latestVersion ?? '',
    // 收藏里存的 category 就是收藏当时该资源的真实类型，回填后卡片动作
    // （详情 / 安装 / 收藏态）在聚合分类下也能取到正确类型。
    category: favorite.category,
  }
}
