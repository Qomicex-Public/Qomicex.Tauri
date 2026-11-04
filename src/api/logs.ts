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
 * 高频日志下打出成百上千个请求。这里按 300ms 窗口聚合、每批最多 20 条、按级别
 * 分组，失败静默（不阻塞主流程，也不重试导致雪崩）。
 */
const FRONTEND_LOG_BATCH = 20
const FRONTEND_LOG_MAX_LINE = 4000
const FRONTEND_LOG_MAX_QUEUE = 500
const frontendLogQueue: Array<{ level: string; message: string }> = []
let frontendLogTimer: ReturnType<typeof setTimeout> | null = null
let frontendLogFlushing = false

function scheduleFrontendLogFlush(): void {
  if (frontendLogTimer !== null) return
  frontendLogTimer = setTimeout(() => {
    frontendLogTimer = null
    void flushFrontendLogs()
  }, 300)
}

async function flushFrontendLogs(): Promise<void> {
  if (frontendLogFlushing || frontendLogQueue.length === 0) return
  frontendLogFlushing = true
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
  await Promise.all(
    [...groups.entries()].map(([level, lines]) =>
      fetch(`${API_BASE}/logs/frontend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message: lines.join('\n') }),
        keepalive: true,
      }).catch(() => {}),
    ),
  )
  frontendLogFlushing = false
  if (frontendLogQueue.length > 0) scheduleFrontendLogFlush()
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
