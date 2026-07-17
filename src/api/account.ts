import { get, post, put, del } from './client.ts'
import type {
  MicrosoftOAuthResponse,
  Account,
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

export function yggdrasilLogin(email: string, password: string, serverUrl = 'https://littleskin.cn/api/yggdrasil'): Promise<Account> {
  return post<Account>('/auth/yggdrasil', { username: email, password, serverUrl })
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
