import { useEffect, useState } from 'react'
import { cn } from '../lib/utils.ts'
import { Button } from './ui'
import { useI18n } from '../i18n/index.tsx'

interface SplashScreenProps {
  state: 'loading' | 'ready' | 'error'
  onRetry: () => void
}

export function SplashScreen({ state, onRetry }: SplashScreenProps) {
  const { t } = useI18n()
  const [progress, setProgress] = useState(0)
  const [exiting, setExiting] = useState(false)
  const [mounted, setMounted] = useState(true)

  useEffect(() => {
    if (state === 'loading') {
      setProgress(0)
      setExiting(false)
      setMounted(true)
      const t1 = setTimeout(() => setProgress(25), 300)
      const t2 = setTimeout(() => setProgress(45), 800)
      const t3 = setTimeout(() => setProgress(70), 1400)
      const t4 = setTimeout(() => setProgress(85), 2200)
      const t5 = setTimeout(() => setProgress(95), 3200)
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); clearTimeout(t5) }
    }
    if (state === 'ready') {
      setProgress(100)
      setExiting(true)
      const t = setTimeout(() => setMounted(false), 600)
      return () => clearTimeout(t)
    }
  }, [state])

  if (!mounted) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-8 bg-background cursor-default select-none',
        exiting && 'opacity-0 transition-opacity duration-500'
      )}
    >
      {/* 顶部 36px 拖动条（与主窗口 TitleBar 等高）：启动阶段只保留这一条可拖，
          不再整屏可拖——否则触控板在启屏背景上"按住带位移"就会拖动整个窗口 */}
      <div data-qomicex-drag-region className="absolute inset-x-0 top-0 h-9" />
      <img src="/logo.svg" alt="Qomicex" className="h-24 w-24" />
      <div className="flex w-72 flex-col items-center gap-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-[400ms] ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        {state === 'loading' && (
          <p className="text-sm text-muted-foreground">
            {progress < 60 ? t('tools.splash.preparing') : t('tools.splash.almostReady')}
          </p>
        )}
      </div>
      {state === 'error' && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-destructive font-medium">{t('running.launchFailedTitle')}</p>
          <Button onClick={onRetry}>{t('common.retry')}</Button>
        </div>
      )}
    </div>
  )
}
