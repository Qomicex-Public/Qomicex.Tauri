import Markdown from 'react-markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Button } from './ui'
import { ArrowRight, CheckCircle2, ExternalLink } from 'lucide-react'
import { useI18n } from '../i18n/index.tsx'
import { REPOSITORY_URL } from '../constants/credits.ts'
import { trainLabelKey, trainOf } from '../lib/updateChannel.ts'
import type { UpdateNotice } from '../api/update.ts'

interface Props {
  open: boolean
  notice: UpdateNotice | null
  onClose: () => void
}

/**
 * 更新完成提示（#108）：自更新重启后的首次启动弹出，展示更新到的版本、
 * 新旧版本号与本次更新内容（changelog），避免用户再去设置页翻版本号。
 *
 * 数据源是旧进程退出前由 `run_updater` 写下的交接文件（读后即删，只弹一次）；
 * App.tsx 已做版本守卫（notice.version === 当前运行版本）才会渲染本组件。
 */
export default function UpdateCompleteDialog({ open, notice, onClose }: Props) {
  const { t } = useI18n()

  if (!notice) return null

  const version = (notice.version || '').replace(/^v+/, '')
  const previous = (notice.previousVersion || '').replace(/^v+/, '')
  // 与旧版相同（理论上不会出现，守卫已过滤跨版本）时不展示迁移行，避免 "→ 同版本" 的噪音。
  const showPrevious = previous !== '' && previous !== version
  const releaseUrl = `${REPOSITORY_URL}/releases/tag/v${version}`
  const channelKey = trainLabelKey(trainOf(version))

  return (
    <Dialog open={open} onClose={onClose} closeOnBackdrop closeOnEsc>
      <DialogHeader onClose={onClose} className="min-h-[3.8125rem]">
        <DialogTitle className="flex min-w-0 items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 leading-snug [overflow-wrap:anywhere]">
            {t('dialogs.updateComplete.title')}
          </span>
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t('dialogs.updateComplete.description')}
        </p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {showPrevious && (
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">{previous}</span>
              <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            </span>
          )}
          <span className="min-w-0 break-words font-medium text-foreground">{version}</span>
          <span className="shrink-0 rounded-full border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t(channelKey)}
          </span>
          <button
            onClick={() => openUrl(releaseUrl).catch(() => window.open(releaseUrl, '_blank'))}
            className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            {t('dialogs.update.viewRelease')}
          </button>
        </div>

        <div className="max-h-56 overflow-y-auto [scrollbar-gutter:stable] break-words rounded-lg bg-background p-3 text-sm leading-relaxed text-muted-foreground prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{notice.changelog || t('dialogs.update.noNotes')}</Markdown>
        </div>
      </DialogBody>
      <DialogFooter className="min-h-[4.0625rem] flex-wrap gap-2">
        <Button size="sm" onClick={onClose}>
          {t('dialogs.updateComplete.dismiss')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
