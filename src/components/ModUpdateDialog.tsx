import { useEffect, useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate } from '@fortawesome/free-solid-svg-icons'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { checkModUpdates, batchUpdateMods } from '../api/instance-files.ts'
import { useMessageBox } from './ui/message-box.tsx'
import type { ModUpdateEntry } from '../types/index.ts'

interface ModUpdateDialogProps {
  open: boolean
  onClose: () => void
  instanceId: string
  onDone: () => void
  onUpdatesFound?: (updates: ModUpdateEntry[]) => void
}

export default function ModUpdateDialog({ open, onClose, instanceId, onDone, onUpdatesFound }: ModUpdateDialogProps) {
  const { notify } = useMessageBox()
  const [updates, setUpdates] = useState<ModUpdateEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setUpdating(false)
    checkModUpdates(instanceId)
      .then(list => {
        setUpdates(list)
        setSelected(new Set(list.map(u => u.fileName)))
        onUpdatesFound?.(list)
      })
      .catch(() => notify('检查更新失败', 'error'))
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
      await batchUpdateMods(instanceId, toUpdate)
      notify(`已更新 ${toUpdate.length} 个模组`, 'success')
      onDone()
      onClose()
    } catch { notify('批量更新失败', 'error') }
    setUpdating(false)
  }, [updates, selected, instanceId, notify, onDone, onClose])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>检查模组更新</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <FontAwesomeIcon icon={faRotate} className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : updates.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">所有模组已是最新版本</p>
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
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button
          onClick={handleUpdate}
          disabled={loading || updating || selected.size === 0}
        >
          {updating ? '更新中...' : `更新 ${selected.size} 个模组`}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
