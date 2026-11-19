// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { DownloadTask } from '../types/index.ts'

const STORAGE_KEY = 'qomicex-download-tasks'

type Listener = () => void

let tasks: DownloadTask[] = []
let listeners: Listener[] = []

/// Debounce timer for high-frequency progress updates.
/// Progress ticks arrive every ~300ms from SSE; persisting to localStorage
/// on every tick blocks the main thread with synchronous JSON.stringify +
/// setItem. Debounce to 500ms so rapid progress updates collapse into one
/// write, while add / remove / clear stay immediate.
let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 500

/** 安装管线卡片（SSE 自动补卡一律记为 'modpack'，本地游戏安装卡是 'game'）。 */
function isInstallCard(task: DownloadTask): boolean {
  return task.type === 'game' || task.type === 'modpack' || task.type === 'modpack-update'
}

/** 同一张卡片的判据：id 相同，或安装类卡片落在同一实例上。 */
function isSameCard(a: DownloadTask, b: DownloadTask): boolean {
  if (a.id === b.id) return true
  return !!a.instanceId && a.instanceId === b.instanceId && isInstallCard(a) && isInstallCard(b)
}

function loadTasks(): DownloadTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // retryPending 是「本次进程内的重试进行中」标记：启动时一律清掉。
    // 否则上次退出时正在重建的卡片会永久跳过 SSE 对账、停在排队态。
    const restored = (parsed as DownloadTask[]).map((t) => ({ ...t, retryPending: false }))
    // 旧版本可能已持久化了同一实例的多张卡片：加载时去重，保留信息最全的一张
    // （有 retry 描述符的优先），否则重复卡片会在整个会话里一直显示。
    const deduped: DownloadTask[] = []
    for (const t of restored) {
      const i = deduped.findIndex((o) => isSameCard(o, t))
      if (i < 0) deduped.push(t)
      else if (t.retry && !deduped[i].retry) deduped[i] = t
    }
    return deduped
  } catch {
    return []
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
}

function emitChange() {
  listeners.forEach((fn) => fn())
}

export function getTasks(): DownloadTask[] {
  return tasks
}

/** 自动补卡的显示名回退（后端没给 title 时就是 instanceId），合并时不能盖掉用户起的名字。 */
function isFallbackName(task: DownloadTask): boolean {
  return !!task.instanceId && task.name === task.instanceId
}

/**
 * 同一实例只允许一张卡片（issue #366）。
 *
 * 两条建卡路径会撞上：SSE 对「本地没有卡片的后端任务」自动补卡，而发起安装的
 * 对话框/重试流程也会建卡。旧实现无条件前插，于是同一 instanceId 出现多张
 * 不同名、同进度的卡片；自动补的那张没有 retry 描述符，失败后没有重试按钮。
 * 这里按 id / instanceId 合并，并保住重试描述符与用户命名的卡片名。
 */
export function addTask(task: DownloadTask) {
  const index = tasks.findIndex(
    (t) =>
      t.id === task.id ||
      (!!task.instanceId && t.instanceId === task.instanceId && isInstallCard(t) && isInstallCard(task)),
  )
  if (index < 0) {
    tasks = [task, ...tasks]
  } else {
    const prev = tasks[index]
    const merged: DownloadTask = { ...prev, ...task }
    // retry 描述符按卡片语义取：整合包**更新**没有描述符，必须清掉安装卡的旧
    // 描述符，否则更新失败后点重试会按旧描述符重新安装旧版本。
    merged.retry = task.type === 'modpack-update' ? task.retry : (task.retry ?? prev.retry)
    if (isFallbackName(task) && prev.name && !isFallbackName(prev)) {
      // SSE 自动补卡：名字回退为 instanceId、类型一律记 'modpack'。这两项都只是
      // 渲染兜底，不能覆盖本地卡片（游戏安装是 'game'，名字由用户起）。
      merged.name = prev.name
      merged.type = prev.type
    }
    tasks = tasks.map((t, i) => (i === index ? merged : t))
  }
  saveTasks()
  emitChange()
}

export function updateTask(id: string, updates: Partial<DownloadTask>) {
  // 重试会把卡片挂到新建的实例上：若 SSE 已给那个实例自动补过卡，这里必须收编，
  // 否则同一实例两张卡（自动卡没有 retry，表现为「重试过一次就没有重试按钮」）。
  // 只收编安装类卡片：batch/file 卡与本实例共存是合法的，不能一并删掉。
  if (updates.instanceId) {
    const instanceId = updates.instanceId
    tasks = tasks.filter((t) => t.id === id || t.instanceId !== instanceId || !isInstallCard(t))
  }
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...updates } : t))
  // Debounce persistence: progress updates are high-frequency (~3/s from SSE),
  // but structural mutations (add/remove/clear) should persist immediately.
  // `retry` 决定重启后能否重试，必须立即落盘；进度更新仍走防抖。
  if (saveTimer) clearTimeout(saveTimer)
  if ('retry' in updates) saveTasks()
  else saveTimer = setTimeout(saveTasks, SAVE_DEBOUNCE_MS)
  emitChange()
}

export function removeTask(id: string) {
  tasks = tasks.filter((t) => t.id !== id)
  saveTasks()
  emitChange()
}

export function clearAllTasks() {
  tasks = []
  saveTasks()
  emitChange()
}

export function clearCompleted() {
  tasks = tasks.filter((t) => t.status !== 'completed')
  saveTasks()
  emitChange()
}

export function subscribe(fn: Listener) {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

tasks = loadTasks()
