import type { DownloadTask } from '../types/index.ts'

const STORAGE_KEY = 'qomicex-download-tasks'

type Listener = () => void

let tasks: DownloadTask[] = []
let listeners: Listener[] = []

function loadTasks(): DownloadTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
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
  saveTasks()
  emitChange()
}

export function removeTask(id: string) {
  tasks = tasks.filter((t) => t.id !== id)
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
