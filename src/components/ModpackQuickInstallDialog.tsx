import { useEffect, useState } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Separator } from './ui'
import { Select, SelectOption } from './ui'
import { Layers, RotateCw } from 'lucide-react'
import { startModpackInstall, resolveModpack, installModpackDirect } from '../api/instance.ts'
import { getResourceVersions } from '../api/resource.ts'
import { loadSettings } from '../api/settings.ts'
import type { ResourceVersion } from '../types/index.ts'
import { useNavigate } from 'react-router-dom'
import { addTask, updateTask, removeTask } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'

interface ModpackQuickInstallDialogProps {
  open: boolean
  onClose: () => void
  modpackName: string
  projectId: string
  source: string
  iconUrl?: string
}

/**
 * Technic 安装是「一个包 = 一个直链」，没有版本/fileId 概念（issue #151，ADR-105）。
 *
 * 后端 `/modpack/install-direct` 的 technic 分支自行从 Technic API 解析直链并
 * 下载导入，因此前端**不需要**也不应该传 URL——只给 slug（projectId）。
 */
const isTechnic = (source: string) => source.toLowerCase() === 'technic'

export default function ModpackQuickInstallDialog({
  open, onClose, modpackName, projectId, source, iconUrl,
}: ModpackQuickInstallDialogProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [step, setStep] = useState<'config' | 'starting'>('config')
  const [instanceName, setInstanceName] = useState(modpackName)
  const [error, setError] = useState('')
  const [versions, setVersions] = useState<ResourceVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<ResourceVersion | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [gameDir, setGameDir] = useState('')
  const [versionIsolation, setVersionIsolation] = useState(true)

  useEffect(() => {
    if (!open) return
    setStep('config')
    setInstanceName(modpackName)
    setError('')
    setSelectedVersion(null)
    setVersions([])
    let cancelled = false
    ;(async () => {
      try {
        const settings = await loadSettings()
        if (!cancelled) {
          setGameDir(settings.gameDir)
          setVersionIsolation(settings.versionIsolation ?? true)
        }
      } catch { /* keep defaults */ }
      // Technic：无版本列表可拉（后端会自行解析直链 + 包内元数据确定版本），
      // 直接进入可安装状态，不请求 /resources/{id}/versions。
      if (isTechnic(source)) {
        if (!cancelled) setLoadingVersions(false)
        return
      }
      setLoadingVersions(true)
      try {
        const vlist = await getResourceVersions(projectId, source)
        if (cancelled) return
        const sorted = [...vlist].sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime())
        setVersions(sorted)
        if (sorted.length > 0) setSelectedVersion(sorted[0])
      } catch {
        if (!cancelled) setError(t('dialogs.resourceInstall.versionsLoadFailed'))
      }
      if (!cancelled) setLoadingVersions(false)
    })()
    return () => { cancelled = true }
  }, [open, modpackName, projectId, source, t])

  const handleInstall = async () => {
    const technic = isTechnic(source)
    // 非 Technic 必须有选中版本；Technic 无版本概念，跳过该前置。
    if (!technic && !selectedVersion) return
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
      if (technic) {
        // Technic：后端解析直链 → 下载 → 期1 导入管线；前端只给 slug。
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
        <DialogTitle className="flex items-center gap-2">
          {iconUrl ? (
            <img src={iconUrl} alt="" className="h-5 w-5 rounded object-cover" />
          ) : (
            <Layers className="h-4 w-4 text-muted-foreground" />
          )}
          {t('dialogs.modpackInstall.title')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {step === 'config' && (
          <>
            <div>
              <Label>{t('dialogs.modpackInstall.modpackLabel')}</Label>
              <p className="text-sm font-medium">{modpackName}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('dialogs.resourceInstall.selectVersion')}</Label>
              {isTechnic(source) ? (
                // Technic 无版本列表：包内元数据（version.json / fmlversion.properties）
                // 决定 MC 与 loader，安装时由后端解析，此处无需用户选择。
                <p className="text-xs text-muted-foreground">{t('dialogs.modpackInstall.technicNoVersion')}</p>
              ) : loadingVersions ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <RotateCw className="h-3 w-3 animate-spin" />
                  {t('dialogs.resourceInstall.loadingVersions')}
                </div>
              ) : (
                <>
                  <Select
                    value={selectedVersion?.id ?? ''}
                    onChange={(val) => setSelectedVersion(versions.find(v => v.id === val) ?? null)}
                  >
                    <SelectOption value="">{t('dialogs.resourceInstall.selectVersionPlaceholder')}</SelectOption>
                    {versions.length === 0 ? (
                      <SelectOption value="" disabled>{t('dialogs.resourceInstall.noVersions')}</SelectOption>
                    ) : (
                      versions.map(v => (
                        <SelectOption key={v.id} value={v.id}>{v.versionNumber}</SelectOption>
                      ))
                    )}
                  </Select>
                  {selectedVersion && selectedVersion.gameVersions.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('dialogs.modpackInstall.gameVersion')}: {selectedVersion.gameVersions.join(', ')}
                    </p>
                  )}
                </>
              )}
            </div>
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
          <Button onClick={handleInstall} disabled={(!isTechnic(source) && !selectedVersion) || loadingVersions}>{t('dialogs.modpackInstall.startInstall')}</Button>
        </DialogFooter>
      )}
    </Dialog>
  )
}