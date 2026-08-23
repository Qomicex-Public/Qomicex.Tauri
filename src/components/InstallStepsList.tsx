import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleCheck, faCircleNotch, faCircle, faCircleXmark } from '@fortawesome/free-solid-svg-icons'
import { useI18n } from '../i18n/index.tsx'
import type { InstallStepInfo } from '../types/index.ts'
import { cn } from '../lib/utils.ts'

interface InstallStepsListProps {
  steps: InstallStepInfo[]
  className?: string
}

/** 安装管线分步列表（后端 SSE 下发的 steps 渲染；活跃步骤显示字节百分比）。 */
export default function InstallStepsList({ steps, className }: InstallStepsListProps) {
  const { t } = useI18n()
  return (
    <ul className={cn('space-y-1', className)}>
      {steps.map((step) => {
        const labelKey = `downloads.steps.${step.id}` as const
        return (
          <li key={step.id} className="flex items-center gap-2 text-xs">
            {step.status === 'done' ? (
              <FontAwesomeIcon icon={faCircleCheck} className="h-3 w-3 shrink-0 text-emerald-400" />
            ) : step.status === 'active' ? (
              <FontAwesomeIcon icon={faCircleNotch} className="h-3 w-3 shrink-0 animate-spin text-primary" />
            ) : step.status === 'failed' ? (
              <FontAwesomeIcon icon={faCircleXmark} className="h-3 w-3 shrink-0 text-red-400" />
            ) : (
              <FontAwesomeIcon icon={faCircle} className="h-3 w-3 shrink-0 text-muted-foreground/30" />
            )}
            <span
              className={cn(
                'truncate',
                step.status === 'done' && 'text-muted-foreground/70',
                step.status === 'active' && 'font-medium text-foreground',
                step.status === 'pending' && 'text-muted-foreground/50',
                step.status === 'failed' && 'text-red-400'
              )}
            >
              {t(labelKey)}
            </span>
            {step.status === 'active' && (step.percent ?? 0) > 0 && (
              <span className="ml-auto shrink-0 tabular-nums text-primary">{Math.round(step.percent!)}%</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
