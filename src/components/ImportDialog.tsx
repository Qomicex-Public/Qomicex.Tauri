import { useState, useRef, useEffect, useCallback } from 'react'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '../components/ui'
import { Button } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Separator } from '../components/ui'
import { parseModpackFile, startModpackInstall, getInstallProgress } from '../api/instance.ts'
import type { ModpackParseResult, InstallProgressResponse } from '../types/index.ts'
import { useNavigate } from 'react-router-dom'
import { addTask } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'

const STAGE_KEYS: readonly string[] = [
  'queued', 'downloading-json', 'downloading', 'downloading-libraries',
  'downloading-assets', 'downloading-mainjar', 'downloading-loader',
  'downloading-loader-libs', 'installing-loader', 'downloading-addons',
  'downloading-modpack', 'parsing-modpack', 'modpack-files', 'modpack-overrides',
]

interface Props {
  open: boolean
  onClose: () => void
  gameDir: string
  versionIsolation: boolean
}

export default function ImportDialog({ open, onClose, gameDir, versionIsolation }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [step, setStep] = useState<'select' | 'parsing' | 'preview' | 'installing'>('select')
  const [parsed, setParsed] = useState<ModpackParseResult | null>(null)
  const [instanceName, setInstanceName] = useState('')
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
        }
      } catch { /* retry next tick */ }
    }, 500)
    return () => stopPolling()
  }, [step, installingInstanceId, stopPolling])

  const handleFileSelect = async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) return
    setStep('parsing')
    setError('')
    setProgress(null)
    try {
      const result = await parseModpackFile(file)
      setParsed(result)
      setInstanceName(result.name)
      setStep('preview')
    } catch (e: any) {
      setError(e.message || t('dialogs.import.parseFailed'))
      setStep('select')
    }
  }

  const handleInstall = async () => {
    if (!parsed) return
    setStep('installing')
    setError('')
    setProgress(null)
    try {
      const { instanceId } = await startModpackInstall({
        name: instanceName,
        gameVersion: parsed.gameVersion,
        loader: parsed.loader,
        loaderVersion: parsed.loaderVersion,
        gameDir,
        versionIsolation,
        modpackFiles: parsed.files,
        overridesZip: parsed.overridesZip,
        iconData: parsed.iconData,
        modpackName: parsed.name,
        modpackVersion: parsed.version,
        modpackAuthor: parsed.author,
        modpackSummary: parsed.summary,
      })
      addTask({
        id: instanceId,
        name: instanceName,
        type: 'modpack',
        gameVersion: parsed.gameVersion,
        loader: parsed.loader,
        loaderVersion: parsed.loaderVersion ?? undefined,
        status: 'downloading',
        progress: 0,
        createdAt: new Date().toISOString(),
        instanceId,
      })
      setInstallingInstanceId(instanceId)
    } catch (e: any) {
      setError(e.message || t('dialogs.import.installFailed'))
      setStep('preview')
    }
  }

  const reset = () => {
    stopPolling()
    setStep('select')
    setParsed(null)
    setInstallingInstanceId(null)
    setProgress(null)
    setError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const isComplete = progress?.status === 'completed'
  const isFailed = progress?.status === 'failed' || progress?.status === 'cancelled'

  return (
    <Dialog open={open} onClose={() => { reset(); onClose() }}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.import.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {step === 'select' && (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".mrpack,.zip"
              onChange={handleFileSelect}
              className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-primary file:text-primary-foreground"
            />
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        )}

        {step === 'parsing' && (
          <p className="text-muted-foreground">{t('dialogs.import.parsing')}</p>
        )}

        {step === 'preview' && parsed && (
          <div className="space-y-4">
            <div>
              <Label>{t('dialogs.import.modpackName')}</Label>
              <p className="text-sm font-medium">{parsed.name}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{t('dialogs.import.gameVersion')}</Label>
                <p className="text-sm">{parsed.gameVersion}</p>
              </div>
              <div>
                <Label>{t('dialogs.import.loader')}</Label>
                <p className="text-sm">{parsed.loader} {parsed.loaderVersion}</p>
              </div>
            </div>
            <Separator />
            <div>
              <Label htmlFor="inst-name">{t('dialogs.import.instanceName')}</Label>
              <Input id="inst-name" value={instanceName} onChange={e => setInstanceName(e.target.value)} />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { reset(); onClose() }}>{t('common.cancel')}</Button>
              <Button onClick={handleInstall}>{t('dialogs.import.startInstall')}</Button>
            </div>
          </div>
        )}

        {step === 'installing' && (
          <div className="space-y-4">
            {!progress && <p className="text-muted-foreground">{t('dialogs.import.connecting')}</p>}
            {progress && !isComplete && !isFailed && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{t('dialogs.import.installing', { name: instanceName })}</span>
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
                <p className="font-medium text-foreground">{t('dialogs.import.completed')}</p>
                <p className="mt-1">{t('dialogs.import.completedDetail', { name: instanceName })}</p>
              </div>
            )}
            {isFailed && (
              <div className="text-sm text-destructive">
                {t('dialogs.import.failedWith', { error: progress?.error || error || t('dialogs.import.seeDownloadPage') })}
              </div>
            )}
            <div className="flex justify-end gap-2">
              {(isComplete || isFailed) && installingInstanceId && (
                <Button variant="outline" onClick={() => { reset(); onClose(); navigate(`/instances/${installingInstanceId}`) }}>
                  {t('dialogs.import.viewInstance')}
                </Button>
              )}
              {!isComplete && !isFailed && (
                <Button variant="outline" onClick={() => { reset(); onClose() }}>{t('dialogs.import.backgroundDownload')}</Button>
              )}
              {(isComplete || isFailed) && (
                <Button onClick={() => { reset(); onClose() }}>{t('common.close')}</Button>
              )}
            </div>
          </div>
        )}
      </DialogBody>
    </Dialog>
  )
}
