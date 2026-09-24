import { get } from './client.ts'
import { hookable } from '../plugins/hookable.ts'
import type { ScannedVersion, RemoteVersionInfo, LoaderVersionInfo, LoaderAddonInfo, ScanVersionsResponse, ScanMeta } from '../types/index.ts'

/** scan 长超时：版本目录大（30+ 实例）/ 冷盘 / 调试器附着时冷扫可达 30s+，
 * 绕过全局 15s 超时（同 instance-files.ts checkModUpdates 模式）。 */
const SCAN_LONG_TIMEOUT_MS = 120_000

/** `mode=full` 同样用长超时（首次扫描要把所有 jar 解一遍）。 */
const SCAN_FULL_TIMEOUT_MS = 120_000

/// 扫描结果 = 版本数组 + 挂在上面的后端元信息（见下方 `scanMeta`）。
export type ScanResult = ScannedVersion[] & { readonly scanMeta?: ScanMeta }

/// 扫描版本目录。可被插件 hook（`hook:scanVersions`）：before 修改 gameDir，
/// after 修改返回的版本列表（增删改扫描结果 —— 虚拟版本/过滤）。
///
/// `mode` 两段式的由来（见 ADR-082）：每个版本目录都要打开 `{name}.jar` 探测游戏版本，
/// 在 73 个集成包目录上要几十秒。后端按"文件指纹"缓存 jar 级的探测结果，所以：
/// - `fast`（默认）：命中缓存者毫秒级返回，未命中者只走 JSON 链先出列表；
/// - `full`：给未命中的条目补算 jar 级结果并写缓存。
///
/// 返回值仍是 `ScannedVersion[]`（hook 契约不变），后端顺带回的 `refineRequired`
/// 以**不可枚举属性**挂在数组上（`versions.scanMeta`）。刻意不用回调参数：
/// `hookable` 会把入参原样 postMessage 给插件 hook，而函数无法结构化克隆，
/// 会让整条 hook 管线抛 DataCloneError。
export const scanVersions = hookable('scanVersions', async (gameDir: string, mode?: 'fast' | 'full'): Promise<ScanResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), mode === 'full' ? SCAN_FULL_TIMEOUT_MS : SCAN_LONG_TIMEOUT_MS)
  const res = await get<ScanVersionsResponse>(`/versions/scan?gameDir=${encodeURIComponent(gameDir)}${mode ? `&mode=${mode}` : ''}`, { signal: controller.signal })
    .finally(() => clearTimeout(timer))
  const result = res.versions as ScanResult
  // 不可枚举：forEach/Object.keys/JSON.stringify 都看不到它，插件拿到的仍是纯数组。
  Object.defineProperty(result, 'scanMeta', {
    value: { refineRequired: !!res.refineRequired } satisfies ScanMeta,
    enumerable: false,
    configurable: true,
  })
  return result
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
