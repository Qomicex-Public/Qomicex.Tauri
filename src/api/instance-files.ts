import { get, del, post, put, ApiError, API_BASE } from './client.ts'
import type { FileEntry, ModMetadata, ModEnrichEntry, ModUpdateEntry, ResourcePackMetadata, ShaderMetadata, SaveMetadata, SaveSettings, ScreenshotMetadata, DataPackMetadata, ServerEntry, ServerState, LanGameEntry, SchematicAssetsBundle } from '../types/index.ts'

/** 从非 JSON 错误响应构造 ApiError（表单上传等场景）。 */
async function apiErrorFrom(res: Response, fallbackCode: string, fallbackMessage: string): Promise<ApiError> {
  try {
    const json = await res.json()
    if (json && typeof json.code === 'string' && typeof json.message === 'string') {
      return new ApiError(json)
    }
    if (json && typeof json.message === 'string') {
      return new ApiError({ code: fallbackCode, message: String(json.message), detail: null, traceId: '', timestamp: new Date().toISOString(), status: res.status })
    }
  } catch { /* non-JSON body */ }
  return new ApiError({ code: fallbackCode, message: fallbackMessage, detail: null, traceId: '', timestamp: new Date().toISOString(), status: res.status })
}

export function getSaves(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/saves`)
}
export function deleteSave(instanceId: string, name: string): Promise<void> {
  return del(`/instance/${instanceId}/files/saves?name=${encodeURIComponent(name)}`)
}
export function copySave(instanceId: string, name: string, newName: string): Promise<void> {
  return post(`/instance/${instanceId}/files/saves/copy`, { name, newName })
}

/** 读取存档设置（level.dat NBT 精选字段）。folderName = 存档目录名。 */
export function getSaveSettings(instanceId: string, folderName: string): Promise<SaveSettings> {
  return get<SaveSettings>(`/instance/${instanceId}/files/saves/${encodeURIComponent(folderName)}/settings`)
}
/** 更新存档设置（写前自动备份 level.dat.qomicex.bak，失败回滚）。返回服务器侧最新值。 */
export function updateSaveSettings(instanceId: string, folderName: string, settings: SaveSettings): Promise<SaveSettings> {
  return put<SaveSettings>(`/instance/${instanceId}/files/saves/${encodeURIComponent(folderName)}/settings`, settings)
}
/** 从 level.dat_old 恢复存档设置。返回恢复后的最新值。 */
export function restoreSaveFromOld(instanceId: string, folderName: string): Promise<SaveSettings> {
  return post<SaveSettings>(`/instance/${instanceId}/files/saves/${encodeURIComponent(folderName)}/settings/restore`)
}

export function getScreenshots(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/screenshots`)
}
export function deleteScreenshot(instanceId: string, name: string): Promise<void> {
  return del(`/instance/${instanceId}/files/screenshots?name=${encodeURIComponent(name)}`)
}

export function getMods(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/mods`)
}
export function deleteMod(instanceId: string, name: string): Promise<void> {
  return del(`/instance/${instanceId}/files/mods?name=${encodeURIComponent(name)}`)
}
export function installMod(instanceId: string, downloadUrl: string, fileName: string): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/install`, { downloadUrl, fileName })
}

export function getResourcePacks(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/resourcepacks`)
}
export function deleteResourcePack(instanceId: string, name: string): Promise<void> {
  return del(`/instance/${instanceId}/files/resourcepacks?name=${encodeURIComponent(name)}`)
}

export function getShaderPacks(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/shaderpacks`)
}
export function deleteShaderPack(instanceId: string, name: string): Promise<void> {
  return del(`/instance/${instanceId}/files/shaderpacks?name=${encodeURIComponent(name)}`)
}

export function getServers(instanceId: string): Promise<ServerEntry[]> {
  return get<ServerEntry[]>(`/instance/${instanceId}/files/servers`)
}
export function addServer(instanceId: string, name: string, ip: string): Promise<void> {
  return post(`/instance/${instanceId}/files/servers`, { name, ip })
}
export function deleteServer(instanceId: string, ip: string): Promise<void> {
  return del(`/instance/${instanceId}/files/servers?ip=${encodeURIComponent(ip)}`)
}
export function pingServer(instanceId: string, address: string): Promise<ServerState> {
  return get<ServerState>(`/instance/${instanceId}/files/server-ping?address=${encodeURIComponent(address)}`)
}

export function getInstalledFileNames(instanceId: string, category: string = 'mods'): Promise<string[]> {
  return get<string[]>(`/instance/${instanceId}/files/installed-names?category=${encodeURIComponent(category)}`)
}

export function getModsCount(instanceId: string): Promise<number> {
  return get<number>(`/instance/${instanceId}/files/mods/count`)
}

export function getModsProgress(instanceId: string): Promise<{ current: number; total: number } | null> {
  return get<{ current: number; total: number } | null>(`/instance/${instanceId}/files/mods/progress`)
}

export function getModsMetadata(instanceId: string): Promise<ModMetadata[]> {
  return get<ModMetadata[]>(`/instance/${instanceId}/files/mods/metadata`)
}

/** 两段式第二步：批量反查远程 id（Modrinth project/version id、CurseForge mod/file id）。
 * 反查可达 10-30s，用 90s 信号绕过全局 15s 超时（失败由调用方静默处理）。 */
