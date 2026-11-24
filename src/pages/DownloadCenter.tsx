// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, useMemo, useCallback } from 'react'
import { ArrowRight, Box, CheckCircle2, Coffee, Download, Hammer, ListChecks, Package, RotateCw, Square, Trash2, ChevronDown, Wrench } from 'lucide-react'
import { RotateCw as RotateCwData, Trash2 as Trash2Data } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { MorphActionIcon } from '../components/MorphActionIcon.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Button } from '../components/ui'
import { Tooltip } from '../components/ui'
import { Tabs } from '../components/ui'
import type { Tab } from '../components/ui'
import { useNavigate } from 'react-router-dom'
import { getTasks, removeTask, updateTask } from '../stores/downloadStore.ts'
import { useDownloadTasks } from '../hooks/useDownloadTasks.ts'
import { pauseInstall, resumeInstall, cancelInstall, dropModpackStaging } from '../api/instance.ts'
import { cancelResourceDownload } from '../api/resource-download.ts'
import { cancelJavaDownload, pauseJavaDownload, resumeJavaDownload } from '../api/java.ts'
import { useI18n } from '../i18n/index.tsx'
import { formatBytes, normalizeSpeed } from '../lib/download-format.ts'
import { groupTasks, readCollapsedGroups, writeCollapsedGroups } from '../lib/downloadGroups.ts'
import type { DownloadGroup, DownloadGroupKey } from '../lib/downloadGroups.ts'
import InstallStepsList from '../components/InstallStepsList.tsx'
import DownloadSpeedGraph from '../components/DownloadSpeedGraph.tsx'
import { BlockedModsDialog } from '../components/BlockedModsDialog.tsx'
import { STATUS_CONFIG } from '../lib/downloadStatus.ts'
import { dismissBackendTask, reconcileAwaitingTasks } from '../lib/progressSync.ts'

import type { DownloadTask, InstallStepInfo } from '../types/index.ts'
import { retryTask } from '../lib/retryTask.ts'

type FilterMode = 'all' | 'downloading' | 'paused' | 'awaiting' | 'completed' | 'failed'

/**
 * 丢弃失败/取消的整合包任务留下的暂存文件。
 *
 * 同一组坐标可能同时存在多张卡片（重试会重新建任务）：只要还有别的卡片引用这组坐标，
 * 就不能删——那份暂存正被新的重试复用。删不删由调用方决定是否吞掉异常。
 */
async function dropStagingForTask(task: DownloadTask): Promise<void> {
  const spec = task.retry
  if (spec?.kind !== 'modpack') return
  if (task.status !== 'failed' && task.status !== 'cancelled') return
  const shared = getTasks().some(
    (other) =>
      other.id !== task.id &&
      other.retry?.kind === 'modpack' &&
      other.retry.gameDir === spec.gameDir &&
      other.retry.source === spec.source &&
      other.retry.projectId === spec.projectId &&
      other.retry.versionId === spec.versionId,
  )
  if (shared) return
  await dropModpackStaging({
    gameDir: spec.gameDir,
    source: spec.source,
    projectId: spec.projectId,
    versionId: spec.versionId,
  })
}

/** 资源图标可能是 data URL，也可能是 Modrinth/CurseForge 的 https CDN 地址（CSP img-src 已放行 https:）。 */
function getSafeIconSrc(icon?: string): string | null {
  if (!icon) return null
  const trimmed = icon.trim()
  const safeDataImagePattern = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/i
  if (safeDataImagePattern.test(trimmed)) return trimmed
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

/** 拼接非空 class（本地实现，避免为页面单独引入 plugin-ui 的 cn）。 */
function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

/** 把状态字符串格式化为 `YYYY-MM-DD HH:mm`，供卡片时间行展示。 */
function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return dateStr }
}

/**
 * 并行管线中多个 step 可同时 active，且它们共用同一个 ProgressField（后端
 * set_stage/current_file 会被各分支每 ~300ms 互相覆写）。取权重最大的 active
 * step 作为「当前步骤」派生文案，确定性且不随并行分支抖动。
 */
