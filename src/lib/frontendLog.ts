// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 前端结构化日志辅助。
//
// 现有 console 拦截器（App.tsx）会把 console.* 转发到 /api/logs/frontend，
// 但直接 console.error(e) 只会带 stack，丢掉 ApiError 的 code/status/detail/
// traceId，也没有业务上下文。这里统一格式化后再走 console，保证：
//   - 每条错误都带「哪个操作 + 哪个对象 + 错误码/状态码/后端 traceId」；
//   - 全局未捕获异常在 App 挂载前也能上报（installGlobalErrorLogging）。

import { reportFrontendLog } from '../api/logs.ts'

interface ApiErrorLike {
  code: string
  status: number
  message: string
  detail?: string | null
  traceId?: string
}

function isApiErrorLike(value: unknown): value is ApiErrorLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.code === 'string' && typeof v.status === 'number' && typeof v.message === 'string'
}

/** 把任意错误转成可读字符串；ApiError 保留结构化字段。 */
export function formatError(error: unknown): string {
  if (isApiErrorLike(error)) {
    const parts = [`[${error.code}] ${error.message}`, `status=${error.status}`]
    if (error.detail) parts.push(`detail=${error.detail}`)
    if (error.traceId) parts.push(`traceId=${error.traceId}`)
    if (error instanceof Error && error.stack) parts.push(error.stack)
    return parts.join(' | ')
  }
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function buildLine(context: string, error: unknown, extra?: Record<string, unknown>): string {
  const parts = [`[${context}]`, formatError(error)]
  if (extra && Object.keys(extra).length > 0) {
    try {
      parts.push(JSON.stringify(extra))
    } catch {
      // 循环引用等序列化失败不影响主错误
    }
  }
  return parts.join(' ')
}

/** 记录一条带业务上下文的错误（经 console 拦截器转发到后端）。 */
export function logError(context: string, error: unknown, extra?: Record<string, unknown>): void {
  console.error(buildLine(context, error, extra))
}

/** 记录一条带业务上下文的警告。 */
export function logWarn(context: string, error: unknown, extra?: Record<string, unknown>): void {
  console.warn(buildLine(context, error, extra))
}

/**
 * 安装全局未捕获异常上报。必须在 React 渲染前调用，覆盖 App 挂载前的错误。
 * 注意：App.tsx 里旧的 window.onerror / unhandledrejection 监听已移除，避免重复。
 */
export function installGlobalErrorLogging(): void {
  window.addEventListener('error', (event) => {
    const line = buildLine('global.error', event.error ?? event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    })
    reportFrontendLog('error', line)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportFrontendLog('error', buildLine('global.unhandledrejection', event.reason))
  })
}
