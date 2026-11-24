// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export interface ListRectInput {
  key: string
  top: number
  left: number
}

export interface ListMove {
  key: string
  dx: number
  dy: number
}

export interface ListDiff {
  /** 本次新增的 key（按 next 顺序） */
  enter: string[]
  /** 本次消失的 key（按 prev 顺序） */
  exit: string[]
  /** 位置发生变化、需要 FLIP 的 key */
  move: ListMove[]
  /** 新旧 key 交集过小，判定为整组替换（不逐项播动画） */
  replace: boolean
}

/**
 * 列表差分：纯函数，便于单测锁回归（对应 useAnimatedList 的判定）。
 *
 * - 位置比较用视口坐标，阈值 0.5px 过滤亚像素抖动
 * - 交集占较大集合的比例低于 replaceRatio 时判为整组替换：
 *   分组/分类切换会产生几十条 exit + 几十条 enter，逐项播会明显掉帧
 */
export function computeListDiff(
  prev: ListRectInput[],
  next: ListRectInput[],
  options?: { moveThreshold?: number; replaceRatio?: number },
): ListDiff {
  const moveThreshold = options?.moveThreshold ?? 0.5
  const replaceRatio = options?.replaceRatio ?? 0.35

  const prevMap = new Map(prev.map((item) => [item.key, item] as const))
  const nextKeys = new Set(next.map((item) => item.key))

  const enter = next.filter((item) => !prevMap.has(item.key)).map((item) => item.key)
  const exit = prev.filter((item) => !nextKeys.has(item.key)).map((item) => item.key)

  const move: ListMove[] = []
  let shared = 0
  for (const item of next) {
    const before = prevMap.get(item.key)
    if (!before) continue
    shared += 1
    const dx = before.left - item.left
    const dy = before.top - item.top
    if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) {
      move.push({ key: item.key, dx, dy })
    }
  }

  const replace =
    prev.length > 0 &&
    next.length > 0 &&
    enter.length > 0 &&
    exit.length > 0 &&
    shared / Math.max(prev.length, next.length) < replaceRatio

  return { enter, exit, move, replace }
}