function dominantStep(steps?: InstallStepInfo[]): InstallStepInfo | undefined {
  if (!steps || steps.length === 0) return undefined
  const active = steps.filter((s) => s.status === 'active')
  if (active.length === 0) return undefined
  return active.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a))
}

const TYPE_ICON: Record<string, typeof Box> = {
  java: Coffee,
  resource: Package,
  repair: Hammer,
  batch: Download,
  file: Box,
  // 整合包安装与更新共用 Package 图标（同属整合包范畴，issue #118）
  modpack: Package,
  'modpack-update': Package,
}

/** 按 `type` 取兜底图标（无资源图标时显示）。 */
function TypeIcon({ taskType, className }: { taskType: string; className?: string }) {
  const Icon = TYPE_ICON[taskType] ?? Box
  return <Icon className={className} />
}

const PLAY_ICON = 'M7 4l10 8-10 8z'
const PAUSE_ICON = 'M7 4v16M17 4v16'

/** 后端 install/modpack 管线实际会下发的 stage 值（install_service.rs / modpack.rs）。
 *  仅作为 t(`downloads.stage.*`) 的存在性白名单；未列出时回退通用文案。 */
const STAGE_LABELS: Record<string, string> = {
  'queued': 'queued',
  'fetching-json': 'fetching-json',
  'downloading-installer': 'downloading-installer',
  'scanning-base': 'scanning-base',
  'downloading-base': 'downloading-base',
  'scanning-loader-libs': 'scanning-loader-libs',
  'downloading-loader-libs': 'downloading-loader-libs',
  'installing-optifine': 'installing-optifine',
  'downloading-addons': 'downloading-addons',
  'downloading-additional-files': 'downloading-additional-files',
  'installing-loader': 'installing-loader',
  'verifying-jar': 'verifying-jar',
  'finishing': 'finishing',
  'downloading-modpack': 'downloading-modpack',
  'parsing-modpack': 'parsing-modpack',
  'extracting-modpack': 'extracting-modpack',
  'modpack-files': 'modpack-files',
  'modpack-overrides': 'modpack-overrides',
  // 整合包原地更新（issue #118）步骤
  'modpack-update-resolve': 'modpack-update-resolve',
  'modpack-update-download': 'modpack-update-download',
  'modpack-update-backup': 'modpack-update-backup',
  'modpack-update-apply': 'modpack-update-apply',
  'modpack-update-finalize': 'modpack-update-finalize',
  'installing-game': 'installing-game',
  'building-version': 'building-version',
  'downloading-game': 'downloading-game',
  'copying-files': 'copying-files',
}

const FILTER_TABS: Tab[] = [
  { id: 'all', label: 'all' },
  { id: 'downloading', label: 'downloading' },
  { id: 'paused', label: 'paused' },
  // 过滤值的 'awaiting' 对应任务状态 'awaiting-files'（见 filtered 的判定）。
  { id: 'awaiting', label: 'awaiting' },
  { id: 'completed', label: 'completed' },
  { id: 'failed', label: 'failed' },
]

type TFunc = ReturnType<typeof useI18n>['t']

/** 步骤显示标签：管线自带 label 优先（插件/新管线的命名通道），其次启动器
 * i18n 词条，都没有 → 原样显示 id（t() 对缺失 key 返回 key 本身）。 */
function stepLabel(step: InstallStepInfo, t: TFunc): string {
  if (step.label) return step.label
  const key = `downloads.steps.${step.id}`
  const translated = t(key)
  return translated === key ? step.id : translated
}

/**
 * 单张下载任务卡片。
 *
 * 刻意放在**模块级**：如果把它定义在 `DownloadCenter` 组件体内，每次渲染都会产生
 * 新的组件身份，React 会把整棵子树卸载重挂 —— `DownloadSpeedGraph` 卸载即清空
 * 速度历史（见「下载中心 UI 规范」），折叠/展开时就会出现「图突然变空」。
 * 除 `task` 与 `t` 外，其余依赖（store 操作、API、图标、格式化）都来自模块级导入，
 * 所以这里的 props 面很窄。
 */
