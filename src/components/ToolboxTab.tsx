import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDownload, faFolderOpen } from '@fortawesome/free-solid-svg-icons'
import { Card, CardHeader, CardTitle, CardContent } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Separator } from './ui'
import { Tooltip } from './ui'
import { cn } from '../lib/utils.ts'
import { downloadTo } from '../api/resource-download.ts'
import { addTask } from '../stores/downloadStore.ts'
import { open } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../i18n/index.tsx'

export default function ToolboxTab() {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [targetDir, setTargetDir] = useState('')
  const [fileName, setFileName] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')

  function extractFileName(rawUrl: string): string {
    try {
      const u = new URL(rawUrl)
      const seg = u.pathname.split('/').filter(Boolean).pop()
      if (!seg) return ''
      return decodeURIComponent(seg).replace(/\?.*$/, '').replace(/\s+/g, '_')
    } catch {
      return ''
    }
  }

  async function handlePickFolder() {
    const result = await open({ directory: true, multiple: false })
    if (!result) return
    const dir = typeof result === 'string' ? result : result[0]
    setTargetDir(dir)
  }

  function handleUrlChange(u: string) {
    setUrl(u)
    const fn = extractFileName(u)
    if (fn) setFileName(fn)
  }

  async function handleDownload() {
    if (!url || !targetDir || !fileName) return
    const targetPath = `${targetDir.replace(/[/\\]+$/, '')}/${fileName}`
    setDownloading(true)
    setError('')
    try {
      const res = await downloadTo(url, targetPath)
      addTask({
        id: crypto.randomUUID(),
        name: fileName,
        type: 'file',
        gameVersion: '',
        taskId: res.taskId,
        status: 'downloading',
        progress: 0,
        createdAt: new Date().toISOString(),
      })
      setUrl('')
      setFileName('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('tools.toolbox.downloadFailed'))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <FontAwesomeIcon icon={faDownload} className="mr-2 h-4 w-4 text-muted-foreground" />
            {t('tools.toolbox.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('tools.toolbox.description')}
          </p>

          <div className="space-y-2">
            <Label>{t('tools.toolbox.urlLabel')}</Label>
            <Input
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              placeholder="https://example.com/file.zip"
            />
          </div>

          <div className="space-y-2">
            <Label>{t('tools.toolbox.savePathLabel')}</Label>
            <div className="flex gap-2">
              <Input
                value={fileName ? `${targetDir.replace(/[/\\]+$/, '')}/${fileName}` : ''}
                readOnly
                className="flex-1"
                placeholder={t('tools.toolbox.autoFillPlaceholder')}
              />
              <Tooltip content={t('tools.toolbox.pickFolder')}>
                <Button variant="outline" size="icon" onClick={handlePickFolder} className="shrink-0">
                  <FontAwesomeIcon icon={faFolderOpen} className="h-4 w-4" />
                </Button>
              </Tooltip>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <Separator />

          <Button
            onClick={handleDownload}
            disabled={downloading || !url || !targetDir || !fileName}
            className="w-full"
          >
            <FontAwesomeIcon icon={faDownload} className={cn('h-4 w-4', downloading && 'animate-spin')} />
            <span>{downloading ? t('tools.toolbox.submitting') : t('tools.toolbox.startDownload')}</span>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
