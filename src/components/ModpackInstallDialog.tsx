import { useState } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Separator } from './ui/separator.tsx'
import { startModpackInstall, resolveModpack } from '../api/instance.ts'
import type { ResourceVersion } from '../types/index.ts'
import { useNavigate } from 'react-router'

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
  const navigate = useNavigate()
  const [instanceName, setInstanceName] = useState(modpackName)
  const [maxMemory, setMaxMemory] = useState(4096)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  const handleInstall = async () => {
    if (!selectedVersion) return
    setInstalling(true)
    setError('')
    try {
      const resolved = await resolveModpack(source, projectId, selectedVersion.id)
      const { instanceId } = await startModpackInstall({
        name: instanceName,
        gameVersion: selectedVersion.gameVersions[0] || resolved.gameVersion,
        loader: resolved.loader,
        loaderVersion: resolved.loaderVersion,
        maxMemory,
        gameDir,
        versionIsolation,
        modpackFiles: resolved.files,
        overridesZip: null,
      })
      onClose()
      navigate(`/instances/${instanceId}`)
    } catch (e: any) {
      setError(e.message || '安装失败')
      setInstalling(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>安装整合包</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div>
          <Label>整合包</Label>
          <p className="text-sm font-medium">{modpackName}</p>
        </div>
        {selectedVersion && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>版本</Label>
              <p className="text-sm">{selectedVersion.name}</p>
            </div>
            <div>
              <Label>游戏版本</Label>
              <p className="text-sm">{selectedVersion.gameVersions.join(', ')}</p>
            </div>
          </div>
        )}
        <Separator />
        <div>
          <Label htmlFor="inst-name">实例名称</Label>
          <Input id="inst-name" value={instanceName} onChange={e => setInstanceName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="max-mem">最大内存 (MB)</Label>
          <Input id="max-mem" type="number" value={maxMemory} onChange={e => setMaxMemory(Number(e.target.value))} />
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter className="border-0 px-0 pb-0">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleInstall} disabled={installing}>
            {installing ? '安装中...' : '开始安装'}
          </Button>
        </DialogFooter>
      </DialogBody>
    </Dialog>
  )
}
