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
  /**
   * 已探知的可用更新计划（null = 尚未探知或无可用更新）。
   *
   * 「有可用更新」这一事实的**唯一事实源**：App.tsx 启动时的后台检查与设置页
   * 「检查更新」按钮都写入此处，设置页「更新」区域据此常驻提示「发现新版本」。
   * 修复前该事实只活在 AppContent 的局部 state 里，用户点「下次再说」后唯一出口
   * 被清空，设置页再也看不到有新版本（issue #147）。
   *
   * 故意**不持久化**：计划里含签名与下载地址，跨会话缓存可能已失效或已被更新版本
   * 取代，启动后由后台检查在 5s 内重新探知即可——短暂不提示优于提示过期信息。
   */
  available: UpdatePlan | null
  /**
   * 记录/清除「有可用更新」。传 `null` = 权威确认当前通道无可用更新
   * （已是最新、或用户切换通道后该通道无更新）；缺少 version 的计划按无更新处理，
   * 因为提示与弹窗都依赖 version（见 `UpdatePlan.version`）。
   */
  setAvailable: (plan: UpdatePlan | null) => void
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

async function runUpdater(packagePath: string, signature: string, version: string, changelog: string | undefined) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('run_updater', { packagePath, signature, version, changelog })
}

export const useUpdaterStore = create<UpdaterState>((set, getState) => ({
  phase: 'idle',
  progress: 0,
  available: null,

  setAvailable(plan) {
    set({ available: plan && plan.version ? plan : null })
  },

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
            await runUpdater(res.targetPath, plan.signature!, plan.version!, plan.changelog)
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
    // 只复位下载/安装流程状态，**不动 `available`**：reset 是「重试下载」的入口
    // （UpdateDialog 下载失败后调用），下载失败不代表更新不再可用，清掉提示会让
    // 用户重试后凭空少一条「有新版本」（issue #147 要求提示常驻到装上为止）。
    set({ phase: 'idle', progress: 0, version: undefined, error: undefined })
  },
}))
