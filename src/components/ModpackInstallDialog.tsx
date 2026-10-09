import { useState } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Separator } from './ui'
import { startModpackInstall, resolveModpack, installModpackDirect } from '../api/instance.ts'
import type { ResourceVersion } from '../types/index.ts'
import { useNavigate } from 'react-router-dom'
import { addTask, updateTask, removeTask } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'

/**
 * Technic 是「一个包 = 一个直链」，无版本/fileId 概念（issue #151，ADR-105）。
 *
 * 后端 `/modpack/install-direct` 的 technic 分支自行解析直链并下载导入，
 * 前端只传 slug（projectId）——不传 URL。
 */
const isTechnic = (source: string) => source.toLowerCase() === 'technic'

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
    // Technic 无版本选择（包内元数据决定），故不要求 selectedVersion。
    if (!selectedVersion && !isTechnic(source)) return
    setStep('starting')
    setError('')

    const taskId = `modpack-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    addTask({
      id: taskId,
      name: instanceName,
      type: 'modpack',
      gameVersion: selectedVersion?.gameVersions[0] || '',
      status: 'queued',
      progress: 0,
      icon: iconUrl,
      createdAt: new Date().toISOString(),
    })

    try {
      if (isTechnic(source)) {
        // 后端解析直链 → 下载 → 期1 导入管线（technic_import_impl）。
        const { instanceId } = await installModpackDirect({
          id: instanceName,
          type: 'technic',
          projectId,
          gameDir,
          versionIsolation,
        })
        removeTask(taskId)
        addTask({
          id: instanceId,
          name: instanceName,
          type: 'modpack',
          gameVersion: '',
          status: 'downloading',
          progress: 0,
          icon: iconUrl,
          createdAt: new Date().toISOString(),
          instanceId,
        })
        onClose()
        navigate('/downloads')
        return
      }
      const resolved = await resolveModpack(source, projectId, selectedVersion!.id)
      const { instanceId } = await startModpackInstall({
        name: instanceName,
        gameVersion: selectedVersion!.gameVersions[0] || resolved.gameVersion,
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
        versionId: selectedVersion!.id,
        // 资源中心安装标记（issue #118）：使该实例可原地更新。
        // 只有本对话框与 ModpackQuickInstallDialog 发送；本地导入/拖入/MultiMC 不发。
        origin: 'resource-center',
        versionPublishedAt: selectedVersion!.datePublished || null,
      })
      removeTask(taskId)
      addTask({
        id: instanceId,
        name: instanceName,
        type: 'modpack',
        gameVersion: selectedVersion!.gameVersions[0] || resolved.gameVersion,
        loader: resolved.loader || undefined,
        loaderVersion: resolved.loaderVersion || undefined,
        status: 'downloading',
        progress: 0,
        icon: iconUrl,
        createdAt: new Date().toISOString(),
        instanceId,
      })
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
