// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { get, del, post, API_BASE } from './client.ts'

export interface LogEntry {
  path: string
  name: string
  size: number
  lastModified: string
  isCurrentSession: boolean
}

export function listLogs(): Promise<LogEntry[]> {
  return get<LogEntry[]>('/logs')
}

export function getExportUrl(path: string): string {
  return `${API_BASE}/logs/export?path=${btoa(path)}`
}

export function exportLogTo(path: string, dest: string): Promise<{ path: string }> {
  return post('/logs/export-to', { path, dest })
}

export function exportAllLogsTo(dest: string): Promise<{ path: string }> {
  return post('/logs/export-all-to', { dest })
}

export function getExportAllUrl(): string {
  return `${API_BASE}/logs/export-all`
}

export function deleteLog(path: string): Promise<void> {
  return del(`/logs?path=${encodeURIComponent(path)}`)
}

export function openLog(path: string): Promise<void> {
  return post('/logs/open', { path })
}

export function openLogDir(path: string): Promise<void> {
  return post('/logs/open-dir', { path })
}

export interface LogContent {
  path: string
  content: string
  truncated: boolean
}

/** 读取日志文件内容（前端查看器用；超大文件返回尾部 2MB）。 */
export function getLogContent(path: string): Promise<LogContent> {
  return get<LogContent>(`/logs/content?path=${encodeURIComponent(path)}`)
}

/**
 * 上报前端 console 日志到后端（构建版无控制台时仍可查看）。
 *
 * 批量 + 节流：console 拦截器会把所有 log/warn/error 都送进来，逐条 fetch 会在
 * 高频日志下打出成百上千个请求。这里按 300ms 窗口聚合、每批最多 10 条 / 2KB，
 * 按级别分组；失败保留批次最多重试 3 次，避免启动早期后端未就绪时丢日志。
 */
const FRONTEND_LOG_BATCH = 10
const FRONTEND_LOG_MAX_LINE = 2000
const FRONTEND_LOG_MAX_QUEUE = 500
const FRONTEND_LOG_TIMEOUT_MS = 5000
const FRONTEND_LOG_MAX_RETRY = 5
const frontendLogQueue: Array<{ level: string; message: string }> = []
let frontendLogTimer: ReturnType<typeof setTimeout> | null = null
let frontendLogFlushing = false
let frontendLogRetry = 0

function scheduleFrontendLogFlush(delayMs = 300): void {
  if (frontendLogTimer !== null) return
  frontendLogTimer = setTimeout(() => {
    frontendLogTimer = null
    void flushFrontendLogs()
  }, delayMs)
}

async function flushFrontendLogs(): Promise<void> {
  if (frontendLogFlushing || frontendLogQueue.length === 0) return
  frontendLogFlushing = true
  // 10 条 × 2KB < 后端 64KiB/200 行上限，也低于浏览器 keepalive 配额。
  const batch = frontendLogQueue.splice(0, FRONTEND_LOG_BATCH)
  const groups = new Map<string, string[]>()
  for (const item of batch) {
    const level =
      item.level === 'error' || item.level === 'warn' || item.level === 'info' || item.level === 'debug'
        ? item.level
        : 'log'
    const lines = groups.get(level) ?? []
    lines.push(item.message)
    groups.set(level, lines)
  }
  let ok = true
  try {
    await Promise.all(
      [...groups.entries()].map(([level, lines]) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FRONTEND_LOG_TIMEOUT_MS)
        return fetch(`${API_BASE}/logs/frontend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level, message: lines.join('\n') }),
          keepalive: true,
          signal: controller.signal,
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
          })
          .catch(() => {
            ok = false
          })
          .finally(() => clearTimeout(timer))
      }),
    )
  } finally {
    frontendLogFlushing = false
    if (!ok) {
      // 启动早期 IPC 传输尚未就绪、后端未起时保留批次，最多重试 3 次。
      frontendLogRetry += 1
      if (frontendLogRetry <= FRONTEND_LOG_MAX_RETRY) {
        frontendLogQueue.unshift(...batch)
      }
    } else {
      frontendLogRetry = 0
    }
    if (frontendLogQueue.length > 0) {
      scheduleFrontendLogFlush(ok ? 300 : 1000 * Math.max(1, frontendLogRetry))
    }
  }
}

/** 页面关闭/隐藏前立即冲刷，避免 300ms 窗口内的最后几条日志丢失。 */
export function flushFrontendLogsNow(): void {
  if (frontendLogTimer !== null) {
    clearTimeout(frontendLogTimer)
    frontendLogTimer = null
  }
  void flushFrontendLogs()
}

export function reportFrontendLog(level: string, message: string): void {
  try {
    frontendLogQueue.push({
      level,
      message: message.length > FRONTEND_LOG_MAX_LINE
        ? `${message.slice(0, FRONTEND_LOG_MAX_LINE)}…[truncated]`
        : message,
    })
    if (frontendLogQueue.length > FRONTEND_LOG_MAX_QUEUE) {
      frontendLogQueue.splice(0, frontendLogQueue.length - FRONTEND_LOG_MAX_QUEUE)
    }
    scheduleFrontendLogFlush()
  } catch {
    /* 忽略 */
  }
}

export interface ClientLogEntry {
  level: 'error' | 'warn' | 'info'
  message: string
  stack?: string
}

export interface ClientLogsResponse {
  success: boolean
  skipped?: boolean
}

/**
 * 上报严重错误日志到后端（后端补全 deviceInfo 后转发上游 api.qomicex.top）。
 * 仅"恶性 bug"白名单使用（ErrorBoundary 渲染崩溃 / 后端 panic），一般业务错误不调用。
 * 失败静默（不阻塞主流程）。
 */
export function uploadClientLogs(logs: ClientLogEntry[]): Promise<ClientLogsResponse> {
  return post<ClientLogsResponse>('/client/logs', { logs })
}
