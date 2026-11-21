// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 全局进度流：/progress/stream 的唯一订阅者。
//
// 原先这段对账逻辑挂在下载中心页的 effect 里：离开 /downloads 流就断，任务进度冻结、
// 完成通知不触发。现在由 App 挂载一次，把 SSE 快照写进 downloadStore，页面只读 store。
//
// 竞态约束（issue #275 / #366）全部沿用手写判定，不要在这里"简化"：
// - retryPending 的卡片不参与对账；
// - SSE 缺项是歧义状态（未开始 / 已完成被剔除 / 后端重启），必须回查后端 + 限次；
// - 用户清除过的后端任务在保留窗口内不自动补卡。
import { getBlockedMods } from '../api/modpack-blocked.ts'
import { getInstallProgress } from '../api/instance.ts'
import { getJavaDownloadProgress } from '../api/java.ts'
import { getResourceDownloadProgress } from '../api/resource-download.ts'
import { openStream, createSseParser } from '../api/ipc.ts'
import { ApiError } from '../api/client.ts'
import { addTask, getTasks, removeTask, updateTask } from '../stores/downloadStore.ts'
import { refreshCustomRuntimes } from '../stores/javaStore.ts'
import { STATUS_CONFIG } from './downloadStatus.ts'
import type { DownloadTask, InstallStepInfo } from '../types/index.ts'

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
  /** 因 CurseForge 分发限制待手动补全的文件数（issue #291）。 */
  blockedFiles?: number
  currentFileProgress: number
  speed: number
  isPaused: boolean
  /** 任务类型："install" / "modpack" / "modpack-update" / "resource"（issue #118）。
   * "plugin" = 插件自报任务（task.register），如服务端搭建；"server" 为历史值。 */
  kind?: string
  /** 任务显示标题（后端发起、前端没有本地卡片的任务用它做名称）。 */
  title?: string
  steps?: InstallStepInfo[]
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

type Translate = (key: string) => string

/** Re-verify an SSE-absent file task at most this often, at most this many times. */
const STALE_FILE_RECHECK_MS = 2000
const STALE_FILE_MAX_CHECKS = 10

/** 用户主动清除过的后端任务（instanceId）：SSE 保留窗口内不再自动补卡。
 * 持久化到 localStorage——刷新/重启后窗口内仍不复活（保留窗口 5 分钟，
 * 超过的条目在读取时按时间戳淘汰，集合不会无限增长）。 */
const DISMISSED_KEY = 'qomicex.dismissedBackendTasks'
const DISMISS_TTL_MS = 15 * 60 * 1000

function loadDismissed(): Map<string, number> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, number>
    const now = Date.now()
    const out = new Map<string, number>()
    for (const [id, at] of Object.entries(obj)) {
      if (typeof at === 'number' && now - at < DISMISS_TTL_MS) out.set(id, at)
    }
    return out
  } catch {
    return new Map()
  }
}

function saveDismissed(map: Map<string, number>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch { /* 配额/隐私模式：退化为仅内存 */ }
}

export function dismissBackendTask(instanceId: string) {
  const map = loadDismissed()
  map.set(instanceId, Date.now())
  saveDismissed(map)
}

function isBackendTaskDismissed(instanceId: string): boolean {
  return loadDismissed().has(instanceId)
}

/** 清掉已离开 SSE 的登记（保留窗口过后该 id 不会再出现）。 */
function pruneDismissed(liveIds: Set<string>) {
  const map = loadDismissed()
  let changed = false
  for (const id of [...map.keys()]) {
    if (!liveIds.has(id)) { map.delete(id); changed = true }
  }
  if (changed) saveDismissed(map)
}

const prevInstallIds = new Set<string>()
const prevJavaIds = new Set<string>()
const checkedStaleJavaIds = new Set<string>()
const checkedStaleInstallIds = new Set<string>()
const staleFileChecks = new Map<string, { attempts: number; lastAt: number }>()

/**
 * 用磁盘清单刷新等待中的任务（issue #291）：用户可能在资源管理器里直接把文件放进了
 * mods 目录，后端 GET 会核对并在清单清空时收尾。
 * 实例已删除时后端返回 404，吞掉会让卡片永远停在等待态且没有移除入口。
 */
