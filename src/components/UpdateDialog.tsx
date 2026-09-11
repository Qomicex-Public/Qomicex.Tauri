import { useCallback } from 'react'
import Markdown from 'react-markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { UpdatePlan } from '../api/update.ts'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Tooltip } from './ui'
import { Button } from './ui'
import { ArrowUp, CheckCircle2, Download, Eraser, ExternalLink, RotateCw, TriangleAlert } from 'lucide-react'
import { useI18n } from '../i18n/index.tsx'
import { REPOSITORY_URL } from '../constants/credits.ts'
import { useUpdaterStore } from '../stores/updaterStore.ts'
import { APP_INFO } from '../constants/credits.ts'

interface Props {
  open: boolean
  plan: UpdatePlan | null
  required?: boolean
  onClose: () => void
}

export default function UpdateDialog({ open, plan, required = false, onClose }: Props) {
  const { t } = useI18n()
  const { phase, progress, error } = useUpdaterStore()
  const start = useUpdaterStore((s) => s.start)
  const reset = useUpdaterStore((s) => s.reset)

  const handleUpdate = useCallback(() => {
    if (!plan) return
    void start(plan)
  }, [plan, start])

  if (!plan) return null

  const downloading = phase === 'starting' || phase === 'downloading'
  const done = phase === 'installing'
  // 下载/安装进行中禁止关闭：对话框只是视图，后台任务仍在跑，
  // 关闭会让用户失去进度可见性且无法取消（backdrop/Esc/关闭按钮三条路径都要禁）。
  const locked = required || downloading || done
  const versionTag = `v${plan.version?.replace(/^v/, '') ?? ''}`
  const releaseUrl = `${REPOSITORY_URL}/releases/tag/${versionTag}`

  return (
    <Dialog open={open} onClose={locked ? () => {} : onClose} closeOnBackdrop={!locked} closeOnEsc={!locked}>
      <DialogHeader onClose={locked ? undefined : onClose}>
        <DialogTitle className="flex items-center gap-2">
          {required ? (
            <TriangleAlert className="h-4 w-4 text-amber-400" />
          ) : (
            <ArrowUp className="h-4 w-4 text-muted-foreground" />
          )}
          {t('dialogs.update.foundNew', { version: plan.version ?? '' })}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {APP_INFO.version} → <span className="font-medium text-foreground">{plan.version}</span>
          </span>
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
          <Markdown>{plan.changelog || t('dialogs.update.noNotes')}</Markdown>
        </div>

        {downloading && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1 text-right text-xs text-muted-foreground">{progress.toFixed(2)}%</p>
          </div>
        )}

        {phase === 'error' && error && (
          <Tooltip content={error}>
            <span className="mt-2 block break-words text-xs text-destructive">
              {t('dialogs.update.downloadFailed')}：{error}
            </span>
          </Tooltip>
        )}
      </DialogBody>
      <DialogFooter className="gap-2">
        {phase === 'error' && (
          <span className="text-xs text-destructive">{t('dialogs.update.downloadFailed')}</span>
        )}
        {done && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <CheckCircle2 className="h-3 w-3" />
            {t('dialogs.update.installing')}
          </span>
        )}
        {downloading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RotateCw className="h-3 w-3 animate-spin" />
            <span>{t('dialogs.update.downloading', { progress: progress.toFixed(2) })}</span>
          </div>
        )}
        {phase === 'idle' && !required && (
          <Button variant="outline" size="sm" onClick={onClose}>{t('dialogs.update.later')}</Button>
        )}
        {phase === 'error' && (
          <Button variant="outline" size="sm" onClick={reset}>
            <Eraser className="mr-1 h-3 w-3" />
            {t('dialogs.update.retry')}
          </Button>
        )}
        {(phase === 'idle' || phase === 'error') && (
          <Button size="sm" onClick={handleUpdate}>
            <Download className="mr-1 h-3 w-3" />
            {t('dialogs.update.updateNow')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
