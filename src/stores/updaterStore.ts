import { create } from 'zustand'
import { get, post } from '../api/client.ts'
import {
  clearPendingInstall,
  stagePendingInstall,
  takePendingInstall,
  type AutoInstallTake,
  type PendingUpdateInstall,
  type UpdatePlan,
} from '../api/update.ts'
import { getSettings } from '../api/settings.ts'
import { APP_INFO } from '../constants/credits.ts'
import { stagedChannelMatchesCurrent } from '../lib/updateChannel.ts'

export type UpdaterPhase =
  | 'idle'
  | 'starting'
  | 'downloading'
  /** 自动模式下已下载完成、落盘待安装（展示可点击的 Toast） */
  | 'ready'
  | 'installing'
  | 'error'

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
   * 已下载完成、等待安装的记录（`phase === 'ready'` 时有值）。
   *
   * 与 `available` 的分工：`available` 是「有新版本」这一**计划级**事实（含下载
   * 地址，未下载）；`staged` 是「包已躺在磁盘上、可以装了」这一**执行级**事实。
   * Toast 只依赖 `staged`——它才是「点这里重启安装」真正需要的前置条件。
   */
  staged: PendingUpdateInstall | null
  /**
   * 用户点了 Toast 上的 ✕（本次不再提示）。
   *
   * 只隐藏提示、**不动磁盘记录**：于是「不点击 → 下次启动自动装完」这条主路径对
   * 「点了 ✕」同样成立（✕ 表达的正是"现在别装"）。要彻底关掉自动流程用设置里的
   * 「自动下载并安装更新」开关——那是唯一的持久出口，避免两个机制表达同一件事。
   */
  toastDismissed: boolean
  /**
   * 记录/清除「有可用更新」。传 `null` = 权威确认当前通道无可用更新
   * （已是最新、或用户切换通道后该通道无更新）；缺少 version 的计划按无更新处理，
   * 因为提示与弹窗都依赖 version（见 `UpdatePlan.version`）。
   */
  setAvailable: (plan: UpdatePlan | null) => void
  /** 手动一键更新：立即下载 → 完成后立刻 run_updater 自动重启（不落盘、不弹 Toast） */
  start: (plan: UpdatePlan) => Promise<void>
  /**
   * 自动模式：后台静默下载 → 落「待安装」记录 → phase='ready' 弹 Toast。
   *
   * 与 `start` 的关键差别：**不主动重启**。下载完成即把记录交给壳侧持久化，
   * 用户点 Toast 才立即安装；不点则下次启动由 `installStagedOnLaunch` 自动装完。
   * 下载失败/落盘失败一律静默（只记 console）——自动流程是附加体验，不能打扰用户；
   * 失败后仍保留 `available`，用户可在设置页或弹窗里手动更新。
   */
  autoStart: (plan: UpdatePlan) => Promise<void>
  /** 用户点 Toast：立即用已下载的包启动 updater 并重启（成功路径进程会退出） */
  installStaged: () => Promise<void>
  /** 启动时自动装完：消费磁盘记录并按结果安装（含失败上限与作废兜底） */
  installStagedOnLaunch: () => Promise<void>
  /**
   * 把磁盘上已有的待安装记录恢复成 `staged`（phase='ready'）以显示 Toast，
   * **不安装**。用于「本次启动推迟安装」（有实例在跑）时让已下好的包可见可点。
   */
  restoreStaged: (install: PendingUpdateInstall) => void
  /** Toast 上的 ✕：本次会话不再提示（磁盘记录保留，下次启动仍会自动装完） */
  dismissStaged: () => void
  /**
   * 彻底丢弃待安装状态：清 store 的 `staged`/`phase` **并**删磁盘记录。
   *
   * 用于设置里关闭「自动下载并安装更新」：仅清磁盘不足以让 Toast 消失（它渲染自
   * `staged`），用户仍能点着立即安装，与「已关闭自动更新」自相矛盾。
   */
  discardStaged: () => void
  reset: () => void
}

let pollTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 下载代号（generation）。每次「取消/丢弃/复位」自增一次。
 *
 * 为什么需要它：`stopPolling()` 只能清掉**尚未触发**的 setTimeout。若此刻正卡在
 * `await get(...progress)` 里，那次请求返回后仍会继续跑——重新排下一个 timer，并
 * 通过 `onProgress` 把 phase 写回 `'downloading'`，把 UI 从 idle 拽回"下载中"。
 * 更糟的是 `downloadToUpdates` 的 Promise 永不 settle，`autoStart` 一直挂着、闭包
 * 不释放（review 指出）。
 *
 * 所以每个下载在开始时捕获当前代号，并在**每次 await 之后**重新比对：代号变了就
 * 立即以中止错误 reject，不再写任何状态、也不再重排 timer。
 */
let downloadGeneration = 0

/** 让所有在飞下载失效（配合各自的代号比对使用）。 */
function invalidateDownloads() {
  downloadGeneration += 1
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  invalidateDownloads()
}

/** 下载被「取消/丢弃/复位」中止时抛出的错误码（与真实下载失败区分）。 */
const DOWNLOAD_ABORTED = 'UPDATE_DOWNLOAD_ABORTED'

async function runUpdater(packagePath: string, signature: string, version: string, changelog: string | undefined) {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('run_updater', { packagePath, signature, version, changelog })
}

/** 当前 dataDir（去掉尾部斜杠）。空串表示设置还没加载完，调用方需自行短路。 */
function currentDataDir(): string {
  return (getSettings().dataDir || '').replace(/[\\/]+$/, '')
}

/**
 * 注册下载中心任务并轮询到终态。
 *
 * 手动（`start`）与自动（`autoStart`）共用这段下载逻辑，只有**完成后的动作**
 * 不同——这样两条路径的进度/失败语义（含「单次轮询失败不终止」的重试）不会漂移。
 *
 * 被 `invalidateDownloads()` 中止（用户关开关/复位）时以 `DOWNLOAD_ABORTED` reject，
 * 调用方据此静默收尾，不当成下载失败。
 */
async function downloadToUpdates(
  plan: UpdatePlan,
  onProgress: (progress: number) => void,
): Promise<{ taskId: string; targetPath: string }> {
  const dataDir = currentDataDir()
  const fileName = `qomicex-update-${plan.version}.zip`
  const res = await post<{ taskId: string; targetPath: string }>('/plugins/download/start', {
    url: plan.packageUrl,
    targetPath: `${dataDir}/updates/${fileName}`,
  })

  // 捕获本次下载的代号：此后每次 await 之后都比对，变了说明已被取消。
  const generation = downloadGeneration

  await new Promise<void>((resolve, reject) => {
    const poll = async () => {
      try {
        const p = await get<{ status: string; progress?: number; error?: string | null }>(
          `/plugins/download/${res.taskId}/progress`,
        )
        // await 之后先查代号：已被取消则不再写状态、不再重排 timer，直接中止。
        if (generation !== downloadGeneration) {
          reject(new Error(DOWNLOAD_ABORTED))
          return
        }
        if (p.status === 'completed') {
          resolve()
          return
        }
        if (p.status === 'failed') {
          reject(new Error(p.error || 'UPDATE_DOWNLOAD_FAILED'))
          return
        }
        if (p.status === 'cancelled') {
          reject(new Error('UPDATE_DOWNLOAD_CANCELLED'))
          return
        }
        if (typeof p.progress === 'number') onProgress(Math.min(99, p.progress))
        pollTimer = setTimeout(poll, 1000)
      } catch {
        // 单次轮询失败不终止流程（后端短暂不可达），1s 后重试。
        // 但若这期间已被取消（代号变了），不再重排——否则被取消的下载会自己复活。
        if (generation !== downloadGeneration) {
          reject(new Error(DOWNLOAD_ABORTED))
          return
        }
        pollTimer = setTimeout(poll, 1000)
      }
    }
    poll()
  })

  return res
}

