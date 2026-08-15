import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faStop, faGamepad, faCube } from '@fortawesome/free-solid-svg-icons'
import { useRunning } from '../contexts/RunningContext.tsx'
import { Button } from '../components/ui'
import { Card, CardContent } from '../components/ui'
import { PageHeader } from '../components/PageHeader.tsx'
import { usePageAnimation } from '../hooks/usePageAnimation.ts'
import { useI18n } from '../i18n/index.tsx'

function formatElapsed(startedAt: number, now: number, t: ReturnType<typeof useI18n>['t']): string {
  const sec = Math.floor((now - startedAt) / 1000)
  if (sec < 60) return t('running.timeSeconds', { count: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('running.timeMinutes', { count: min, sec: sec % 60 })
  const h = Math.floor(min / 60)
  return t('running.timeHours', { hours: h, mins: min % 60 })
}

export default function RunningInstances() {
  const { runningInstances, killInstance } = useRunning()
  const navigate = useNavigate()
  const pageRef = usePageAnimation()
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (runningInstances.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [runningInstances.length])

  return (
    <div ref={pageRef} className="flex flex-1 min-h-0 flex-col overflow-y-auto p-8">
      <PageHeader
        title={t('running.title')}
        subtitle={runningInstances.length > 0 ? t('running.instancesRunning', { count: runningInstances.length }) : undefined}
      />

      {runningInstances.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted/50">
            <FontAwesomeIcon icon={faGamepad} className="h-10 w-10 opacity-30" />
          </div>
          <p className="text-sm">{t('running.noRunningGame')}</p>
          <Button variant="outline" size="sm" onClick={() => navigate('/instances')}>
            <FontAwesomeIcon icon={faCube} className="h-4 w-4" />{t('running.goToInstances')}
          </Button>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {runningInstances.map(inst => (
            <Card key={inst.instanceId} className="overflow-hidden">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
                      <button
                        onClick={() => navigate(`/instances/${inst.instanceId}`)}
                        className="text-base font-semibold truncate hover:underline"
                      >
                        {inst.name}
                      </button>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t('running.runningFor', { time: formatElapsed(inst.startedAt, now, t) })}
                    </p>
                    {inst.processId && (
                      <p className="mt-1 text-xs text-muted-foreground/60">PID: {inst.processId}</p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-shrink-0 text-muted-foreground hover:text-destructive hover:border-destructive/50"
                    onClick={() => killInstance(inst.instanceId)}
                  >
                    <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
