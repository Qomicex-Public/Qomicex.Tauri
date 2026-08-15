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
 * 失败静默（不阻塞主流程）。由 App.tsx 的 console 拦截器调用。
 */
export function reportFrontendLog(level: string, message: string): void {
  try {
    void fetch(`${API_BASE}/logs/frontend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message }),
    }).catch(() => {})
  } catch { /* 忽略 */ }
}
