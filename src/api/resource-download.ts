import { get, post } from './client.ts'
import type { ResourceDownloadState } from '../types/index.ts'

export function startResourceDownload(instanceId: string, url: string, fileName: string, category: string): Promise<{ taskId: string; fileName: string }> {
  return post('/resource-download/start', { instanceId, url, fileName, category })
}

export function downloadTo(url: string, targetPath: string): Promise<{ taskId: string; path: string }> {
  return post('/resource-download/download-to', { url, targetPath })
}

export function getResourceDownloadProgress(taskId: string): Promise<ResourceDownloadState> {
  return get(`/resource-download/${taskId}/progress`)
}

export function cancelResourceDownload(taskId: string): Promise<void> {
  return post(`/resource-download/${taskId}/cancel`)
}

export function cancelBatch(taskIds: string[]): Promise<void> {
  return post('/resource-download/cancel-batch', { taskIds })
}
