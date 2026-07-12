import { get, del, API_BASE } from './client.ts'

export interface LogEntry {
  path: string
  name: string
  size: number
  lastModified: string
  isCurrentSession: boolean
}

export interface PreviewResult {
  content: string
  totalSize: number
  previewSize: number
}

export function listLogs(): Promise<LogEntry[]> {
  return get<LogEntry[]>('/logs')
}

export function previewLog(path: string): Promise<PreviewResult> {
  return get<PreviewResult>(`/logs/preview?path=${encodeURIComponent(path)}`)
}

export function getExportUrl(path: string): string {
  return `${API_BASE}/logs/export?path=${encodeURIComponent(path)}`
}

export function getExportAllUrl(): string {
  return `${API_BASE}/logs/export-all`
}

export function deleteLog(path: string): Promise<void> {
  return del(`/logs?path=${encodeURIComponent(path)}`)
}
