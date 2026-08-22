import { startResourceDownload, getResourceDownloadProgress } from '../api/resource-download.ts'
import { deleteMod, invalidateModUpdatesCache } from '../api/instance-files.ts'
import { addTask, updateTask } from '../stores/downloadStore.ts'
import { cacheInvalidate } from './simple-cache.ts'
import type { ModUpdateEntry, ResourceDownloadState } from '../types/index.ts'

const POLL_INTERVAL_MS = 800
/** 外层总超时上限：足够覆盖任何正常模组下载，仅作兜底 */
const DEFAULT_TIMEOUT_MS = 30 * 60_000
/** 无任何字节进度达到该时长即判定停滞（慢速但持续下载不会被误标为失败） */
const STALL_TIMEOUT_MS = 120_000

type TFunc = (key: string, params?: Record<string, string | number>) => string

function errorMessage(status: string, t: TFunc): string {
  switch (status) {
    case 'not_found': return t('dialogs.common.taskExpired')
    case 'timeout': return t('dialogs.common.downloadTimeout')
    case 'stalled': return t('dialogs.common.downloadStalled')
    case 'cancelled': return t('dialogs.common.cancelled')
    default: return t('dialogs.common.downloadFailed')
  }
}

function terminalUpdate(taskId: string, status: string, t: TFunc): void {
  if (status === 'completed') {
    updateTask(taskId, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
  } else {
    updateTask(taskId, { status: 'failed', progress: 0, error: errorMessage(status, t) })
  }
}

/** 轮询后端下载会话直到终态；onProgress 用于调用方聚合展示（如 batch 进度条）。 */
export async function waitForCompletion(
  taskId: string,
  t: TFunc,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  onProgress?: (p: ResourceDownloadState) => void,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastBytes = -1
  let lastMoveAt = Date.now()
  while (true) {
    const p = await getResourceDownloadProgress(taskId)
    if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled' || p.status === 'not_found') {
      terminalUpdate(taskId, p.status, t)
      return p.status
    }
    if (p.downloadedBytes !== lastBytes) {
      lastBytes = p.downloadedBytes
      lastMoveAt = Date.now()
    } else if (Date.now() - lastMoveAt >= STALL_TIMEOUT_MS) {
      terminalUpdate(taskId, 'stalled', t)
      return 'stalled'
    }
    if (Date.now() >= deadline) {
      terminalUpdate(taskId, 'timeout', t)
      return 'timeout'
    }
    updateTask(taskId, {
      status: 'downloading',
      progress: Math.round(p.progress),
      speed: p.speed,
      downloadedBytes: p.downloadedBytes,
      totalBytes: p.totalBytes,
      error: p.error || undefined,
    })
    onProgress?.(p)
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
}

export interface UpdateModsResult {
  success: number
  failed: number
  succeededFileNames: string[]
  failedFileNames: string[]
}

/** 通过下载中心逐文件更新模组：start → 进下载中心 → 轮询 → 完成后删除旧文件。并行启动。 */
export async function updateModsViaDownloadCenter(
  instanceId: string,
  updates: ModUpdateEntry[],
  onAdded?: (added: number) => void,
  t?: TFunc,
): Promise<UpdateModsResult> {
  const tf: TFunc = t ?? ((k: string) => k)
  const started = await Promise.all(updates.map(async (u): Promise<{ taskId: string; u: ModUpdateEntry; startError?: string }> => {
    try {
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
    } catch (e) {
      // 启动失败立即写入 failed 任务（下载中心可见），显式保留错误信息
      const failedTaskId = `mod-start-failed:${instanceId}:${u.newFileName}`
      addTask({
        id: failedTaskId,
        name: u.name,
        type: 'file',
        gameVersion: '',
        instanceId,
        status: 'failed',
        progress: 0,
        taskId: failedTaskId,
        currentFile: u.newFileName,
        createdAt: new Date().toISOString(),
        error: e instanceof Error ? `${tf('dialogs.common.startFailed')}：${e.message}` : tf('dialogs.common.startFailed'),
      })
      return { taskId: failedTaskId, u, startError: e instanceof Error ? e.message : String(e) }
    }
  }))
  const queued = started.filter(s => !s.startError)
  if (queued.length > 0) onAdded?.(queued.length)
  const results = await Promise.all(started.map(async ({ taskId, u, startError }): Promise<{ ok: boolean; fileName: string }> => {
    if (startError) return { ok: false, fileName: u.fileName }
    try {
      const status = await waitForCompletion(taskId, tf)
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
  const success = succeeded.length
  if (success > 0) {
    // 统一咽喉点：失效 mods 列表缓存（三条入口共用，修复更新后列表不刷新）
    cacheInvalidate(`api-instance-${instanceId}-mods`)
    // 失效后端 update-cache，避免下次自动检查返回已更新模组的过期条目
    invalidateModUpdatesCache(instanceId).catch(() => {})
  }
  return {
    success,
    failed: results.length - success,
    succeededFileNames: succeeded.map(r => r.fileName),
    failedFileNames: results.filter(r => !r.ok).map(r => r.fileName),
  }
}