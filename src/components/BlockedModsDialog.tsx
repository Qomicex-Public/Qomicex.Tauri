// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  AlertTriangle,
  ExternalLink,
  FileUp,
  FolderDown,
  Layers,
  Loader2,
  RefreshCw,
  SkipForward,
  Upload,
} from 'lucide-react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Button, useMessageBox, cn } from './ui'
import {
  blockedModLabel,
  fetchBlockedMod,
  getBlockedFetchProgress,
  getBlockedMods,
  scanBlockedDownloads,
  skipBlockedMods,
  submitBlockedMod,
} from '../api/modpack-blocked.ts'
import { ApiError } from '../api/client.ts'
import { importDialogActive } from '../lib/drop-routing.ts'
import { useI18n } from '../i18n/index.tsx'
import type { BlockedModFile } from '../types/index.ts'

interface Props {
  open: boolean
  instanceId: string
  onClose: () => void
  /** 全部补全后回调，调用方据此把下载中心的任务卡转为已完成。 */
  onResolved?: () => void
  /** 用户放弃补全后回调，调用方据此把任务卡转为已取消。 */
  onSkipped?: () => void
}

/** 应用内下载窗口在页面触发下载时回传的文件地址（见 src-tauri/src/curseforge_dl.rs）。 */
interface DownloadRequested {
  instanceId: string
  fileId: number
  url: string
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * CurseForge 分发受限文件的补全对话框（issue #291）。
 *
 * 展示原因（作者关闭了第三方分发，不是网络错误）、直达项目页的链接，并支持
 * 两种补全方式：把下载好的 jar 拖进对话框（可多选，后端按 SHA-1 匹配条目），
 * 或逐条「选择文件」明确指定。校验在后端做——文件最终要落到后端管理的实例
 * 目录，前端算完哈希再传也没有意义。
 */
export function BlockedModsDialog({ open, instanceId, onClose, onResolved, onSkipped }: Props) {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [items, setItems] = useState<BlockedModFile[]>([])
  const [loading, setLoading] = useState(false)
  const [busyFileId, setBusyFileId] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [scanning, setScanning] = useState(false)
  /** 启动器正在下载的条目 → 百分比（total 未知时为 null）；可多个并发。 */
  const [fetching, setFetching] = useState<Record<number, number | null>>({})
  /** 每个文件的下载尝试序号：旧尝试的 finally 不能清掉新尝试的进度。 */
  const fetchAttempts = useRef<Record<number, number>>({})
  const [hover, setHover] = useState(false)
  const [error, setError] = useState('')
  // 关闭/切换实例后，仍在飞的请求不能回写状态（否则会把旧实例的清单灌进新实例）。
  const reqIdRef = useRef(0)
  // 对话框不销毁、只换 instanceId：异步回调要按发起时的实例核对，不能只靠 reqId
  // （逐条提交/跳过不走 refresh，旧实例的结果会写到新实例上）。
  const instanceIdRef = useRef(instanceId)
  instanceIdRef.current = instanceId
  const busyRef = useRef(false)
  // 扫描下载目录要判断「有没有补上」，用 ref 取调用时刻的清单长度。
  const itemsRef = useRef<BlockedModFile[]>([])
  itemsRef.current = items
  // 回调经 ref 取最新值：调用方通常传内联箭头函数，直接进依赖会让加载 effect 每帧重跑。
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved
  // 拖放监听只注册一次，处理函数经 ref 取最新值，避免每次渲染重订阅。
  const dropHandlerRef = useRef<(paths: string[]) => void>(() => {})
  // 应用内下载窗口的事件同样只订阅一次。
  const downloadRequestedRef = useRef<(req: DownloadRequested) => void>(() => {})

  const describeError = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof ApiError) {
        if (e.code === 'BLOCKED_UPLOAD_UNMATCHED') return t('dialogs.blockedMods.unmatched')
        return e.displayMessage || fallback
      }
      return e instanceof Error ? e.message : fallback
    },
    [t],
  )

  /** 清单清空即结束：通知调用方转完成态并关闭对话框。 */
  const applyRemaining = useCallback(
    (remaining: BlockedModFile[]) => {
      setItems(remaining)
      if (remaining.length === 0) {
        notify(t('dialogs.blockedMods.completed'), 'success')
        onResolvedRef.current?.()
        onClose()
      }
    },
    [notify, onClose, t],
  )

  const refresh = useCallback(async () => {
    const reqId = ++reqIdRef.current
    setLoading(true)
    setError('')
    try {
      const res = await getBlockedMods(instanceId)
      if (reqId !== reqIdRef.current) return
      const remaining = res.items ?? []
      setItems(remaining)
      // 用户可能已在文件管理器里补齐：清单已空就不用再占着等待态。
      if (remaining.length === 0) onResolvedRef.current?.()
    } catch (e: unknown) {
      if (reqId !== reqIdRef.current) return
      setError(describeError(e, t('dialogs.blockedMods.loadFailed')))
    } finally {
      if (reqId === reqIdRef.current) setLoading(false)
    }
  }, [describeError, instanceId, t])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  /**
   * 逐个登记拖入/选中的文件：一次失败不影响后续（多选里可能混着别的文件）。
   * 后端按 SHA-1 把文件对应到清单条目，匹配不到即拒绝，不会误放错版本。
   */
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (busyRef.current || paths.length === 0) return
      busyRef.current = true
      setImporting(true)
      setError('')
      let remaining: BlockedModFile[] | null = null
      const failures: string[] = []
      try {
        for (const path of paths) {
          if (instanceIdRef.current !== instanceId) return
          try {
            const res = await submitBlockedMod(instanceId, path)
            remaining = res.items ?? []
            setItems(remaining)
          } catch (e: unknown) {
            if (instanceIdRef.current !== instanceId) return
            failures.push(describeError(e, t('dialogs.blockedMods.submitFailed')))
          }
          if (remaining && remaining.length === 0) break
        }
        if (instanceIdRef.current !== instanceId) return
        if (failures.length > 0) setError(failures[0])
        if (remaining && remaining.length === 0) {
          notify(t('dialogs.blockedMods.completed'), 'success')
          onResolvedRef.current?.()
          onClose()
        }
      } finally {
        busyRef.current = false
        setImporting(false)
      }
    },
    [describeError, instanceId, notify, onClose, t],
  )

  dropHandlerRef.current = paths => {
    void importPaths(paths)
  }

  // 拖放：Tauri 的全局 file-drop 事件是窗口级的，对话框打开期间接管，
  // 否则同一次拖放会被安装流程的全局处理器抢走。
  useEffect(() => {
    if (!open) return
    importDialogActive.current = true
    let cancelled = false
    const unlisteners: Array<() => void> = []
    // 卸载早于 listen() 兑现时，回调会落在已清理之后：拿到就用 cancelled 补一次退订。
    const track = (p: Promise<() => void>) => {
      p.then(fn => {
        if (cancelled) fn()
        else unlisteners.push(fn)
      }).catch(() => {})
    }
    track(listen<boolean>('file-drop-hover', e => setHover(!!e.payload)))
    track(
      listen<string[]>('file-drop', e => {
        setHover(false)
        const paths = e.payload
        if (paths?.length) dropHandlerRef.current(paths)
      }),
    )
    return () => {
      cancelled = true
      importDialogActive.current = false
      unlisteners.forEach(fn => fn())
    }
  }, [open])

  // 应用内下载窗口把 CDN 地址交过来：由启动器下载（有进度）。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const unlisteners: Array<() => void> = []
    const track = (p: Promise<() => void>) => {
      p.then(fn => {
        if (cancelled) fn()
        else unlisteners.push(fn)
      }).catch(() => {})
    }
    track(
      listen<DownloadRequested>('blocked-download-requested', e => {
        downloadRequestedRef.current(e.payload)
      }),
    )
    return () => {
      cancelled = true
      unlisteners.forEach(fn => fn())
      // 窗口与对话框共享生命周期：对话框关闭后没人接收下载事件，留着队列只会
      // 丢事件（原生端仍会取消下载并消耗标签）。关闭即放弃这一批。
      if (isTauri()) {
        void import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('close_blocked_download_window'))
          .catch(() => {})
      }
    }
  }, [open])

  const openProjectPage = useCallback(async (url: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } catch {
      // Tauri opener 不可用（浏览器调试模式）时退化为新标签页。
      // noopener/noreferrer：否则被打开的页面可通过 window.opener 反向操作本窗口。
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [])

  /**
   * 打开条目的 CurseForge 页面：优先精确版本文件页，解析不到退回项目页。
   *
   * 项目页只到「项目」粒度，用户得自己在 Files 里翻版本，这正是 issue #301
   * 里下错版本的来源；精确文件页由后端拼好，缺失说明上游解析失败。
   *
   * 精确文件页在 Tauri 里改用应用内小窗（ADR-132）：用户在页面上点 Download，
   * 启动器接管下载并自动校验补全；命令不可用时退回系统浏览器，手动流程不变。
   */
  const openItemPage = useCallback(
    async (item: BlockedModFile) => {
      if (item.filePageUrl && isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('open_blocked_download_window', {
            instanceId,
            files: [
              {
                fileId: item.fileId,
                fileName: blockedModLabel(item),
                url: item.filePageUrl,
              },
            ],
            title: blockedModLabel(item),
          })
          return
        } catch {
          // 落到系统浏览器：手动补全仍然可用。
        }
      }
      await openProjectPage(item.filePageUrl || item.pageUrl)
    },
    [instanceId, openProjectPage],
  )

  /** 一键把全部待补文件开成标签队列：逐个点 Download，标签自动关闭。 */
  const openAllPages = useCallback(async () => {
    const files = itemsRef.current
      .filter(item => !!item.filePageUrl)
      .map(item => ({
        fileId: item.fileId,
        fileName: blockedModLabel(item),
        url: item.filePageUrl!,
      }))
    if (files.length === 0) {
      setError(t('dialogs.blockedMods.openAllEmpty'))
      return
    }
    if (!isTauri()) {
      await openProjectPage(files[0].url)
      return
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_blocked_download_window', {
        instanceId,
        files,
        title: `${files.length} 个待补文件`,
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('dialogs.blockedMods.downloadFailed'))
    }
  }, [instanceId, openProjectPage, t])

  /** 逐条指定文件：用于文件名缺失、或拖入后匹配不到条目的情况。 */
  const pickFile = useCallback(
    async (item: BlockedModFile) => {
      if (busyRef.current) return
      setError('')
      let picked: string | null
      try {
        const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
        // 只有 Windows 认 `jar` 过滤；其它平台给通配，否则用户可能选不到自己的文件。
        const filters = navigator.userAgent.includes('Windows')
          ? [{ name: 'Mod', extensions: ['jar'] }]
          : [{ name: 'All', extensions: ['*'] }]
        const selected = await openDialog({ multiple: false, filters })
        picked = typeof selected === 'string' && selected ? selected : null
      } catch (e: unknown) {
        // 文件选择器本身失败：必须提示，否则用户点了没反应且控制台才有未处理拒绝。
        setError(e instanceof Error ? e.message : t('dialogs.blockedMods.submitFailed'))
        return
      }
      if (!picked) return
      // 系统文件选择器期间实例可能已被切走：不要再把文件提交到旧实例。
      if (instanceIdRef.current !== instanceId) return

      busyRef.current = true
      setBusyFileId(item.fileId)
      try {
        // 后端直接读这个绝对路径（与 /modpack/parse-path 同一思路），
        // 不把文件读进前端内存再重传。
        const res = await submitBlockedMod(instanceId, picked, item.fileId)
        if (instanceIdRef.current !== instanceId) return
        applyRemaining(res.items ?? [])
      } catch (e: unknown) {
        if (instanceIdRef.current !== instanceId) return
        // refresh 开头会同步清空 error，必须先调用它再写本次错误。
        // 失败也回查一次列表：可能是后端已写入但响应丢失，避免列表停在过期状态。
        void refresh()
        setError(describeError(e, t('dialogs.blockedMods.submitFailed')))
      } finally {
        // 无条件清理自己这一条的忙碌态：共用 reqIdRef 时若被新一轮加载推进，
        // 带条件的清理会让按钮永久禁用。
        busyRef.current = false
        setBusyFileId(prev => (prev === item.fileId ? null : prev))
      }
    },
    [applyRemaining, describeError, instanceId, refresh, t],
  )

  /**
   * 窗口把 CDN 地址交过来后由启动器下载：轮询进度显示在对应行，完成后
   * 后端已经做完 SHA-1 校验并落盘，这里只刷新剩余清单。
   */
  const startFetch = useCallback(
    async (req: DownloadRequested) => {
      if (req.instanceId !== instanceIdRef.current) return
      const fileId = req.fileId
      const attempt = (fetchAttempts.current[fileId] ?? 0) + 1
      fetchAttempts.current[fileId] = attempt
      setFetching(prev => ({ ...prev, [fileId]: null }))
      setError('')
      let timer: ReturnType<typeof setInterval> | null = null
      try {
        timer = setInterval(() => {
          void getBlockedFetchProgress(instanceId, fileId)
            .then(p => {
              if (instanceIdRef.current !== instanceId) return
              if (fetchAttempts.current[fileId] !== attempt) return
              const percent =
                p.total && p.total > 0
                  ? Math.min(100, Math.floor((p.downloaded / p.total) * 100))
                  : null
              setFetching(prev => (fileId in prev ? { ...prev, [fileId]: percent } : prev))
            })
            .catch(() => {})
        }, 400)
        const res = await fetchBlockedMod(instanceId, fileId, req.url)
        if (instanceIdRef.current !== instanceId) return
        if (fetchAttempts.current[fileId] !== attempt) return
        const remaining = res.items ?? []
        // 并发下载时响应可能乱序到达：列表只会变短，变长的响应是过期快照。
        if (remaining.length <= itemsRef.current.length) {
          applyRemaining(remaining)
        } else {
          void refresh()
        }
      } catch (e: unknown) {
        if (instanceIdRef.current !== instanceId) return
        // 失败也回查一次：可能后端已落盘但响应丢失。
        void refresh()
        setError(describeError(e, t('dialogs.blockedMods.submitFailed')))
      } finally {
        if (timer) clearInterval(timer)
        if (fetchAttempts.current[fileId] === attempt) {
          delete fetchAttempts.current[fileId]
          setFetching(prev => {
            if (!(fileId in prev)) return prev
            const next = { ...prev }
            delete next[fileId]
            return next
          })
        }
      }
    },
    [applyRemaining, describeError, instanceId, refresh, t],
  )

  downloadRequestedRef.current = req => {
    void startFetch(req)
  }

  /** 从系统下载文件夹补全：后端按哈希匹配，源文件保留。 */
  const scanDownloads = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setScanning(true)
    setError('')
    try {
      const before = itemsRef.current.length
      const res = await scanBlockedDownloads(instanceId)
      if (instanceIdRef.current !== instanceId) return
      const remaining = res.items ?? []
      applyRemaining(remaining)
      // 没补上任何一条时明确说出来，否则用户只看到按钮转了一圈。
      if (before > 0 && remaining.length === before) {
        setError(t('dialogs.blockedMods.scanDownloadsEmpty'))
      }
    } catch (e: unknown) {
      if (instanceIdRef.current !== instanceId) return
      // 扫描可能已完成一部分（后端逐个导入后失败）：先回查清单再报错。
      void refresh()
      setError(describeError(e, t('dialogs.blockedMods.loadFailed')))
    } finally {
      busyRef.current = false
      setScanning(false)
    }
  }, [applyRemaining, describeError, instanceId, refresh, t])

  /** 重扫清单：用户可能已经把文件放进 mods 目录，后端会核对后剔除。 */
  const rescan = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    setError('')
    try {
      const res = await getBlockedMods(instanceId)
      if (instanceIdRef.current !== instanceId) return
      applyRemaining(res.items ?? [])
    } catch (e: unknown) {
      if (instanceIdRef.current !== instanceId) return
      setError(describeError(e, t('dialogs.blockedMods.loadFailed')))
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }, [applyRemaining, describeError, instanceId, t])

  /** 放弃补全：清空清单并结束等待态（实例保留，缺的文件仍可后续手动放入）。 */
  const skip = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await skipBlockedMods(instanceId)
    } catch (e: unknown) {
      if (instanceIdRef.current === instanceId) {
        setError(describeError(e, t('dialogs.blockedMods.submitFailed')))
      }
      return
    } finally {
      busyRef.current = false
    }
    if (instanceIdRef.current !== instanceId) return
    onSkipped?.()
    onClose()
  }, [describeError, instanceId, onClose, onSkipped, t])

  const busy = importing || scanning || loading || busyFileId !== null

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.blockedMods.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="mb-3 text-xs text-muted-foreground">{t('dialogs.blockedMods.description')}</p>
        {error && (
          <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div
          className={cn(
            'mb-3 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-4 text-center transition-colors',
            hover ? 'border-primary/60 bg-primary/5' : 'border-border/60',
          )}
        >
          {importing ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : (
            <Upload className="h-5 w-5 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{t('dialogs.blockedMods.dropHere')}</span>
          <span className="text-[11px] text-muted-foreground">
            {t('dialogs.blockedMods.dropHint')}
          </span>
        </div>

        {loading && items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('dialogs.blockedMods.empty')}
          </div>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {items.map(item => {
              const itemBusy = busyFileId === item.fileId
              return (
                <div
                  key={item.fileId}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-accent"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{blockedModLabel(item)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      fileId {item.fileId}
                      {item.fileLength ? ` · ${formatSize(item.fileLength)}` : ''}
                    </div>
                  </div>
                  {fetching[item.fileId] !== undefined && (
                    <span className="shrink-0 text-[11px] tabular-nums text-primary">
                      {fetching[item.fileId] === null ? '…' : `${fetching[item.fileId]}%`}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 gap-1"
                    onClick={() => void openItemPage(item)}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {item.filePageUrl
                      ? isTauri()
                        ? t('dialogs.blockedMods.downloadInApp')
                        : t('dialogs.blockedMods.openFilePage')
                      : t('dialogs.blockedMods.openPage')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1"
                    disabled={busy}
                    onClick={() => pickFile(item)}
                  >
                    {itemBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <FileUp className="h-3 w-3" />
                    )}
                    {t('dialogs.blockedMods.chooseFile')}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </DialogBody>
      <DialogFooter className="justify-between">
        {/* 紧凑样式确保 4 个动作在 max-w-lg 下排成一行；窗口被压到极窄时才换行。 */}
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-1.5"
            disabled={busy || items.length === 0}
            onClick={() => void openAllPages()}
            hidden={!isTauri()}
          >
            <Layers className="h-3 w-3" />
            {t('dialogs.blockedMods.openAllPages')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-1.5"
            disabled={busy}
            onClick={() => void scanDownloads()}
          >
            {scanning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FolderDown className="h-3 w-3" />
            )}
            {t('dialogs.blockedMods.scanDownloads')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-1.5"
            disabled={busy}
            onClick={() => void rescan()}
          >
            <RefreshCw className="h-3 w-3" />
            {t('dialogs.blockedMods.rescan')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-1.5 text-muted-foreground"
            disabled={busy}
            onClick={() => void skip()}
          >
            <SkipForward className="h-3 w-3" />
            {t('dialogs.blockedMods.skip')}
          </Button>
        </div>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}
