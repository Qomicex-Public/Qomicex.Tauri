// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 模组快捷安装的**前置安装计划**（issue #249）。
 *
 * 把依赖列表分成「要下载的」与「要清理的旧文件」两拨。抽成纯函数是为了让
 * 「已安装的前置不会被删」这条契约可以被回归测试直接断言——它此前藏在
 * `ResourceInstallDialog` 的 useCallback 里，只能靠人读，回归无声。
 *
 * # 为什么会出 issue #249
 *
 * 已安装的判定用 `projectId`（远程身份），而「是否要替换」曾拿
 * `existing.fileName !== dep.fileName` 比较：
 * - `existing.fileName` 是**本地重命名后**的文件名（命名模板 `[{cn}]{name}-{version}`，ENH-10），
 *   如 `[Fabric-API]Fabric-API-0.162.0+26.3.jar`；
 * - `dep.fileName` 是**上游原名**（后端取上游 `filename`），如 `fabric-api-0.162.0+26.3.jar`。
 *
 * 两个命名域不同，字符串必然不等 → 每个已安装的前置都被塞进删除名单；同时下载
 * 分支被 `continue` 跳过。等到 `quickInstall` 的 aggregate 跑完全部下载成功，删除
 * 才真正执行 —— 于是「已存在的前置被删掉，且没有任何新前置被下载」。
 *
 * # 现在的口径
 *
 * **已安装的前置：既不重下、也不删除。**
 * - 不重下：与 ADR-101「已装即满足依赖、不校验版本区间」一致；本对话框的 UI 也
 *   只对**未安装**的依赖展示版本选择器，用户无从指定要替换成哪个版本。
 * - 不删除：本地名与上游名分属两个命名域，不能用来判定「过期」。要判定过期只能
 *   比对远程版本 id（`modrinthVersionId` / `curseForgeFileId`），那是版本切换
 *   功能的事，不是安装前置该顺手做的破坏性动作。
 */
/**
 * 本模块只依赖依赖条目里这四个字段。刻意**不** `import type { ResolvedDependency }`：
 * 引入 `src/types` 会把整个类型模块拉进编译程序，tsc 推断出的 rootDir 由 `src/lib`
 * 上移成 `src`，产物落成 `lib/xxx.js`，与 `deepLink.ts` / `updateChannel.ts` 这类
 * 自包含模块的回归脚本约定（平铺产物）不一致。结构化类型让调用方照常传
 * `ResolvedDependency[]`，无需类型断言。
 */
export interface DependencyLike {
  /** 远程项目 id（平台内唯一），已安装判定用它 */
  projectId: string
  /** 上游原始下载 URL */
  downloadUrl: string
  /** 上游原始文件名 —— ⚠️ 与本地落盘名不同域，不可用于文件比较 */
  fileName: string
  /** 目标分类目录（mods / resourcepacks / shaderpacks ...） */
  category: string
  /** 展示名 */
  name: string
}

/** 需要下载的前置文件（对应 `quickInstallViaDownloadCenter` 的 `deps` 条目）。 */
export interface DepInstallItem {
  url: string
  fileName: string
  category: string
  name: string
}

/** 需要删除的旧文件（对应 `quickInstallViaDownloadCenter` 的 `toDelete` 条目）。 */
export interface DepInstallDeletion {
  fileName: string
  category: string
}

export interface DependencyInstallPlan {
  /** 本次要下载的前置 */
  downloads: DepInstallItem[]
  /**
   * 本次要清理的旧文件。
   *
   * 保留这个字段是为了把「已安装的前置不得进入删除名单」写成**可断言的契约**
   * （见 `scripts/test-dependency-install-plan.mjs`）。当前实现对依赖恒为空：
   * 计划里只会产生下载，绝不会因为「本地名与上游名不同」就去删用户的文件。
   */
  deletions: DepInstallDeletion[]
}

/**
 * 生成前置安装计划。
 *
 * @param deps 后端解析出的依赖闭包（`/resources/{id}/dependencies`）
 * @param installedByProjectId 已安装模组的 `projectId → {fileName, version}` 索引
 * @param selected 用户在依赖版本选择器里的覆盖（按 `projectId`）
 */
export function planDependencyInstall(
  deps: readonly DependencyLike[],
  installedByProjectId: ReadonlyMap<string, { fileName: string; version: string }>,
  selected: Readonly<Record<string, { downloadUrl: string; fileName: string } | undefined>> = {},
): DependencyInstallPlan {
  const downloads: DepInstallItem[] = []
  const deletions: DepInstallDeletion[] = []

  for (const dep of deps) {
    // 已安装（按远程 projectId 认定）→ 保留原件，既不重下也不删除。
    // 这里**不能**拿文件名判断"要不要换代"：本地名经过命名模板，与上游名不同域。
    if (installedByProjectId.has(dep.projectId)) continue

    const sel = selected[dep.projectId]
    const url = sel?.downloadUrl ?? dep.downloadUrl
    const fileName = sel?.fileName ?? dep.fileName
    // 没有可下载 URL 的依赖跳过（后端已尽力解析，缺 URL 时不伪造下载任务）。
    if (!url) continue

    downloads.push({
      url,
      fileName,
      category: dep.category,
      name: dep.name,
    })
  }

  return { downloads, deletions }
}
