import { useRef } from 'react'
import { RotateCw } from 'lucide-react'
import { Dialog, DialogHeader, DialogTitle, DialogBody } from './ui'
import InstallStepsList from './InstallStepsList.tsx'
import type { InstallStepInfo } from '../types/index.ts'
import { useRunning } from '../contexts/RunningContext.tsx'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../lib/utils.ts'

/** 启动阶段 → 分步显示的固定步骤（repairing 是"检查完整性"的进行中子状态）。 */
const STEP_STAGES: ReadonlyArray<{ id: string; stages: readonly string[] }> = [
  { id: 'checking', stages: ['starting', 'checking', 'repairing'] },
  { id: 'preparing', stages: ['preparing'] },
  { id: 'launching', stages: ['launching'] },
]

const FINAL_STAGES = ['completed', 'crashed', 'failed']
const ERROR_STAGES = ['crashed', 'failed']

/** 由当前 stage 派生分步状态；failed/crashed 时以最后已知非终态 stage 定位失败步。 */
function deriveSteps(stage: string, lastStage: string, progress: number): InstallStepInfo[] {
  const locating = ERROR_STAGES.includes(stage) ? lastStage : stage
  const activeIndex = STEP_STAGES.findIndex((s) => s.stages.includes(locating))
  return STEP_STAGES.map((s, i) => {
    if (stage === 'completed' || i < activeIndex) return { id: s.id, status: 'done' as const }
    if (i === activeIndex) {
      if (ERROR_STAGES.includes(stage)) return { id: s.id, status: 'failed' as const }
      // repairing 子阶段用文件数百分比
      const percent = locating === 'repairing' ? progress : undefined
      return { id: s.id, status: 'active' as const, percent }
    }
    return { id: s.id, status: 'pending' as const }
  })
}

export default function LaunchProgressDialog() {
  const { t } = useI18n()
  const { launchProgress, crashDialogState, cancelLaunch } = useRunning()
  const lastStageRef = useRef('starting')

  if (!launchProgress) return null
  if (crashDialogState) return null

  if (!FINAL_STAGES.includes(launchProgress.stage) && !ERROR_STAGES.includes(launchProgress.stage)) {
    lastStageRef.current = launchProgress.stage
  }

  const isFinal = FINAL_STAGES.includes(launchProgress.stage)
  const isError = ERROR_STAGES.includes(launchProgress.stage)

  const overrideDetail = { message: launchProgress.message, stage: launchProgress.stage }
  const oe = new CustomEvent('plugin:launch-progress-override', { detail: overrideDetail, cancelable: true })
  window.dispatchEvent(oe)
  const displayMessage = overrideDetail.message

  const steps = deriveSteps(
    launchProgress.stage,
    lastStageRef.current,
    launchProgress.totalFiles && launchProgress.completedFiles
      ? (launchProgress.completedFiles / launchProgress.totalFiles) * 100
      : 0,
  )

  return (
    <Dialog open onClose={() => cancelLaunch()} closeOnBackdrop={isFinal} closeOnEsc={isFinal}>
      <DialogHeader onClose={() => cancelLaunch()}>
        <DialogTitle>{isError ? t('dialogs.launchProgress.titleFailed') : t('dialogs.launchProgress.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <InstallStepsList steps={steps} keyPrefix="dialogs.launchProgress.stage" />
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{displayMessage}</span>
          <span className={cn('font-medium tabular-nums', isError && 'text-destructive')}>{Math.round(launchProgress.progress)}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', isError ? 'bg-destructive' : 'bg-primary')}
            style={{ width: `${launchProgress.progress}%` }}
          />
        </div>
        {launchProgress.error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{launchProgress.error}</p>
        )}
        {launchProgress.crashReport && (
          <details className="rounded-lg border border-border bg-muted/30">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">{t('dialogs.launchProgress.viewCrashReport')}</summary>
            <pre className="max-h-48 overflow-auto px-3 pb-3 text-[11px] text-muted-foreground">{launchProgress.crashReport}</pre>
          </details>
        )}
        {launchProgress.stage === 'running' && launchProgress.processId && (
          <p className="text-xs text-muted-foreground">{t('dialogs.launchProgress.processId', { pid: launchProgress.processId })}</p>
        )}
        {!isFinal ? (
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <RotateCw className="h-3 w-3 animate-spin" />
              {t('dialogs.launchProgress.startingUp')}
            </span>
            <button onClick={() => cancelLaunch()} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground">{t('common.cancel')}</button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 pt-2">
            <button onClick={() => cancelLaunch()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">{t('common.close')}</button>
          </div>
        )}
      </DialogBody>
    </Dialog>
  )
}
