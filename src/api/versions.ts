import { get } from './client.ts'
import { hookable } from '../plugins/hookable.ts'
import type { ScannedVersion, RemoteVersionInfo, LoaderVersionInfo, LoaderAddonInfo, ScanVersionsResponse } from '../types/index.ts'

/// 扫描版本目录。可被插件 hook（`hook:scanVersions`）：before 修改 gameDir，
/// after 修改返回的版本列表（增删改扫描结果 —— 虚拟版本/过滤）。
export const scanVersions = hookable('scanVersions', async (gameDir: string): Promise<ScannedVersion[]> => {
  const res = await get<ScanVersionsResponse>(`/versions/scan?gameDir=${encodeURIComponent(gameDir)}`)
  return res.versions
})

export function getRemoteVersions(source?: number): Promise<RemoteVersionInfo[]> {
  return get<RemoteVersionInfo[]>(`/versions/remote${source ? `?source=${source}` : ''}`)
}

export function getLoaderAddons(loader: string, gameVersion?: string): Promise<LoaderAddonInfo[]> {
  return get<LoaderAddonInfo[]>(`/loaders/addons?loader=${encodeURIComponent(loader)}${gameVersion ? `&gameVersion=${encodeURIComponent(gameVersion)}` : ''}`)
}

export function getLoaderVersions(gameVersion: string, loader: string, lang?: string): Promise<LoaderVersionInfo[]> {
  return get<LoaderVersionInfo[]>(`/loaders/versions?gameVersion=${encodeURIComponent(gameVersion)}&loader=${encodeURIComponent(loader)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`)
}
