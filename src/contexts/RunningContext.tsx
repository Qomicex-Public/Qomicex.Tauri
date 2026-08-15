import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { launchInstance as apiLaunchInstance, getLaunchProgress, cancelLaunch as apiCancelLaunch } from '../api/instance.ts'
import type { LaunchInstanceOptions } from '../api/instance.ts'
import { getJavaRequirement } from '../api/java.ts'
import { analyzeCrash } from '../api/crashDiagnostics.ts'
import { getRuntimes } from '../stores/javaStore.ts'
import { useMessageBox } from '../components/ui'
import { useI18n } from '../i18n/index.tsx'
import type { LaunchResult, LaunchProgress, CrashDialogState } from '../types/index.ts'

export interface RunningInstance {
  instanceId: string
  name: string
  startedAt: number
  stage: string
  processId?: number | null
}

export interface JavaCheckInfo {
  path?: string | null
  gameVersion?: string
  gameDir?: string
}

export interface RunningContextValue {
  runningInstances: RunningInstance[]
  launchProgress: LaunchProgress | null
  launchingInstanceId: string | null
  launchInstance: (id: string, name: string, javaInfo?: JavaCheckInfo, quickJoin?: LaunchInstanceOptions) => Promise<LaunchResult>
  watchInstance: (id: string, name: string) => void
  cancelLaunch: (id?: string) => Promise<void>
  killInstance: (id: string) => Promise<void>
  setNotifyImpl: (fn: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void) => void
  crashDialogState: CrashDialogState | null
  clearCrashDialog: () => void
  showLaunchError: (title: string, message: string, detail?: string | null, args?: string | null) => void
}

const RunningCtx = createContext<RunningContextValue | null>(null)

export function useRunning(): RunningContextValue {
  const ctx = useContext(RunningCtx)
  if (!ctx) throw new Error('useRunning must be used within RunningProvider')
  return ctx
}

