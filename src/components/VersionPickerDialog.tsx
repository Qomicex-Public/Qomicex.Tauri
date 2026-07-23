import { useEffect, useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate, faArrowRightArrowLeft } from '@fortawesome/free-solid-svg-icons'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { cn } from '../lib/utils.ts'
import { getResourceVersions } from '../api/resource.ts'
import { changeModVersion } from '../api/instance-files.ts'
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
  const [versions, setVersions] = useState<ResourceVersion[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !mod || !mod.source) return
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId
    if (!id) return
    setLoading(true)
    const loaderType = (loader || '').toLowerCase() || undefined
    getResourceVersions(id, mod.source, gameVersion, loaderType)
      .then(setVersions)
      .catch(() => setVersions([]))
      .finally(() => setLoading(false))
  }, [open, mod, gameVersion, loader])

  const handleInstall = useCallback(async (version: ResourceVersion) => {
    if (!mod || !mod.source) { console.error('VersionPicker: no mod or source', mod); return }
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId
    if (!id) { console.error('VersionPicker: no project ID', mod); return }
    console.log('VersionPicker: installing version', version.versionNumber, 'downloads:', version.downloads)
    setInstalling(version.id)
    try {
      const jarFile = version.downloads.find(f => f.fileName.endsWith('.jar'))
      if (jarFile) {
        console.log('VersionPicker: installing', jarFile.fileName, jarFile.url)
        await changeModVersion(instanceId, mod.fileName, jarFile.url, jarFile.fileName)
        onDone()
        onClose()
      } else {
        console.error('VersionPicker: no .jar in downloads', version.downloads)
      }
    } catch (e) { console.error('Version install failed:', e) }
    setInstalling(null)
  }, [mod, instanceId, onDone, onClose])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>更换版本 — {mod?.name}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载版本列表...
          </div>
        ) : versions.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">没有可用的版本</div>
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
                  {installing === v.id ? (
                    <><FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />更换中...</>
                  ) : (
                    <><FontAwesomeIcon icon={faArrowRightArrowLeft} className="h-3 w-3" />更换</>
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={installing !== null}>取消</Button>
      </DialogFooter>
    </Dialog>
  )
}
