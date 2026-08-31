import { useState, useRef, useEffect } from 'react'
import type { DragEvent } from 'react'
import { FileDown, FolderOpen } from 'lucide-react'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '../components/ui'
import { Button } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Separator } from '../components/ui'
import { parseModpackFile, startModpackInstall, parseMultiMcFolder, startMultiMcImport } from '../api/instance.ts'
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Tauri 原生 file-drop 事件最近一次拖入的路径（文件夹拖入用）。
  const folderPathsRef = useRef<string[]>([])
  const [step, setStep] = useState<'select' | 'parsing' | 'preview'>('select')
  const [dragActive, setDragActive] = useState(false)
  const [parsed, setParsed] = useState<ModpackParseResult | MultiMcParseResult | null>(null)
  const [instanceName, setInstanceName] = useState('')
  const [error, setError] = useState('')

  // 打开期间让全局拖放路由进本对话框；同时监听 Tauri 原生 file-drop 取路径（文件夹）。
  useEffect(() => {
    importDialogActive.current = open
    if (!open) return
    let un: (() => void) | undefined
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        un = await listen<string[]>('file-drop', e => {
          folderPathsRef.current = e.payload || []
        })
      })
      .catch(() => {})
    return () => {
      importDialogActive.current = false
      un?.()
    }
  }, [open])

  /** 解析一个文件（后端 /modpack/parse 统一识别 MultiMC / CF / MR / Qomicex）。 */
  const parseFile = async (file: File) => {
    setStep('parsing')
    setError('')
    try {
      const result = await parseModpackFile(file)
      setParsed(result)
      setInstanceName(result.name)
      setStep('preview')
    } catch (e: any) {
      setError(e instanceof ApiError ? e.displayMessage : e.message || t('dialogs.import.parseFailed'))
      setStep('select')
    }
  }

  /** 解析一个 MultiMC 实例文件夹。 */
  const parseFolder = async (path: string) => {
    setStep('parsing')
    setError('')
    try {
      const result = await parseMultiMcFolder(path)
      setParsed(result)
      setInstanceName(result.name)
      setStep('preview')
    } catch (e: any) {
      setError(e instanceof ApiError ? e.displayMessage : e.message || t('dialogs.import.parseFailed'))
      setStep('select')
    }
  }

  const handleFileSelect = async () => {
    const input = fileInputRef.current
    const file = input?.files?.[0]
    if (!file) return
    input!.value = ''
    await parseFile(file)
  }

  /** 拖放：文件走浏览器 DnD（File 对象上传）；文件夹走 Tauri file-drop 路径。 */
  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      await parseFile(files[0])
      return
    }
    // 文件夹：无 files，用 Tauri 原生事件给的路径。
    const path = folderPathsRef.current[0]
    if (path) {
      await parseFolder(path)
    } else {
      setError(t('dialogs.import.folderDropUnsupported'))
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
    if (!parsed) return
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
      setError(e.message || t('dialogs.import.installFailed'))
    }
  }

  const reset = () => {
    setStep('select')
    setParsed(null)
    setError('')
    setDragActive(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <Dialog open={open} onClose={() => { reset(); onClose() }}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.import.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {step === 'select' && (
          <div className="space-y-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true) }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors',
                dragActive ? 'border-primary/60 bg-primary/5' : 'border-muted-foreground/40 hover:border-primary/50 hover:bg-primary/5',
              )}
            >
              <FileDown className={cn('h-8 w-8', dragActive ? 'text-primary' : 'text-muted-foreground')} />
              <span className="text-sm font-medium">{t('dialogs.import.dropHint')}</span>
              <span className="text-xs text-muted-foreground">{t('dialogs.import.dropSubHint')}</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.mrpack,.qmodpack"
              onChange={handleFileSelect}
              className="hidden"
            />
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
          <p className="text-muted-foreground">{t('dialogs.import.parsing')}</p>
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
              <Button variant="outline" onClick={() => { reset(); onClose() }}>{t('common.cancel')}</Button>
              <Button onClick={handleInstall}>{t('dialogs.import.startInstall')}</Button>
            </div>
          </div>
        )}
      </DialogBody>
    </Dialog>
  )
}