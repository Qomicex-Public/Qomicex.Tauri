// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getResourceVersions, getResourceDependencies } from '../api/resource.ts'
import { getInstalledFileNames, getModsMetadata } from '../api/instance-files.ts'
import { getInstance, getInstallProgress } from '../api/instance.ts'
import { loadInstalledMods, installedResourceKey } from './installedResources.ts'
import {
  planFavoriteFolderInstall,
  favoriteInstallKey,
  type FavoriteFolderInstallPlan,
  type FavoriteRootLike,
  type FavoriteRootResolution,
} from './favoriteFolderInstallPlan.ts'
import {
  claimFavoriteInstall,
  dropFavoriteInstall,
  getPendingFavoriteInstalls,
  type PendingFavoriteInstall,
} from '../stores/pendingFavoriteInstallStore.ts'
import type { ResourceFavorite, ResourceVersion } from '../types/index.ts'

/**
 * 收藏夹批量安装的解析编排（issue #223）。
 *
 * 把「收藏夹成员」解析成规划器要的输入：逐个取兼容版本、取依赖闭包，再交给
 * `planFavoriteFolderInstall` 生成计划。两个入口（资源中心一键安装、新建实例
 * 附带安装）共用本模块。
 *
 * # 并发上限
 *
 * `getResourceVersions` / `getResourceDependencies` 是远程查询，单次超时 90s
 * （issue #133）。一个收藏夹可能有几十个 mod，一次性并发会把连接池与后端都打满，
 * 也让「90s 超时」在慢网络上更容易触发。固定 3 并发换取稳定性。
 *
 * # 单个资源失败不中断整体
 *
 * 某个 mod 的版本查询失败只让它自己进 `skipped`，其余照常解析 —— 收藏夹里有几十个
 * mod 时，因为其中一个上游抖动就整体失败是不可接受的。
 */

/** 解析并发上限。 */
const RESOLVE_CONCURRENCY = 3

/** 收藏夹成员（只取安装需要的字段）。 */
export interface FavoriteFolderMember {
  source: string
  id: string
  title: string
  category: string
}

export interface BuildFavoriteFolderPlanOptions {
  instanceId: string
  gameVersion: string
  /** 实例加载器（小写；空串表示原版） */
  loader: string
  members: readonly FavoriteFolderMember[]
}

/** 从收藏条目里抽出安装需要的字段。 */
export function toFolderMember(f: ResourceFavorite): FavoriteFolderMember {
  return { source: f.source, id: f.id, title: f.title, category: f.category }
}

