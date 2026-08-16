// 严重错误日志上报（前端侧）。
//
// 白名单（只报"影响运行的恶性 bug"，其余一律不上报，仅作上下文附带）：
//   1. ErrorBoundary 渲染崩溃（页面进入"前端渲染错误"fallback 页）→ reportRenderCrash；
//   2. 后端 panic（后端进程内崩溃）→ 由后端自行上报，前端不参与。
// window.onerror / unhandledrejection / 一般启动失败、下载安装错误等都不触发上报。
//
// 去重：同一错误（name+message）10 分钟内只上报一次。
// 上报内容：主错误条目（level/message/stack）+ 前端 console 缓冲尾部 20 条 +
// 后端 trace 缓冲尾部 30 条；deviceInfo 由后端统一生成（系统/硬件信息）。
// 开关：跟随后端设置 autoReportErrors（默认开）；关闭时不触发、不上报。

import { get, post } from '../api/client.ts'
import { getSettings, onSettingsChange } from '../api/settings.ts'

export interface ReportLogEntry {
  level: 'error' | 'warn' | 'info'
  message: string
  stack?: string
}

// ---------------------------------------------------------------
// 前端 console 环形缓冲（最近 200 条），供上报时作为上下文。
// ---------------------------------------------------------------
const CONSOLE_BUFFER_LIMIT = 200
const consoleBuffer: ReportLogEntry[] = []

const LEVEL_MAP: Record<string, 'error' | 'warn' | 'info'> = {
  error: 'error',
  warn: 'warn',
  log: 'info',
  info: 'info',
  debug: 'info',
  trace: 'info',
}

/** App.tsx console 拦截器调用：记录一条前端 console 行（无条件，供上下文用）。 */
export function pushConsole(level: string, message: string): void {
  consoleBuffer.push({ level: LEVEL_MAP[level] ?? 'info', message })
  if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
    consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_BUFFER_LIMIT)
  }
}

// ---------------------------------------------------------------
// 上报开关（跟随后端设置，默认开）。
// ---------------------------------------------------------------
let enabled = getSettings().autoReportErrors !== false
onSettingsChange((s) => {
  enabled = s.autoReportErrors !== false
})

// ---------------------------------------------------------------
// 去重：同一错误 10 分钟内只报一次。
// ---------------------------------------------------------------
const DEDUP_WINDOW_MS = 10 * 60_000
const dedup = new Map<string, number>()

function normalizeKey(error: Error): string {
  return `${error.name}:${error.message}`.slice(0, 300)
}

function shouldReport(key: string): boolean {
  const now = Date.now()
  const last = dedup.get(key) ?? 0
  if (now - last < DEDUP_WINDOW_MS) return false
  dedup.set(key, now)
  return true
}

// 单条 message 上限，避免把巨型日志灌进上游数据库。
const MAX_MESSAGE = 2000

function clip(s: string): string {
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…[truncated]` : s
}

/** 组装上下文条目：前端 console 尾部 20 条 + 后端 trace 尾部 30 条。 */
async function buildContextEntries(): Promise<ReportLogEntry[]> {
  const entries: ReportLogEntry[] = []
  for (const l of consoleBuffer.slice(-20)) {
    entries.push({ level: l.level, message: clip(l.message) })
  }
  try {
    const trace = await get<string[]>('/diagnostics/trace')
    for (const line of trace.slice(-30)) {
      entries.push({ level: 'info', message: clip(line) })
    }
  } catch {
    // trace 拉不到不阻塞上报
  }
  return entries
}

async function upload(entries: ReportLogEntry[]): Promise<void> {
  try {
    await post('/client/logs', { logs: entries })
  } catch {
    // 静默：上报失败不打扰用户、不阻塞主流程
  }
}

/**
 * 上报一次"前端渲染崩溃"（ErrorBoundary fallback 触发）。
 * 白名单 + 去重 + 开关检查都在这层完成。
 */
export function reportRenderCrash(error: Error): void {
  if (!enabled) return
  if (!shouldReport(normalizeKey(error))) return
  const entries: ReportLogEntry[] = [
    {
      level: 'error',
      message: clip(`[launcher render crash] ${error.name}: ${error.message}`),
      stack: error.stack ? clip(error.stack) : undefined,
    },
  ]
  void buildContextEntries().then((ctx) => upload([...entries, ...ctx]))
}
