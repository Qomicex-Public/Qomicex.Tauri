// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 监听器批量安装与回滚。
 *
 * l4 桥初始化要等一组 Tauri 监听器全部就绪才算完成（否则插件前端抢先发出的
 * register/call 会被丢弃），但「部分失败」的回滚容易漏：
 *
 * - 不解绑已成功的监听器 → 下次重试重复注册 → 同一个 `plugin-l4-api-call` 被处理
 *   两次，写文件/发请求这类非幂等操作会产生重复副作用；
 * - 失败后仍认为桥可用 → 事件永远收不到，调用只能等超时。
 *
 * 本模块只描述这套「全成功才生效，否则全部回滚」的语义，不依赖 Tauri，因此可以
 * 脱离运行时验证。
 */

/** 注册一个监听器，返回解绑函数。 */
export type ListenerRegistrar = (event: string, handler: (payload: unknown) => void) => Promise<() => void>

export interface InstalledListeners {
  /** 是否全部安装成功。false 时 listeners 为空且已回滚。 */
  ok: boolean
  /** 全部成功时的解绑函数集合；调用方在桥销毁时执行。 */
  unlisten: () => void
  /** 失败原因（仅 ok=false 时有值）。 */
  error?: unknown
}

/**
 * 安装全部监听器：任一失败则解绑已成功的，返回 ok=false。
 *
 * 关键点是失败路径**必须**回滚：调用方失败后通常会重置初始化状态以便重试，
 * 若此时旧监听器仍挂着，重试会叠加出两套。
 */
export async function installListeners(
  registrar: ListenerRegistrar,
  subscriptions: Array<{ event: string; handler: (payload: unknown) => void }>,
): Promise<InstalledListeners> {
  const disposers: Array<() => void> = []
  const settled = await Promise.allSettled(
    subscriptions.map((s) => registrar(s.event, s.handler)),
  )

  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected) {
    // 回滚：只解绑已成功的，失败项本身没有监听器
    for (const r of settled) {
      if (r.status === 'fulfilled' && typeof r.value === 'function') {
        try { r.value() } catch { /* 已失效 */ }
      }
    }
    return { ok: false, unlisten: () => {}, error: rejected.reason }
  }

  for (const r of settled) {
    if (r.status === 'fulfilled') disposers.push(r.value)
  }
  return {
    ok: true,
    unlisten: () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已失效 */ }
      }
    },
  }
}
