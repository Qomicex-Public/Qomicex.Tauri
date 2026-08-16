import { useState } from 'react'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '../components/ui'
import { Button } from '../components/ui'
import { Label } from '../components/ui'
import { Checkbox } from '../components/ui'
import { Separator } from '../components/ui'
import { exportModpack } from '../api/instance.ts'
import type { GameInstance } from '../types/index.ts'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../components/ui'

interface Props {
  open: boolean
  onClose: () => void
  instance: GameInstance | null
}

export default function ExportModpackDialog({ open, onClose, instance }: Props) {
  const { t } = useI18n()
  const [format, setFormat] = useState<'cf' | 'mr'>('cf')
  const [includeSaves, setIncludeSaves] = useState(false)
  const [includeScreenshots, setIncludeScreenshots] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const reset = () => {
    setExporting(false)
    setDone(false)
    setError('')
  }

  const packName = instance?.modpackName?.trim() || instance?.name || 'modpack'
  const fileName = `${packName}.${format === 'cf' ? 'zip' : 'mrpack'}`

  const handleExport = async () => {
    if (!instance) return
    setExporting(true)
    setDone(false)
    setError('')
    try {
      const { blob, filename } = await exportModpack(instance.id, {
        format,
        includeSaves,
        includeScreenshots,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDone(true)
    } catch (e: any) {
      setError(e.message || t('dialogs.modpackExport.exportFailed'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onClose={() => { reset(); onClose() }}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.modpackExport.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-4">
          <div>
            <Label>{t('dialogs.modpackExport.format')}</Label>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFormat('cf')}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm transition-colors',
                  format === 'cf' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                )}
              >
                CurseForge (.zip)
              </button>
              <button
                type="button"
                onClick={() => setFormat('mr')}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm transition-colors',
                  format === 'mr' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                )}
              >
                Modrinth (.mrpack)
              </button>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>{t('dialogs.modpackExport.include')}</Label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={includeSaves} onCheckedChange={(c) => setIncludeSaves(c === true)} />
              {t('dialogs.modpackExport.includeSaves')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={includeScreenshots} onCheckedChange={(c) => setIncludeScreenshots(c === true)} />
              {t('dialogs.modpackExport.includeScreenshots')}
            </label>
          </div>

          <div>
            <Label>{t('dialogs.modpackExport.fileName')}</Label>
            <p className="mt-0.5 text-sm font-medium break-all">{fileName}</p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && <p className="text-sm text-muted-foreground">{t('dialogs.modpackExport.exported')}</p>}
          {exporting && <p className="text-sm text-muted-foreground">{t('dialogs.modpackExport.exporting')}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={exporting} onClick={() => { reset(); onClose() }}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleExport} disabled={exporting || !instance}>
              {t('dialogs.modpackExport.startExport')}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}
