import { get, post, put, del, API_BASE, ApiError } from './client.ts'
import type { GameInstance, CreateInstanceRequest, LaunchResult, LaunchProgress, InstallProgressResponse, VerifyResourcesResult, RepairResourcesResult, GameSettingDto, ModpackParseResult, ModpackInstallRequest, ModpackInstallDirectRequest, ModpackInstallDirectResult } from '../types/index.ts'

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

// --- 实例自定义分组 ---

export interface InstanceGroup {
  id: string
  name: string
  color: string
}

export function getInstanceGroups(): Promise<InstanceGroup[]> {
  return get<InstanceGroup[]>('/instance-groups')
}

export function createInstanceGroup(name: string, color: string): Promise<InstanceGroup> {
  return post<InstanceGroup>('/instance-groups', { name, color })
}

export function updateInstanceGroup(id: string, name: string, color: string): Promise<InstanceGroup> {
  return put<InstanceGroup>(`/instance-groups/${id}`, { name, color })
}

export function deleteInstanceGroup(id: string): Promise<void> {
  return del<void>(`/instance-groups/${id}`)
}

export interface LaunchInstanceOptions {
  joinServer?: string
  joinWorld?: string
  accountUuid?: string
}

export async function launchInstance(id: string, options?: LaunchInstanceOptions): Promise<LaunchResult> {
  return post<LaunchResult>(`/instance/${id}/launch`, options || {})
}

export async function getLaunchProgress(id: string): Promise<LaunchProgress> {
  return get<LaunchProgress>(`/instance/${id}/launch/progress`)
}

export async function cancelLaunch(id: string): Promise<void> {
  await post(`/instance/${id}/launch/cancel`)
}

export async function startInstall(id: string, loader?: string, loaderVersion?: string, addons?: string[], downloadThreads?: number, versionIsolation?: boolean, downloadSource?: number, downloadTimeout?: number, optifineVersion?: string): Promise<void> {
  await post(`/instance/${id}/install`, { loader, loaderVersion, addons, downloadThreads, versionIsolation, downloadSourceId: downloadSource, downloadTimeout, optifineVersion })
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
  return get<GameSettingDto[]>(`/instance/${id}/files/options`)
}

export async function setGameSetting(id: string, name: string, value: string): Promise<void> {
  await put(`/instance/${id}/files/options/` + encodeURIComponent(name), { value })
}

export async function exportDiagnostics(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instance/${id}/export-diagnostics`, { method: 'POST' })
  if (!res.ok) throw new ApiError({ code: 'EXPORT_DIAGNOSTICS_FAILED', message: '导出诊断报告失败', detail: null, traceId: '', timestamp: new Date().toISOString(), status: res.status })
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition')
  const match = disposition?.match(/filename="?(.+?)"?$/)
  const filename = match?.[1] || `diagnostics-${id}.zip`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function parseModpackFile(file: File): Promise<ModpackParseResult> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${API_BASE}/modpack/parse`, { method: 'POST', body: formData })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    if (err.message) throw new Error(String(err.message))
    throw new ApiError({ code: 'MODPACK_PARSE_FAILED', message: '解析失败', detail: typeof err.error === 'string' ? err.error : null, traceId: '', timestamp: new Date().toISOString(), status: res.status })
  }
  return res.json()
}

export async function resolveModpack(source: string, projectId: string, versionId: string): Promise<ModpackParseResult> {
  return post<ModpackParseResult>('/modpack/resolve', { source, projectId, versionId })
}

export async function startModpackInstall(data: ModpackInstallRequest): Promise<{ message: string; instanceId: string }> {
  const res = await post<{ message: string; versionId: string }>('/modpack/install', data)
  return { message: res.message, instanceId: res.versionId }
}

export async function installModpackDirect(data: ModpackInstallDirectRequest): Promise<ModpackInstallDirectResult> {
  return post<ModpackInstallDirectResult>('/modpack/install-direct', data)
}
