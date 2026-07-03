import { get, del, post } from './client.ts'
import type { FileEntry, ModMetadata, ResourcePackMetadata, ShaderMetadata, SaveMetadata, ScreenshotMetadata, DataPackMetadata, ServerEntry, ServerState, LanGameEntry } from '../types/index.ts'

export function getSaves(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/saves`)
}
export function deleteSave(instanceId: string, name: string): Promise<void> {
  return del(`/instance/${instanceId}/files/saves?name=${encodeURIComponent(name)}`)
}
export function copySave(instanceId: string, name: string, newName: string): Promise<void> {
  return post(`/instance/${instanceId}/files/saves/copy`, { name, newName })
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
