import { get } from './client.ts'
import { hookable } from '../plugins/hookable.ts'
import type { ScannedVersion, RemoteVersionInfo, LoaderVersionInfo, LoaderAddonInfo, ScanVersionsResponse } from '../types/index.ts'

/** scan 长超时：版本目录大（30+ 实例）/ 冷盘 / 调试器附着时冷扫可达 30s+，
 * 绕过全局 15s 超时（同 instance-files.ts checkModUpdates 模式）。 */
const SCAN_LONG_TIMEOUT_MS = 120_000

/// 扫描版本目录。可被插件 hook（`hook:scanVersions`）：before 修改 gameDir，
/// after 修改返回的版本列表（增删改扫描结果 —— 虚拟版本/过滤）。
export const scanVersions = hookable('scanVersions', async (gameDir: string): Promise<ScannedVersion[]> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCAN_LONG_TIMEOUT_MS)
  const res = await get<ScanVersionsResponse>(`/versions/scan?gameDir=${encodeURIComponent(gameDir)}`, { signal: controller.signal })
    .finally(() => clearTimeout(timer))
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
