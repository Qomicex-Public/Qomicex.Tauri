// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { startResourceDownload, cancelBatch } from '../api/resource-download.ts'
import { deleteMod } from '../api/instance-files.ts'
import { addTask, updateTask } from '../stores/downloadStore.ts'
import { waitForCompletion } from './updateMods.ts'
import { cacheInvalidate } from './simple-cache.ts'
import { invalidateInstalledMods } from './installedResources.ts'
import { getSettings } from '../api/settings.ts'
import { formatDownloadFileName } from './download-naming.ts'
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
 * 收藏夹批量安装（issue #223）：把多个根资源及其依赖合并为一个 batch 任务。
 *
 * 与 `quickInstallViaDownloadCenter` 的差异只有两点：
 * - 本体是**多个**根资源（收藏夹成员），不是单个；
 * - 命名去重从调用方接手（`existingFileNames`），因为一批里有多个资源时，
 *   每个资源各自从空集合开始去重会撞名。
 *
 * 其余语义完全一致：`fileNaming` 模板、`download-deps` / `download-main` 两步、
 * 启动失败 `cancelBatch`、后台 `waitForCompletion` 聚合、成功后失效
 * `api-instance-{id}-mods`。批量安装**不做删除**，`toDelete` 恒为空。
 */
export interface FolderQuickInstallOptions {
  instanceId: string
  gameVersion: string
  /** 根资源（收藏夹成员） */
  mains: QuickInstallItem[]
  /** 依赖（已按来源去重，见 favoriteFolderInstallPlan） */
  deps: QuickInstallItem[]
  /** 批任务标题（收藏夹名） */
  taskName: string
  /** 实例里已有的文件名，作为全局命名预留的初始内容 */
  existingFileNames: Iterable<string>
  icon?: string
  t: TFunc
  lang?: string
}

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
  const namingTemplate = resolveNamingTemplate(opts.lang)
  const usedNames = new Set<string>()
  const applyNaming = makeNaming(namingTemplate, usedNames)

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
    void aggregate(batchId, instanceId, started.slice(0, -1), [mainTaskId], steps, t, toDelete, newFileNames)
    return batchId
  } catch (e) {
    return failStart(e)
  }
}

/**
 * 收藏夹批量安装（issue #223）：一次提交多个根资源及其依赖。
 *
 * 保留 `quickInstallViaDownloadCenter` 的签名与行为不变，供单资源安装继续使用。
 * 本函数只做「多本体」扩展，聚合仍复用同一个 `aggregate`。
 */
