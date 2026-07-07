import { useState, useRef, useEffect, useCallback } from 'react'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Separator } from '../components/ui/separator.tsx'
import { parseModpackFile, startModpackInstall, getInstallProgress } from '../api/instance.ts'
import type { ModpackParseResult, InstallProgressResponse } from '../types/index.ts'
import { useNavigate } from 'react-router'
import { addTask } from '../stores/downloadStore.ts'

const STAGE_LABELS: Record<string, string> = {
  'queued': '排队中',
  'downloading-json': '下载版本 JSON',
  'downloading': '下载游戏文件',
  'downloading-libraries': '下载支持库',
  'downloading-assets': '下载资源文件',
  'downloading-mainjar': '下载主文件',
  'downloading-loader': '下载加载器',
  'downloading-loader-libs': '下载加载器库',
  'installing-loader': '安装加载器',
  'downloading-addons': '下载附加内容',
  'modpack-files': '下载整合包文件',
  'modpack-overrides': '解压覆盖文件',
}

interface Props {
  open: boolean
  onClose: () => void
  gameDir: string
  versionIsolation: boolean
}

export default function ImportDialog({ open, onClose, gameDir, versionIsolation }: Props) {
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
      setError(e.message || '解析失败')
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
      setError(e.message || '安装失败')
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
            {error && <p className="text-destructive text-sm">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { reset(); onClose() }}>取消</Button>
              <Button onClick={handleInstall}>开始安装</Button>
            </div>
          </div>
        )}

        {step === 'installing' && (
          <div className="space-y-4">
            {!progress && <p className="text-muted-foreground">正在连接...</p>}
            {progress && !isComplete && !isFailed && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">安装中：{instanceName}</span>
                    <span className="font-medium">{Math.round(progress.progress)}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.progress}%` }} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{STAGE_LABELS[progress.status] || progress.status}</span>
                  {progress.totalFiles != null && progress.totalFiles > 0 && <span>{progress.completedFiles ?? 0}/{progress.totalFiles}</span>}
                </div>
                {progress.currentFile && (
                  <p className="truncate text-xs text-muted-foreground">{progress.currentFile}</p>
                )}
              </>
            )}
            {isComplete && (
              <div className="text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">✓ 安装完成！</p>
                <p className="mt-1">整合包已成功安装为实例「{instanceName}」</p>
              </div>
            )}
            {isFailed && (
              <div className="text-sm text-destructive">
                安装失败：{progress?.error || error || '请查看下载页了解详情'}
              </div>
            )}
            <div className="flex justify-end gap-2">
              {(isComplete || isFailed) && installingInstanceId && (
                <Button variant="outline" onClick={() => { reset(); onClose(); navigate(`/instances/${installingInstanceId}`) }}>
                  查看实例
                </Button>
              )}
              {!isComplete && !isFailed && (
                <Button variant="outline" onClick={() => { reset(); onClose() }}>后台下载</Button>
              )}
              {(isComplete || isFailed) && (
                <Button onClick={() => { reset(); onClose() }}>关闭</Button>
              )}
            </div>
          </div>
        )}
      </DialogBody>
    </Dialog>
  )
}
