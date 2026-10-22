// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, FileUp, Loader2 } from 'lucide-react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Button, cn } from './ui'
import { blockedModLabel, getBlockedMods, submitBlockedMod } from '../api/modpack-blocked.ts'
import { useI18n } from '../i18n/index.tsx'
import type { BlockedModFile } from '../types/index.ts'

interface Props {
  open: boolean
  instanceId: string
  onClose: () => void
  /** 全部补全后回调，调用方据此刷新实例状态 */
  onAllResolved?: () => void
}

/**
 * CurseForge 分发受限文件的补全对话框（issue #291）。
 *
 * 展示原因（作者关闭了第三方分发，不是网络错误）、直达项目页的链接，以及
 * 每个条目独立的「选择已下载的文件」入口。选择后交给后端做 SHA-1 校验——
 * 校验在前端做没有意义，文件最终要落到后端管理的实例目录。
 */
export function BlockedModsDialog({ open, instanceId, onClose, onAllResolved }: Props) {
  const { t } = useI18n()
  const [items, setItems] = useState<BlockedModFile[]>([])
  const [loading, setLoading] = useState(false)
  const [busyFileId, setBusyFileId] = useState<number | null>(null)
  const [error, setError] = useState('')
  // 关闭/切换实例后，仍在飞的请求不能回写状态（否则会把旧实例的清单灌进新实例）。
  const reqIdRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const reqId = ++reqIdRef.current
    setLoading(true)
    setError('')
    getBlockedMods(instanceId)
      .then(res => {
        if (reqId !== reqIdRef.current) return
        setItems(res.items ?? [])
      })
      .catch((e: unknown) => {
        if (reqId !== reqIdRef.current) return
        setError(e instanceof Error ? e.message : t('dialogs.blockedMods.loadFailed'))
      })
      .finally(() => {
        if (reqId === reqIdRef.current) setLoading(false)
      })
  }, [open, instanceId, t])

  const openProjectPage = useCallback(async (url: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } catch {
      // Tauri opener 不可用（浏览器调试模式）时退化为新标签页。
      window.open(url, '_blank')
    }
  }, [])

  const pickFile = useCallback(
    async (item: BlockedModFile) => {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
      // 只有 Windows 认 `jar` 过滤；其它平台给通配，否则用户可能选不到自己的文件。
      const filters = navigator.userAgent.includes('Windows')
        ? [{ name: 'Mod', extensions: ['jar'] }]
        : [{ name: 'All', extensions: ['*'] }]
      const picked = await openDialog({ multiple: false, filters })
      if (typeof picked !== 'string' || !picked) return

      setBusyFileId(item.fileId)
      setError('')
      const reqId = ++reqIdRef.current
      try {
        // 后端直接读这个绝对路径（与 /modpack/parse-path 同一思路），
        // 不把文件读进前端内存再重传。
        const res = await submitBlockedMod(instanceId, item.fileId, picked)
        if (reqId !== reqIdRef.current) return
        const remaining = res.items ?? []
        setItems(remaining)
        if (remaining.length === 0) onAllResolved?.()
      } catch (e: unknown) {
        if (reqId !== reqIdRef.current) return
        setError(e instanceof Error ? e.message : t('dialogs.blockedMods.submitFailed'))
      } finally {
        if (reqId === reqIdRef.current) setBusyFileId(null)
      }
    },
    [instanceId, onAllResolved, t],
  )

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.blockedMods.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="mb-3 text-xs text-muted-foreground">
          {t('dialogs.blockedMods.description')}
        </p>
        {error && (
          <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {loading ? (
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
              const busy = busyFileId === item.fileId
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
                    className={cn('shrink-0 gap-1')}
                    disabled={busy}
                    onClick={() => pickFile(item)}
                  >
                    {busy ? (
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
      <DialogFooter>
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
