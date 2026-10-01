import { startResourceDownload, cancelBatch } from '../api/resource-download.ts'
import { deleteMod } from '../api/instance-files.ts'
import { addTask, updateTask } from '../stores/downloadStore.ts'
import { waitForCompletion } from './updateMods.ts'
import { cacheInvalidate } from './simple-cache.ts'
import { getSettings } from '../api/settings.ts'
import { formatDownloadFileName, dedupFileName } from './download-naming.ts'
import { normalizeResourceKind } from './downloadGroups.ts'
import type { InstallStepInfo } from '../types/index.ts'

type TFunc = (key: string, params?: Record<string, string | number>) => string

export interface QuickInstallItem {
  url: string
  fileName: string
  category: string
  name: string
  /** 中文名（mcmod.cn），用于 [{cn}] 命名模板 */
  cnName?: string | null
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
  /** 资源图标（https URL 或 data URL），显示在下载中心列表 */
  icon?: string
  t: TFunc
  /** 当前语言（用于按语言决定默认命名格式） */
  lang?: string
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

  // 旧文件**不在这里删**：换版本场景下立刻删除会让「下载失败」直接损失原文件。
  // 改为全部下载成功后由 aggregate 删除（见其 toDelete 处理），与后端
  // change_mod_version 的「先下成功、再替旧」语义一致。

  // 资源文件命名格式（ENH-10）：读取设置，按模板生成新文件名。
  // 已存在的目标文件名（下载中/已安装）做序号去重，避免覆盖。
  const isZh = (opts.lang ?? '').toLowerCase().startsWith('zh')
  const namingTemplate = getSettings().fileNaming || (isZh ? '[{cn}]{name}-{version}' : '{name}-{version}')
  const usedNames = new Set<string>()
  const applyNaming = (item: QuickInstallItem): QuickInstallItem => {
    const extMatch = item.fileName.match(/\.(jar|zip|mrpack|qmodpack|shaderpacks|mcpack)$/i)
    const ext = extMatch ? extMatch[0] : ''
    const version = item.fileName.replace(/\.(jar|zip|mrpack|qmodpack|shaderpacks|mcpack)$/i, '').replace(/^.*-(\d[\w.+]*)$/, '$1')
    const renamed = formatDownloadFileName(namingTemplate, {
      name: item.name.replace(/\.(jar|zip|mrpack|qmodpack|mcpack|shaderpacks)$/i, ''),
      version,
      cnName: item.cnName ?? null,
    })
    const finalName = dedupFileName(`${renamed}${ext}`, usedNames)
    usedNames.add(finalName)
    return { ...item, fileName: finalName }
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
    icon: opts.icon,
    // 下载中心分组按**主资源**归类：一个 batch 可能「本体是模组、依赖里有光影」，
    // 用户在界面上看到的是本体，按依赖分类会与直觉相反。依赖项分类不参与。
    resourceKind: normalizeResourceKind(main.category),
    steps,
    batchTaskIds: [],
  })

  const started: string[] = []
  /** 本次真正落盘的新文件名 —— toDelete 与它同名时绝不能删（原地重下同一版本）。 */
  const newFileNames = new Set<string>()
  const startOne = async (item: QuickInstallItem): Promise<string> => {
    const named = applyNaming(item)
    const { taskId } = await startResourceDownload(instanceId, named.url, named.fileName, named.category)
    newFileNames.add(named.fileName)
    return taskId
  }
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
    void aggregate(batchId, instanceId, hasDeps, started, steps, t, toDelete, newFileNames)
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
  toDelete: { fileName: string; category: string }[] = [],
  newFileNames: Set<string> = new Set(),
): Promise<void> {
  const prog = new Map<string, number>()
  const speedMap = new Map<string, number>()
  const total = taskIds.length
  const setStep = (id: string, patch: Partial<InstallStepInfo>) => {
    const idx = steps.findIndex(s => s.id === id)
    if (idx < 0) return
    steps[idx] = { ...steps[idx], ...patch }
    updateTask(batchId, { steps: steps.map(s => ({ ...s })) })
  }
  const sumSpeed = () => [...speedMap.values()].reduce((a, b) => a + b, 0)
  const track = (stepId: string, ids: string[]) =>
    Promise.all(ids.map(async id => {
      const status = await waitForCompletion(id, t, undefined, p => {
        prog.set(id, p.progress)
        speedMap.set(id, p.speed)
        const avg = ids.reduce((a, x) => a + (prog.get(x) ?? 0), 0) / ids.length
        setStep(stepId, { percent: avg })
        const overall = [...prog.values()].reduce((a, b) => a + b, 0) / total
        updateTask(batchId, { progress: Math.round(overall), speed: sumSpeed() })
      })
      speedMap.set(id, 0)
      updateTask(batchId, { speed: sumSpeed() })
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
    // 全部下载成功后才清理旧版本文件（失败时保留原件，用户不会丢数据）。
    // 同名（原地重下同一版本）时跳过：那个文件正是刚下好的新文件。
    //
    // 必须 **await 并检查** 删除结果：旧文件删不掉（文件被占用 / 权限拒绝 / 后端抖动）时
    // 新旧两个版本会同时留在 mods 里 —— 那不是「换版本成功」，静默忽略会误导用户。
    const pending = toDelete.filter(d => !newFileNames.has(d.fileName))
    const cleanup = await Promise.allSettled(
      pending.map(d => deleteMod(instanceId, d.fileName)),
    )
    const failedCleanup = cleanup
      .map((r, i) => (r.status === 'rejected' ? pending[i].fileName : null))
      .filter((n): n is string => n !== null)

    // 缓存必须在删除完成之后失效：否则刷新的列表可能仍含刚删掉的旧文件。
    cacheInvalidate(`api-instance-${instanceId}-mods`)

    if (failedCleanup.length > 0) {
      updateTask(batchId, {
        status: 'failed',
        error: t('dialogs.common.cleanupFailed', { files: failedCleanup.join('、') }),
      })
    } else {
      updateTask(batchId, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
    }
  } else {
    updateTask(batchId, { status: 'failed', error: t('dialogs.common.downloadFailed') })
  }
}

function startErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
