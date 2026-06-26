import { get } from './client.ts'
import type { ScannedVersion, RemoteVersionInfo, LoaderVersionInfo, LoaderAddonInfo } from '../types/index.ts'

export function scanVersions(gameDir: string): Promise<ScannedVersion[]> {
  return get<ScannedVersion[]>(`/versions/scan?gameDir=${encodeURIComponent(gameDir)}`)
}

export function getRemoteVersions(source?: number): Promise<RemoteVersionInfo[]> {
  return get<RemoteVersionInfo[]>(`/versions/remote${source ? `?source=${source}` : ''}`)
}

export function getLoaderAddons(loader: string): Promise<LoaderAddonInfo[]> {
  return get<LoaderAddonInfo[]>(`/loaders/addons?loader=${encodeURIComponent(loader)}`)
}

export function getLoaderVersions(gameVersion: string, loader: string): Promise<LoaderVersionInfo[]> {
  return get<LoaderVersionInfo[]>(`/loaders/versions?gameVersion=${encodeURIComponent(gameVersion)}&loader=${encodeURIComponent(loader)}`)
}