export function enrichMods(instanceId: string): Promise<ModEnrichEntry[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  return post<ModEnrichEntry[]>(`/instance/${instanceId}/files/mods/enrich`, undefined, { signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

export function enableMod(instanceId: string, name: string): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/enable?name=${encodeURIComponent(name)}`)
}

export function disableMod(instanceId: string, name: string): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/disable?name=${encodeURIComponent(name)}`)
}

export function changeModVersion(instanceId: string, fileName: string, downloadUrl: string, newFileName: string): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/change-version`, { fileName, downloadUrl, newFileName })
}

export function batchEnableMods(instanceId: string, names: string[]): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/batch-enable`, names)
}

export function batchDisableMods(instanceId: string, names: string[]): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/batch-disable`, names)
}

export function batchDeleteMods(instanceId: string, names: string[]): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/batch-delete`, names)
}

export async function getResourcePacksMetadata(instanceId: string): Promise<ResourcePackMetadata[]> {
  return get<ResourcePackMetadata[]>(`/instance/${instanceId}/files/resourcepacks/metadata`)
}

export async function getShadersMetadata(instanceId: string): Promise<ShaderMetadata[]> {
  return get<ShaderMetadata[]>(`/instance/${instanceId}/files/shaderpacks/metadata`)
}

export async function getSavesMetadata(instanceId: string): Promise<SaveMetadata[]> {
  return get<SaveMetadata[]>(`/instance/${instanceId}/files/saves/metadata`)
}

export async function renameSave(instanceId: string, oldName: string, newName: string): Promise<void> {
  await post(`/instance/${instanceId}/files/saves/rename`, { oldName, newName })
}

export async function backupSave(instanceId: string, name: string): Promise<void> {
  await post(`/instance/${instanceId}/files/saves/backup?name=${encodeURIComponent(name)}`)
}

export async function getScreenshotsMetadata(instanceId: string): Promise<ScreenshotMetadata[]> {
  return get<ScreenshotMetadata[]>(`/instance/${instanceId}/files/screenshots/metadata`)
}

export async function getDataPacks(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/datapacks`)
}

export async function getDataPacksMetadata(instanceId: string): Promise<DataPackMetadata[]> {
  return get<DataPackMetadata[]>(`/instance/${instanceId}/files/datapacks/metadata`)
}

export async function deleteDataPack(instanceId: string, name: string): Promise<void> {
  await del(`/instance/${instanceId}/files/datapacks?name=${encodeURIComponent(name)}`)
}

export function getLanGames(instanceId: string): Promise<LanGameEntry[]> {
  return get<LanGameEntry[]>(`/instance/${instanceId}/files/lan-games`)
}

// =====================================================================
// 投影原理图 / Litematica (.litematic) 管理
// =====================================================================

export function getSchematics(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/schematics`)
}

export function deleteSchematic(instanceId: string, name: string): Promise<void> {
  return del(`/instance/${instanceId}/files/schematics?name=${encodeURIComponent(name)}`)
}

export function renameSchematic(instanceId: string, oldName: string, newName: string): Promise<void> {
  return post(`/instance/${instanceId}/files/schematics/rename`, { oldName, newName })
}

/** 导入本地原理图文件（multipart）。同名报 409 SCHEMATIC_EXISTS。 */
export async function importSchematic(instanceId: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${API_BASE}/instance/${instanceId}/files/schematics/import`, { method: 'POST', body: form })
  if (!res.ok) throw await apiErrorFrom(res, 'SCHEMATIC_IMPORT_FAILED', '导入失败')
}

/** 下载原理图原始字节（浏览器端解析 NBT）。 */
export async function getSchematicBytes(instanceId: string, name: string): Promise<ArrayBuffer> {
  const res = await fetch(`${API_BASE}/instance/${instanceId}/files/schematics/${encodeURIComponent(name)}/bytes`)
  if (!res.ok) throw await apiErrorFrom(res, 'SCHEMATIC_DOWNLOAD_FAILED', '下载原理图失败')
  return res.arrayBuffer()
}

/** 按调色板方块集从游戏 jar/版本目录提取预览素材（首次提取可达数十秒，绕过 15s 全局超时）。 */
export function getSchematicAssets(instanceId: string, blocks: string[]): Promise<SchematicAssetsBundle> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  return post<SchematicAssetsBundle>(`/instance/${instanceId}/schematics/assets`, { blocks }, { signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

export function getModUpdatesCache(instanceId: string): Promise<{ updates: ModUpdateEntry[]; stale: boolean }> {
  return get<{ updates: ModUpdateEntry[]; stale: boolean }>(`/instance/${instanceId}/files/mods/update-cache`)
}

export function invalidateModUpdatesCache(instanceId: string): Promise<void> {
  return del(`/instance/${instanceId}/files/mods/update-cache`)
}

export function checkModUpdates(instanceId: string, force = false): Promise<ModUpdateEntry[]> {
  // CurseForge fingerprints 批量反查可达 30-50s，用 120s 信号绕过全局 15s 超时
  // （失败由调用方静默处理，同 enrichMods 模式）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  return get<{ updates: ModUpdateEntry[]; refreshed: boolean }>(`/instance/${instanceId}/files/mods/check-updates${force ? '?force=1' : ''}`, { signal: controller.signal })
    .then(r => r.updates)
    .finally(() => clearTimeout(timer))
}

export function batchUpdateMods(instanceId: string, updates: ModUpdateEntry[]): Promise<void> {
  // 批量下载替换多个 mod 耗时随数量增长，用 180s 信号绕过全局 15s 超时
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  return post<void>(`/instance/${instanceId}/files/mods/batch-update`, updates, { signal: controller.signal })
    .finally(() => clearTimeout(timer))
}
