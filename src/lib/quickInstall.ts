import { startResourceDownload, cancelBatch } from '../api/resource-download.ts'
import { deleteMod } from '../api/instance-files.ts'
import { addTask, updateTask } from '../stores/downloadStore.ts'
import { waitForCompletion } from './updateMods.ts'
import { cacheInvalidate } from './simple-cache.ts'
import type { InstallStepInfo } from '../types/index.ts'

type TFunc = (key: string, params?: Record<string, string | number>) => string

export interface QuickInstallItem {
  url: string
  fileName: string
  category: string
  name: string
}

export interface QuickInstallOptions {
  instanceId: string
  gameVersion: string
  resourceTitle: string
  deps: QuickInstallItem[]
  main: QuickInstallItem
  /** 下载前需清理的旧文件（版本切换替换） */
  toDelete?: { fileName: string; category: string }[]
  taskName: string
  t: TFunc
}

const DEP_STEP = 'download-deps'
const MAIN_STEP = 'download-main'

/**
 * 模组快捷安装后台化：并行启动「前置资源组 + 资源本体」下载会话，聚合为一个
 * 带 2-step（无依赖时 1-step）的 batch 任务进入下载中心。
 * 返回的 Promise 在全部会话启动成功后 resolve（返回 batchId）；任一会话启动失败时
 * 取消已启动的会话并 reject，由调用方留在对话框提示重试。下载进度/终态由本函数
 * 的后台聚合循环驱动（不依赖调用方组件存活）。
 */
export async function quickInstallViaDownloadCenter(opts: QuickInstallOptions): Promise<string> {
  const { instanceId, gameVersion, deps, main, toDelete = [], taskName, t } = opts

  for (const d of toDelete) {
    deleteMod(instanceId, d.fileName).catch(() => {})
  }

  const batchId = `quick-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const hasDeps = deps.length > 0
  const steps: InstallStepInfo[] = hasDeps
    ? [
        { id: DEP_STEP, status: 'active', percent: 0 },
        { id: MAIN_STEP, status: 'active', percent: 0 },
      ]
    : [{ id: MAIN_STEP, status: 'active', percent: 0 }]
  addTask({
    id: batchId,
    name: taskName,
    type: 'batch',
    gameVersion,
    status: 'downloading',
    progress: 0,
    totalFiles: deps.length + 1,
    completedFiles: 0,
    createdAt: new Date().toISOString(),
    instanceId,
    steps,
    batchTaskIds: [],
  })

  const startOne = async (item: QuickInstallItem): Promise<string> => {
    const { taskId } = await startResourceDownload(instanceId, item.url, item.fileName, item.category)
    return taskId
  }

  const started: string[] = []
  const cancelStarted = async () => {
    if (started.length > 0) await cancelBatch(started).catch(() => {})
    updateTask(batchId, { status: 'failed' })
  }
  const failStart = async (e: unknown): Promise<never> => {
    await cancelStarted()
    throw new Error(startErrorMessage(e))
  }

  const depResults = await Promise.allSettled(deps.map(startOne))
  for (const r of depResults) {
    if (r.status === 'fulfilled') started.push(r.value)
  }
  const failedDeps = depResults.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
  if (failedDeps.length > 0) {
    return failStart(failedDeps[0].reason)
  }
  try {
    const mainTaskId = await startOne(main)
    started.push(mainTaskId)
    updateTask(batchId, { batchTaskIds: [...started] })
    void aggregate(batchId, instanceId, hasDeps, started, steps, t)
    return batchId
  } catch (e) {
    return failStart(e)
  }
}

async function aggregate(
  batchId: string,
  instanceId: string,
  hasDeps: boolean,
  taskIds: string[],
  steps: InstallStepInfo[],
  t: TFunc,
): Promise<void> {
  const prog = new Map<string, number>()
  const total = taskIds.length
  const setStep = (id: string, patch: Partial<InstallStepInfo>) => {
    const idx = steps.findIndex(s => s.id === id)
    if (idx < 0) return
    steps[idx] = { ...steps[idx], ...patch }
    updateTask(batchId, { steps: steps.map(s => ({ ...s })) })
  }
  const track = (stepId: string, ids: string[]) =>
    Promise.all(ids.map(async id => {
      const status = await waitForCompletion(id, t, undefined, p => {
        prog.set(id, p.progress)
        const avg = ids.reduce((a, x) => a + (prog.get(x) ?? 0), 0) / ids.length
        setStep(stepId, { percent: avg })
        const overall = [...prog.values()].reduce((a, b) => a + b, 0) / total
        updateTask(batchId, { progress: Math.round(overall) })
      })
      return status
    }))
  const [depsStatuses, mainStatus] = await Promise.all([
    hasDeps ? track(DEP_STEP, taskIds.slice(0, -1)) : ([] as string[]),
    track(MAIN_STEP, [taskIds[taskIds.length - 1]]),
  ])
  setStep(MAIN_STEP, { status: mainStatus[0] === 'completed' ? 'done' : 'failed' })
  if (hasDeps) {
    setStep(DEP_STEP, { status: depsStatuses.every(s => s === 'completed') ? 'done' : 'failed' })
  }
  const all = [...depsStatuses, mainStatus[0]]
  const failedCount = all.filter(s => s !== 'completed').length
  if (failedCount === 0) {
    updateTask(batchId, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
    cacheInvalidate(`api-instance-${instanceId}-mods`)
  } else {
    updateTask(batchId, { status: 'failed', error: t('dialogs.common.downloadFailed') })
  }
}

function startErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
