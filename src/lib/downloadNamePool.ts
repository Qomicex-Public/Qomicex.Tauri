// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 下载落盘名的**跨批次**冲突预留（issue #223 评审）。
 *
 * # 为什么需要共享池
 *
 * 每个批次若各自用「实例已安装文件名」的快照去重，同一实例上并发两个批次时，
 * 彼此看不到对方**在途**的下载，可能给不同资源分配同一个目标名 —— 后下的覆盖先下的，
 * 两个批次都显示完成，实例里却少一个 mod。
 *
 * # 为什么池里存小写键
 *
 * 冲突判定必须大小写不敏感：Windows / macOS 默认文件系统不区分大小写，实例里已有
 * `Foo.jar` 时 `foo.jar` 实际会写到同一个路径。多个批次共享同一个池，比较口径必须
 * 落在池里，而不是各批次各自快照一份 —— 快照会让后预留的名字对先建快照的批次不可见。
 *
 * # 为什么按实例引用计数
 *
 * 并发批次共享同一个池，先结束的批次不能直接删池：仍在跑的批次虽然握着 Set 引用，
 * 但新批次会建出一个**空的新池**，看不到前者已预留的名字，冲突重新出现。
 *
 * # 为什么模板渲染由调用方注入
 *
 * 本模块刻意零 import，以便被 `scripts/test-download-name-pool.mjs` 按仓库既有约定
 * 单文件编译断言（同 ADR-112 抽 `planDependencyInstall` 的理由：藏在下载批次内部时
 * 只能靠人读，回归无声）。
 */

/** 模板渲染函数：把模板与占位符变量合成为文件名主体。 */
export type NameFormatter = (
  template: string,
  vars: { name: string; version: string; cnName: string | null },
) => string

/** 每个实例的命名池。 */
interface NamePool {
  /** 已占用的归一化（小写）文件名 */
  names: Set<string>
  /** 持有该池的批次数量：归零才真正释放。 */
  refs: number
}

const pools = new Map<string, NamePool>()

/**
 * 取得该实例的命名池并登记一个持有者。
 *
 * 每次调用都必须有对应的 `releaseNamePool`，否则引用计数永不归零、池泄漏。
 */
export function acquireNamePool(instanceId: string, seed: Iterable<string> = []): Set<string> {
  let entry = pools.get(instanceId)
  if (!entry) {
    entry = { names: new Set<string>(), refs: 0 }
    pools.set(instanceId, entry)
  }
  entry.refs += 1
  for (const n of seed) entry.names.add(n.toLowerCase())
  return entry.names
}

/** 释放一次持有；计数归零才删除该实例的池。 */
export function releaseNamePool(instanceId: string): void {
  const entry = pools.get(instanceId)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) pools.delete(instanceId)
}

/** 当前该实例的池是否还存在（测试与排障用）。 */
export function hasNamePool(instanceId: string): boolean {
  return pools.has(instanceId)
}

/** 当前该实例池的持有者数量（测试与排障用）。 */
export function namePoolRefCount(instanceId: string): number {
  return pools.get(instanceId)?.refs ?? 0
}

/** 待命名的下载项：只需要生成落盘名所需的字段。 */
export interface NamingItem {
  fileName: string
  name: string
  cnName?: string | null
}

/**
 * 按命名模板生成本地落盘名，并在共享池里预留。
 *
 * 冲突判定直接读写池（小写键），不做快照 —— 见模块头注释。
 * 返回的 `fileName` 仍是生成时的拼写：只有比较口径归一，用户看到的名称不变。
 *
 * @param format 模板渲染函数（生产用 `formatDownloadFileName`，测试可注入简单实现）
 */
export function makeNaming<T extends NamingItem>(
  template: string,
  pool: Set<string>,
  format: NameFormatter,
): (item: T) => T {
  const reserve = (candidate: string): boolean => {
    const key = candidate.toLowerCase()
    if (pool.has(key)) return false
    pool.add(key)
    return true
  }

  return (item: T): T => {
    const extMatch = item.fileName.match(/\.(jar|zip|mrpack|qmodpack|shaderpacks|mcpack)$/i)
    const ext = extMatch ? extMatch[0] : ''
    const version = item.fileName
      .replace(/\.(jar|zip|mrpack|qmodpack|shaderpacks|mcpack)$/i, '')
      .replace(/^.*-(\d[\w.+]*)$/, '$1')
    const renamed = format(template, {
      name: item.name.replace(/\.(jar|zip|mrpack|qmodpack|mcpack|shaderpacks)$/i, ''),
      version,
      cnName: item.cnName ?? null,
    })
    const desired = `${renamed}${ext}`
    if (reserve(desired)) {
      return { ...item, fileName: desired }
    }
    // 与 dedupFileName 同形（追加 (i)），但走大小写不敏感的比较口径。
    const dot = desired.lastIndexOf('.')
    const base = dot > 0 ? desired.slice(0, dot) : desired
    const suffix = dot > 0 ? desired.slice(dot) : ''
    for (let i = 1; i < 100; i++) {
      const candidate = `${base}(${i})${suffix}`
      if (reserve(candidate)) {
        return { ...item, fileName: candidate }
      }
    }
    return { ...item, fileName: desired }
  }
}
