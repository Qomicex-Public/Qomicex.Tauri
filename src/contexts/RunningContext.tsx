import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { launchInstance as apiLaunchInstance, getLaunchProgress, cancelLaunch as apiCancelLaunch } from '../api/instance.ts'
import type { LaunchResult, LaunchProgress } from '../types/index.ts'

export interface RunningInstance {
  instanceId: string
  name: string
  startedAt: number
  stage: string
  processId?: number | null
}

export interface RunningContextValue {
  runningInstances: RunningInstance[]
  launchProgress: LaunchProgress | null
  launchInstance: (id: string, name: string) => Promise<LaunchResult>
  cancelLaunch: (id?: string) => Promise<void>
  killInstance: (id: string) => Promise<void>
  setNotifyImpl: (fn: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void) => void
}

const RunningCtx = createContext<RunningContextValue | null>(null)

export function useRunning(): RunningContextValue {
  const ctx = useContext(RunningCtx)
  if (!ctx) throw new Error('useRunning must be used within RunningProvider')
  return ctx
}

export function RunningProvider({ children }: { children: ReactNode }) {
  const [runningInstances, setRunningInstances] = useState<RunningInstance[]>([])
  const [launchProgress, setLaunchProgress] = useState<LaunchProgress | null>(null)
  const pollRefs = useRef<Map<string, number>>(new Map())
  const notifyRef = useRef<(msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void>(() => {})
  const launchingIdRef = useRef<string | null>(null)

  const setNotifyImpl = useCallback((fn: typeof notifyRef.current) => { notifyRef.current = fn }, [])

  const clearInstancePoll = useCallback((id: string) => {
    const ref = pollRefs.current.get(id)
    if (ref) { clearTimeout(ref); pollRefs.current.delete(id) }
  }, [])

  const launchInstance = useCallback(async (id: string, name: string): Promise<LaunchResult> => {
    const result = await apiLaunchInstance(id)
    if (!result.success) return result

    launchingIdRef.current = id
    setLaunchProgress({ stage: 'starting', message: '准备启动...', progress: 0, isRunning: false })

    const poll = async () => {
      try {
        const p = await getLaunchProgress(id)
        if (p.stage === 'crashed' || p.stage === 'failed') {
          setLaunchProgress(p)
          clearInstancePoll(id)
          setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
          launchingIdRef.current = null
          notifyRef.current?.('游戏已崩溃', 'error')
        } else if (p.stage === 'completed') {
          setLaunchProgress(null)
          clearInstancePoll(id)
          setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
          launchingIdRef.current = null
          notifyRef.current?.('游戏已退出', 'info')
        } else if (p.stage === 'running') {
          setLaunchProgress(null)
          setRunningInstances(prev => {
            if (prev.some(r => r.instanceId === id)) return prev
            return [...prev, { instanceId: id, name, startedAt: Date.now(), stage: 'running', processId: p.processId }]
          })
          pollRefs.current.set(id, window.setTimeout(poll, 5000))
        } else {
          setLaunchProgress(p)
          pollRefs.current.set(id, window.setTimeout(poll, 500))
        }
      } catch {
        clearInstancePoll(id)
        setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
        setLaunchProgress(null)
        launchingIdRef.current = null
      }
    }
    pollRefs.current.set(id, window.setTimeout(poll, 500))
    return result
  }, [clearInstancePoll])

  const cancelLaunch = useCallback(async (id?: string) => {
    const targetId = id || launchingIdRef.current
    if (!targetId) return
    try { await apiCancelLaunch(targetId) } catch {}
    setLaunchProgress(null)
    clearInstancePoll(targetId)
    setRunningInstances(prev => prev.filter(r => r.instanceId !== targetId))
    launchingIdRef.current = null
    notifyRef.current?.('已取消启动', 'info')
  }, [clearInstancePoll])

  const killInstance = useCallback(async (id: string) => {
    try { await apiCancelLaunch(id) } catch {}
    clearInstancePoll(id)
    setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
    notifyRef.current?.('已停止游戏', 'info')
  }, [clearInstancePoll])

  useEffect(() => () => {
    for (const id of pollRefs.current.keys()) clearInstancePoll(id)
  }, [clearInstancePoll])

  return (
    <RunningCtx.Provider value={{ runningInstances, launchProgress, launchInstance, cancelLaunch, killInstance, setNotifyImpl }}>
      {children}
    </RunningCtx.Provider>
  )
}
