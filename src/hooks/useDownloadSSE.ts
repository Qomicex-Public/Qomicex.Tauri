import { useEffect, useState } from 'react'
import { openStream, createSseParser } from '../api/ipc.ts'

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
  currentFileProgress: number
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
  const [reconnectKey, setReconnectKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const feed = createSseParser(text => {
      try {
        setData(JSON.parse(text) as ProgressPayload)
      } catch { /* ignore malformed */ }
    })
    // 断线自动重连（对齐原 EventSource 自动重连语义）
    const connect = () => {
      if (cancelled) return
      setReconnectKey(c => c + 1)
      openStream('/progress/stream', feed).done.catch(() => {
        if (!cancelled) timer = setTimeout(connect, 1000)
      })
    }
    connect()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return { data, reconnectKey }
}
