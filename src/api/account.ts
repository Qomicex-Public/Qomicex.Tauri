import { get, post, put, del } from './client.ts'
import type {
  MicrosoftOAuthResponse,
  Account,
  YggdrasilProfilesResponse,
  YggdrasilProfileInfo,
} from '../types'

export function getAccounts(): Promise<Account[]> {
  return get<Account[]>('/account')
}

export function getAccount(uuid: string): Promise<Account> {
  return get<Account>(`/account/${uuid}`)
}

export function saveAccount(account: Account): Promise<Account> {
  return post<Account>('/account', account)
}

export function deleteAccount(uuid: string): Promise<void> {
  return del(`/account/${uuid}`)
}

export function microsoftOAuth(): Promise<MicrosoftOAuthResponse> {
  return post<MicrosoftOAuthResponse>('/auth/microsoft/device-code')
}

export function microsoftPoll(deviceCode: string): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/auth/microsoft/poll', { accessToken: deviceCode })
}

export function microsoftUserInfo(accessToken: string, refreshToken: string): Promise<Account> {
  return post<Account>('/auth/microsoft/info', { accessToken, refreshToken })
}

export function yggdrasilGetProfiles(email: string, password: string, serverUrl = 'https://littleskin.cn/api/yggdrasil'): Promise<YggdrasilProfilesResponse> {
  return post<YggdrasilProfilesResponse>('/auth/yggdrasil', { username: email, password, serverUrl })
}

export function yggdrasilSelectProfiles(accessToken: string, clientToken: string, serverUrl: string, selectedProfiles: YggdrasilProfileInfo[]): Promise<Account[]> {
  return post<Account[]>('/auth/yggdrasil/select', { accessToken, clientToken, serverUrl, selectedProfiles })
}

export function yggdrasilLogin(email: string, password: string, serverUrl = 'https://littleskin.cn/api/yggdrasil'): Promise<Account> {
  return post<Account>('/auth/yggdrasil', { username: email, password, serverUrl })
}

// ---------------------------------------------------------------------------
// LittleSkin OAuth（设备代码流，issue #145 / ADR-098）
// ---------------------------------------------------------------------------

export interface LittleSkinDeviceCodeResponse {
  userCode: string
  deviceCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export interface LittleSkinPollResponse {
  success: boolean
  isPending: boolean
  accessToken?: string
  refreshToken?: string
  profiles?: YggdrasilProfileInfo[]
  errorMessage?: string
  /** 轮询间隔（秒）；`slow_down` 时上游会要求放慢。 */
  interval?: number
}

/** 请求设备代码对（user_code + device_code）。 */
export function littleskinDeviceCode(): Promise<LittleSkinDeviceCodeResponse> {
  return post<LittleSkinDeviceCodeResponse>('/auth/littleskin/device-code')
}

/** 轮询授权结果；授权完成后一并返回 OAuth 令牌与角色列表。 */
export function littleskinPoll(deviceCode: string): Promise<LittleSkinPollResponse> {
  return post<LittleSkinPollResponse>('/auth/littleskin/poll', { deviceCode })
}

/** 为选中角色换取 Minecraft 令牌并保存账户。 */
export function littleskinSelectProfiles(
  accessToken: string,
  refreshToken: string | undefined,
  serverUrl: string,
  selectedProfiles: YggdrasilProfileInfo[],
): Promise<Account[]> {
  return post<Account[]>('/auth/littleskin/select', { accessToken, refreshToken, serverUrl, selectedProfiles })
}

/** 服务器地址是否指向 LittleSkin（OAuth 登录仅对其可用）。 */
export function isLittleSkinServer(serverUrl: string): boolean {
  const raw = serverUrl.trim()
  if (!raw) return false
  const withScheme = raw.includes('://') ? raw : `https://${raw}`
  try {
    const host = new URL(withScheme).hostname.toLowerCase()
    return host === 'littleskin.cn' || host.endsWith('.littleskin.cn')
  } catch {
    return false
  }
}

export interface YggdrasilResolveResult {
  apiRoot: string
  changed: boolean
  insecure: boolean
}

/** ALI (API Location Indicator) resolution: turn a shortened server address
 *  (e.g. `littleskin.cn`) into the full Yggdrasil API root. */
export function yggdrasilResolve(url: string): Promise<YggdrasilResolveResult> {
  return post<YggdrasilResolveResult>('/account/yggdrasil-resolve', { url })
}

export function tongyiLogin(serverId: string, email: string, password: string): Promise<Account> {
  return post<Account>('/auth/tongyi', { serverId, email: email, password })
}

export function getOfflineUuid(name: string): Promise<{ uuid: string }> {
  return get<{ uuid: string }>(`/account/offline-uuid?name=${encodeURIComponent(name)}`)
}

export function getDefaultAccount(): Promise<Account> {
  return get<Account>('/account/default')
}

export function setDefaultAccount(uuid: string): Promise<Account> {
  return put<Account>(`/account/${uuid}/default`)
}

export function clearDefaultAccount(): Promise<void> {
  return del('/account/default')
}

export async function checkAccountsLost(): Promise<boolean> {
  const res = await get<{ lost: boolean }>('/account/lost')
  return res.lost
}

const yggdrasilMetaCache = new Map<string, string>()

export function getCachedMeta(serverUrl?: string | null): string {
  if (!serverUrl) return ''
  return yggdrasilMetaCache.get(serverUrl) ?? ''
}

export async function getYggdrasilMeta(serverUrl: string): Promise<string> {
  const cached = yggdrasilMetaCache.get(serverUrl)
  if (cached) return cached
  try {
    const result = await get<{ serverName: string }>(`/account/yggdrasil-meta?serverUrl=${encodeURIComponent(serverUrl)}`)
    yggdrasilMetaCache.set(serverUrl, result.serverName)
    return result.serverName
  } catch {
    return ''
  }
}
