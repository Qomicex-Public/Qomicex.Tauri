import { useState, useRef, useEffect, useCallback } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Separator } from './ui'
import { startModpackInstall, resolveModpack, getInstallProgress } from '../api/instance.ts'
import type { ResourceVersion, InstallProgressResponse } from '../types/index.ts'
import { useNavigate } from 'react-router-dom'
import { addTask, updateTask, removeTask } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'

const STAGE_KEYS: readonly string[] = [
  'queued', 'downloading-json', 'downloading', 'downloading-libraries',
  'downloading-assets', 'downloading-mainjar', 'downloading-loader',
  'downloading-loader-libs', 'installing-loader', 'downloading-addons',
  'downloading-modpack', 'parsing-modpack', 'modpack-files', 'modpack-overrides',
]

interface ModpackInstallDialogProps {
  open: boolean
  onClose: () => void
  modpackName: string
  projectId: string
  source: string
  selectedVersion: ResourceVersion | null
  gameDir: string
  versionIsolation: boolean
}

export default function ModpackInstallDialog({
  open, onClose, modpackName, projectId, source, selectedVersion, gameDir, versionIsolation,
}: ModpackInstallDialogProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [step, setStep] = useState<'config' | 'installing'>('config')
  const [instanceName, setInstanceName] = useState(modpackName)
  const [installingInstanceId, setInstallingInstanceId] = useState<string | null>(null)
  const [progress, setProgress] = useState<InstallProgressResponse | null>(null)
  const [error, setError] = useState('')

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  useEffect(() => { return () => stopPolling() }, [stopPolling])

  useEffect(() => {
    if (step !== 'installing' || !installingInstanceId) { stopPolling(); return }
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const p = await getInstallProgress(installingInstanceId)
        setProgress(p)
        if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') {
          stopPolling()
          if (p.status === 'completed') {
            updateTask(installingInstanceId, { status: 'completed', progress: 100, completedAt: new Date().toISOString() })
          } else {
            updateTask(installingInstanceId, { status: 'failed', progress: Math.round(p.progress), error: p.error || (p.status === 'cancelled' ? t('dialogs.modpackInstall.cancelled') : t('dialogs.modpackInstall.installFailed')) })
          }
        }
      } catch { /* retry next tick */ }
    }, 500)
    return () => stopPolling()
  }, [step, installingInstanceId, stopPolling])

  const handleInstall = async () => {
    if (!selectedVersion) return
    setStep('installing')
    setError('')
    setProgress(null)

    const taskId = `modpack-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    addTask({
      id: taskId,
      name: instanceName,
      type: 'modpack',
      gameVersion: selectedVersion.gameVersions[0] || '',
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
    })

    try {
      const resolved = await resolveModpack(source, projectId, selectedVersion.id)
      const { instanceId } = await startModpackInstall({
        name: instanceName,
        gameVersion: selectedVersion.gameVersions[0] || resolved.gameVersion,
        loader: resolved.loader,
        loaderVersion: resolved.loaderVersion,
        gameDir,
        versionIsolation,
        modpackFiles: resolved.files,
        overridesZip: resolved.overridesZip,
        iconData: resolved.iconData,
        modpackName: resolved.name,
        modpackVersion: resolved.version,
        modpackAuthor: resolved.author,
        modpackSummary: resolved.summary,
        source,
        projectId,
        versionId: selectedVersion.id,
      })
      addTask({
        id: instanceId,
        name: instanceName,
        type: 'modpack',
        gameVersion: selectedVersion.gameVersions[0] || '',
        loader: resolved.loader,
        loaderVersion: resolved.loaderVersion ?? undefined,
        status: 'downloading',
        progress: 0,
        icon: resolved.iconData ?? undefined,
        createdAt: new Date().toISOString(),
        instanceId,
      })
      removeTask(taskId)
      setInstallingInstanceId(instanceId)
    } catch (e: any) {
      updateTask(taskId, {
        status: 'failed',
        error: e.message || t('dialogs.modpackInstall.installFailed'),
      })
      setError(e.message || t('dialogs.modpackInstall.installFailed'))
      setStep('config')
    }
  }

  const isComplete = progress?.status === 'completed'
  const isFailed = progress?.status === 'failed' || progress?.status === 'cancelled'

  return (
    <Dialog open={open} onClose={() => { stopPolling(); onClose() }}>
      <DialogHeader onClose={() => { stopPolling(); onClose() }}>
        <DialogTitle>{t('dialogs.modpackInstall.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {step === 'config' && (
          <>
            <div>
              <Label>{t('dialogs.modpackInstall.modpackLabel')}</Label>
              <p className="text-sm font-medium">{modpackName}</p>
            </div>
            {selectedVersion && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{t('common.version')}</Label>
                  <p className="text-sm">{selectedVersion.name}</p>
                </div>
                <div>
                  <Label>{t('dialogs.modpackInstall.gameVersion')}</Label>
                  <p className="text-sm">{selectedVersion.gameVersions.join(', ')}</p>
                </div>
              </div>
            )}
            <Separator />
            <div>
              <Label htmlFor="inst-name">{t('dialogs.modpackInstall.instanceName')}</Label>
              <Input id="inst-name" value={instanceName} onChange={e => setInstanceName(e.target.value)} />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter className="border-0 px-0 pb-0">
              <Button variant="outline" onClick={() => { stopPolling(); onClose() }}>{t('common.cancel')}</Button>
              <Button onClick={handleInstall}>{t('dialogs.modpackInstall.startInstall')}</Button>
            </DialogFooter>
          </>
        )}

        {step === 'installing' && (
          <>
            {!progress && <p className="text-muted-foreground">{t('dialogs.modpackInstall.resolving')}</p>}
            {progress && !isComplete && !isFailed && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{t('dialogs.modpackInstall.installing', { name: instanceName })}</span>
                    <span className="font-medium">{Math.round(progress.progress)}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.progress}%` }} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{STAGE_KEYS.includes(progress.stage) ? t(`dialogs.stage.${progress.stage}`) : (STAGE_KEYS.includes(progress.status) ? t(`dialogs.stage.${progress.status}`) : (progress.stage || progress.status))}</span>
                  {progress.currentFileProgress > 0 && <span>({Math.round(progress.currentFileProgress)}%)</span>}
                  {progress.totalFiles != null && progress.totalFiles > 0 && <span>{progress.completedFiles ?? 0}/{progress.totalFiles}</span>}
                </div>
                {progress.currentFile && (
                  <p className="truncate text-xs text-muted-foreground">{progress.currentFile}</p>
                )}
              </>
            )}
            {isComplete && (
              <div className="text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">{t('dialogs.modpackInstall.completed')}</p>
                <p className="mt-1">{t('dialogs.modpackInstall.completedDetail', { name: instanceName })}</p>
              </div>
            )}
            {isFailed && (
              <div className="text-sm text-destructive">
                {t('dialogs.modpackInstall.failedWith', { error: progress?.error || error || t('dialogs.modpackInstall.seeDownloadPage') })}
              </div>
            )}
            <DialogFooter className="border-0 px-0 pb-0">
              {(isComplete || isFailed) && installingInstanceId && (
                <Button variant="outline" onClick={() => { stopPolling(); onClose(); navigate(`/instances/${installingInstanceId}`) }}>
                  {t('dialogs.modpackInstall.viewInstance')}
                </Button>
              )}
              {!isComplete && !isFailed && (
                <Button variant="outline" onClick={() => { stopPolling(); onClose() }}>{t('dialogs.modpackInstall.backgroundDownload')}</Button>
              )}
              {(isComplete || isFailed) && (
                <Button onClick={() => { stopPolling(); onClose() }}>{t('common.close')}</Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogBody>
    </Dialog>
  )
}
