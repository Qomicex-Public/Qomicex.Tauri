// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { launchInstance as apiLaunchInstance, getLaunchProgress, cancelLaunch as apiCancelLaunch, getInstance } from '../api/instance.ts'
import type { LaunchInstanceOptions } from '../api/instance.ts'
import { getSettings } from '../api/settings.ts'
import { resolveGameWindowArgs } from '../lib/gameWindow.ts'
import { getJavaRequirement, searchJava, getJavaDownloadCatalog, startJavaDownload, getJavaDownloadProgress, cancelJavaDownload } from '../api/java.ts'
import { getProcessResourceUsage } from '../api/system.ts'
import { ApiError } from '../api/client.ts'
import { analyzeCrash } from '../api/crashDiagnostics.ts'
import { getRuntimes } from '../stores/javaStore.ts'
import { useMessageBox } from '../components/ui'
import { useI18n } from '../i18n/index.tsx'
import { hookable } from '../plugins/hookable.ts'
import { useRunningStore } from '../stores/runningStore.ts'
import type { LaunchResult, LaunchProgress, CrashDialogState } from '../types/index.ts'

export interface JavaCheckInfo {
  path?: string | null
  gameVersion?: string
  gameDir?: string
}

/** 高频状态（启动进度 0.5s、崩溃弹窗）：只有真正展示它的界面订阅。 */
interface RunningStateValue {
  launchProgress: LaunchProgress | null
  launchingInstanceId: string | null
  crashDialogState: CrashDialogState | null
}

/** 动作集合：引用稳定，订阅的组件不会随运行状态重渲染。 */
interface RunningActionsValue {
  launchInstance: (id: string, name: string, javaInfo?: JavaCheckInfo, quickJoin?: LaunchInstanceOptions) => Promise<LaunchResult>
  watchInstance: (id: string, name: string) => void
  cancelLaunch: (id?: string) => Promise<void>
  killInstance: (id: string) => Promise<void>
  setNotifyImpl: (fn: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void) => void
  clearCrashDialog: () => void
  showLaunchError: (title: string, message: string, detail?: string | null, args?: string | null) => void
}

const RunningStateCtx = createContext<RunningStateValue | null>(null)
const RunningActionsCtx = createContext<RunningActionsValue | null>(null)

export function useRunningState(): RunningStateValue {
  const ctx = useContext(RunningStateCtx)
  if (!ctx) throw new Error('useRunningState must be used within RunningProvider')
  return ctx
}

export function useRunningActions(): RunningActionsValue {
  const ctx = useContext(RunningActionsCtx)
  if (!ctx) throw new Error('useRunningActions must be used within RunningProvider')
  return ctx
}

