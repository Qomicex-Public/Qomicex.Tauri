// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 收藏夹批量安装的**安装计划**（issue #223）。
 *
 * 把「一个收藏夹的全部 mod 成员 + 它们的依赖」压成一次下载任务。抽成纯函数是为了让
 * 三条契约能被回归测试直接断言，而不是埋在对话框的 useCallback 里：
 *
 * 1. **已安装的条目既不重下也不删除**（与 ADR-112 / issue #249 同一口径）。
 * 2. **根资源优先于依赖**：一个项目既是收藏夹成员又是别人的依赖时，按根资源处理。
 * 3. **只做新增**：`deletions` 恒为空，批量安装绝不清除用户已有文件。
 *
 * # 为什么身份是「来源 + 项目 ID」而不是文件名
 *
 * 本地落盘名经命名模板（`[{cn}]{name}-{version}`，ENH-10）重写，与上游原名分属两个
 * 命名域，字符串比较恒不相等 —— 那正是 issue #249 的根因。因此「是否已安装」只用
 * 远程身份（`modrinth:abc` / `curseforge:12345`）判定。
 *
 * # 为什么这里不做文件名去重
 *
 * 本模块输出的 `fileName` 是**上游原名**，原样透传。真正的落盘名由批任务的命名阶段
 * 按模板生成，去重也必须在那个命名域里做（见 `quickInstallViaDownloadCenterForFolder`
 * 的 `existingFileNames` 参数）。若在此处给上游名追加序号，批任务反推版本号的正则
 * `^.*-(\d[\w.+]*)$` 会把序号当成版本号，生成 `xxx-2.jar` 这类错误文件名。
 *
 * # 为什么不 import `src/types`
 *
 * 与 `dependencyInstallPlan.ts` 同理：引入 `src/types` 会把整个类型模块拉进编译程序，
 * tsc 推断出的 rootDir 由 `src/lib` 上移成 `src`，产物落成 `lib/xxx.js`，与回归脚本
 * 约定的平铺产物不一致。结构化类型让调用方照常传真实类型，无需断言。
 */

/** 规划器只依赖根资源的这几个字段。 */
export interface FavoriteRootLike {
  /** 平台（modrinth / curseforge） */
  source: string
  /** 平台内项目 id */
  id: string
  /** 展示名 */
  title: string
  /** 收藏时记录的分类（只有 `mod` 参与安装） */
  category: string
}

/** 已解析出的可下载版本；`null` 表示没有兼容版本。 */
export interface FavoriteVersionLike {
  /** 上游原始文件名 —— ⚠️ 与本地落盘名不同域，不可用于文件比较 */
  fileName: string
  /** 上游下载 URL；空串表示无可下载文件 */
  url: string
  /** 展示用版本号 */
  versionName?: string
}

/** 依赖条目（后端 `/resources/{id}/dependencies` 的解析结果）。 */
export interface FavoriteDepLike {
  /** 远程项目 id，已安装判定用它 */
  projectId: string
  /** 依赖所属平台 */
  source: string
  downloadUrl: string
  fileName: string
  category: string
  name: string
}

/** 一个根资源的解析结果。 */
export interface FavoriteRootResolution {
  root: FavoriteRootLike
  /** 选中的版本；`null` = 没有兼容版本 */
  version: FavoriteVersionLike | null
  /** 该版本的依赖闭包（解析失败时传空数组） */
  deps: readonly FavoriteDepLike[]
}

/** 需要下载的文件（对应批任务的下载项）。 */
export interface FavoriteInstallItem {
  url: string
  /** 上游原名，落盘前由批任务按命名模板重写 */
  fileName: string
  category: string
  name: string
  /** 来源，用于按来源区分身份 */
  source: string
  /** 远程项目 id */
  projectId: string
  /** 是否为收藏夹根资源（false = 依赖） */
  isRoot: boolean
}

/** 跳过原因。 */
export type FavoriteSkipReason =
  /** 实例里已安装（按远程身份），不重下不替换 */
  | 'installed'
  /** 没有兼容当前实例的版本 */
  | 'noCompatibleVersion'
  /** 版本存在但没有下载 URL */
  | 'missingUrl'
  /** 来源不在支持范围（仅 modrinth / curseforge） */
  | 'unsupportedSource'
  /** 收藏条目不是 mod */
  | 'notMod'
  /** 同一来源下重复（根资源优先，共享依赖保留首次出现） */
  | 'duplicate'

/** 被跳过的条目。 */
export interface FavoriteInstallSkip {
  source: string
  /** 远程项目 id；非 mod / 不支持的来源可能没有可靠 id */
  projectId: string
  title: string
  reason: FavoriteSkipReason
}

