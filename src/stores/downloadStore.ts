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

function loadTasks(): DownloadTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // retryPending 是「本次进程内的重试进行中」标记：启动时一律清掉。
    // 否则上次退出时正在重建的卡片会永久跳过 SSE 对账、停在排队态。
    return (parsed as DownloadTask[]).map((t) => ({ ...t, retryPending: false }))
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

export function addTask(task: DownloadTask) {
  tasks = [task, ...tasks]
  saveTasks()
  emitChange()
}

export function updateTask(id: string, updates: Partial<DownloadTask>) {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...updates } : t))
  // Debounce persistence: progress updates are high-frequency (~3/s from SSE),
  // but structural mutations (add/remove/clear) should persist immediately.
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveTasks, SAVE_DEBOUNCE_MS)
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