function TaskCard({ task, t, onFix }: { task: DownloadTask; t: TFunc; onFix?: (task: DownloadTask) => void }) {
  const cfg = STATUS_CONFIG[task.status]
  const isActive = task.status === 'downloading' || task.status === 'paused' || task.status === 'queued'
  /** 待补全：安装管线已结束但缺文件，等用户手动补齐（issue #291）。不算 active——没有可暂停的进程。 */
  const isAwaiting = task.status === 'awaiting-files'
  /** 受限文件由插件自己补全的任务（服务端搭建等）：launcher 不开实例对话框。 */
  const pluginOwned = task.kind === 'plugin' || task.kind === 'server'
  const safeIcon = getSafeIconSrc(task.icon)
  // 失败按 URL 记录而非布尔：icon 变更后旧请求的 onError 仍可能晚到，布尔态会把
  // 新图标一并压成回退；img 以 src 为 key，地址变更即重挂，旧元素的过期 error 不会
  // 进入 React 事件系统，重置随地址变化天然发生。
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const showImage = safeIcon !== null && failedIcon !== safeIcon
  const steps = task.steps && task.steps.length > 0 ? task.steps : undefined
  const stepsLive = task.status === 'downloading' || task.status === 'paused'
  const stepsDoneCount = steps?.filter((s) => s.status === 'done').length ?? 0
  // 速度图只在字节流动时才有意义，但不应被 stage 门控：整合包的
  // modpack-files 等阶段同样在下载，旧逻辑按 downloading-* 前缀过滤
  // 会让图在多个 step 间消失/重挂（历史被清空）。按状态判断即可常显。
  const showSpeedGraph = task.status === 'downloading' || task.status === 'paused'
  const activeStep = dominantStep(steps)
  return (
    <div className="group glass-surface rounded-xl border bg-card p-4 transition-all hover:border-primary/20">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg',
              // 状态底色只给回退图标：透明模组 PNG 会把底色透出来（issue #199）。
              showImage
                ? ''
                : task.status === 'completed'
                  ? 'bg-emerald-500/10'
                  : task.status === 'failed'
                    ? 'bg-red-500/10'
                    : isAwaiting
                      ? 'bg-amber-500/10'
                      : 'bg-primary/10',
            )}
          >
            {showImage ? (
              <img
                key={safeIcon}
                src={safeIcon!}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setFailedIcon(safeIcon)}
              />
            ) : (
              <TypeIcon
                taskType={task.type}
                className={cn(
                  'h-5 w-5',
                  task.status === 'completed' ? 'text-emerald-400' : task.status === 'failed' ? 'text-red-400' : isAwaiting ? 'text-amber-400' : 'text-primary'
                )}
              />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium">{task.name}</span>
              <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', cfg.color)}>
                {t(`downloads.status.${task.status}`)}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
              {task.gameVersion && <span>{task.type === 'java' ? 'Java' : 'Minecraft'} {task.gameVersion}</span>}
              {task.loader && <span>{task.loader}{task.loaderVersion ? ` ${task.loaderVersion}` : ''}</span>}
              {task.addons && task.addons.length > 0 && <span>{t('downloads.addonsCount', { count: task.addons.length })}</span>}
              <span>{t('downloads.createdAt', { date: formatDate(task.createdAt) })}</span>
              {task.completedAt && <span>{t('downloads.completedAt', { date: formatDate(task.completedAt) })}</span>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isActive && task.type === 'java' && task.status !== 'queued' && (
            <>
              <Tooltip content={t(task.status === 'paused' ? 'downloads.resume' : 'downloads.pause')}>
                <Button variant="ghost" size="icon" className={cn('h-8 w-8 text-muted-foreground', task.status === 'paused' ? 'hover:text-primary' : 'hover:text-amber-400')} onClick={() => task.taskId && (task.status === 'paused' ? resumeJavaDownload(task.taskId) : pauseJavaDownload(task.taskId)).catch(() => updateTask(task.id, { status: 'failed', error: t('downloads.errors.taskInvalid') }))}>
                  <MorphIcon icon={task.status === 'paused' ? PLAY_ICON : PAUSE_ICON} strokeLinecap="round" strokeLinejoin="round" spring="snappy" reducedMotion="user" />
                </Button>
              </Tooltip>
              <Tooltip content={t('downloads.cancel')}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                  if (task.type === 'java' && task.taskId) {
                    cancelJavaDownload(task.taskId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                  } else if (task.status === 'queued') {
                    removeTask(task.id)
                  } else if (task.type === 'batch' && task.batchTaskIds && task.batchTaskIds.length > 0) {
                    import('../api/resource-download.ts').then(m => m.cancelBatch(task.batchTaskIds!)).then(() => removeTask(task.id))
                  } else if (task.type === 'file' && task.taskId) {
                    cancelResourceDownload(task.taskId).then(() => removeTask(task.id))
                  } else if (task.instanceId) {
                    cancelInstall(task.instanceId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                  }
                }}>
                  <Square className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </>
          )}
          {isActive && task.type === 'file' && task.status !== 'queued' && (
            <Tooltip content={t('downloads.cancel')}>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                if (task.taskId) {
                  cancelResourceDownload(task.taskId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                } else {
                  removeTask(task.id)
                }
              }}>
                <Square className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          {isActive && task.type !== 'file' && task.type !== 'java' && task.status !== 'queued' && (
            <>
              {/* 整合包更新不支持暂停/继续：更新进程一旦进入应用阶段便整体完成或整体回滚，
                  暴露暂停按钮会误导用户以为可以中断在半途。
                  服务端搭建同理：后端管线只在批量下载阶段检查暂停标志，安装器运行期间
                  仍会继续，而 SSE 会把卡片显示成「已暂停」——隐藏按钮避免假承诺。 */}
              {task.type !== 'modpack-update' && task.kind !== 'server' && (
                <Tooltip content={t(task.status === 'paused' ? 'downloads.resume' : 'downloads.pause')}>
                  <Button variant="ghost" size="icon" className={cn('h-8 w-8 text-muted-foreground', task.status === 'paused' ? 'hover:text-primary' : 'hover:text-amber-400')} onClick={() => task.instanceId && (task.status === 'paused' ? resumeInstall(task.instanceId) : pauseInstall(task.instanceId))}>
                    <MorphIcon icon={task.status === 'paused' ? PLAY_ICON : PAUSE_ICON} strokeLinecap="round" strokeLinejoin="round" spring="snappy" reducedMotion="user" />
                  </Button>
                </Tooltip>
              )}
              <Tooltip content={t('downloads.cancel')}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                  if (task.type === 'java' && task.taskId) {
                    cancelJavaDownload(task.taskId).then(() => removeTask(task.id))
                  } else if (task.status === 'queued') {
                    removeTask(task.id)
                  } else if (task.type === 'batch' && task.batchTaskIds && task.batchTaskIds.length > 0) {
                    import('../api/resource-download.ts').then(m => m.cancelBatch(task.batchTaskIds!)).then(() => removeTask(task.id))
                  } else if (task.type === 'file' && task.taskId) {
                    cancelResourceDownload(task.taskId).then(() => removeTask(task.id))
                  } else if (task.instanceId) {
                    // 更新与安装共用同一 tracker 与取消端点（按 instanceId 键）。
                    cancelInstall(task.instanceId).then(() => removeTask(task.id)).catch(() => removeTask(task.id))
                  }
                }}>
                  <Square className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </>
          )}
          {isAwaiting && onFix && !pluginOwned && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 border-amber-500/40 text-amber-300 hover:text-amber-200"
              onClick={() => onFix(task)}
            >
              <Wrench className="h-3.5 w-3.5" />
              {t('downloads.missingMods.fix')}
            </Button>
          )}
          {task.status === 'failed' && task.retry && (
            <Tooltip content={t('downloads.retry')}>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => {
                // 先置回排队态：重试要重新解析/建实例，耗时数秒，避免用户重复点击。
                // retryPending 让 SSE 对账在重建期间跳过本卡片——旧 instanceId 对应的
                // 失败记录还在后端保留窗口内，否则会被立刻刷回原失败原因。
                updateTask(task.id, {
                  status: 'queued',
                  progress: 0,
                  error: undefined,
                  retryPending: true,
                })
                retryTask(task)
                  .then((patch) => updateTask(task.id, { ...patch, retryPending: false }))
                  .catch((e) =>
                    updateTask(task.id, {
                      status: 'failed',
                      error: e?.message || t('downloads.errors.downloadFailed'),
                      retryPending: false,
                    }),
                  )
              }}>
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'queued') && (
            <Tooltip content={t('downloads.remove')}>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={async () => {
                // 后端发起的任务（process 管线）在 SSE 保留窗口内会被自动补卡——
                // 用户点删除时登记 instanceId，补卡逻辑据此跳过，否则清除后复活。
                if (task.instanceId) dismissBackendTask(task.instanceId)
                try {
                  // 丢弃失败时保留卡片，用户可以再点一次：静默失败会留下几百 MB 暂存文件。
                  await dropStagingForTask(task)
                } catch {
                  return
                }
                removeTask(task.id)
              }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full w-full origin-left rounded-full transition-transform duration-500',
              task.status === 'completed' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : task.status === 'paused' || isAwaiting ? 'bg-amber-400' : 'bg-primary'
            )}
            style={{ transform: `scaleX(${task.progress / 100})` }}
          />
        </div>
        {(steps || showSpeedGraph) && (
          <div className={cn('flex items-start gap-4 pt-1', !steps && showSpeedGraph && 'justify-end')}>
            {steps && (stepsLive ? (
              <InstallStepsList steps={steps} className="min-w-0 flex-1" />
            ) : task.status === 'completed' ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{t('downloads.status.completed')}</span>
              </div>
            ) : (
              <div className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 text-xs',
                task.status === 'failed' ? 'text-red-400' : 'text-muted-foreground'
              )}>
                <ListChecks className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {t('downloads.stepsDone', { done: stepsDoneCount, total: steps.length })}
                </span>
              </div>
            ))}
            {showSpeedGraph && (
              <DownloadSpeedGraph
                speed={normalizeSpeed(task.speed)}
                className={cn('w-44 shrink-0', task.status === 'paused' ? 'text-amber-400' : 'text-primary')}
              />
            )}
          </div>
        )}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
          <span className="min-w-0 truncate">
            {task.status === 'completed' ? t('downloads.statusText.done') :
             task.status === 'failed' ? (task.error ? t('downloads.statusText.failedWith', { error: task.error }) : t('downloads.statusText.failed')) :
             isAwaiting ? t('downloads.statusText.awaitingFiles', { count: task.blockedFiles ?? 0 }) :
             task.status === 'paused' ? t('downloads.statusText.pausedProgress', { progress: task.progress }) :
             task.status === 'queued' ? t('downloads.statusText.waiting') :
             // 有 steps 的管线任务：从「权重最大的 active step」派生，避免并行分支
             // 共用 ProgressField 导致的 stage/currentFile 互相覆写（鬼畜闪烁）。
             // percent 为该步自身进度，扫描/安装类步骤无字节进度时不显示数字
             // （避免把合成总进度误读成该步完成度）。
             activeStep ? (
               <>
                 {stepLabel(activeStep, t)}
                 {(activeStep.percent ?? 0) > 0 && ` (${Math.floor(activeStep.percent!)}%)`}
               </>
             ) :
             // "连接中" only while nothing is known yet — a large file can sit at
             // a rounded 0% with bytes already flowing.
              (task.progress > 0 || (task.downloadedBytes ?? 0) > 0 || (task.totalBytes ?? 0) > 0) ? (
               <>
                 {task.stage && STAGE_LABELS[task.stage] ? t(`downloads.stage.${task.stage}`) : t('downloads.statusText.downloading')} ({Math.floor((task.currentFileProgress ?? 0) > 0 ? (task.currentFileProgress ?? 0) : task.progress)}%)
                 {task.currentFile && <span className="ml-1.5 opacity-70">· {task.currentFile}</span>}
               </>
             ) : (
              <span>{t('downloads.statusText.connecting')}</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-2 ml-2">
            {task.status === 'downloading' && task.totalFiles !== undefined && task.totalFiles > 0 && task.stage && (
              <span>{t('downloads.filesCount', { done: task.completedFiles ?? 0, total: task.totalFiles })}</span>
            )}
            {task.totalBytes !== undefined && task.totalBytes > 0 && (
              <span className="tabular-nums">{formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}</span>
            )}
            {task.status === 'downloading' && task.progress > 0 && <span className="tabular-nums">{task.progress}%</span>}
          </span>
        </div>
        {isAwaiting && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-400/80">
            {pluginOwned ? t('downloads.missingMods.pluginHint') : t('downloads.missingMods.hint')}
          </p>
        )}
        {task.status === 'failed' && task.error && (
          <div className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
            {task.error}
          </div>
        )}
      </div>
    </div>
  )
}

