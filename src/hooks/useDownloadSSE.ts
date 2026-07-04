import { useEffect, useState } from 'react'

export interface InstallState {
  instanceId: string
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
  taskId: string
  url: string
  targetPath: string
  fileName: string
  progress: number
  speed: number
  status: string
  error: string | null
  downloadedBytes: number
  totalBytes: number
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
    const es = new EventSource('/api/progress/stream')
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
