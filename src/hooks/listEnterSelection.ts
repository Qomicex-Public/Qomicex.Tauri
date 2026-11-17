// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 选中「本次需要播入场动画」的列表项（useAnimatedList 的纯逻辑，便于单测锁回归）。
 *
 * 按 data-key 与上一批 diff：只返回本次新增的项，避免追加分页（资源中心划到底加载下一页）
 * 时从列表顶部重播整段动画、底部新项反而无动画（issue #355）。
 * 首屏/整页替换（prev 为空、无 diff 基线）时退化为前 max 个。
 * 无 data-key 的项不参与 diff（调用方契约要求子元素带 data-key）。
 */
export function selectEnterItems<T extends { dataset: { key?: string } }>(
  allChildren: T[],
  prevChildren: T[],
  max: number,
): T[] {
  if (prevChildren.length === 0) return allChildren.slice(0, max)
  const prevKeys = new Set(prevChildren.map((c) => c.dataset.key))
  return allChildren.filter((c) => !!c.dataset.key && !prevKeys.has(c.dataset.key)).slice(0, max)
}
