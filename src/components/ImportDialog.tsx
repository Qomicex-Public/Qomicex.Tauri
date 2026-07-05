import { useState, useRef } from 'react'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Separator } from '../components/ui/separator.tsx'
import { parseModpackFile, startModpackInstall } from '../api/instance.ts'
import type { ModpackParseResult } from '../types/index.ts'
import { useNavigate } from 'react-router'

interface Props {
  open: boolean
  onClose: () => void
  gameDir: string
  versionIsolation: boolean
}

export default function ImportDialog({ open, onClose, gameDir, versionIsolation }: Props) {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<'select' | 'parsing' | 'preview' | 'installing'>('select')
  const [parsed, setParsed] = useState<ModpackParseResult | null>(null)
  const [instanceName, setInstanceName] = useState('')
  const [maxMemory, setMaxMemory] = useState(4096)
  const [error, setError] = useState('')

  const handleFileSelect = async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) return
    setStep('parsing')
    setError('')
    try {
      const result = await parseModpackFile(file)
      setParsed(result)
      setInstanceName(result.name)
      setStep('preview')
    } catch (e: any) {
      setError(e.message || 'Parse failed')
      setStep('select')
    }
  }

  const handleInstall = async () => {
    if (!parsed) return
    setStep('installing')
    setError('')
    try {
      const { instanceId } = await startModpackInstall({
        name: instanceName,
        gameVersion: parsed.gameVersion,
        loader: parsed.loader,
        loaderVersion: parsed.loaderVersion,
        maxMemory,
        gameDir,
        versionIsolation,
        modpackFiles: parsed.files,
        overridesZip: parsed.overridesZip,
      })
      onClose()
      navigate(`/instances/${instanceId}`)
    } catch (e: any) {
      setError(e.message || 'Install failed')
      setStep('preview')
    }
  }

  const reset = () => {
    setStep('select')
    setParsed(null)
    setError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <Dialog open={open} onClose={() => { reset(); onClose() }}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>导入整合包</DialogTitle>
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
          <p className="text-muted-foreground">正在解析整合包文件...</p>
        )}

        {step === 'preview' && parsed && (
          <div className="space-y-4">
            <div>
              <Label>整合包名称</Label>
              <p className="text-sm font-medium">{parsed.name}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>游戏版本</Label>
                <p className="text-sm">{parsed.gameVersion}</p>
              </div>
              <div>
                <Label>加载器</Label>
                <p className="text-sm">{parsed.loader} {parsed.loaderVersion}</p>
              </div>
            </div>
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
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={reset}>取消</Button>
              <Button onClick={handleInstall}>开始安装</Button>
            </div>
          </div>
        )}

        {step === 'installing' && (
          <p className="text-muted-foreground">正在创建实例并安装整合包...</p>
        )}
      </DialogBody>
    </Dialog>
  )
}
