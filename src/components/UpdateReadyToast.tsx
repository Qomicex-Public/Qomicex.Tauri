import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import { Tooltip } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { useUpdaterStore } from '../stores/updaterStore.ts'

/**
 * 「已准备好安装更新」Toast。
 *
 * 自动模式下后台静默下载完成后弹出，取代原来的更新对话框：点击横幅主体立即
 * 重启安装；点 ✕ 表示「本次先不提示」。**两种情况下记录都留在磁盘上，下次启动
 * 都会自动安装完成**——即「现在装，或下次启动自动装」的二选一。要彻底关掉自动
 * 流程请用设置里的「自动下载并安装更新」开关（那是唯一的持久出口）。
 *
 * 为什么不用 `useMessageBox().notify`：现有 notify 是不可点击的 3 秒短提示，
 * 而这条提示需要「点击触发安装」与「持久可见直到用户处理」两个能力。
 *
 * 渲染在 portal 里而非 App 的组件树内：它要贴在窗口底部居中，不能被路由或
 * Layout 的 overflow 裁掉。
 */
export default function UpdateReadyToast() {
  const { t } = useI18n()
  const staged = useUpdaterStore((s) => s.staged)
  const phase = useUpdaterStore((s) => s.phase)
  const toastDismissed = useUpdaterStore((s) => s.toastDismissed)
  const installStaged = useUpdaterStore((s) => s.installStaged)
  const dismissStaged = useUpdaterStore((s) => s.dismissStaged)

  // 只在「包已下好、等安装」且用户本次会话没关掉它时展示。installing 阶段横幅
  // 消失（进程马上退出，留着反而让人以为还能取消）。
  if (!staged || phase !== 'ready' || toastDismissed) return null

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[110] flex justify-center px-4">
      <div
        role="button"
        tabIndex={0}
        onClick={() => { void installStaged() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            void installStaged()
          }
        }}
        className="glass-surface pointer-events-auto flex w-fit max-w-[min(92vw,560px)] cursor-pointer items-center gap-3 rounded-xl border border-border/50 bg-popover/90 py-2.5 pl-3 pr-2 text-sm shadow-2xl backdrop-blur-lg transition-all duration-300 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* 绿色方块 + 白勾：与截图一致的「成功/就绪」视觉锚点 */}
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/90 text-white"
        >
          <Check className="h-5 w-5" strokeWidth={3} />
        </span>

        <span className="min-w-0 leading-snug [overflow-wrap:anywhere]">
          {t('dialogs.updateReady.message')}
          {staged.version && (
            <span className="ml-1 text-xs text-muted-foreground">v{staged.version.replace(/^v/, '')}</span>
          )}
        </span>

        {/* ✕ 关闭 = 本次不再提示（磁盘记录保留，下次启动仍会自动装完）。
            stopPropagation 防止冒泡到横幅主体的「立即安装」——点关闭绝不能让应用重启。 */}
        <span className="ml-1 flex shrink-0 items-center">
          <Tooltip content={t('dialogs.updateReady.dismiss')}>
            <button
              type="button"
              aria-label={t('dialogs.updateReady.dismiss')}
              onClick={(e) => {
                e.stopPropagation()
                dismissStaged()
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </span>
      </div>
    </div>,
    document.body,
  )
}