export function RunningProvider({ children }: { children: ReactNode }) {
  const { confirm } = useMessageBox()
  const { t } = useI18n()
  // tRef：保持 useCallback 依赖稳定（t 随语言变化，但回调内始终取最新翻译）
  const tRef = useRef(t)
  tRef.current = t
  const [launchProgress, setLaunchProgress] = useState<LaunchProgress | null>(null)
  const [launchingInstanceId, setLaunchingInstanceId] = useState<string | null>(null)
  const [crashDialogState, setCrashDialogState] = useState<CrashDialogState | null>(null)
  // 运行实例列表与资源遥测由 store 持有：1s 级 tick 只改 usage，不波及列表消费者。
  const upsertRunning = useRunningStore((s) => s.upsert)
  const removeRunning = useRunningStore((s) => s.remove)
  const setUsage = useRunningStore((s) => s.setUsage)
  const clearUsage = useRunningStore((s) => s.clearUsage)
  const pollRefs = useRef<Map<string, number>>(new Map())
  const resourcePollRefs = useRef<Map<string, number>>(new Map())
  /** 资源轮询链序号：clear/重启时递增，旧链回包据此退出。 */
  const resourceSeq = useRef<Map<string, number>>(new Map())
  // 轮询所有权标记：clearInstancePoll 后，飞行中的 fetch resolve 时据此退出，
  // 不复活 launchProgress（dialog 复现）也不重排下一跳（轮询链复活）
  const activePolls = useRef<Set<string>>(new Set())
  const notifyRef = useRef<(msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void>(() => {})
  const launchingIdRef = useRef<string | null>(null)
  // per-instance 启动序号：cancelLaunch 递增使 in-flight 的 launchInstance 失配，
  // 其 apiLaunchInstance resolve 后不再 startPoll（否则轮询链在取消后复活，dialog 弹回）
  const launchSeqRef = useRef<Map<string, number>>(new Map())

  const bumpLaunchSeq = useCallback((id: string) => {
    const next = (launchSeqRef.current.get(id) ?? 0) + 1
    launchSeqRef.current.set(id, next)
    return next
  }, [])

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
    activePolls.current.delete(id)
    const ref = pollRefs.current.get(id)
    if (ref) { clearTimeout(ref); pollRefs.current.delete(id) }
    // 资源轮询链作废：在途请求返回后不得复活计时器或写入遥测
    resourceSeq.current.set(id, (resourceSeq.current.get(id) ?? 0) + 1)
    const resRef = resourcePollRefs.current.get(id)
    if (resRef) { clearTimeout(resRef); resourcePollRefs.current.delete(id) }
    clearUsage(id)
  }, [clearUsage])

  /** 轮询进程资源使用（CPU/内存），每秒更新一次。 */
  const startResourcePoll = useCallback((id: string, pid: number) => {
    const seq = (resourceSeq.current.get(id) ?? 0) + 1
    resourceSeq.current.set(id, seq)
    const alive = () => resourceSeq.current.get(id) === seq
    const poll = async () => {
      try {
        const usage = await getProcessResourceUsage(pid)
        // 同一实例可能已重启：旧链的回包不能写入新运行的遥测
        if (!alive()) return
        setUsage(id, usage)
        resourcePollRefs.current.set(id, window.setTimeout(poll, 1000))
      } catch {
        // 进程可能已退出，停止轮询
        if (alive()) resourcePollRefs.current.delete(id)
      }
    }
    resourcePollRefs.current.set(id, window.setTimeout(poll, 1000))
  }, [setUsage])

  /** 轮询启动进度直到终态（running 注册进运行列表 / failed/crashed 弹窗 / completed 移除）。
   * 供 launchInstance（启动后）与 watchInstance（联机房主由后端代启，仅监听）复用。 */
  const startPoll = useCallback((id: string, name: string) => {
    activePolls.current.add(id)
    const poll = async () => {
      if (!activePolls.current.has(id)) return
      try {
        const p = await getLaunchProgress(id)
        if (!activePolls.current.has(id)) return
        if (p.stage === 'crashed' || p.stage === 'failed') {
          // 崩溃/失败走崩溃分析弹窗，不再保留 launchProgress（否则弹窗关闭后
          // LaunchProgressDialog 会以 crashed 终态重新出现，造成二次弹窗）。
          setLaunchProgress(null)
          clearInstancePoll(id)
          removeRunning(id)
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
          removeRunning(id)
          setLaunchingInstanceId(null)
          notifyRef.current?.(tRef.current('running.gameExited'), 'info')
        } else if (p.stage === 'running') {
          setLaunchProgress(null)
          // 5s 一次的启动轮询会反复进入本分支：已在运行列表则只续资源监控，不重复计数
          if (!useRunningStore.getState().instances.some(r => r.instanceId === id)) {
            notifyRef.current?.(tRef.current('running.gameStarted'), 'success')
          }
          upsertRunning({ instanceId: id, name, startedAt: Date.now(), stage: 'running', processId: p.processId })
          // 资源监控链只能有一条：每 5s 无条件重启会累积无人回收的计时器
          if (p.processId && !resourcePollRefs.current.has(id)) {
            startResourcePoll(id, p.processId)
          }
          pollRefs.current.set(id, window.setTimeout(poll, 5000))
        } else {
          setLaunchProgress(p)
          pollRefs.current.set(id, window.setTimeout(poll, 500))
        }
        } catch {
          if (!activePolls.current.has(id)) return
          clearInstancePoll(id)
        removeRunning(id)
        setLaunchProgress(null)
        setLaunchingInstanceId(null)
      }
    }
    pollRefs.current.set(id, window.setTimeout(poll, 500))
  }, [clearInstancePoll, removeRunning, startResourcePoll, upsertRunning])

  /** 监听一个由后端代启（联机 host/instance）的实例，进入运行列表并跟踪终态。 */
  const watchInstance = useCallback((id: string, name: string) => {
    startPoll(id, name)
  }, [startPoll])

  function detectPlatform(): string {
    const ua = navigator.userAgent
    if (/Windows/i.test(ua)) return 'windows'
    if (/Mac|iPhone|iPad/i.test(ua)) return 'macos'
    return 'linux'
  }

  function detectArch(): string {
    const ua = navigator.userAgent
    if (/arm64|aarch64/i.test(ua)) return 'arm64'
    return 'x64'
  }

  /** 启动前 Java 预检：本地无所需版本时自动下载（进度映射到总进度前 10%）。
   * 失败不中止启动——交给后端启动链路最终裁决。返回 false 表示启动被取消。 */
  const ensureJavaForLaunch = useCallback(async (id: string, javaInfo: JavaCheckInfo, seq: number): Promise<boolean> => {
    if (!javaInfo.gameVersion || !javaInfo.gameDir) return true
    // 用户明确指定了 Java：尊重其选择，只走既有的版本不匹配确认弹窗，不自动下载
    if (javaInfo.path) return true

    let required = 0
    try {
      const req = await getJavaRequirement(javaInfo.gameDir, javaInfo.gameVersion)
      required = req.requiredMajorVersion
    } catch { return true }
    if (!required) return true

    const hasMatch = (list: { majorVersion?: number; versionID: number; state: string }[]) =>
      list.some(r => r.state === 'Valid' && (r.majorVersion ?? r.versionID) >= required)

    let runtimes = await searchJava('quick').catch(() => [])
    if (hasMatch(runtimes)) return true

    setLaunchProgress({
      stage: 'java',
      message: tRef.current('running.javaAutoDownloading', { version: required }),
      progress: 0,
      isRunning: false,
    })
    let taskId: string
    try {
      const catalog = await getJavaDownloadCatalog()
      const vendor = catalog.vendors.find(v => v.versions.includes(required)) ?? catalog.vendors[0]
      if (!vendor) throw new Error('no vendor')
      const res = await startJavaDownload({
        vendor: vendor.id,
        version: required,
        platform: detectPlatform(),
        architecture: detectArch(),
      })
      taskId = res.taskId
      for (;;) {
        // 启动被取消：联动取消下载任务
        if (launchSeqRef.current.get(id) !== seq) {
          void cancelJavaDownload(taskId).catch(() => {})
          return false
        }
        await new Promise(r => setTimeout(r, 800))
        const p = await getJavaDownloadProgress(taskId)
        if (!p) throw new Error('task lost')
        setLaunchProgress({
          stage: 'java',
          message: tRef.current('running.javaAutoDownloading', { version: required }),
          progress: Math.min(9.9, p.progress / 10),
          isRunning: false,
        })
        if (p.status === 'completed') break
        if (p.status === 'failed' || p.status === 'cancelled') throw new Error(p.status)
      }
      runtimes = await searchJava('quick').catch(() => [])
      if (!hasMatch(runtimes)) throw new Error('not registered')
    } catch {
      // 下载失败：警告后继续尝试启动（后端会推荐替代运行时或报错）
      notifyRef.current?.(tRef.current('running.javaAutoDownloadFailed', { version: required }), 'warning')
    }
    return true
  }, [])

  const launchInstance = useCallback(hookable('launchInstanceFlow', async (id: string, name: string, javaInfo?: JavaCheckInfo, quickJoin?: LaunchInstanceOptions): Promise<LaunchResult> => {
    launchingIdRef.current = id
    const seq = bumpLaunchSeq(id)
    setLaunchingInstanceId(id)
    setLaunchProgress({ stage: 'java', message: tRef.current('running.javaAutoChecking'), progress: 0, isRunning: false })

    // Java 预检：info 不全时兜底拉一次实例详情（Connect 快捷启动等入口）
    let info = javaInfo
    if (!info?.gameVersion || !info?.gameDir) {
      info = await getInstance(id)
        .then(inst => ({ path: inst.javaPath, gameVersion: inst.gameVersion, gameDir: inst.gameDir }))
        .catch(() => info)
    }
    if (info && !(await ensureJavaForLaunch(id, info, seq))) {
      setLaunchProgress(null)
      setLaunchingInstanceId(null)
      launchingIdRef.current = null
      return { success: false, processId: 0 } as LaunchResult
    }

    setLaunchProgress({ stage: 'auth', message: tRef.current('dialogs.launchProgress.stage.logging-in'), progress: 0, isRunning: false })

    if (info?.path && info.gameVersion && info.gameDir) {
      try {
        const req = await getJavaRequirement(info.gameDir, info.gameVersion)
        const rt = getRuntimes().find(r => r.path === info?.path)
        if (rt && rt.versionID < req.requiredMajorVersion) {
          const ok = await confirm(
            tRef.current('running.javaIncompatible', {
              current: rt.versionID,
              game: info.gameVersion,
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
      // 窗口参数在启动瞬间换算（屏幕/DPI 可能变）；实例 null = 跟随全局。
      let windowArgs: LaunchInstanceOptions = {}
      try {
        const [inst, settings] = await Promise.all([getInstance(id), Promise.resolve(getSettings())])
        windowArgs = resolveGameWindowArgs(
          { mode: inst.gameWindowMode, width: inst.gameWindowWidth, height: inst.gameWindowHeight },
          { mode: settings.gameWindowMode, width: settings.gameWindowWidth, height: settings.gameWindowHeight },
        )
      } catch { /* 读不到实例/设置时不传窗口参数，不阻塞启动 */ }

      result = await apiLaunchInstance(id, { ...quickJoin, ...windowArgs })
    } catch (e) {
      if (launchSeqRef.current.get(id) !== seq) return { success: false, processId: 0 } as LaunchResult
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

    // 期间被取消（seq 失配）：apiLaunchInstance 已在后端开跑，由后端 cancel
    // 兜底终止；前端只保证不再建立轮询链（否则 dialog 在关闭后弹回）
    if (launchSeqRef.current.get(id) !== seq) {
      try { await apiCancelLaunch(id) } catch (e) {
        // 兜底取消失败意味着后端进程可能仍在启动；这里不能影响主流程，但必须留痕。
        notifyRef.current?.(e instanceof ApiError ? e.displayMessage : String(e), 'error')
      }
      return result
    }
    startPoll(id, name)
    return result
  }), [bumpLaunchSeq, clearInstancePoll, confirm, ensureJavaForLaunch, startPoll])

  const cancelLaunch = useCallback(async (id?: string) => {
    const targetId = id || launchingIdRef.current
    // 先清 UI（dialog 立即关闭），后端杀进程放后台，避免取消 API 挂起时 dialog 关不掉
    setLaunchProgress(null)
    setLaunchingInstanceId(null)
    launchingIdRef.current = null
    if (targetId) {
      // 递增序号使 in-flight 的 launchInstance 失配，其 resolve 后不再复活轮询链
      bumpLaunchSeq(targetId)
      clearInstancePoll(targetId)
      removeRunning(targetId)
    }
    if (targetId) {
      try { await apiCancelLaunch(targetId) } catch (e) {
        // 取消失败时界面仍会显示「已取消启动」，但后端进程可能还在跑；必须告知用户。
        notifyRef.current?.(e instanceof ApiError ? e.displayMessage : String(e), 'error')
      }
    }
    notifyRef.current?.(tRef.current('running.launchCancelled'), 'info')
  }, [bumpLaunchSeq, clearInstancePoll, removeRunning])

  const killInstance = useCallback(async (id: string) => {
    try { await apiCancelLaunch(id) } catch (e) {
      // 停止失败时界面已把实例移出运行列表并提示「已停止游戏」，与实际不符；必须告知用户。
      notifyRef.current?.(e instanceof ApiError ? e.displayMessage : String(e), 'error')
    }
    clearInstancePoll(id)
    removeRunning(id)
    notifyRef.current?.(tRef.current('running.gameStopped'), 'info')
  }, [clearInstancePoll, removeRunning])

  useEffect(() => () => {
    for (const id of pollRefs.current.keys()) clearInstancePoll(id)
  }, [clearInstancePoll])

  const stateValue = useMemo<RunningStateValue>(() => ({
    launchProgress,
    launchingInstanceId,
    crashDialogState,
  }), [launchProgress, launchingInstanceId, crashDialogState])

  const actionsValue = useMemo<RunningActionsValue>(() => ({
    launchInstance,
    watchInstance,
    cancelLaunch,
    killInstance,
    setNotifyImpl,
    clearCrashDialog,
    showLaunchError,
  }), [launchInstance, watchInstance, cancelLaunch, killInstance, setNotifyImpl, clearCrashDialog, showLaunchError])

  return (
    <RunningActionsCtx.Provider value={actionsValue}>
      <RunningStateCtx.Provider value={stateValue}>
        {children}
      </RunningStateCtx.Provider>
    </RunningActionsCtx.Provider>
  )
}
