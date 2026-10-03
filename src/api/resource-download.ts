import { get, post } from './client.ts'
import type { ResourceDownloadState } from '../types/index.ts'

export function startResourceDownload(instanceId: string, url: string, fileName: string, category: string): Promise<{ taskId: string; fileName: string }> {
  return post('/resource-download/start', { instanceId, url, fileName, category })
}

/**
 * 下载到指定路径。
 *
 * `extract: true` 时后端会在下载完成后把 `.zip` 解压到其所在目录并删除原 zip
 * （#162：地图存档必须解压成文件夹，Minecraft 才认）。仅对 `.zip` 生效；
 * 普通文件下载（直链、FTB 导出 json）保持缺省 false。
 */
export function downloadTo(url: string, targetPath: string, extract = false): Promise<{ taskId: string; path: string }> {
  return post('/resource-download/download-to', { url, targetPath, extract })
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
