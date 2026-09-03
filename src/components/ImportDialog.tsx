import { useState, useRef, useEffect } from 'react'
import { Download, FileDown, FolderOpen, RotateCw } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '../components/ui'
import { Button } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Separator } from '../components/ui'
import { parseModpackFileByPath, startModpackInstall, parseMultiMcFolder, startMultiMcImport } from '../api/instance.ts'
import { ApiError } from '../api/client.ts'
import type { ModpackParseResult, MultiMcParseResult } from '../types/index.ts'
import { useNavigate } from 'react-router-dom'
import { addTask } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../lib/utils.ts'
import { importDialogActive } from '../lib/drop-routing.ts'

interface Props {
  open: boolean
  onClose: () => void
  gameDir: string
  versionIsolation: boolean
}

export default function ImportDialog({ open, onClose, gameDir, versionIsolation }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [step, setStep] = useState<'select' | 'parsing' | 'preview'>('select')
  const [parsed, setParsed] = useState<ModpackParseResult | MultiMcParseResult | null>(null)
  const [instanceName, setInstanceName] = useState('')
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  // 防重入标记：不能用 installing state 兜底——标题栏 ×/Escape/背景关闭都会走 reset()
  // 清掉 state，请求进行中关闭再重开对话框就能绕过按钮 disabled 再次发起安装（PR#82 review）。
  const installingRef = useRef(false)
  const [dropHover, setDropHover] = useState(false)
  // 单调递增请求 ID：丢弃过期解析结果（快速连续拖入多个包时旧响应不得覆盖新预览）。
  const parseReqIdRef = useRef(0)

  // Tauri 原生 file-drop 事件：文件和文件夹统一处理。
  useEffect(() => {
    importDialogActive.current = open
    if (!open) return
    // listen() 是异步的：若对话框在注册完成前关闭，旧监听器不会被取消。
    // disposed 标志 + 注册完成后立即检查，避免后续拖放触发已卸载对话框的回调。
    let disposed = false
    let unHover: (() => void) | undefined
    let unDrop: (() => void) | undefined
    listen<boolean>('file-drop-hover', e => {
      setDropHover(!!e.payload)
    }).then(fn => { if (disposed) fn(); else unHover = fn }).catch(() => {})
    listen<string[]>('file-drop', async e => {
      setDropHover(false)
      const paths = e.payload
      if (!paths?.length) return
      const reqId = ++parseReqIdRef.current
      const p = paths[0]
      if (/\.(zip|mrpack|qmodpack)$/i.test(p)) {
        setStep('parsing')
        setError('')
        try {
          const result = await parseModpackFileByPath(p)
          if (reqId !== parseReqIdRef.current) return
          setParsed(result)
          setInstanceName(result.name)
          setStep('preview')
        } catch (e: any) {
          if (reqId !== parseReqIdRef.current) return
          setError(e instanceof ApiError ? e.displayMessage : e.message || t('dialogs.import.parseFailed'))
          setStep('select')
        }
      } else {
        await parseFolder(p, reqId)
      }
    }).then(fn => { if (disposed) fn(); else unDrop = fn }).catch(() => {})
    return () => {
      disposed = true
      importDialogActive.current = false
      unHover?.()
      unDrop?.()
    }
  }, [open, t])

  /** 解析一个 MultiMC 实例文件夹。 */
  const parseFolder = async (path: string, reqId = ++parseReqIdRef.current) => {
    setStep('parsing')
    setError('')
    try {
      const result = await parseMultiMcFolder(path)
      if (reqId !== parseReqIdRef.current) return
      setParsed(result)
      setInstanceName(result.name)
      setStep('preview')
    } catch (e: any) {
      if (reqId !== parseReqIdRef.current) return
      setError(e instanceof ApiError ? e.displayMessage : e.message || t('dialogs.import.parseFailed'))
      setStep('select')
    }
  }

  const handleFileSelect = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const file = await open({ multiple: false, filters: [{ name: 'Modpack', extensions: ['zip', 'mrpack', 'qmodpack'] }] })
    if (typeof file !== 'string' || !file) return
    const reqId = ++parseReqIdRef.current
    setStep('parsing')
    setError('')
    try {
      const result = await parseModpackFileByPath(file)
      if (reqId !== parseReqIdRef.current) return
      setParsed(result)
      setInstanceName(result.name)
      setStep('preview')
    } catch (e: any) {
      if (reqId !== parseReqIdRef.current) return
      setError(e instanceof ApiError ? e.displayMessage : e.message || t('dialogs.import.parseFailed'))
      setStep('select')
    }
  }

  const handleFolderSelect = async () => {
    setStep('parsing')
    setError('')
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const dir = await open({ directory: true, multiple: false })
      if (typeof dir !== 'string' || !dir) { setStep('select'); return }
      await parseFolder(dir)
    } catch (e: any) {
      setError(e instanceof ApiError ? e.displayMessage : e.message || t('dialogs.import.parseFailed'))
      setStep('select')
    }
  }

  const handleInstall = async () => {
    if (!parsed || installingRef.current) return
    installingRef.current = true
    setInstalling(true)
    setError('')
    try {
      const isMultiMc = parsed.packType === 'multimc' || (parsed as MultiMcParseResult).sourcePath != null
      const instanceId = isMultiMc
        ? (await startMultiMcImport({
            sourceId: parsed.sourceId ?? undefined,
            sourcePath: (parsed as MultiMcParseResult).sourcePath ?? undefined,
            name: instanceName,
            gameDir,
            versionIsolation,
          })).instanceId
        : (await startModpackInstall({
            name: instanceName,
            gameVersion: parsed.gameVersion,
            loader: parsed.loader,
            loaderVersion: parsed.loaderVersion,
            gameDir,
            versionIsolation,
            modpackFiles: (parsed as ModpackParseResult).files,
            overridesZip: (parsed as ModpackParseResult).overridesZip,
            iconData: parsed.iconData,
            modpackName: parsed.name,
            modpackVersion: (parsed as ModpackParseResult).version,
            modpackAuthor: (parsed as ModpackParseResult).author,
            modpackSummary: (parsed as ModpackParseResult).summary,
            source: (parsed as ModpackParseResult).source,
            fileId: (parsed as ModpackParseResult).fileId ?? undefined,
          })).instanceId
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
        icon: parsed.iconData ?? undefined,
      })
      // 安装已入队：关闭弹窗并跳转下载中心查看进度。
      reset()
      onClose()
      navigate('/downloads')
    } catch (e: any) {
      setInstalling(false)
      setError(e.message || t('dialogs.import.installFailed'))
    } finally {
      installingRef.current = false
    }
  }

  const reset = () => {
    parseReqIdRef.current++ // 作废在途解析请求，防止关闭后旧响应回写 state
    setStep('select')
    setParsed(null)
    setError('')
    setInstalling(false)
    setDropHover(false)
  }

  // 统一关闭路径：标题栏 × 与弹窗遮罩都先 reset（作废在途解析）再 onClose，
  // 避免解析请求在关闭后仍把 parsed/error/step 写入已卸载对话框。
  const handleDialogClose = () => {
    reset()
    onClose()
  }

  return (
    <Dialog open={open} onClose={handleDialogClose}>
      <DialogHeader onClose={handleDialogClose}>
        <DialogTitle>{t('dialogs.import.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {step === 'select' && (
          <div className="space-y-4">
            <div
              role="button"
              tabIndex={0}
              onClick={handleFileSelect}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors',
                dropHover ? 'border-primary/60 bg-primary/5' : 'border-muted-foreground/40 hover:border-primary/50 hover:bg-primary/5',
              )}
            >
              <FileDown className={cn('h-8 w-8', dropHover ? 'text-primary' : 'text-muted-foreground')} />
              <span className="text-sm font-medium">{t('dialogs.import.dropHint')}</span>
              <span className="text-xs text-muted-foreground">{t('dialogs.import.dropSubHint')}</span>
            </div>
            <div className="flex items-center gap-2">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">or</span>
              <Separator className="flex-1" />
            </div>
            <Button variant="outline" className="w-full" onClick={handleFolderSelect}>
              <FolderOpen className="h-4 w-4 mr-2" />
              {t('dialogs.import.chooseFolder')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('dialogs.import.folderHint')}</p>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        )}

        {step === 'parsing' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              <div className="h-5 w-48 animate-pulse rounded bg-muted" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                <div className="h-4 w-16 animate-pulse rounded bg-muted" />
              </div>
              <div className="space-y-2">
                <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              </div>
            </div>
            <div className="h-px w-full bg-border" />
            <div className="space-y-2">
              <div className="h-4 w-28 animate-pulse rounded bg-muted" />
              <div className="h-8 w-full animate-pulse rounded bg-muted" />
            </div>
            <p className="text-xs text-muted-foreground">{t('dialogs.import.parsing')}</p>
          </div>
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
              <Button variant="outline" disabled={installing} onClick={() => { reset(); onClose() }}>{t('common.cancel')}</Button>
              <Button onClick={handleInstall} disabled={installing}>
                {installing
                  ? <RotateCw className="mr-1.5 h-4 w-4 animate-spin" />
                  : <Download className="mr-1.5 h-4 w-4" />}
                {t('dialogs.import.startInstall')}
              </Button>
            </div>
          </div>
        )}
      </DialogBody>
    </Dialog>
  )
}