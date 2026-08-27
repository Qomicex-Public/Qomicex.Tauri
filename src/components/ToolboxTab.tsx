import { useEffect, useState } from 'react'
import { Download, FolderOpen } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Separator } from './ui'
import { Textarea } from './ui'
import { Tooltip } from './ui'
import { useMessageBox } from './ui'
import { cn } from '../lib/utils.ts'
import { downloadTo } from '../api/resource-download.ts'
import { getDataDir } from '../api/settings.ts'
import { addTask } from '../stores/downloadStore.ts'
import { open } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../i18n/index.tsx'

export default function ToolboxTab() {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [url, setUrl] = useState('')
  const [targetDir, setTargetDir] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')

  // 默认保存目录 = 数据目录下 QML/Downloads，可改选
  useEffect(() => {
    getDataDir().then((p) => setTargetDir(`${p.replace(/[/\\]+$/, '')}/QML/Downloads`)).catch(() => {})
  }, [])

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

  const lines = url.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const validCount = lines.filter((l) => extractFileName(l)).length

  async function handleDownload() {
    if (!validCount || !targetDir) return
    const dir = targetDir.replace(/[/\\]+$/, '')
    setDownloading(true)
    setError('')
    let ok = 0
    let failed = 0
    let invalid = 0
    for (const line of lines) {
      const fn = extractFileName(line)
      if (!fn) { invalid++; continue }
      try {
        const res = await downloadTo(line, `${dir}/${fn}`)
        addTask({
          id: crypto.randomUUID(),
          name: fn,
          type: 'file',
          gameVersion: '',
          taskId: res.taskId,
          status: 'downloading',
          progress: 0,
          createdAt: new Date().toISOString(),
        })
        ok++
      } catch {
        failed++
      }
    }
    setDownloading(false)
    const suffix = invalid > 0 ? ` · ${t('tools.toolbox.invalidLines', { count: invalid })}` : ''
    if (ok === 0 || failed > 0) {
      const msg = `${t('tools.toolbox.toastPartial', { ok, failed })}${suffix}`
      setError(msg)
      notify(msg, 'error')
    } else {
      notify(`${t('tools.toolbox.toastAdded', { count: ok })}${suffix}`, 'success')
      setUrl('')
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <Download className="mr-2 h-4 w-4 text-muted-foreground" />
            {t('tools.toolbox.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('tools.toolbox.description')}
          </p>

          <div className="space-y-2">
            <Label>{t('tools.toolbox.urlLabel')}</Label>
            <Textarea
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/file.zip"
              rows={5}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground/70">{t('tools.toolbox.urlHint')}</p>
          </div>

          <div className="space-y-2">
            <Label>{t('tools.toolbox.savePathLabel')}</Label>
            <div className="flex gap-2">
              <Input
                value={targetDir.replace(/[/\\]+$/, '')}
                onChange={(e) => setTargetDir(e.target.value)}
                className="flex-1"
                placeholder={t('tools.toolbox.autoFillPlaceholder')}
              />
              <Tooltip content={t('tools.toolbox.pickFolder')}>
                <Button variant="outline" size="icon" onClick={handlePickFolder} className="shrink-0">
                  <FolderOpen className="h-4 w-4" />
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
            disabled={downloading || !validCount || !targetDir}
            className="w-full"
          >
            <Download className={cn('h-4 w-4', downloading && 'animate-spin')} />
            <span>
              {downloading
                ? t('tools.toolbox.submitting')
                : validCount > 1
                  ? t('tools.toolbox.startDownloadCount', { count: validCount })
                  : t('tools.toolbox.startDownload')}
            </span>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
