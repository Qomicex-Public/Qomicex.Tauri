import { create } from 'zustand'
import { get, post } from '../api/client.ts'
import type { UpdatePlan } from '../api/update.ts'
import { getSettings } from '../api/settings.ts'

export type UpdaterPhase = 'idle' | 'starting' | 'downloading' | 'installing' | 'error'

interface UpdaterState {
  phase: UpdaterPhase
  progress: number
  version?: string
  error?: string
  /** 启动一键更新：注册下载中心任务 → 轮询 → 完成后 run_updater 自动重启 */
  start: (plan: UpdatePlan) => Promise<void>
  reset: () => void
}

let pollTimer: ReturnType<typeof setTimeout> | null = null

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

async function runUpdater(packagePath: string, signature: string, version: string) {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('run_updater', { packagePath, signature, version })
}

export const useUpdaterStore = create<UpdaterState>((set, getState) => ({
  phase: 'idle',
  progress: 0,

  async start(plan) {
    if (getState().phase !== 'idle' && getState().phase !== 'error') return
    if (!plan.packageUrl || !plan.signature || !plan.version) {
      set({ phase: 'error', error: 'UPDATE_PLAN_INCOMPLETE' })
      return
    }
    set({ phase: 'starting', progress: 0, version: plan.version, error: undefined })
    try {
      const dataDir = (getSettings().dataDir || '').replace(/[\\/]+$/, '')
      const fileName = `qomicex-update-${plan.version}.zip`
      const res = await post<{ taskId: string; targetPath: string }>('/plugins/download/start', {
        url: plan.packageUrl,
        targetPath: `${dataDir}/updates/${fileName}`,
      })
      set({ phase: 'downloading' })
      const poll = async () => {
        try {
          const p = await get<{ status: string; progress?: number; error?: string | null }>(
            `/plugins/download/${res.taskId}/progress`,
          )
          if (p.status === 'completed') {
            set({ phase: 'installing', progress: 100 })
            await runUpdater(res.targetPath, plan.signature!, plan.version!)
            // 成功路径应用已退出；若仍在运行说明 updater 未生效
            set({ phase: 'error', error: 'UPDATER_NOT_CONFIRMED' })
            return
          }
          if (p.status === 'failed') {
            set({ phase: 'error', error: p.error || 'UPDATE_DOWNLOAD_FAILED' })
            return
          }
          if (p.status === 'cancelled') {
            set({ phase: 'error', error: 'UPDATE_DOWNLOAD_CANCELLED' })
            return
          }
          if (typeof p.progress === 'number') set({ progress: Math.min(99, p.progress) })
          pollTimer = setTimeout(poll, 1000)
        } catch {
          // 单次轮询失败不终止流程（后端短暂不可达），1s 后重试
          pollTimer = setTimeout(poll, 1000)
        }
      }
      poll()
    } catch (e) {
      set({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  reset() {
    stopPolling()
    set({ phase: 'idle', progress: 0, version: undefined, error: undefined })
  },
}))