export function RunningProvider({ children }: { children: ReactNode }) {
  const { confirm } = useMessageBox()
  const { t } = useI18n()
  // tRef：保持 useCallback 依赖稳定（t 随语言变化，但回调内始终取最新翻译）
  const tRef = useRef(t)
  tRef.current = t
  const [runningInstances, setRunningInstances] = useState<RunningInstance[]>([])
  const [launchProgress, setLaunchProgress] = useState<LaunchProgress | null>(null)
  const [launchingInstanceId, setLaunchingInstanceId] = useState<string | null>(null)
  const [crashDialogState, setCrashDialogState] = useState<CrashDialogState | null>(null)
  const pollRefs = useRef<Map<string, number>>(new Map())
  const notifyRef = useRef<(msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void>(() => {})
  const launchingIdRef = useRef<string | null>(null)

  const setNotifyImpl = useCallback((fn: typeof notifyRef.current) => { notifyRef.current = fn }, [])

  const clearCrashDialog = useCallback(() => setCrashDialogState(null), [])

  const showLaunchError = useCallback((title: string, message: string, detail?: string | null, args?: string | null) => {
    setCrashDialogState({
      instanceId: '',
      title,
      message,
      detail: detail || null,
      crashReport: null,
      args: args || null,
      loading: false,
    })
  }, [])

  const clearInstancePoll = useCallback((id: string) => {
    const ref = pollRefs.current.get(id)
    if (ref) { clearTimeout(ref); pollRefs.current.delete(id) }
  }, [])

  /** 轮询启动进度直到终态（running 注册进运行列表 / failed/crashed 弹窗 / completed 移除）。
   * 供 launchInstance（启动后）与 watchInstance（联机房主由后端代启，仅监听）复用。 */
  const startPoll = useCallback((id: string, name: string) => {
    const poll = async () => {
      try {
        const p = await getLaunchProgress(id)
        if (p.stage === 'crashed' || p.stage === 'failed') {
          setLaunchProgress(p)
          clearInstancePoll(id)
          setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
          setLaunchingInstanceId(null)
          notifyRef.current?.(tRef.current('running.gameCrashed'), 'error')
          // Auto-trigger crash analysis dialog
          const crashTitle = p.stage === 'crashed' ? tRef.current('running.gameCrashTitle') : tRef.current('running.launchFailedTitle')
          const crashMessage = p.error || (p.stage === 'crashed' ? tRef.current('running.gameExitedAbnormally', { code: p.exitCode ?? '?' }) : tRef.current('running.launchError'))
          setCrashDialogState({
            instanceId: id,
            title: crashTitle,
            message: crashMessage,
            detail: p.error || null,
            crashReport: p.crashReport || null,
            args: p.arguments || null,
            loading: true,
          })
          analyzeCrash(id)
            .then(res => {
              setCrashDialogState(prev => prev ? { ...prev, analysis: res.analysis, mcloGsUrl: res.mcloGsUrl, qrCodeBase64: res.qrCodeBase64, loading: false } : null)
            })
            .catch(() => {
              setCrashDialogState(prev => prev ? { ...prev, loading: false, error: tRef.current('running.analysisUnavailable') } : null)
            })
        } else if (p.stage === 'completed') {
          setLaunchProgress(null)
          clearInstancePoll(id)
          setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
          setLaunchingInstanceId(null)
          notifyRef.current?.(tRef.current('running.gameExited'), 'info')
        } else if (p.stage === 'running') {
          setLaunchProgress(null)
          setRunningInstances(prev => {
            if (prev.some(r => r.instanceId === id)) return prev
            notifyRef.current?.(tRef.current('running.gameStarted'), 'success')
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
        setLaunchingInstanceId(null)
      }
    }
    pollRefs.current.set(id, window.setTimeout(poll, 500))
  }, [clearInstancePoll])

  /** 监听一个由后端代启（联机 host/instance）的实例，进入运行列表并跟踪终态。 */
  const watchInstance = useCallback((id: string, name: string) => {
    startPoll(id, name)
  }, [startPoll])

  const launchInstance = useCallback(async (id: string, name: string, javaInfo?: JavaCheckInfo, quickJoin?: LaunchInstanceOptions): Promise<LaunchResult> => {
    launchingIdRef.current = id
    setLaunchingInstanceId(id)
    setLaunchProgress({ stage: 'starting', message: tRef.current('running.preparingLaunch'), progress: 0, isRunning: false })

    if (javaInfo?.path && javaInfo.gameVersion && javaInfo.gameDir) {
      try {
        const req = await getJavaRequirement(javaInfo.gameDir, javaInfo.gameVersion)
        const rt = getRuntimes().find(r => r.path === javaInfo.path)
        if (rt && rt.versionID < req.requiredMajorVersion) {
          const ok = await confirm(
            tRef.current('running.javaIncompatible', {
              current: rt.versionID,
              game: javaInfo.gameVersion,
              required: req.requiredMajorVersion,
            }),
            tRef.current('running.javaIncompatibleTitle')
          )
          if (!ok) {
            setLaunchProgress(null)
            setLaunchingInstanceId(null)
            launchingIdRef.current = null
            return { success: false, processId: 0 } as LaunchResult
          }
        }
      } catch { /* 检查失败不影响启动 */ }
    }

    let result: LaunchResult
    try {
      result = await apiLaunchInstance(id, quickJoin)
    } catch (e) {
      // 请求异常（超时/后端不可达）：清掉启动 dialog，避免残留"准备启动"无法关闭
      setLaunchProgress(null)
      setLaunchingInstanceId(null)
      launchingIdRef.current = null
      setCrashDialogState({
        instanceId: id,
        title: tRef.current('running.launchFailedTitle'),
        message: e instanceof Error ? e.message : String(e),
        detail: null,
        crashReport: null,
        args: null,
        loading: false,
      })
      return { success: false, processId: 0 } as LaunchResult
    }
    if (!result.success) {
      setLaunchProgress(null)
      setLaunchingInstanceId(null)
      launchingIdRef.current = null
      setCrashDialogState({
        instanceId: id,
        title: tRef.current('running.launchFailedTitle'),
        message: result.error || tRef.current('common.unknown'),
        detail: result.detail || null,
        crashReport: null,
        args: result.arguments || null,
        loading: false,
      })
      return result
    }

    startPoll(id, name)
    return result
  }, [clearInstancePoll, confirm, startPoll])

  const cancelLaunch = useCallback(async (id?: string) => {
    const targetId = id || launchingIdRef.current
    // 先清 UI（dialog 立即关闭），后端杀进程放后台，避免取消 API 挂起时 dialog 关不掉
    setLaunchProgress(null)
    setLaunchingInstanceId(null)
    launchingIdRef.current = null
    if (targetId) clearInstancePoll(targetId)
    setRunningInstances(prev => prev.filter(r => r.instanceId !== targetId))
    if (targetId) {
      try { await apiCancelLaunch(targetId) } catch {}
    }
    notifyRef.current?.(tRef.current('running.launchCancelled'), 'info')
  }, [clearInstancePoll])

  const killInstance = useCallback(async (id: string) => {
    try { await apiCancelLaunch(id) } catch {}
    clearInstancePoll(id)
    setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
    notifyRef.current?.(tRef.current('running.gameStopped'), 'info')
  }, [clearInstancePoll])

  useEffect(() => () => {
    for (const id of pollRefs.current.keys()) clearInstancePoll(id)
  }, [clearInstancePoll])

  return (
    <RunningCtx.Provider value={{ runningInstances, launchProgress, launchingInstanceId, launchInstance, watchInstance, cancelLaunch, killInstance, setNotifyImpl, crashDialogState, clearCrashDialog, showLaunchError }}>
      {children}
    </RunningCtx.Provider>
  )
}