export const useUpdaterStore = create<UpdaterState>((set, getState) => ({
  phase: 'idle',
  progress: 0,
  available: null,
  staged: null,
  toastDismissed: false,

  setAvailable(plan) {
    set({ available: plan && plan.version ? plan : null })
  },

  async start(plan) {
    // 已下载完、待安装的同一版本：直接装，不重复下载几十 MB（用户可能先看到
    // Toast 又去设置页点了「立即更新」，两条入口必须收敛到同一个包）。
    const staged = getState().staged
    if (staged && staged.version === plan.version) {
      await getState().installStaged()
      return
    }
    if (getState().phase !== 'idle' && getState().phase !== 'error' && getState().phase !== 'ready') return
    if (!plan.packageUrl || !plan.signature || !plan.version) {
      set({ phase: 'error', error: 'UPDATE_PLAN_INCOMPLETE' })
      return
    }
    // 待安装记录属于**另一个**版本（用户在设置页切换了通道/手动要求装别的版本）：
    // 先清掉它再走手动路径。否则旧记录会留在磁盘上，下次启动时自动装成那个较旧的
    // 版本，把用户刚刚手动装好的新版本降级回去。
    if (staged) {
      set({ staged: null, toastDismissed: false })
      void clearPendingInstall(currentDataDir())
    }
    set({ phase: 'starting', progress: 0, version: plan.version, error: undefined })
    try {
      const res = await downloadToUpdates(plan, (progress) => set({ phase: 'downloading', progress }))
      set({ phase: 'installing', progress: 100 })
      await runUpdater(res.targetPath, plan.signature, plan.version, plan.changelog)
      // 成功路径应用已退出；若仍在运行说明 updater 未生效
      set({ phase: 'error', error: 'UPDATER_NOT_CONFIRMED' })
    } catch (e) {
      // 被复位中止（用户点了「重试」/关开关）：静默回 idle，不显示成下载失败。
      if (e instanceof Error && e.message === DOWNLOAD_ABORTED) return
      set({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async autoStart(plan) {
    // 只从 idle 进入：已在下载/待安装/安装中时不重复发起（后台检查每次启动只跑一次，
    // 但用户可能在设置页手动触发，需幂等）。
    if (getState().phase !== 'idle') return
    if (!plan.packageUrl || !plan.signature || !plan.version) return
    set({ phase: 'starting', progress: 0, version: plan.version, error: undefined })
    try {
      const res = await downloadToUpdates(plan, (progress) => set({ phase: 'downloading', progress }))

      // **暂存边界复检开关**：下载可能耗时几十秒，用户完全可能在这期间去设置里
      // 关掉「自动下载并安装更新」。关掉后若照常落盘并进入 ready，屏幕上就会冒出
      // 一个可点击的「已准备好安装」Toast，与「已关闭自动更新」直接矛盾（review 指出）。
      // 此时清掉刚下的记录、回 idle，让用户只能走「检查更新 → 弹窗 → 立即更新」。
      if (getSettings().updateAutoInstall === false) {
        await clearPendingInstall(currentDataDir())
        set({ phase: 'idle', progress: 0, error: undefined })
        return
      }

      const staged: PendingUpdateInstall = {
        version: plan.version,
        packagePath: res.targetPath,
        signature: plan.signature,
        changelog: plan.changelog ?? '',
        attempts: 0,
        // 记下落盘时的列车：启动自动安装前据此比对当前有效通道，跨列车则不装
        // （ADR-081：通道切换必须由用户显式决定，不能被一份旧包悄悄绕过）。
        channel: plan.channel,
      }
      await stagePendingInstall(currentDataDir(), {
        version: staged.version,
        packagePath: staged.packagePath,
        signature: staged.signature,
        changelog: staged.changelog,
        channel: staged.channel,
      })
      set({ phase: 'ready', progress: 100, staged, toastDismissed: false })
    } catch (e) {
      // 被「关开关/复位」中止：用户已明确不要这次下载，静默收尾即可——**不要**写
      // idle（discardStaged/reset 已经写过状态，这里再写可能覆盖它们刚设好的值）。
      if (e instanceof Error && e.message === DOWNLOAD_ABORTED) return
      // 自动流程失败不打扰用户：回到 idle，保留 available 供手动更新入口使用。
      console.warn('[updater] auto download failed:', e)
      set({ phase: 'idle', progress: 0, error: undefined })
    }
  },

  async installStaged() {
    const { staged } = getState()
    if (!staged) return
    set({ phase: 'installing', progress: 100 })
    try {
      await runUpdater(staged.packagePath, staged.signature, staged.version, staged.changelog)
      // 成功路径应用已退出；若仍在运行说明 updater 未生效
      set({ phase: 'error', error: 'UPDATER_NOT_CONFIRMED' })
    } catch (e) {
      set({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async installStagedOnLaunch() {
    const dataDir = currentDataDir()
    if (!dataDir) return
    // 启动路径只处理 ready：安装失败后不应在同一次启动里反复重试。
    if (getState().phase !== 'idle') return
    let taken: AutoInstallTake
    try {
      taken = await takePendingInstall(dataDir)
    } catch (e) {
      // 读不出待安装记录（IPC 失败/后端未就绪）：**不能**当成「没有记录」静默返回，
      // 否则更新就此永久卡住且用户毫无提示。这里保留 available，让 App.tsx 的后台
      // 检查（5s，晚于本函数的 2s）照常弹更新对话框，用户仍有手动入口。
      console.warn('[updater] take pending install failed — 回退手动更新入口:', e)
      return
    }
    if (taken.status === 'installed') {
      // 目标版本已在运行 = 上次更新装成了、或用户已通过别的途径升到更新版本，
      // 记录已被壳侧清掉（自动流程的收敛点）。
      console.warn('[updater] auto install already applied:', taken.version)
      return
    }
    if (taken.status === 'abandoned' || taken.status === 'unpersisted') {
      // abandoned：重试超限已被壳侧记进 abandonedVersion。
      // unpersisted：尝试计数写不进盘，壳侧拒绝无人值守安装（否则永不触顶、无限重装）。
      // 两条都由 App.tsx 的下一次后台检查（5s，晚于本函数所在的 2s 定时器）读到并
      // 回退到原有更新对话框，用户仍可手动安装。
      console.warn(`[updater] auto install skipped (${taken.status}):`, taken.version)
      return
    }
    if (taken.status !== 'ready' || !taken.install) {
      // none / missing：无事可做（missing 表示包被清理，记录已作废，下次会重下）
      return
    }
    // 跨列车守卫（ADR-081）：这份包落盘时属于别的列车，说明用户中途切了通道。
    // 通道切换必须由用户显式决定，无人值守装上一份别列车的包会绕过这个前提——
    // 丢弃记录并交回正常流程（下次检查会按当前列车重新发现更新）。
    if (!stagedChannelMatchesCurrent(taken.install.channel, APP_INFO.version)) {
      console.warn(
        `[updater] auto install skipped: staged channel ${taken.install.channel} != current`,
      )
      await clearPendingInstall(dataDir)
      return
    }
    set({ phase: 'starting', progress: 100, version: taken.install.version, staged: taken.install })
    await getState().installStaged()
  },

  restoreStaged(install) {
    // 已在下载/安装中时不覆盖（避免把进度状态打回 ready）。
    if (getState().phase !== 'idle') return
    set({ phase: 'ready', progress: 100, staged: install, toastDismissed: false })
  },

  dismissStaged() {
    // 只隐藏提示，**不清磁盘记录**：用户在 Toast 上点 ✕ 表达的语义是「现在别装」，
    // 而「不点击」也同样是「现在别装」——两者都应当走「下次启动自动装完」。清掉
    // 记录会让 ✕ 变成「以后都别装」的隐藏开关，与设置里的持久开关重复且更难发现。
    set({ toastDismissed: true })
  },

  discardStaged() {
    // stopPolling 内含 invalidateDownloads()：在飞的轮询会在下一个 await 后中止，
    // 不会再把 phase 写回 downloading，也不会重排 timer（review 指出）。
    stopPolling()
    set({ phase: 'idle', progress: 0, version: undefined, staged: null, toastDismissed: false, error: undefined })
  },

  reset() {
    // 同样经 stopPolling 让在飞轮询失效（见 discardStaged 注释）。
    stopPolling()
    // 只复位下载/安装流程状态，**不动 `available`**：reset 是「重试下载」的入口
    // （UpdateDialog 下载失败后调用），下载失败不代表更新不再可用，清掉提示会让
    // 用户重试后凭空少一条「有新版本」（issue #147 要求提示常驻到装上为止）。
    set({ phase: 'idle', progress: 0, version: undefined, error: undefined })
  },
}))