/** 一个资源类型分组：可折叠头部 + 卡片列表。折叠只做视觉隐藏，卡片保持挂载。 */
function TaskGroupSection({ group, collapsed, onToggle, t, onFix }: {
  group: DownloadGroup
  collapsed: boolean
  onToggle: (key: DownloadGroupKey) => void
  t: TFunc
  onFix?: (task: DownloadTask) => void
}) {
  const GroupIcon = group.icon
  const contentId = `download-group-${group.key}`
  const inProgress = group.tasks.filter(
    (task) => task.status === 'downloading' || task.status === 'paused' || task.status === 'queued',
  ).length
  return (
    <section>
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn('anim-transition h-4 w-4 shrink-0 text-muted-foreground transition-transform', collapsed && '-rotate-90')} />
        <GroupIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{t(group.labelKey)}</span>
        <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {group.tasks.length}
        </span>
        {inProgress > 0 && (
          <span className="text-[10px] text-primary">{t('downloads.groups.inProgress', { count: inProgress })}</span>
        )}
      </button>
      {/* `hidden` 而非条件渲染：卸载会清空 DownloadSpeedGraph 的速度历史，
          也会中断卡片上的 SSE 更新对账。 */}
      <div id={contentId} hidden={collapsed} className="mt-2 space-y-3">
        {group.tasks.map((task) => <TaskCard key={task.id} task={task} t={t} onFix={onFix} />)}
      </div>
    </section>
  )
}

