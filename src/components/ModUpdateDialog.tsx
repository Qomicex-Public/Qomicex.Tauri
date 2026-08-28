import { useEffect, useState, useCallback } from 'react'
import { RotateCw } from 'lucide-react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { checkModUpdates } from '../api/instance-files.ts'
import { updateModsViaDownloadCenter } from '../lib/updateMods.ts'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { ModUpdateEntry } from '../types/index.ts'

interface ModUpdateDialogProps {
  open: boolean
  onClose: () => void
  instanceId: string
  onDone: () => void
  onUpdatesFound?: (updates: ModUpdateEntry[]) => void
}

export default function ModUpdateDialog({ open, onClose, instanceId, onDone, onUpdatesFound }: ModUpdateDialogProps) {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [updates, setUpdates] = useState<ModUpdateEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setUpdating(false)
    checkModUpdates(instanceId, true)
      .then(list => {
        setUpdates(list)
        setSelected(new Set(list.map(u => u.fileName)))
        onUpdatesFound?.(list)
      })
      .catch(() => notify(t('dialogs.modUpdate.checkFailed'), 'error'))
      .finally(() => setLoading(false))
  }, [open, instanceId, notify])

  const toggle = useCallback((fileName: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(fileName)) next.delete(fileName)
      else next.add(fileName)
      return next
    })
  }, [])

  const handleUpdate = useCallback(async () => {
    const toUpdate = updates.filter(u => selected.has(u.fileName))
    if (toUpdate.length === 0) return
    setUpdating(true)
    try {
      const result = await updateModsViaDownloadCenter(
        instanceId,
        toUpdate,
        (n) => notify(t('dialogs.modUpdate.addedToDownloadList', { count: n }), 'success'),
        t
      )
      const failNames = result.failedFileNames.length > 0 && result.failedFileNames.length <= 3
        ? `：${result.failedFileNames.join('、')}`
        : ''
      if (result.failed === 0) {
        notify(t('dialogs.modUpdate.updatedCount', { count: result.success }), 'success')
      } else {
        notify(t('dialogs.modUpdate.completedWithFailed', { success: result.success, failed: result.failed, failNames }), 'error')
      }
      onDone()
      onClose()
    } catch { notify(t('dialogs.modUpdate.batchFailed'), 'error') }
    setUpdating(false)
  }, [updates, selected, instanceId, notify, onDone, onClose])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.modUpdate.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <RotateCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : updates.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('dialogs.modUpdate.allUpToDate')}</p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {updates.map(u => (
              <label
                key={u.fileName}
                className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(u.fileName)}
                  onChange={() => toggle(u.fileName)}
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {u.currentVersion} → {u.latestVersion}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          onClick={handleUpdate}
          disabled={loading || updating || selected.size === 0}
        >
          {updating ? t('dialogs.modUpdate.updating') : t('dialogs.modUpdate.updateCount', { count: selected.size })}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
