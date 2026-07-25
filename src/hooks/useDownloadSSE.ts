import { useEffect, useState } from 'react'
import { API_BASE } from '../api/client.ts'

export interface InstallState {
  instanceId: string
  status: string
  stage: string
  progress: number
  error: string | null
  totalFiles: number
  completedFiles: number
  failedFiles: number
  currentFile: string
  speed: number
  isPaused: boolean
}

export interface JavaDownloadState {
  taskId: string
  status: string
  progress: number
  speed: number
  fileName: string
  targetDir: string
  error: string | null
}

export interface ResourceDownloadState {
  sessionId: string
  type: string
  status: string
  stage: string
  progress: number
  speed: number
  currentFile: string | null
  error: string | null
  totalFiles: number
  completedFiles: number
  failedFiles: number
  downloadedBytes: number
  totalBytes: number
  isPaused: boolean
  instanceId?: string | null
  url?: string | null
  targetPath?: string | null
}

export interface ProgressPayload {
  type: 'progress'
  installs: InstallState[]
  javaDownloads: JavaDownloadState[]
  resources: ResourceDownloadState[]
  summary: {
    activeCount: number
    totalSpeed: number
  }
}

export function useDownloadSSE() {
  const [data, setData] = useState<ProgressPayload | null>(null)

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/progress/stream`)
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as ProgressPayload
        setData(parsed)
      } catch { /* ignore malformed */ }
    }
    es.onerror = () => {
      // browser will auto-reconnect
    }
    return () => es.close()
  }, [])

  return data
}
