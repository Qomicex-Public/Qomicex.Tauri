import { get, del, post, API_BASE } from './client.ts'

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

export async function exportLog(path: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/logs/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) throw new Error()
  return res.blob()
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