export interface FavoriteFolderInstallPlan {
  /** 本次要下载的文件（根资源在前，依赖在后） */
  downloads: FavoriteInstallItem[]
  /** 跳过的条目及原因 —— 必须在 UI 上展示，避免静默缺失 */
  skipped: FavoriteInstallSkip[]
  /**
   * 恒为空。
   *
   * 保留这个字段是为了把「已安装的条目不得进入删除名单」写成**可断言的契约**
   * （见 `scripts/test-favorite-folder-install-plan.mjs`）。批量安装只做新增，
   * 绝不清除用户已有文件。
   */
  deletions: { fileName: string; category: string }[]
}

/** 支持批量安装的来源。 */
const SUPPORTED_SOURCES = new Set(['modrinth', 'curseforge'])

/** 远程身份键（`source:id`，来源小写）。 */
export function favoriteInstallKey(source: string, projectId: string): string {
  return `${source.toLowerCase()}:${projectId}`
}

/**
 * 生成收藏夹批量安装计划。
 *
 * @param resolutions 每个收藏成员的解析结果（未解析到的传 `version: null`）
 * @param installedKeys 实例已安装的远程身份键（`favoriteInstallKey` 构造）
 */
export function planFavoriteFolderInstall(
  resolutions: readonly FavoriteRootResolution[],
  installedKeys: ReadonlySet<string>,
): FavoriteFolderInstallPlan {
  const downloads: FavoriteInstallItem[] = []
  const skipped: FavoriteInstallSkip[] = []
  /** 已决定「下载」或「跳过」的身份，用于去重（根资源优先，故先跑根）。 */
  const claimed = new Set<string>()
  /** 根资源被采纳的来源:id —— 只有它们才带依赖进来。 */
  const acceptedRoots = new Set<string>()

  const skip = (source: string, projectId: string, title: string, reason: FavoriteSkipReason) => {
    skipped.push({ source, projectId, title, reason })
  }

  // ── 第一遍：根资源 ──────────────────────────────────────────────
  // 先跑根资源再跑依赖，保证「既是成员又是依赖」的项目按根资源处理。
  for (const { root, version } of resolutions) {
    if (root.category !== 'mod') {
      skip(root.source, root.id, root.title, 'notMod')
      continue
    }
    if (!SUPPORTED_SOURCES.has(root.source.toLowerCase())) {
      skip(root.source, root.id, root.title, 'unsupportedSource')
      continue
    }

    const key = favoriteInstallKey(root.source, root.id)
    // 同一来源 id 出现在多条解析结果时去重（收藏本身按 source|id|category 唯一，
    // 这里是防御性的：调用方传入重复条目也不会重复下载）。
    if (claimed.has(key)) {
      skip(root.source, root.id, root.title, 'duplicate')
      continue
    }
    // 已安装：不重下、不替换、不删除（ADR-112）。
    if (installedKeys.has(key)) {
      claimed.add(key)
      skip(root.source, root.id, root.title, 'installed')
      continue
    }
    if (!version) {
      claimed.add(key)
      skip(root.source, root.id, root.title, 'noCompatibleVersion')
      continue
    }
    if (!version.url) {
      claimed.add(key)
      skip(root.source, root.id, root.title, 'missingUrl')
      continue
    }

    claimed.add(key)
    acceptedRoots.add(key)
    downloads.push({
      url: version.url,
      fileName: version.fileName,
      category: 'mod',
      name: root.title,
      source: root.source,
      projectId: root.id,
      isRoot: true,
    })
  }

  // ── 第二遍：依赖 ────────────────────────────────────────────────
  for (const { root, deps } of resolutions) {
    // 根资源自身没被采纳（非 mod / 不支持来源 / 无版本 / 已安装）时，它的依赖也不带进来：
    // 用户要装的是这个 mod，mod 都装不了就没有理由装它的前置。
    if (!acceptedRoots.has(favoriteInstallKey(root.source, root.id))) continue

    for (const dep of deps) {
      if (!SUPPORTED_SOURCES.has(dep.source.toLowerCase())) {
        skip(dep.source, dep.projectId, dep.name, 'unsupportedSource')
        continue
      }
      const key = favoriteInstallKey(dep.source, dep.projectId)
      // 共享依赖只下一次（保留第一次出现的版本），根资源优先。
      if (claimed.has(key)) {
        skip(dep.source, dep.projectId, dep.name, 'duplicate')
        continue
      }
      if (installedKeys.has(key)) {
        claimed.add(key)
        skip(dep.source, dep.projectId, dep.name, 'installed')
        continue
      }
      if (!dep.downloadUrl) {
        claimed.add(key)
        skip(dep.source, dep.projectId, dep.name, 'missingUrl')
        continue
      }

      claimed.add(key)
      downloads.push({
        url: dep.downloadUrl,
        fileName: dep.fileName,
        category: dep.category || 'mod',
        name: dep.name,
        source: dep.source,
        projectId: dep.projectId,
        isRoot: false,
      })
    }
  }

  return { downloads, skipped, deletions: [] }
}

/** 从跳过列表里统计某类原因的数量（UI 分组展示用）。 */
export function countSkipped(plan: FavoriteFolderInstallPlan, reason: FavoriteSkipReason): number {
  return plan.skipped.filter((s) => s.reason === reason).length
}