/** 按日期降序取最新版本（与 `ResourceInstallDialog` 的排序口径一致）。 */
function latestVersion(versions: readonly ResourceVersion[]): ResourceVersion | null {
  if (!versions || versions.length === 0) return null
  return [...versions].sort(
    (a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime(),
  )[0]
}

/** 固定并发的 map：保持结果顺序与输入一致。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 解析单个收藏成员：取最新兼容版本 + 该版本的依赖闭包。
 *
 * 版本查询失败或没有结果时返回 `version: null`，由规划器记为
 * `noCompatibleVersion` / `missingUrl`，不会静默消失。
 */
async function resolveOne(
  member: FavoriteFolderMember,
  gameVersion: string,
  loader: string,
): Promise<FavoriteRootResolution> {
  const root: FavoriteRootLike = {
    source: member.source,
    id: member.id,
    title: member.title,
    category: member.category,
  }

  let versions: ResourceVersion[]
  try {
    versions = await getResourceVersions(member.id, member.source, gameVersion, loader || undefined)
    // cleanroom 是 forge 的兼容分支，上游可能只标了 forge —— 与 ResourceDetail 的回退口径一致。
    if (versions.length === 0 && loader === 'cleanroom') {
      versions = await getResourceVersions(member.id, member.source, gameVersion, 'forge')
    }
  } catch {
    return { root, version: null, deps: [] }
  }

  const picked = latestVersion(versions)
  const file = picked?.downloads?.[0]
  if (!picked || !file) {
    return { root, version: null, deps: [] }
  }

  const version = {
    fileName: file.fileName,
    url: file.url,
    versionName: picked.versionNumber ?? picked.name,
  }

  // 依赖只对 mod 查询：其它类型没有依赖概念，白跑一次远程请求。
  if (member.category !== 'mod') {
    return { root, version, deps: [] }
  }

  try {
    const deps = await getResourceDependencies(
      member.id,
      member.source,
      picked.id,
      gameVersion,
      loader || undefined,
    )
    return { root, version, deps }
  } catch {
    // 依赖查询失败不影响本体安装：先把本体装上，前置由用户在实例详情里补。
    return { root, version, deps: [] }
  }
}

/**
 * 解析结果：安装计划 + 实例已有文件名。
 *
 * `existingFileNames` 要交给批任务的命名阶段做全局预留 —— 计划本身只透传上游原名，
 * 落盘名与去重都在 `quickInstallViaDownloadCenterForFolder` 里完成。
 */
export interface FavoriteFolderPlanResult {
  plan: FavoriteFolderInstallPlan
  existingFileNames: string[]
}

/**
 * 生成收藏夹安装计划。
 *
 * 会读取实例已有文件名（交给批任务做命名预留）与已安装模组的远程身份（跳过判定）。
 */
export async function buildFavoriteFolderPlan(
  opts: BuildFavoriteFolderPlanOptions,
): Promise<FavoriteFolderPlanResult> {
  const { instanceId, gameVersion, members } = opts
  const loader = (opts.loader || '').toLowerCase()

  // 已安装身份与已有文件名并行读取：两者互不依赖。
  const [installedMods, existingNames] = await Promise.all([
    loadInstalledMods(instanceId).catch(() => new Map()),
    // category 取值与后端目录名一致（mods，不是 mod）。
    getInstalledFileNames(instanceId, 'mods').catch(() => [] as string[]),
  ])

  // 已安装身份只取模组的远程 id（材质包/光影没有可靠的远程 id，不做名称猜测）。
  const installedKeys = new Set<string>()
  for (const key of installedMods.keys()) {
    // loadInstalledMods 的键已经是 `source:id` 形式（小写来源）。
    installedKeys.add(key)
  }
  // 兜底：loadInstalledMods 失败时用元数据直接构造（两处口径一致）。
  if (installedKeys.size === 0) {
    const meta = await getModsMetadata(instanceId).catch(() => [])
    for (const m of meta) {
      if (m.modrinthId) installedKeys.add(installedResourceKey('modrinth', m.modrinthId))
      if (m.curseForgeId != null && m.curseForgeId > 0) {
        installedKeys.add(installedResourceKey('curseforge', String(m.curseForgeId)))
      }
    }
  }

  const resolutions = await mapWithConcurrency(members, RESOLVE_CONCURRENCY, (m) =>
    resolveOne(m, gameVersion, loader),
  )

  return {
    plan: planFavoriteFolderInstall(resolutions, installedKeys),
    existingFileNames: existingNames,
  }
}

/** 计划里真正会落盘的条目数（UI 上判断能否提交）。 */
export function plannedDownloadCount(plan: FavoriteFolderInstallPlan): number {
  return plan.downloads.length
}

/** 已安装的条数（对话框分组展示用）。 */
export function installedSkipCount(plan: FavoriteFolderInstallPlan): number {
  return plan.skipped.filter((s) => s.reason === 'installed').length
}

/** 计划里的根资源（用于统计「会装几个 mod」）。 */
export function plannedRootCount(plan: FavoriteFolderInstallPlan): number {
  return plan.downloads.filter((d) => d.isRoot).length
}

export { favoriteInstallKey }

// =====================================================================
// 新建实例的「完成门控」编排器
// =====================================================================

/**
 * 实例安装的终态轮询间隔。
 *
 * 后端安装动辄数分钟，轮询只是等终态，不需要更密；但也不能太稀，否则用户装完后
 * 要干等一段时间才看到 mod 开始下载。
 */
const INSTALL_POLL_INTERVAL_MS = 3_000

/**
 * `not_found` 的重试次数。
 *
 * `createInstance` 返回后立刻 `startInstall`，进度端点可能有一小段窗口读不到条目
 * （后端 spawn 尚未登记）。给几次机会，耗尽才放弃 —— 不能把「还没登记」当成
 * 「实例不存在」。
 */
const NOT_FOUND_RETRIES = 10

type ProgressFn = (instanceId: string) => Promise<{ status: string }>

/** 编排器依赖的外部能力（便于测试与解耦）。 */
export interface FavoriteInstallOrchestratorDeps {
  /** 读取实例安装进度（默认 `getInstallProgress`） */
  getProgress?: ProgressFn
  /** 重新读取实例信息，拿到权威 gameVersion / loader */
  getInstanceInfo: (instanceId: string) => Promise<{ gameVersion: string; loader: string } | null>
  /** 生成计划 */
  buildPlan: (opts: BuildFavoriteFolderPlanOptions) => Promise<FavoriteFolderPlanResult>
  /** 提交批任务，返回 batchId */
  submit: (opts: {
    instanceId: string
    gameVersion: string
    plan: FavoriteFolderInstallPlan
    existingFileNames: string[]
    taskName: string
  }) => Promise<string>
  /** 提示用户（成功/取消/失败） */
  notify: (message: string, level: 'success' | 'error' | 'info') => void
  /** i18n */
  t: (key: string, params?: Record<string, string | number>) => string
}

/** 编排器当前是否在跑（避免重复起轮询循环）。 */
const runningInstances = new Set<string>()

/**
 * 等待实例安装到终态，然后在 `completed` 时安装收藏夹。
 *
 * **认领语义**：调用方必须先 `claimFavoriteInstall` 拿到条目再调本函数，或者直接调
 * `resumePending`（内部认领）。本函数不碰 store，保证「谁认领谁执行」。
 */
export async function runPendingFavoriteInstall(
  entry: PendingFavoriteInstall,
  deps: FavoriteInstallOrchestratorDeps,
): Promise<void> {
  const { instanceId, folderName, members } = entry
  if (runningInstances.has(instanceId)) return
  runningInstances.add(instanceId)
  try {
    const getProgress: ProgressFn = deps.getProgress ?? ((id) => getInstallProgress(id))

    let notFoundStreak = 0
    for (;;) {
      let status: string
      try {
        const progress = await getProgress(instanceId)
        status = progress.status
        notFoundStreak = 0
      } catch {
        // 404 / 网络抖动：都按「暂时读不到」处理，有限次重试后放弃。
        notFoundStreak += 1
        if (notFoundStreak > NOT_FOUND_RETRIES) {
          dropFavoriteInstall(instanceId)
          deps.notify(deps.t('resource.favorites.installFolder.instanceMissing', { name: folderName }), 'error')
          return
        }
        await sleep(INSTALL_POLL_INTERVAL_MS)
        continue
      }

      if (status === 'completed') break
      if (status === 'failed' || status === 'cancelled') {
        // 实例没装成，收藏夹也就没有意义：丢弃条目并告知用户，不留悬挂项。
        dropFavoriteInstall(instanceId)
        deps.notify(deps.t('resource.favorites.installFolder.instanceFailed', { name: folderName }), 'error')
        return
      }
      // pending / downloading / awaiting-files：继续等。
      await sleep(INSTALL_POLL_INTERVAL_MS)
    }

    // 以实例的权威信息重新生成计划：向导提交时的 loader 可能被后端校正过。
    const info = await deps.getInstanceInfo(instanceId)
    if (!info) {
      dropFavoriteInstall(instanceId)
      deps.notify(deps.t('resource.favorites.installFolder.instanceMissing', { name: folderName }), 'error')
      return
    }

    const { plan, existingFileNames } = await deps.buildPlan({
      instanceId,
      gameVersion: info.gameVersion,
      loader: info.loader,
      members,
    })

    if (plan.downloads.length === 0) {
      deps.notify(deps.t('resource.favorites.installFolder.nothingToInstall', { name: folderName }), 'info')
      return
    }

    await deps.submit({
      instanceId,
      gameVersion: info.gameVersion,
      plan,
      existingFileNames,
      taskName: deps.t('downloads.quickInstallName', { name: folderName }),
    })
    deps.notify(
      deps.t('resource.favorites.installFolder.queued', {
        name: folderName,
        count: String(plan.downloads.filter((d) => d.isRoot).length),
      }),
      'success',
    )
  } catch (e) {
    deps.notify(
      deps.t('resource.favorites.installFolder.failed', {
        name: folderName,
        error: e instanceof Error ? e.message : String(e),
      }),
      'error',
    )
  } finally {
    runningInstances.delete(instanceId)
  }
}

/**
 * 恢复全部待执行条目（应用启动时调一次）。
 *
 * 刷新 / 重新打开启动器后，仍停在等待中的条目会继续等实例装完。
 */
export function resumePendingFavoriteInstalls(deps: FavoriteInstallOrchestratorDeps): void {
  for (const entry of getPendingFavoriteInstalls()) {
    // 认领后再跑：避免轮询循环与恢复流程同时处理同一条目。
    const claimed = claimFavoriteInstall(entry.instanceId)
    if (!claimed) continue
    void runPendingFavoriteInstall(claimed, deps)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 用真实 API 组装编排器依赖。
 *
 * `submit` 由调用方注入：它需要 `quickInstallViaDownloadCenterForFolder`，而那个模块
 * 反向依赖本模块的类型 —— 注入避免 `favoriteFolderInstall` ↔ `quickInstall` 的循环导入。
 */
export function createFavoriteInstallDeps(opts: {
  submit: FavoriteInstallOrchestratorDeps['submit']
  notify: FavoriteInstallOrchestratorDeps['notify']
  t: FavoriteInstallOrchestratorDeps['t']
}): FavoriteInstallOrchestratorDeps {
  return {
    submit: opts.submit,
    notify: opts.notify,
    t: opts.t,
    getProgress: (id) => getInstallProgress(id),
    getInstanceInfo: async (id) => {
      const inst = await getInstance(id).catch(() => null)
      if (!inst) return null
      return { gameVersion: inst.gameVersion, loader: inst.loader ?? '' }
    },
    buildPlan: (o) => buildFavoriteFolderPlan(o),
  }
}
