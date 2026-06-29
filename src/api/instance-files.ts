import { get, del, post } from './client.ts'
import type { FileEntry, ServerEntry, ServerState } from '../types/index.ts'

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