function reconcileBlockedTask(taskId: string, instId: string, t: Translate) {
  // 服务端搭建任务的等待态对账走 tracker 进度（它不是实例，modpack 的
  // 阻塞清单端点会 404 → 此前把等待卡误刷成取消）。
  const task = getTasks().find(tk => tk.id === taskId)
  if (task?.kind === 'server') {
    getInstallProgress(instId)
      .then(p => {
        // 后端 tracker 无条目（后端重启后内存记录丢失）返回 not-started。
        // 若卡片还停在「待补全/进行中」，它会永远挂着且没有移除入口——转为
        // 可清除的失败态并提示重新发起搭建。其余未知状态仍跳过：直接写入
        // 会让 STATUS_CONFIG[status] 变 undefined、TaskCard 崩溃并持久化。
        if (p?.status === 'not-started') {
          const cur = getTasks().find(tk => tk.id === taskId)
          if (cur && cur.status !== 'failed' && cur.status !== 'cancelled' && cur.status !== 'completed') {
            updateTask(taskId, {
              status: 'failed',
              blockedFiles: undefined,
              error: t('downloads.errors.serverTaskLost'),
            })
          }
          return
        }
        if (!p || !(p.status in STATUS_CONFIG)) return
        updateTask(taskId, {
          status: p.status as DownloadTask['status'],
          progress: Math.floor(p.progress),
          blockedFiles: p.blockedFiles ?? undefined,
        })
      })
      .catch(() => { /* 后端未起/任务回收：保持现状 */ })
    return
  }
  getBlockedMods(instId)
    .then(res => {
      const count = (res.items ?? []).length
      if (count > 0) {
        updateTask(taskId, { status: 'awaiting-files', blockedFiles: count })
      } else {
        updateTask(taskId, {
          status: 'completed',
          progress: 100,
          blockedFiles: undefined,
          completedAt: new Date().toISOString(),
        })
      }
    })
    .catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) {
        updateTask(taskId, { status: 'cancelled', blockedFiles: undefined })
      }
    })
}

