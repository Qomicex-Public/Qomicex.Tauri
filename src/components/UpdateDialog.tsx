import { useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowUp, faRotate, faDownload } from '@fortawesome/free-solid-svg-icons'
import { cn } from '../lib/utils.ts'

interface Props {
  open: boolean
  version: string
  body: string
  required: boolean
  downloadUrl: string
  onClose: () => void
}

export default function UpdateDialog({ open, version, body, required, downloadUrl, onClose }: Props) {
  const [state, setState] = useState<'idle' | 'downloading' | 'installing' | 'error'>('idle')
  const [progress, setProgress] = useState(0)

  const handleDownload = useCallback(async () => {
    if (!downloadUrl) return
    setState('downloading')
    setProgress(0)
    try {
      const { Channel } = await import('@tauri-apps/api/core')
      const onEvent = new Channel()
      onEvent.onmessage = (event: any) => {
        if (event.event === 'Started') {
          const contentLength = event.data.contentLength ?? 0
          if (contentLength > 0) setProgress(0)
        } else if (event.event === 'Progress') {
          setProgress((prev) => Math.min(99, prev + 1))
        }
      }
      await invoke('download_and_install_update', { url: downloadUrl, onEvent })
      setState('installing')
      await relaunch()
    } catch {
      setState('error')
    }
  }, [downloadUrl])

  return (
    <Dialog open={open} onClose={required ? () => {} : onClose} closeOnBackdrop={!required} closeOnEsc={!required}>
      <DialogHeader onClose={required ? undefined : onClose}>
        <DialogTitle>
          <FontAwesomeIcon icon={faArrowUp} className="mr-2 h-4 w-4 text-primary" />
          发现新版本 {version}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        {required && (
          <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            此版本包含重要更新，必须安装后才能继续使用
          </div>
        )}
        <div className="max-h-56 overflow-y-auto rounded-lg bg-background p-3 text-sm leading-relaxed text-muted-foreground prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{body || '暂无更新说明'}</Markdown>
        </div>
      </DialogBody>
      <DialogFooter className="gap-2">
        {state === 'error' && <span className="text-xs text-destructive">下载失败</span>}
        {state === 'downloading' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
            <span>下载中 {progress}%</span>
          </div>
        )}
        {!required && state === 'idle' && (
          <Button variant="outline" size="sm" onClick={onClose}>下次再说</Button>
        )}
        <Button size="sm" onClick={handleDownload} disabled={state === 'downloading' || state === 'installing'}>
          <FontAwesomeIcon icon={state === 'downloading' ? faRotate : faDownload} className={cn('mr-1 h-3 w-3', state === 'downloading' && 'animate-spin')} />
          {state === 'installing' ? '安装中...' : state === 'downloading' ? '下载中...' : '立即更新'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
