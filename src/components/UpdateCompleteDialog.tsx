import Markdown from 'react-markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Button } from './ui'
import { ArrowRight, CheckCircle2, CircleAlert, ExternalLink } from 'lucide-react'
import { useI18n } from '../i18n/index.tsx'
import { REPOSITORY_URL } from '../constants/credits.ts'
import { trainLabelKey, trainOf } from '../lib/updateChannel.ts'
import type { UpdateError, UpdateNotice } from '../api/update.ts'


/**
 * `last-update-error.json` 的机器码 → 文案 key。
 *
 * 码由 Qomicex.Updater 决定（`ELEVATION_DENIED` / `UPDATE_INSTALL_FAILED` /
 * `UPDATE_WAIT_TIMEOUT`），这里只做映射——未知码走 `failed.unknown`，
 * 上游新增码时最多少一句定制文案，不会渲染成空白。
 */
const FAILURE_REASON_KEYS: Record<string, string> = {
  ELEVATION_DENIED: 'dialogs.updateComplete.failed.elevationDenied',
  UPDATE_INSTALL_FAILED: 'dialogs.updateComplete.failed.installFailed',
  UPDATE_WAIT_TIMEOUT: 'dialogs.updateComplete.failed.waitTimeout',
}

interface Props {
  open: boolean
  notice: UpdateNotice | null
  /** updater 落下的「这次更新没成」交接（读后即删，见 api/update.ts） */
  error: UpdateError | null
  onClose: () => void
}

/**
 * 更新完成提示（#108）：自更新重启后的首次启动弹出，展示更新到的版本、
 * 新旧版本号与本次更新内容（changelog），避免用户再去设置页翻版本号。
 *
 * 两份交接都来自 `{dataDir}/updates/`，各自有独立的 claim 锁、各只提示一次：
 * - `notice`：updater **装成功**并重启后的自报家门（App.tsx 已做版本守卫）；
 * - `error`：updater **没装成**（提权被拒 / 覆盖失败 / 旧进程没退出）。
 *
 * `error` 这条是 issue #201 要的可见性：updater 是 detached 进程，它失败退出时
 * 旧启动器早已退出，屏幕上原本不会留下任何痕迹——用户只能看到「应用自己消失了」。
 * 两份同时存在时以 `notice` 为准（成功比旧的失败更贴近当前事实）。
 */
export default function UpdateCompleteDialog({ open, notice, error, onClose }: Props) {
  const { t } = useI18n()

  if (!notice && error) {
    const failedVersion = (error.version || '').replace(/^v+/, '')
    return (
      <Dialog open={open} onClose={onClose} closeOnBackdrop closeOnEsc>
        <DialogHeader onClose={onClose} className="min-h-[3.8125rem]">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <CircleAlert className="h-4 w-4 shrink-0 text-destructive" />
            <span className="min-w-0 leading-snug [overflow-wrap:anywhere]">
              {t('dialogs.updateComplete.failed.title')}
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm leading-relaxed text-foreground">
            {t(FAILURE_REASON_KEYS[error.code] ?? 'dialogs.updateComplete.failed.unknown')}
          </p>
          {failedVersion && (
            <p className="text-xs text-muted-foreground">
              {t('dialogs.updateComplete.failed.target')}{' '}
              <span className="font-medium text-foreground">{failedVersion}</span>
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {error.strategy === 'system'
              ? t('dialogs.updateComplete.failed.hintSystem')
              : t('dialogs.updateComplete.failed.hint')}
          </p>
          <div className="break-words rounded-lg border bg-background p-2">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {t('dialogs.updateComplete.failed.detail')}
            </p>
            {/* message 是 updater 落的 OS 报错原文，不进翻译，只作诊断展示 */}
            <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
              {error.message}
            </p>
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
