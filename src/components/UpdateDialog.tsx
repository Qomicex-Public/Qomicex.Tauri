import { useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import { relaunch } from '@tauri-apps/plugin-process'
import type { Update } from '@tauri-apps/plugin-updater'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowUp, faRotate, faDownload, faCheckCircle } from '@fortawesome/free-solid-svg-icons'
import { cn } from '../lib/utils.ts'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  open: boolean
  update: Update | null
  onClose: () => void
}

export default function UpdateDialog({ open, update, onClose }: Props) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'downloading' | 'installing' | 'error' | 'done'>('idle')
  const [progress, setProgress] = useState(0)

  const handleDownload = useCallback(async () => {
    if (!update) return
    setState('downloading')
    setProgress(0)
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          if ((event.data?.contentLength ?? 0) > 0) setProgress(0)
        } else if (event.event === 'Progress') {
          setProgress((prev) => Math.min(99, prev + 1))
        }
      })
      setState('installing')
      await relaunch()
    } catch {
      setState('error')
    }
  }, [update])

  if (!update) return null

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>
          <FontAwesomeIcon icon={faArrowUp} className="mr-2 h-4 w-4 text-muted-foreground" />
          {t('dialogs.update.foundNew', { version: update.version })}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="max-h-56 overflow-y-auto rounded-lg bg-background p-3 text-sm leading-relaxed text-muted-foreground prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{update.body || t('dialogs.update.noNotes')}</Markdown>
        </div>
      </DialogBody>
      <DialogFooter className="gap-2">
        {state === 'error' && <span className="text-xs text-destructive">{t('dialogs.update.downloadFailed')}</span>}
        {state === 'done' && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <FontAwesomeIcon icon={faCheckCircle} className="h-3 w-3" />
            {t('dialogs.update.done')}
          </span>
        )}
        {state === 'downloading' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
            <span>{t('dialogs.update.downloading', { progress })}</span>
          </div>
        )}
        {state === 'idle' && (
          <Button variant="outline" size="sm" onClick={onClose}>{t('dialogs.update.later')}</Button>
        )}
        <Button size="sm" onClick={handleDownload} disabled={state === 'downloading' || state === 'installing'}>
          <FontAwesomeIcon icon={state === 'downloading' ? faRotate : faDownload} className={cn('mr-1 h-3 w-3', state === 'downloading' && 'animate-spin')} />
          {state === 'installing' ? t('dialogs.update.installing') : state === 'downloading' ? t('dialogs.update.downloadingAction') : t('dialogs.update.updateNow')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