export async function quickInstallViaDownloadCenterForFolder(
  opts: FolderQuickInstallOptions,
): Promise<string> {
  const { instanceId, gameVersion, deps, mains, taskName, t } = opts

  // 命名预留从实例已有文件名起步，并与**同一实例其他在途批次**共享同一命名池：
  // 只靠快照会让并发批次互相看不见对方在途的下载，从而分配出同一个目标名。
  const namingTemplate = resolveNamingTemplate(opts.lang)
  const usedNames = acquireNamePool(instanceId, opts.existingFileNames)
  const applyNaming = makeNaming(namingTemplate, usedNames)

  const batchId = `quick-install-folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
    totalFiles: deps.length + mains.length,
    completedFiles: 0,
    createdAt: new Date().toISOString(),
    instanceId,
    icon: opts.icon,
    resourceKind: 'mod',
    steps,
    batchTaskIds: [],
  })

  const started: string[] = []
  const startOne = async (item: QuickInstallItem): Promise<string> => {
    const named = applyNaming(item)
    const { taskId } = await startResourceDownload(instanceId, named.url, named.fileName, named.category)
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
    // 本体按顺序启动：并行启动多个本体时，任一个失败都要回滚，顺序启动能让错误
    // 归因到具体资源，也避免瞬时打出大量并发请求。
    const mainTaskIds: string[] = []
    for (const item of mains) {
      const id = await startOne(item)
      mainTaskIds.push(id)
      started.push(id)
    }
    updateTask(batchId, { batchTaskIds: [...started] })
    // 批量安装不做删除：toDelete 恒为空（只新增，不清除用户已有文件）。
    void aggregate(batchId, instanceId, started.slice(0, depResults.length), mainTaskIds, steps, t, [], new Set(), usedNames)
    return batchId
  } catch (e) {
    return failStart(e)
  }
}

/** 资源命名模板（ENH-10）：读设置，中文环境默认带中文名前缀。 */
function resolveNamingTemplate(lang?: string): string {
  const isZh = (lang ?? '').toLowerCase().startsWith('zh')
  return getSettings().fileNaming || (isZh ? '[{cn}]{name}-{version}' : '{name}-{version}')
}

/**
 * 同一实例**正在进行中**的批任务命名预留池（instanceId → 已占用的落盘名）。
 *
 * 为什么需要：`usedNames` 若只从「实例已安装文件名」快照起步，同一实例并发两个
 * 批次时彼此看不到对方在途的下载，可能给不同资源分配同一个目标名 —— 后下的覆盖
 * 先下的，两个批次都显示完成，实例里却少一个 mod。
 *
 * 池在批次启动时登记、聚合结束时释放（见 `aggregate` 的 finally）。
 */
const instanceNamePools = new Map<string, Set<string>>()

function acquireNamePool(instanceId: string, seed: Iterable<string>): Set<string> {
  let pool = instanceNamePools.get(instanceId)
  if (!pool) {
    pool = new Set<string>()
    instanceNamePools.set(instanceId, pool)
  }
  for (const n of seed) pool.add(n)
  return pool
}

/**
 * 释放命名池。
 *
 * 只在该实例的池**仍是调用方持有的那个**时才删：并发批次共享同一个池，
 * 先结束的批次不能把后结束批次还在用的池摘掉，否则后者失去预留保护。
 */
function releaseNamePool(instanceId: string, pool: Set<string>): void {
  if (instanceNamePools.get(instanceId) === pool) instanceNamePools.delete(instanceId)
}

/**
 * 按模板生成本地落盘名，并在 `usedNames` 里做全局预留。
 *
 * 冲突检查**大小写不敏感**：Windows / macOS 默认的文件系统不区分大小写，
 * 实例里已有 `Foo.jar` 时 `foo.jar` 实际会写到同一个路径。实际下载仍用生成时的
 * 拼写（保留用户看到的名称），只让比较口径归一。
 */
function makeNaming(template: string, usedNames: Set<string>) {
  /** 已占用名的归一化视图（小写）→ 用于冲突判定。 */
  const normalized = new Set<string>()
  for (const n of usedNames) normalized.add(n.toLowerCase())

  const reserve = (candidate: string): boolean => {
    const key = candidate.toLowerCase()
    if (normalized.has(key)) return false
    normalized.add(key)
    usedNames.add(candidate)
    return true
  }

  return (item: QuickInstallItem): QuickInstallItem => {
    const extMatch = item.fileName.match(/\.(jar|zip|mrpack|qmodpack|shaderpacks|mcpack)$/i)
    const ext = extMatch ? extMatch[0] : ''
    const version = item.fileName.replace(/\.(jar|zip|mrpack|qmodpack|shaderpacks|mcpack)$/i, '').replace(/^.*-(\d[\w.+]*)$/, '$1')
    const renamed = formatDownloadFileName(template, {
      name: item.name.replace(/\.(jar|zip|mrpack|qmodpack|mcpack|shaderpacks)$/i, ''),
      version,
      cnName: item.cnName ?? null,
    })
    const desired = `${renamed}${ext}`
    // 与 dedupFileName 同形（追加 (i)），但走大小写不敏感的比较口径。
    let finalName = desired
    if (!reserve(finalName)) {
      const dot = finalName.lastIndexOf('.')
      const base = dot > 0 ? finalName.slice(0, dot) : finalName
      const suffix = dot > 0 ? finalName.slice(dot) : ''
      for (let i = 1; i < 100; i++) {
        const candidate = `${base}(${i})${suffix}`
        if (reserve(candidate)) {
          finalName = candidate
          break
        }
      }
    }
    return { ...item, fileName: finalName }
  }
}


/**
 * 聚合下载终态并驱动 batch 任务进度。
 *
 * `depTaskIds` / `mainTaskIds` 由调用方显式传入，**不按位置切分**：收藏夹批量安装
 * 有多个本体，用 `taskIds.slice(0, -1)` 会把除最后一个之外的本体误算进依赖步骤，
 * 导致进度与终态错位。
 */
async function aggregate(
  batchId: string,
  instanceId: string,
  depTaskIds: string[],
  mainTaskIds: string[],
  steps: InstallStepInfo[],
  t: TFunc,
  toDelete: { fileName: string; category: string }[] = [],
  newFileNames: Set<string> = new Set(),
  namePool?: Set<string>,
): Promise<void> {
  const prog = new Map<string, number>()
  const speedMap = new Map<string, number>()
  const total = depTaskIds.length + mainTaskIds.length
  const hasDeps = depTaskIds.length > 0
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
    hasDeps ? track(DEP_STEP, depTaskIds) : ([] as string[]),
    track(MAIN_STEP, mainTaskIds),
  ])
  setStep(MAIN_STEP, { status: mainStatus.every(s => s === 'completed') ? 'done' : 'failed' })
  if (hasDeps) {
    setStep(DEP_STEP, { status: depsStatuses.every(s => s === 'completed') ? 'done' : 'failed' })
  }
  const all = [...depsStatuses, ...mainStatus]
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
    // 「已安装」角标读的是同一批元数据，安装完成后一并失效。
    invalidateInstalledMods(instanceId)

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
  // 释放该实例的命名预留池：下载已全部结束，后续批次应重新以「已安装文件名」为基线。
  if (namePool) releaseNamePool(instanceId, namePool)
}

function startErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
