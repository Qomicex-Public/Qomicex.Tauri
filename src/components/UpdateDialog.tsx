import { useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import { relaunch } from '@tauri-apps/plugin-process'
import type { Update } from '@tauri-apps/plugin-updater'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowUp, faRotate, faDownload, faCheckCircle } from '@fortawesome/free-solid-svg-icons'
import { cn } from '../lib/utils.ts'

interface Props {
  open: boolean
  update: Update | null
  onClose: () => void
}

export default function UpdateDialog({ open, update, onClose }: Props) {
  const [state, setState] = useState<'idle' | 'downloading' | 'installing' | 'error' | 'done'>('idle')
  const [progress, setProgress] = useState(0)

  const handleDownload = useCallback(async () => {
    if (!update) return
    setState('downloading')
    setProgress(0)
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          if ((event.data?.contentLength ?? 0) > 0) setProgress(0)
        } else if (event.event === 'Progress') {
          setProgress((prev) => Math.min(99, prev + 1))
        }
      })
      setState('installing')
      await relaunch()
    } catch {
      setState('error')
    }
  }, [update])

  if (!update) return null

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>
          <FontAwesomeIcon icon={faArrowUp} className="mr-2 h-4 w-4 text-muted-foreground" />
          发现新版本 {update.version}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="max-h-56 overflow-y-auto rounded-lg bg-background p-3 text-sm leading-relaxed text-muted-foreground prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{update.body || '暂无更新说明'}</Markdown>
        </div>
      </DialogBody>
      <DialogFooter className="gap-2">
        {state === 'error' && <span className="text-xs text-destructive">下载失败</span>}
        {state === 'done' && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <FontAwesomeIcon icon={faCheckCircle} className="h-3 w-3" />
            更新完成
          </span>
        )}
        {state === 'downloading' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
            <span>下载中 {progress}%</span>
          </div>
        )}
        {state === 'idle' && (
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
