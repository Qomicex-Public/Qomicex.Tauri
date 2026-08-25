import { get, post } from './client.ts'

const base = '/store'

export interface StoreUser {
  id: string
  username: string
  email?: string
  displayName?: string
  role: string
  developerLevel: string
  avatarUrl?: string
}

export interface StorePlugin {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  tags: string[]
  iconUrl?: string
  latestVersion?: string
  downloadsCount: number
  ratingAverage?: number
  ratingCount?: number
  developerName?: string
  developerLevel?: string
  publishedAt?: string
}

export interface StorePluginVersion {
  id: string
  version: string
  changelog?: string
  minLauncherVersion?: string
  layers: string[]
  permissions: string[]
  sha256: string
  sizeBytes: number
  downloadCount: number
  createdAt: string
}

export interface StorePluginDetail extends StorePlugin {
  versions: StorePluginVersion[]
}

export interface StoreReview {
  id: string
  rating: number
  content?: string
  createdAt: string
  updatedAt?: string
  username: string
  developerLevel?: string
  avatarUrl?: string
}

export interface StoreListResult {
  total: number
  page: number
  pageSize: number
  items: StorePlugin[]
}

export interface StoreUpdateEntry {
  slug: string
  currentVersion: string
  latestVersion: string
  changelog?: string
  sha256: string
  permissions: string[]
  layers: string[]
  download: { url: string; mirrorUrl?: string }
  /** 灰度放量百分比（0-100），缺省视为 100 全量；本版本仅透传，灰度 UI 后置 TODO */
  rolloutPercent?: number
}

export interface StoreDownloadInfo {
  url: string
  mirrorUrl?: string | null
  sha256: string
  size: number
}

export interface StoreListParams {
  q?: string
  category?: string
  tags?: string
  sort?: string
  page?: number
  pageSize?: number
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export function listStorePlugins(params: StoreListParams = {}): Promise<StoreListResult> {
  return get<StoreListResult>(
    `${base}/plugins${qs({
      q: params.q,
      category: params.category,
      tags: params.tags,
      sort: params.sort,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
    })}`
  )
}

export function fetchStorePlugin(slug: string): Promise<StorePluginDetail> {
  return get<StorePluginDetail>(`${base}/plugins/${encodeURIComponent(slug)}`)
}

export function fetchStoreReviews(
  slug: string,
  page = 1,
  pageSize = 20
): Promise<{ items: StoreReview[]; total?: number }> {
  return get(
    `${base}/plugins/${encodeURIComponent(slug)}/reviews${qs({ page, pageSize })}`
  )
}

/** launcherVersion 由后端注入，前端只传本地已装清单 */
export function checkStoreUpdates(
  installed: { slug: string; version: string }[]
): Promise<{ updates: StoreUpdateEntry[] }> {
  return post(`${base}/check-updates`, { installed })
}

export function fetchStoreDownloadInfo(
  slug: string,
  version = 'latest'
): Promise<StoreDownloadInfo> {
  return get(
    `${base}/download-info/${encodeURIComponent(slug)}${qs({ version })}`
  )
}

/** 在线安装/更新（后端下载+SHA256 校验+依赖预检），返回与 /plugins 列表同构的 PluginInfo */
export function installStorePlugin(slug: string, version?: string): Promise<unknown> {
  return post(`${base}/install`, { slug, version })
}

export interface StoreSessionResponse {
  user: StoreUser | null
  expiresIn?: number | null
}

export function storeLogin(account: string, password: string): Promise<StoreSessionResponse> {
  return post(`${base}/auth/login`, { account, password })
}

export interface StoreRegisterResult {
  user?: StoreUser
  checkEmail?: boolean
}

export function storeRegister(
  username: string,
  email: string,
  password: string
): Promise<StoreRegisterResult> {
  return post(`${base}/auth/register`, { username, email, password })
}

export function storeLogout(): Promise<void> {
  return post(`${base}/auth/logout`)
}

export interface StoreDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export function storeDeviceCode(): Promise<StoreDeviceCode> {
  return post(`${base}/auth/device/code`)
}

export type StoreDeviceTokenResult =
  | { status: 'pending' }
  | { status: 'ok'; user: StoreUser | null; expiresIn?: number | null }

export function storeDeviceToken(deviceCode: string): Promise<StoreDeviceTokenResult> {
  return post(`${base}/auth/device/token`, { deviceCode })
}

export function fetchStoreMe(): Promise<{ user: StoreUser | null }> {
  return get(`${base}/auth/me`)
}

export function fetchMyPlugins(): Promise<{ items: unknown[] }> {
  return get(`${base}/mine`)
}
