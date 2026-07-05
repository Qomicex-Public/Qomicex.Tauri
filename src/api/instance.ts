import { get, post, put, del } from './client.ts'
import type { GameInstance, CreateInstanceRequest, LaunchResult, LaunchProgress, InstallProgressResponse, VerifyResourcesResult, RepairResourcesResult, GameSettingDto, ModpackParseResult, ModpackInstallRequest } from '../types/index.ts'

export async function getInstances(): Promise<GameInstance[]> {
  return get<GameInstance[]>('/instance')
}

export async function getInstance(id: string): Promise<GameInstance> {
  return get<GameInstance>(`/instance/${id}`)
}

export async function getDefaultInstance(): Promise<GameInstance | null> {
  return get<GameInstance | null>('/instance/default')
}

export async function setDefaultInstance(id: string): Promise<GameInstance> {
  return put<GameInstance>(`/instance/${id}/default`)
}

export async function clearDefaultInstance(id: string): Promise<void> {
  await del(`/instance/${id}/default`)
}

export async function createInstance(data: CreateInstanceRequest): Promise<GameInstance> {
  return post<GameInstance>('/instance', data)
}

export async function updateInstance(id: string, data: Partial<CreateInstanceRequest>): Promise<GameInstance> {
  return put<GameInstance>(`/instance/${id}`, data)
}

export async function deleteInstance(id: string): Promise<void> {
  await del(`/instance/${id}`)
}

export async function launchInstance(id: string): Promise<LaunchResult> {
  return post<LaunchResult>(`/instance/${id}/launch`)
}

export async function getLaunchProgress(id: string): Promise<LaunchProgress> {
  return get<LaunchProgress>(`/instance/${id}/launch/progress`)
}

export async function cancelLaunch(id: string): Promise<void> {
  await post(`/instance/${id}/launch/cancel`)
}

export async function startInstall(id: string, loader?: string, loaderVersion?: string, addons?: string[], downloadThreads?: number, versionIsolation?: boolean, downloadSource?: number, downloadTimeout?: number): Promise<void> {
  await post(`/instance/${id}/install`, { loader, loaderVersion, addons, downloadThreads, versionIsolation, downloadSourceId: downloadSource, downloadTimeout })
}

export async function getInstallProgress(id: string): Promise<InstallProgressResponse> {
  return get<InstallProgressResponse>(`/instance/${id}/install/progress`)
}

export async function pauseInstall(id: string): Promise<void> {
  await post(`/instance/${id}/install/pause`)
}

export async function resumeInstall(id: string): Promise<void> {
  await post(`/instance/${id}/install/resume`)
}

export async function cancelInstall(id: string): Promise<void> {
  await post(`/instance/${id}/install/cancel`)
}

export async function repairInstance(id: string, threads?: number): Promise<void> {
  await post(`/instance/${id}/repair${threads ? `?threads=${threads}` : ''}`)
}

export async function verifyResources(id: string): Promise<VerifyResourcesResult> {
  return get<VerifyResourcesResult>(`/instance/${id}/verify-resources`)
}

export async function repairResources(id: string): Promise<RepairResourcesResult> {
  return post<RepairResourcesResult>(`/instance/${id}/repair-resources`)
}

export async function getGameSettings(id: string): Promise<GameSettingDto[]> {
  return get<GameSettingDto[]>(`/instance/${id}/game-settings`)
}

export async function setGameSetting(id: string, name: string, value: string): Promise<void> {
  await put(`/instance/${id}/game-settings/` + encodeURIComponent(name), value)
}

export async function parseModpackFile(file: File): Promise<ModpackParseResult> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch('/api/modpack/parse', { method: 'POST', body: formData })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.error || '解析失败')
  }
  return res.json()
}

export async function resolveModpack(source: string, projectId: string, versionId: string): Promise<ModpackParseResult> {
  return post<ModpackParseResult>('/modpack/resolve', { source, projectId, versionId })
}

export async function startModpackInstall(data: ModpackInstallRequest): Promise<{ message: string; instanceId: string }> {
  return post('/modpack/install', data)
}
