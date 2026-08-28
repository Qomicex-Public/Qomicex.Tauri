import { useState, useCallback, useRef } from 'react'
import Markdown from 'react-markdown'
import { relaunch } from '@tauri-apps/plugin-process'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { Update } from '@tauri-apps/plugin-updater'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Tooltip } from './ui'
import { Button } from './ui'
import { ArrowUp, CheckCircle2, Download, Eraser, ExternalLink, RotateCw, TriangleAlert } from 'lucide-react'
import { useI18n } from '../i18n/index.tsx'
import { REPOSITORY_URL } from '../constants/credits.ts'

interface Props {
  open: boolean
  update: Update | null
  required?: boolean
  onClose: () => void
}

export default function UpdateDialog({ open, update, required = false, onClose }: Props) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'downloading' | 'installing' | 'error' | 'done'>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string>()
  const cancelledRef = useRef(false)

  const handleDownload = useCallback(async () => {
    if (!update) return
    cancelledRef.current = false
    setState('downloading')
    setProgress(0)
    setError(undefined)

    let total = 0
    let downloaded = 0
    try {
      // ponytail: plugin 无下载中止 API，cancel 语义 = 下载完成后不安装/不重启
      await update.download((event) => {
        if (event.event === 'Started') {
          total = event.data?.contentLength ?? 0
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
          if (total > 0) setProgress(Math.min(99, Math.round((downloaded / total) * 100)))
        }
      })
      if (cancelledRef.current) {
        setState('idle')
        return
      }
      setState('installing')
      await update.install()
      if (cancelledRef.current) return
      setState('done')
      await relaunch()
    } catch (e) {
      if (cancelledRef.current) return
      setState('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [update])

  const handleCancel = useCallback(() => {
    cancelledRef.current = true
    setState('idle')
    setProgress(0)
  }, [])

  if (!update) return null

  const versionTag = `v${update.version.replace(/^v/, '')}`
  const releaseUrl = `${REPOSITORY_URL}/releases/tag/${versionTag}`
  const date = update.date ? new Date(update.date).toLocaleDateString() : undefined

  return (
    <Dialog open={open} onClose={required ? () => {} : onClose} closeOnBackdrop={!required} closeOnEsc={!required}>
      <DialogHeader onClose={required ? undefined : onClose}>
        <DialogTitle className="flex items-center gap-2">
          {required ? (
            <TriangleAlert className="h-4 w-4 text-amber-400" />
          ) : (
            <ArrowUp className="h-4 w-4 text-muted-foreground" />
          )}
          {t('dialogs.update.foundNew', { version: update.version })}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {update.currentVersion} → <span className="font-medium text-foreground">{update.version}</span>
          </span>
          {date && <span>{t('dialogs.update.released', { date })}</span>}
          <button
            onClick={() => openUrl(releaseUrl).catch(() => window.open(releaseUrl, '_blank'))}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            {t('dialogs.update.viewRelease')}
          </button>
        </div>

        {required && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {t('dialogs.update.requiredNotice')}
          </div>
        )}

        <div className="max-h-56 overflow-y-auto rounded-lg bg-background p-3 text-sm leading-relaxed text-muted-foreground prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{update.body || t('dialogs.update.noNotes')}</Markdown>
        </div>

        {state === 'error' && error && (
          <Tooltip content={error}>
            <span className="mt-2 block break-words text-xs text-destructive">
              {t('dialogs.update.downloadFailed')}：{error}
            </span>
          </Tooltip>
        )}
      </DialogBody>
      <DialogFooter className="gap-2">
        {state === 'error' && (
          <span className="text-xs text-destructive">{t('dialogs.update.downloadFailed')}</span>
        )}
        {state === 'done' && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <CheckCircle2 className="h-3 w-3" />
            {t('dialogs.update.done')}
          </span>
        )}
        {state === 'downloading' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RotateCw className="h-3 w-3 animate-spin" />
            <span>{t('dialogs.update.downloading', { progress })}</span>
          </div>
        )}
        {state === 'idle' && !required && (
          <Button variant="outline" size="sm" onClick={onClose}>{t('dialogs.update.later')}</Button>
        )}
        {state === 'downloading' && (
          <Button variant="outline" size="sm" onClick={handleCancel}>{t('dialogs.update.cancelDownload')}</Button>
        )}
        {state === 'error' && (
          <Button variant="outline" size="sm" onClick={() => { setState('idle'); setError(undefined) }}>
            <Eraser className="mr-1 h-3 w-3" />
            {t('dialogs.update.retry')}
          </Button>
        )}
        {state === 'idle' && (
          <Button size="sm" onClick={handleDownload}>
            <Download className="mr-1 h-3 w-3" />
            {t('dialogs.update.updateNow')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
