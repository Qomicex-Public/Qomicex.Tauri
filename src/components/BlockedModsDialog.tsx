// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { AlertTriangle, ExternalLink, FileUp, Loader2, RefreshCw, Upload } from 'lucide-react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Button, useMessageBox, cn } from './ui'
import {
  blockedModLabel,
  getBlockedMods,
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
  const [hover, setHover] = useState(false)
  const [error, setError] = useState('')
  // 关闭/切换实例后，仍在飞的请求不能回写状态（否则会把旧实例的清单灌进新实例）。
  const reqIdRef = useRef(0)
  const busyRef = useRef(false)
  // 回调经 ref 取最新值：调用方通常传内联箭头函数，直接进依赖会让加载 effect 每帧重跑。
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved
  // 拖放监听只注册一次，处理函数经 ref 取最新值，避免每次渲染重订阅。
  const dropHandlerRef = useRef<(paths: string[]) => void>(() => {})

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
      for (const path of paths) {
        try {
          const res = await submitBlockedMod(instanceId, path)
          remaining = res.items ?? []
          setItems(remaining)
        } catch (e: unknown) {
          failures.push(describeError(e, t('dialogs.blockedMods.submitFailed')))
        }
        if (remaining && remaining.length === 0) break
      }
      busyRef.current = false
      setImporting(false)
      if (failures.length > 0) setError(failures[0])
      if (remaining && remaining.length === 0) {
        notify(t('dialogs.blockedMods.completed'), 'success')
        onResolvedRef.current?.()
        onClose()
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
    const unlisteners: Array<() => void> = []
    listen<boolean>('file-drop-hover', e => setHover(!!e.payload))
      .then(fn => unlisteners.push(fn))
      .catch(() => {})
    listen<string[]>('file-drop', e => {
      setHover(false)
      const paths = e.payload
      if (paths?.length) dropHandlerRef.current(paths)
    })
      .then(fn => unlisteners.push(fn))
      .catch(() => {})
    return () => {
      importDialogActive.current = false
      unlisteners.forEach(fn => fn())
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

      busyRef.current = true
      setBusyFileId(item.fileId)
      try {
        // 后端直接读这个绝对路径（与 /modpack/parse-path 同一思路），
        // 不把文件读进前端内存再重传。
        const res = await submitBlockedMod(instanceId, picked, item.fileId)
        applyRemaining(res.items ?? [])
      } catch (e: unknown) {
        setError(describeError(e, t('dialogs.blockedMods.submitFailed')))
        // 失败也回查一次列表：可能是后端已写入但响应丢失，避免列表停在过期状态。
        void refresh()
      } finally {
        // 无条件清理自己这一条的忙碌态：共用 reqIdRef 时若被新一轮加载推进，
        // 带条件的清理会让按钮永久禁用。
        busyRef.current = false
        setBusyFileId(prev => (prev === item.fileId ? null : prev))
      }
    },
    [applyRemaining, describeError, instanceId, refresh, t],
  )

  /** 重扫清单：用户可能已经把文件放进 mods 目录，后端会核对后剔除。 */
  const rescan = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    setError('')
    try {
      const res = await getBlockedMods(instanceId)
      applyRemaining(res.items ?? [])
    } catch (e: unknown) {
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
      setError(describeError(e, t('dialogs.blockedMods.submitFailed')))
      busyRef.current = false
      return
    }
    busyRef.current = false
    onSkipped?.()
    onClose()
  }, [describeError, instanceId, onClose, onSkipped, t])

  const busy = importing || loading || busyFileId !== null

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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 gap-1"
                    onClick={() => openProjectPage(item.pageUrl)}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {t('dialogs.blockedMods.openPage')}
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
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={busy}
            onClick={() => void rescan()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('dialogs.blockedMods.rescan')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => void skip()}
          >
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
