import { useState, useRef, useEffect, useCallback } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Separator } from './ui/separator.tsx'
import { startModpackInstall, resolveModpack, getInstallProgress } from '../api/instance.ts'
import type { ResourceVersion, InstallProgressResponse } from '../types/index.ts'
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
        createdAt: new Date().toISOString(),
        instanceId,
      })
      setInstallingInstanceId(instanceId)
    } catch (e: any) {
      addTask({
        id: `modpack-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name: instanceName,
        type: 'modpack',
        gameVersion: selectedVersion.gameVersions[0] || '',
        status: 'failed',
        progress: 0,
        error: e.message || '安装失败',
        createdAt: new Date().toISOString(),
      })
      setError(e.message || '安装失败')
      setStep('config')
    }
  }

  const isComplete = progress?.status === 'completed'
  const isFailed = progress?.status === 'failed' || progress?.status === 'cancelled'

  return (
    <Dialog open={open} onClose={() => { stopPolling(); onClose() }}>
      <DialogHeader onClose={() => { stopPolling(); onClose() }}>
        <DialogTitle>安装整合包</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {step === 'config' && (
          <>
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
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter className="border-0 px-0 pb-0">
              <Button variant="outline" onClick={() => { stopPolling(); onClose() }}>取消</Button>
              <Button onClick={handleInstall}>开始安装</Button>
            </DialogFooter>
          </>
        )}

        {step === 'installing' && (
          <>
            {!progress && <p className="text-muted-foreground">正在解析并安装...</p>}
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
            <DialogFooter className="border-0 px-0 pb-0">
              {(isComplete || isFailed) && installingInstanceId && (
                <Button variant="outline" onClick={() => { stopPolling(); onClose(); navigate(`/instances/${installingInstanceId}`) }}>
                  查看实例
                </Button>
              )}
              {!isComplete && !isFailed && (
                <Button variant="outline" onClick={() => { stopPolling(); onClose() }}>后台下载</Button>
              )}
              {(isComplete || isFailed) && (
                <Button onClick={() => { stopPolling(); onClose() }}>关闭</Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogBody>
    </Dialog>
  )
}
