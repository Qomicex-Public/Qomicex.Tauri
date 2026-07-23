import { get } from './client.ts'
import type { ScannedVersion, RemoteVersionInfo, LoaderVersionInfo, LoaderAddonInfo, ScanVersionsResponse } from '../types/index.ts'

export async function scanVersions(gameDir: string): Promise<ScannedVersion[]> {
  const res = await get<ScanVersionsResponse>(`/versions/scan?gameDir=${encodeURIComponent(gameDir)}`)
  return res.versions
}

export function getRemoteVersions(source?: number): Promise<RemoteVersionInfo[]> {
  return get<RemoteVersionInfo[]>(`/versions/remote${source ? `?source=${source}` : ''}`)
}

export function getLoaderAddons(loader: string, gameVersion?: string): Promise<LoaderAddonInfo[]> {
  return get<LoaderAddonInfo[]>(`/loaders/addons?loader=${encodeURIComponent(loader)}${gameVersion ? `&gameVersion=${encodeURIComponent(gameVersion)}` : ''}`)
}

export function getLoaderVersions(gameVersion: string, loader: string): Promise<LoaderVersionInfo[]> {
  return get<LoaderVersionInfo[]>(`/loaders/versions?gameVersion=${encodeURIComponent(gameVersion)}&loader=${encodeURIComponent(loader)}`)
}
