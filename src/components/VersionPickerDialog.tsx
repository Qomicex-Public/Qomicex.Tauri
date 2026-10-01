import { useEffect, useState, useCallback } from 'react'
import { RotateCw } from 'lucide-react'
import { ArrowLeftRight as ArrowLeftRightData, RotateCw as RotateCwData } from 'lucide'
import { MorphActionIcon } from './MorphActionIcon.tsx'
import { useMessageBox, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { cn } from '../lib/utils.ts'
import { getResourceVersions } from '../api/resource.ts'
import { quickInstallViaDownloadCenter } from '../lib/quickInstall.ts'
import { useI18n } from '../i18n/index.tsx'
import type { ModMetadata, ResourceVersion } from '../types/index.ts'

interface VersionPickerDialogProps {
  open: boolean
  onClose: () => void
  mod: ModMetadata | null
  instanceId: string
  gameVersion?: string
  loader?: string
  onDone: () => void
}

export default function VersionPickerDialog({
  open, onClose, mod, instanceId, gameVersion, loader, onDone,
}: VersionPickerDialogProps) {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [versions, setVersions] = useState<ResourceVersion[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !mod || !mod.source) return
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId
    if (!id) return
    setLoading(true)
    setError(null)
    const loaderType = (loader || '').toLowerCase() || undefined
    getResourceVersions(id, mod.source, gameVersion, loaderType)
      .then(setVersions)
      .catch(() => setVersions([]))
      .finally(() => setLoading(false))
  }, [open, mod, gameVersion, loader])

  const handleInstall = useCallback(async (version: ResourceVersion) => {
    if (!mod) return
    // 换版本必须有可下载文件：先校验再进下载中心，避免"什么都没发生"。
    const jarFile = version.downloads.find(f => f.fileName.endsWith('.jar')) ?? version.downloads[0]
    if (!jarFile) {
      setError(t('dialogs.versionPicker.noDownloadableFile'))
      return
    }
    setInstalling(version.id)
    setError(null)
    try {
      // 走下载中心：真实进度、真实下载记录（issue #117 的核心诉求）。
      // toDelete 传旧文件名 —— 下载成功后才由后端 replace（先删会让失败直接丢件）。
      await quickInstallViaDownloadCenter({
        instanceId,
        gameVersion: gameVersion ?? '',
        resourceTitle: mod.name,
        deps: [],
        main: {
          url: jarFile.url,
          fileName: jarFile.fileName,
          category: 'mods',
          name: mod.name,
          cnName: mod.chineseName ?? null,
        },
        toDelete: [{ fileName: mod.fileName, category: 'mods' }],
        taskName: t('dialogs.versionPicker.taskName', { name: mod.name }),
        icon: mod.iconUrl || (mod.iconBase64 ? `data:image/png;base64,${mod.iconBase64}` : undefined),
        t,
      })
      notify(t('dialogs.versionPicker.addedToDownloadCenter', { name: mod.name }), 'success')
      onDone()
      onClose()
    } catch (e) {
      // 失败必须可见：原实现只 console.error，用户只看到按钮弹回（issue #117）。
      const msg = e instanceof Error ? e.message : t('dialogs.versionPicker.switchFailed')
      setError(msg)
      notify(msg, 'error')
    } finally {
      setInstalling(null)
    }
  }, [mod, instanceId, gameVersion, onDone, onClose, notify, t])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.versionPicker.title', { name: mod?.name ?? '' })}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <RotateCw className="h-4 w-4 animate-spin" />{t('dialogs.versionPicker.loadingVersions')}
          </div>
        ) : versions.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t('dialogs.versionPicker.noVersions')}</div>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {versions.map((v) => (
              <div
                key={v.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                  installing !== v.id && 'hover:bg-accent'
                )}
              >
                <span className="flex-1 truncate">{v.name}</span>
                <span className="text-xs text-muted-foreground">{v.versionNumber}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => handleInstall(v)}
                  disabled={installing !== null}
                >
                  <MorphActionIcon active={installing === v.id} busy={RotateCwData} rest={ArrowLeftRightData} className="h-3 w-3" />
                  {installing === v.id ? t('dialogs.versionPicker.switching') : t('dialogs.versionPicker.switch')}
                </Button>
              </div>
            ))}
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={installing !== null}>{t('common.cancel')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
