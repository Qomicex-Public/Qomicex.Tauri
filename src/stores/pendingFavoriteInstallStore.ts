// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 新建实例时「同时安装收藏夹」的待执行队列（issue #223）。
 *
 * 实例安装由后端在 `tokio::spawn` 里异步执行，向导提交后会跳转到下载中心。收藏夹的
 * mod 只能在实例真正装好（`getInstallProgress` 返回 `completed`）之后再装 —— 否则游戏
 * 目录还不存在，mod 会落到错误位置或与安装器并发写同一批文件。
 *
 * 队列以 **instanceId 为键**持久化到 localStorage，这样页面跳转、组件卸载、甚至刷新
 * 之后条目都还在，由 `resumePending` 重新接管。
 *
 * 持久化方式与 `downloadStore.ts` 一致（手写 localStorage，不引入 zustand persist），
 * 保持仓库内 store 的实现风格统一。
 */

/** 成员快照：只存安装需要的字段，避免收藏夹后续被改/删影响已排队任务。 */
export interface PendingFavoriteMember {
  source: string
  id: string
  title: string
  category: string
}

export interface PendingFavoriteInstall {
  /** 实例 id（同时也是队列键） */
  instanceId: string
  /** 收藏夹 id */
  folderId: string
  /** 收藏夹名（批任务标题用） */
  folderName: string
  /** 成员快照 */
  members: PendingFavoriteMember[]
  /** 入队时间（ISO） */
  createdAt: string
}

const STORAGE_KEY = 'qomicex-pending-favorite-installs'

type Listener = () => void

let entries: PendingFavoriteInstall[] = []
let listeners: Listener[] = []

function loadEntries(): PendingFavoriteInstall[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as PendingFavoriteInstall[]).filter(
      (e) => e && typeof e.instanceId === 'string' && Array.isArray(e.members),
    )
  } catch {
    return []
  }
}

function saveEntries() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // 配额满 / 隐私模式：队列只是「尽力而为」的恢复能力，写不进去不影响本次安装。
  }
}

function emitChange() {
  listeners.forEach((fn) => fn())
}

/** 全部待执行条目（按入队时间升序）。 */
export function getPendingFavoriteInstalls(): PendingFavoriteInstall[] {
  return [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** 登记一条待执行条目；同实例已有条目时覆盖（以最新一次选择为准）。 */
export function scheduleFavoriteInstall(entry: PendingFavoriteInstall): void {
  entries = [entry, ...entries.filter((e) => e.instanceId !== entry.instanceId)]
  saveEntries()
  emitChange()
}

/**
 * 认领一条条目：**先从队列删除，再返回**。
 *
 * 这是「只执行一次」的关键：轮询循环与 `resumePending` 可能同时命中同一条目，
 * 谁先把删除做完谁才拿到执行权，另一个拿不到就跳过。
 */
export function claimFavoriteInstall(instanceId: string): PendingFavoriteInstall | null {
  const found = entries.find((e) => e.instanceId === instanceId) ?? null
  if (!found) return null
  entries = entries.filter((e) => e.instanceId !== instanceId)
  saveEntries()
  emitChange()
  return found
}

/** 放弃一条条目（安装失败/取消/超时重试耗尽）。 */
export function dropFavoriteInstall(instanceId: string): void {
  const before = entries.length
  entries = entries.filter((e) => e.instanceId !== instanceId)
  if (entries.length !== before) {
    saveEntries()
    emitChange()
  }
}

/** 该实例是否已有排队条目（向导据此避免重复登记）。 */
export function hasPendingFavoriteInstall(instanceId: string): boolean {
  return entries.some((e) => e.instanceId === instanceId)
}

export function subscribePendingFavoriteInstalls(fn: Listener): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

entries = loadEntries()
