import { useCallback } from 'react'
import Markdown from 'react-markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { UpdatePlan } from '../api/update.ts'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Tooltip } from './ui'
import { Button } from './ui'
import { ArrowLeftRight, ArrowUp, CheckCircle2, Download, Eraser, ExternalLink, RotateCw, TriangleAlert } from 'lucide-react'
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
      {/* Header 高度拉平：61px = py-4(32px) + 关闭按钮 28px + 1px 边框；两种状态不再抽搐 */}
      <DialogHeader onClose={locked ? undefined : onClose} className="min-h-[3.8125rem]">
        <DialogTitle className="flex min-w-0 items-center gap-2">
          {required ? (
            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-400" />
          ) : plan.channelSwitch ? (
            <ArrowLeftRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ArrowUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          {/* min-w-0 + break-all：共享 DialogHeader 的 flex-1 wrapper 带
              min-width:auto，truncate 的 nowrap 会被 min-content 顶爆导致
              Close 按钮被挤出；break-all 让 min-content 塌缩到单字符，
              极端长版本号降级为换行而非溢出 */}
          <span className="min-w-0 break-all">
            {plan.channelSwitch
              ? t('dialogs.update.channelSwitchTitle', { channel: plan.channel ?? '' })
              : t('dialogs.update.foundNew', { version: plan.version ?? '' })}
          </span>
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">{APP_INFO.version}</span>
            <span aria-hidden="true" className="shrink-0">
              →
            </span>
            <span className="min-w-0 break-words font-medium text-foreground">{plan.version}</span>
          </span>
          <button
            onClick={() => openUrl(releaseUrl).catch(() => window.open(releaseUrl, '_blank'))}
            className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            {t('dialogs.update.viewRelease')}
          </button>
        </div>

        {plan.channelSwitch && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" />
            {t('dialogs.update.channelSwitchNotice', { channel: plan.channel ?? '' })}
          </div>
        )}

        {required && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {t('dialogs.update.requiredNotice')}
          </div>
        )}

        <div className="max-h-56 overflow-y-auto [scrollbar-gutter:stable] break-words rounded-lg bg-background p-3 text-sm leading-relaxed text-muted-foreground prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{plan.changelog || t('dialogs.update.noNotes')}</Markdown>
        </div>

        {downloading && (
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {progress.toFixed(2)}%
            </span>
          </div>
        )}

        {phase === 'error' && error && (
          <Tooltip content={error}>
            <span className="block break-words text-xs text-destructive">
              {t('dialogs.update.downloadFailed')}：{error}
            </span>
          </Tooltip>
        )}
      </DialogBody>
      {/* Footer 高度拉平：65px = py-4(32px) + sm 按钮 32px + 1px 边框；两种形态不再改变高度 */}
      <DialogFooter className="min-h-[4.0625rem] flex-wrap gap-2">
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
            <span>{t('dialogs.update.downloadingAction')}</span>
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