export default function DownloadCenter() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const tasks = useDownloadTasks()
  const [filter, setFilter] = useState<FilterMode>('all')
  const [clearing, setClearing] = useState(false)
  /** 已折叠的分组键。默认全部展开；持久化在独立 localStorage 键里（见 downloadGroups.ts）。 */
  const [collapsedGroups, setCollapsedGroups] = useState<DownloadGroupKey[]>(() => readCollapsedGroups())
  /** 正在补全待补文件的实例（打开 BlockedModsDialog）；null 表示对话框关闭。 */
  const [fixInstanceId, setFixInstanceId] = useState<string | null>(null)

  // 进页面时对账一次待补全任务：用户可能在资源管理器里补齐了文件
  useEffect(() => { reconcileAwaitingTasks(t) }, [t])

  const handleFix = useCallback((task: DownloadTask) => {
    if (!task.instanceId) return
    // 插件自报任务（kind='plugin'，如服务端搭建）不是实例：受限文件由插件自己
    // 的界面补全（写 .qml-server/blocked-mods.json）。这里不能打开实例语义的
    // BlockedModsDialog（会报 Instance not found），也不能替插件改状态
    // ——卡片直接隐藏该动作（见 TaskCard 的 canFix）。
    if (task.kind === 'plugin' || task.kind === 'server') return
    setFixInstanceId(task.instanceId)
  }, [])

  /** 全部补全：把对应卡片转完成（后端也会推 SSE，这里让点击瞬间生效）。 */
  const handleResolved = useCallback(() => {
    if (!fixInstanceId) return
    const task = getTasks().find(t => t.instanceId === fixInstanceId && t.status === 'awaiting-files')
    if (!task) return
    updateTask(task.id, {
      status: 'completed',
      progress: 100,
      blockedFiles: undefined,
      completedAt: new Date().toISOString(),
    })
  }, [fixInstanceId])

  /** 用户放弃补全：卡片转取消（实例保留）。 */
  const handleSkipped = useCallback(() => {
    if (!fixInstanceId) return
    const task = getTasks().find(t => t.instanceId === fixInstanceId && t.status === 'awaiting-files')
    if (task) updateTask(task.id, { status: 'cancelled', blockedFiles: undefined })
  }, [fixInstanceId])

  const toggleGroup = useCallback((key: DownloadGroupKey) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      writeCollapsedGroups(next)
      return next
    })
  }, [])

  const filterTabs = useMemo(() => FILTER_TABS.map((tab) => ({ ...tab, label: t(`downloads.filter.${tab.id}`) })), [t])

  const filtered = useMemo(() => tasks.filter((t) => {
    if (filter === 'all') return true
    // 过滤标签用 'awaiting'，任务状态是 'awaiting-files'（标签 id 不能带连字符：
    // 它会被拼成 i18n key `downloads.filter.awaiting`）。
    if (filter === 'awaiting') return t.status === 'awaiting-files'
    return t.status === filter
  }), [tasks, filter])

  /** 在状态过滤之后按资源类型分组，固定顺序输出非空分组（组内保持 store 顺序）。 */
  const groups = useMemo(() => groupTasks(filtered), [filtered])

  return (
    <>
      <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title={t('downloads.title')} subtitle={t('downloads.subtitle', { count: tasks.length })} actions={
        <Button variant="outline" size="sm" onClick={() => {
          setClearing(true)
          import('../stores/downloadStore.ts').then(m => {
            m.getTasks().filter(t => t.status !== 'downloading' && t.status !== 'paused' && t.status !== 'queued' && t.status !== 'awaiting-files').forEach(t => {
              // 后端发起任务的 instanceId 一并登记：SSE 保留窗口内不自动补卡
              if (t.instanceId) dismissBackendTask(t.instanceId)
              // 与单卡删除同一套清理：批量清除也要丢弃失败/取消的整合包暂存。
              // 批量场景不阻塞、不提示；删不掉的由 7 天 TTL 兜底。
              void dropStagingForTask(t).catch(() => {})
              m.removeTask(t.id)
            })
            setTimeout(() => setClearing(false), 800)
          })
        }} className="gap-1.5">
          <MorphActionIcon active={clearing} busy={RotateCwData} rest={Trash2Data} className="h-3.5 w-3.5" />{t('downloads.clearFinished')}
        </Button>
      } />

      <div className="flex items-center gap-2">
        <Tabs tabs={filterTabs} activeTab={filter} onChange={(id) => setFilter(id as FilterMode)} className="flex-1 min-w-0" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('downloads.taskCount', { count: filter === 'all' ? tasks.length : filtered.length })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="animate-in fade-in flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-24 text-center">
          <Download className="mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">{t('downloads.empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">{t('downloads.emptyHint')}</p>
          <Button variant="outline" size="sm" onClick={() => navigate('/instances')} className="mt-4 gap-1.5">
            <ArrowRight className="h-3 w-3" />{t('downloads.goToInstances')}
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <TaskGroupSection
              key={group.key}
              group={group}
              collapsed={collapsedGroups.includes(group.key)}
              onToggle={toggleGroup}
              t={t}
              onFix={handleFix}
            />
          ))}
        </div>
      )}
      </PageShell>
      {fixInstanceId && (
        <BlockedModsDialog
          open={fixInstanceId !== null}
          instanceId={fixInstanceId}
          onClose={() => setFixInstanceId(null)}
          onResolved={handleResolved}
          onSkipped={handleSkipped}
        />
      )}
    </>
  )
}
