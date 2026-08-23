import { useState } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Separator } from './ui'
import { startModpackInstall, resolveModpack } from '../api/instance.ts'
import type { ResourceVersion } from '../types/index.ts'
import { useNavigate } from 'react-router-dom'
import { addTask, updateTask, removeTask } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'

interface ModpackInstallDialogProps {
  open: boolean
  onClose: () => void
  modpackName: string
  projectId: string
  source: string
  selectedVersion: ResourceVersion | null
  gameDir: string
  versionIsolation: boolean
  iconUrl?: string
}

export default function ModpackInstallDialog({
  open, onClose, modpackName, projectId, source, selectedVersion, gameDir, versionIsolation, iconUrl,
}: ModpackInstallDialogProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [step, setStep] = useState<'config' | 'starting'>('config')
  const [instanceName, setInstanceName] = useState(modpackName)
  const [error, setError] = useState('')

  const handleInstall = async () => {
    if (!selectedVersion) return
    setStep('starting')
    setError('')

    const taskId = `modpack-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    addTask({
      id: taskId,
      name: instanceName,
      type: 'modpack',
      gameVersion: selectedVersion.gameVersions[0] || '',
      status: 'queued',
      progress: 0,
      icon: iconUrl,
      createdAt: new Date().toISOString(),
    })

    try {
      const resolved = await resolveModpack(source, projectId, selectedVersion.id)
      await startModpackInstall({
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
      removeTask(taskId)
      onClose()
      navigate('/downloads')
    } catch (e: any) {
      updateTask(taskId, {
        status: 'failed',
        error: e.message || t('dialogs.modpackInstall.installFailed'),
      })
      setError(e.message || t('dialogs.modpackInstall.installFailed'))
      setStep('config')
    }
  }

  return (
    <Dialog open={open} onClose={() => { if (step === 'config') onClose() }}>
      <DialogHeader onClose={() => { if (step === 'config') onClose() }}>
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
          </>
        )}

        {step === 'starting' && (
          <p className="text-muted-foreground">{t('dialogs.modpackInstall.resolving')}</p>
        )}
      </DialogBody>
      {step === 'config' && (
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={handleInstall}>{t('dialogs.modpackInstall.startInstall')}</Button>
        </DialogFooter>
      )}
    </Dialog>
  )
}
