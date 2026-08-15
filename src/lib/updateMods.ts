import { startResourceDownload, getResourceDownloadProgress } from '../api/resource-download.ts'
import { deleteMod } from '../api/instance-files.ts'
import { addTask, updateTask } from '../stores/downloadStore.ts'
import { cacheInvalidate } from './simple-cache.ts'
import type { ModUpdateEntry } from '../types/index.ts'

const POLL_INTERVAL_MS = 800
const TIMEOUT_MS = 300_000

function terminalUpdate(taskId: string, status: string): void {
  if (status === 'completed') {
    updateTask(taskId, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
  } else {
    updateTask(taskId, {
      status: 'failed',
      progress: 0,
      error: status === 'not_found' ? '任务已过期（后端未报告该会话）' : '下载失败',
    })
  }
}

async function waitForCompletion(taskId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const p = await getResourceDownloadProgress(taskId)
    if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled' || p.status === 'not_found') {
      terminalUpdate(taskId, p.status)
      return p.status
    }
    updateTask(taskId, {
      status: 'downloading',
      progress: Math.round(p.progress),
      speed: p.speed,
      downloadedBytes: p.downloadedBytes,
      totalBytes: p.totalBytes,
      error: p.error || undefined,
    })
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  terminalUpdate(taskId, 'failed')
  return 'failed'
}

export interface UpdateModsResult {
  success: number
  failed: number
  succeededFileNames: string[]
}

/** 通过下载中心逐文件更新模组：start → 进下载中心 → 轮询 → 完成后删除旧文件。并行启动。 */
export async function updateModsViaDownloadCenter(
  instanceId: string,
  updates: ModUpdateEntry[],
  onAdded?: (added: number) => void,
): Promise<UpdateModsResult> {
  const started = await Promise.allSettled(updates.map(async (u): Promise<{ taskId: string; u: ModUpdateEntry }> => {
    const { taskId } = await startResourceDownload(instanceId, u.downloadUrl, u.newFileName, 'mod')
    addTask({
      id: taskId,
      name: u.name,
      type: 'file',
      gameVersion: '',
      instanceId,
      status: 'queued',
      progress: 0,
      taskId,
      currentFile: u.newFileName,
      createdAt: new Date().toISOString(),
    })
    return { taskId, u }
  }))
  const ready = started.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ taskId: string; u: ModUpdateEntry }>[]
  if (ready.length > 0) onAdded?.(ready.length)
  const results = await Promise.all(ready.map(async ({ value }): Promise<{ ok: boolean; fileName: string }> => {
    const { taskId, u } = value
    try {
      const status = await waitForCompletion(taskId)
      if (status === 'completed') {
        await deleteMod(instanceId, u.fileName)
        return { ok: true, fileName: u.fileName }
      }
      return { ok: false, fileName: u.fileName }
    } catch {
      return { ok: false, fileName: u.fileName }
    }
  }))
  const succeeded = results.filter(r => r.ok)
  return {
    success: succeeded.length,
    failed: results.length - succeeded.length,
    succeededFileNames: succeeded.map(r => r.fileName),
  }
}

/** 失效该实例 mods 列表缓存，使更新后 loadMods() 重新拉取（修复更新后列表不刷新）。 */
export function refreshModsAfterUpdate(instanceId: string): void {
  cacheInvalidate(`api-instance-${instanceId}-mods`)
}