function applySnapshot(payload: ProgressPayload, t: Translate) {
  // 后端/插件发起的安装（如服务端搭建）没有本地任务卡片：自动补建。
  // 只补进行中的任务；SSE 不推 completed，无需担心反复补卡。
  const existingInstanceIds = new Set(getTasks().map(tk => tk.instanceId).filter(Boolean) as string[])
  // 清理掉已消失的登记项（任务离开 SSE 后，同 id 不会再出现；防集合无限增长）
  pruneDismissed(new Set(payload.installs.map(i => i.instanceId)))
  for (const inst of payload.installs) {
    if (existingInstanceIds.has(inst.instanceId)) continue
    // 用户主动清除过的任务不复活（SSE 保留窗口内 failed/cancelled 仍会推送）。
    // 未清除的终态任务**仍要建卡**：首次 SSE 数据里就是 failed 的任务
    // （如服务端搭建一开始就失败）否则完全没有卡片与错误信息可看。
    if (isBackendTaskDismissed(inst.instanceId)) continue
    addTask({
      id: inst.instanceId,
      name: inst.title || inst.instanceId,
      // 后端安装管线与整合包卡片同一渲染路径（分步进度等）；server 任务
      // 借用 modpack 类型展示（无 retry 描述符 → 不显示重试按钮）。
      type: 'modpack',
      gameVersion: '',
      status: 'downloading',
      stage: inst.stage,
      progress: Math.floor(inst.progress),
      currentFile: inst.currentFile || undefined,
      totalFiles: inst.totalFiles || undefined,
      completedFiles: inst.completedFiles || undefined,
      blockedFiles: inst.blockedFiles || undefined,
      createdAt: new Date().toISOString(),
      instanceId: inst.instanceId,
      kind: inst.kind,
      steps: inst.steps,
    })
  }

  const ts = getTasks()
  for (const task of ts) {
    // 重试重建期间不参与对账：卡片还挂着旧 instanceId，后端那条失败记录仍在
    // 保留窗口内，参与对账会把刚置的排队态刷回失败（issue #275）。
    if (task.retryPending) continue
    // awaiting-files 也要对账：它是非终态，后端补全完成后要靠 SSE 推 completed。
    if (task.status !== 'queued' && task.status !== 'downloading' && task.status !== 'paused' && task.status !== 'awaiting-files') continue

    if (task.type === 'java' && task.taskId) {
      const match = payload.javaDownloads.find((j) => j.taskId === task.taskId)
      if (match) {
        let newStatus: DownloadTask['status'] = 'downloading'
        if (match.status === 'completed') newStatus = 'completed'
        else if (match.status === 'cancelled') newStatus = 'cancelled'
        else if (match.status === 'failed') newStatus = 'failed'
        else if (match.status === 'paused') newStatus = 'paused'
        else if (match.status === 'queued' || match.status === 'resolving') newStatus = 'queued'
        updateTask(task.id, {
          status: newStatus,
          stage: match.status,
          progress: Math.floor(match.progress),
          speed: match.speed,
          currentFile: match.fileName || undefined,
          error: match.error || undefined,
          completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
        })
        if (newStatus === 'completed') refreshCustomRuntimes()
      } else if (!checkedStaleJavaIds.has(task.taskId)) {
        checkedStaleJavaIds.add(task.taskId)
        getJavaDownloadProgress(task.taskId).then(p => {
          if (!p) {
            updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskExpired') })
          } else if (p.status === 'failed') {
            updateTask(task.id, { status: 'failed', error: p.error || t('downloads.errors.downloadFailed') })
          } else if (p.status === 'cancelled') {
            updateTask(task.id, { status: 'cancelled' })
          } else if (p.status === 'completed') {
            updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
            refreshCustomRuntimes()
          }
        }).catch(() => {
          updateTask(task.id, { status: 'failed', error: t('downloads.errors.cannotVerify') })
        })
      }
      continue
    }

    if (task.type === 'file' && task.taskId) {
      const match = payload.resources.find((r) => r.sessionId === task.taskId)
      if (match) {
        let newStatus: DownloadTask['status'] = 'downloading'
        if (match.status === 'completed') newStatus = 'completed'
        else if (match.status === 'cancelled') newStatus = 'cancelled'
        else if (match.status === 'failed') newStatus = 'failed'
        updateTask(task.id, {
          status: newStatus,
          progress: newStatus === 'completed' ? 100 : Math.floor(match.progress),
          speed: newStatus === 'completed' ? 0 : match.speed,
          error: match.error || undefined,
          currentFile: match.currentFile || undefined,
          downloadedBytes: match.downloadedBytes,
          totalBytes: match.totalBytes,
          completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
        })
      } else {
        // Session not in SSE — either not started yet, completed & removed, or backend restarted.
        const prev = staleFileChecks.get(task.taskId)
        const attempts = prev?.attempts ?? 0
        const sinceLast = Date.now() - (prev?.lastAt ?? 0)
        if (attempts >= STALE_FILE_MAX_CHECKS) {
          updateTask(task.id, { status: 'failed', error: t('downloads.errors.statusUnknown') })
        } else if (sinceLast >= STALE_FILE_RECHECK_MS) {
          staleFileChecks.set(task.taskId, { attempts: attempts + 1, lastAt: Date.now() })
          getResourceDownloadProgress(task.taskId).then(p => {
            if (!p || p.status === 'not_found') {
              updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskExpired') })
            } else if (p.status === 'completed') {
              updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
            } else if (p.status === 'failed' || p.status === 'cancelled') {
              updateTask(task.id, { status: p.status, error: p.error || undefined })
            }
          }).catch(() => {
            updateTask(task.id, { status: 'failed', error: t('downloads.errors.cannotVerify') })
          })
        }
      }
      continue
    }

    if (task.instanceId && task.type !== 'batch') {
      const match = payload.installs.find((i) => i.instanceId === task.instanceId)
      if (match) {
        // 卡片重新出现在 SSE 里：允许它下一次消失时再做一次过期检查。
        checkedStaleInstallIds.delete(task.instanceId)
        let newStatus: DownloadTask['status'] = 'downloading'
        if (match.status === 'completed') newStatus = 'completed'
        else if (match.status === 'cancelled') newStatus = 'cancelled'
        else if (match.status === 'failed') newStatus = 'failed'
        // 整合包缺文件待补（issue #291）：安装管线已停止，等用户手动补齐。
        else if (match.status === 'awaiting-files') newStatus = 'awaiting-files'
        else if (match.isPaused) newStatus = 'paused'
        updateTask(task.id, {
          // 后端发起的任务（如服务端搭建）标题晚于首帧 SSE 到达：随快照回填
          name: match.title || task.name,
          status: newStatus,
          stage: match.stage,
          progress: Math.floor(match.progress),
          speed: match.speed,
          currentFile: match.currentFile || undefined,
          totalFiles: match.totalFiles || undefined,
          completedFiles: match.completedFiles || undefined,
          currentFileProgress: match.currentFileProgress,
          steps: match.steps,
          // 回到终态时必须清空，否则补完后卡片还挂着「待补全」计数。
          blockedFiles: newStatus === 'completed' || newStatus === 'cancelled'
            ? undefined
            : (match.blockedFiles ?? task.blockedFiles),
          error: match.error || undefined,
          completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
        })
      } else if (!checkedStaleInstallIds.has(task.instanceId)) {
        checkedStaleInstallIds.add(task.instanceId)
        // 等待补全的任务不依赖 tracker（重启后后端没有这条记录）：以磁盘清单为准，
        // 否则 not-started 会把「等用户补文件」误判成任务过期。
        if (task.status === 'awaiting-files') {
          reconcileBlockedTask(task.id, task.instanceId, t)
          continue
        }
        getInstallProgress(task.instanceId).then(p => {
          if (!p || p.status === 'not-started') {
            const taskId = task.id
            const instId = task.instanceId!
            // 异步回包前卡片可能已被 SSE 推进到终态：按 id+instanceId 确认还是同一张卡。
            const stillSameTask = () => {
              const cur = getTasks().find((tk) => tk.id === taskId)
              return !!cur && cur.instanceId === instId
            }
            const expired = () => {
              if (!stillSameTask()) return
              if (task.status === 'queued') {
                // Not-started may be a race with SSE push — wait 5s then re-check before removal
                setTimeout(() => {
                  const cur = getTasks().find(tk => tk.id === taskId)
                  if (!cur || cur.status !== 'queued') return
                  getInstallProgress(instId).then(p2 => {
                    if (!p2 || p2.status === 'not-started') removeTask(taskId)
                    else if (p2.status === 'completed') {
                      updateTask(taskId, {
                        status: 'completed',
                        progress: 100,
                        completedAt: new Date().toISOString(),
                      })
                    }
                  }).catch(() => {})
                }, 5000)
              } else {
                updateTask(taskId, { status: 'failed', error: t('downloads.errors.taskExpired') })
              }
            }
            // 重启后 tracker 是空的，但待补全清单还在磁盘上：那是「等用户补文件」，
            // 不是过期。先查清单再决定，否则一重启就再也回不到补全入口。
            if (task.kind === 'server' || task.kind === 'plugin') {
              expired()
              return
            }
            getBlockedMods(instId)
              .then(res => {
                if (!stillSameTask()) return
                const count = (res.items ?? []).length
                if (count > 0) {
                  updateTask(taskId, { status: 'awaiting-files', blockedFiles: count })
                } else {
                  expired()
                }
              })
              .catch(expired)
          } else if (p.status === 'completed') {
            // 任务已完成后才被 SSE 剔除（get_all_active 不含 completed），
            // 此处补正终态，否则任务会永远卡在"连接中/下载中"
            updateTask(task.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
          } else if (p.status === 'awaiting-files') {
            // 后端重启后 SSE 缺项，但清单仍在：保留等待态，别降级成失败。
            updateTask(task.id, {
              status: 'awaiting-files',
              progress: Math.floor(p.progress),
              blockedFiles: p.blockedFiles ?? task.blockedFiles,
            })
          } else if (p.status === 'failed' || p.status === 'cancelled') {
            updateTask(task.id, { status: p.status, error: p.error || undefined })
          }
        }).catch(() => {
          updateTask(task.id, { status: 'failed', error: t('downloads.errors.cannotVerify') })
        })
      }
    }
  }

  const currentIds = new Set(payload.installs.map(i => i.instanceId))
  for (const prevId of prevInstallIds) {
    if (!currentIds.has(prevId)) {
      const lost = getTasks().find(tk => tk.instanceId === prevId && (tk.status === 'downloading' || tk.status === 'paused'))
      if (lost) {
        getInstallProgress(prevId).then(p => {
          if (p.status === 'completed') updateTask(lost.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
          // not-started 交给磁盘恢复路径处理：这里判成 cancelled 会把待补全卡片直接关掉。
          else if (p.status === 'failed' || p.status === 'cancelled') updateTask(lost.id, { status: p.status })
        }).catch(() => {})
      }
    }
  }
  prevInstallIds.clear()
  for (const id of currentIds) prevInstallIds.add(id)

  const currentJavaIds = new Set(payload.javaDownloads.map(j => j.taskId))
  for (const prevId of prevJavaIds) {
    if (!currentJavaIds.has(prevId)) {
      const lost = getTasks().find(tk => tk.taskId === prevId && tk.type === 'java' && (tk.status === 'downloading' || tk.status === 'paused'))
      if (lost) {
        getJavaDownloadProgress(prevId).then(p => {
          if (p.status === 'completed') { updateTask(lost.id, { status: 'completed', progress: 100, completedAt: new Date().toISOString() }); refreshCustomRuntimes() }
          else if (p.status === 'failed' || p.status === 'cancelled') updateTask(lost.id, { status: p.status })
        }).catch(() => {})
      }
    }
  }
  prevJavaIds.clear()
  for (const id of currentJavaIds) prevJavaIds.add(id)
}

/** 把「等待补全」的卡片与磁盘清单对一次账：重启后 tracker 为空，只能看清单。
 * 进下载中心时也调一次——用户可能刚在资源管理器里补齐了文件。 */
export function reconcileAwaitingTasks(t: Translate) {
  for (const task of getTasks()) {
    if (task.status === 'awaiting-files' && task.instanceId) reconcileBlockedTask(task.id, task.instanceId, t)
  }
}

let stop: (() => void) | null = null

/**
 * 启动全局进度流；重复调用返回同一个停止函数（StrictMode 双挂载不会开两条流）。
 * `t` 必须是稳定引用（语言切换不应重连流）。
 */
export function startProgressSync(t: Translate): () => void {
  if (stop) return stop

  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let handle: { done: Promise<void>; close: () => void } | null = null

  // 启动时先对账一次待补全任务：后端重启后 tracker 为空，只能看磁盘清单
  reconcileAwaitingTasks(t)

  const connect = () => {
    if (cancelled) return
    // 重连视为新会话：僵尸任务的过期检查重新计数
    checkedStaleInstallIds.clear()
    checkedStaleJavaIds.clear()
    staleFileChecks.clear()
    // parser 在每次 connect 内新建：避免上一条连接残留的半行拼进下一条连接
    const feed = createSseParser(text => {
      try {
        applySnapshot(JSON.parse(text) as ProgressPayload, t)
      } catch { /* ignore malformed */ }
    })
    try {
      handle = openStream('/progress/stream', feed.feed)
    } catch {
      if (!cancelled) timer = setTimeout(connect, 1000)
      return
    }
    // 流结束时才 flush：中途 flush 会把被切断的半行提前吐出
    handle.done
      .then(() => feed.flush())
      .catch(() => {
        if (!cancelled) timer = setTimeout(connect, 1000)
      })
  }
  connect()

  const dispose = () => {
    cancelled = true
    if (timer) clearTimeout(timer)
    handle?.close()
    stop = null
  }
  stop = dispose
  return dispose
}
