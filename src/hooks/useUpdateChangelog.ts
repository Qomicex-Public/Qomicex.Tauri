// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { fetchUpdateChangelog, type UpdateChangelog } from '../api/update.ts'
import { logWarn } from '../lib/frontendLog.ts'

const EMPTY: UpdateChangelog = { spanning: false, entries: [], total: 0, truncated: false }

/**
 * 拉取跨版本更新内容。
 *
 * 设计要点：
 * - **不阻塞主流程**：调用方照常用 `plan.changelog` 立即渲染，本 hook 拉到
 *   数据后再切换成跨版本视图。上游慢或未部署时用户完全无感。
 * - **失败即空**：后端已把上游故障收敛成「空 entries」，这里再兜一层异常，
 *   保证 `entries` 永远是可渲染的数组。
 * - `enabled=false`（弹窗没打开）时不发请求。
 */
export function useUpdateChangelog(params: {
  enabled: boolean
  current: string
  target?: string
  channel?: string
}): UpdateChangelog {
  const { enabled, current, target, channel } = params
  const [state, setState] = useState<UpdateChangelog>(EMPTY)

  useEffect(() => {
    if (!enabled || !current) {
      // 关掉弹窗后清空，避免下次打开先闪一眼上次的旧版本列表。
      setState(EMPTY)
      return
    }
    // 参数一变就先清空：否则新旧请求之间会有一段「用旧版本的条目渲染新目标」
    // 的窗口，用户看到的版本号与内容对不上。`stale` 只拦住写入时机，拦不住
    // 这段已渲染的陈旧内容。
    setState(EMPTY)

    let stale = false
    void (async () => {
      try {
        const res = await fetchUpdateChangelog({ current, target, channel })
        if (!stale) setState(res)
      } catch (e) {
        logWarn('updateChangelog.fetch', e)
        if (!stale) setState(EMPTY)
      }
    })()
    return () => {
      stale = true
    }
  }, [enabled, current, target, channel])

  return state
}
