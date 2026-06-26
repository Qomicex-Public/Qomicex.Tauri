import { get, post, put, del } from './client.ts'
import type { GameInstance, CreateInstanceRequest, LaunchResult, InstallProgressResponse } from '../types/index.ts'

export async function getInstances(): Promise<GameInstance[]> {
  return get<GameInstance[]>('/instance')
}

export async function getInstance(id: string): Promise<GameInstance> {
  return get<GameInstance>(`/instance/${id}`)
}

export async function createInstance(data: CreateInstanceRequest): Promise<GameInstance> {
  return post<GameInstance>('/instance', data)
}

export async function updateInstance(id: string, data: CreateInstanceRequest): Promise<GameInstance> {
  return put<GameInstance>(`/instance/${id}`, data)
}

export async function deleteInstance(id: string): Promise<void> {
  await del(`/instance/${id}`)
}

export async function launchInstance(id: string): Promise<LaunchResult> {
  return post<LaunchResult>(`/instance/${id}/launch`)
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
