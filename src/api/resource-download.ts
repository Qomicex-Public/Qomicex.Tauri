import { get, post } from './client.ts'
import type { ResourceDownloadState } from '../types/index.ts'

export function startResourceDownload(instanceId: string, url: string, fileName: string, category: string): Promise<{ taskId: string; fileName: string }> {
  return post('/resource-download/start', { instanceId, url, fileName, category })
}

/**
 * 下载到指定路径。
 *
 * `extract: true` 时后端会在下载完成后把 `.zip` 解压到其所在目录并删除原 zip；
 * `worldName` 给定时按**地图存档**语义解压：解成 `saves/<worldName>/` 恰好一层
 * （#162：Minecraft 只认文件夹形态的存档），同名已存在时后端返回 409
 * `SAVE_NAME_CONFLICT`，调用方应弹出改名对话框后重试。
 *
 * 普通文件下载（直链、FTB 导出 json）两个参数都不传。
 */
export function downloadTo(
  url: string,
  targetPath: string,
  extract = false,
  worldName?: string,
): Promise<{ taskId: string; path: string }> {
  return post('/resource-download/download-to', { url, targetPath, extract, worldName })
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
