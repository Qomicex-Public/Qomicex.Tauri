// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { FileJson, Upload } from 'lucide-react'
import { RotateCw as RotateCwData, Upload as UploadData } from 'lucide'
import { MorphActionIcon } from './MorphActionIcon.tsx'
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from './ui'
import { cn } from '../lib/utils.ts'
import { importResourceFavorites, type FavoriteImportResult } from '../api/resource.ts'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  /** 选中的导入文件绝对路径；null 关闭对话框。 */
  path: string | null
  onClose: () => void
  onImported: (result: FavoriteImportResult) => void
}

/**
 * 收藏导入的模式选择（issue #293）。
 *
 * 合并：保留本地已有收藏，只补新增条目；覆盖：先备份 `.bak` 再整体替换。
 * 覆盖是破坏性操作，默认选中合并，且按钮文案明确写出会清空。
 */
export default function FavoriteImportDialog({ path, onClose, onImported }: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'merge' | 'overwrite'>('merge')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!path) return
    setMode('merge')
    setImporting(false)
    setError('')
  }, [path])

  const fileName = path ? (path.split(/[\\/]/).pop() ?? path) : ''

  async function handleImport() {
    if (!path || importing) return
    setImporting(true)
    setError('')
    try {
      onImported(await importResourceFavorites(path, mode))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('dialogs.common.unknownError'))
      setImporting(false)
    }
  }

  const options = [
    { value: 'merge' as const, label: t('resource.favorites.transfer.merge'), hint: t('resource.favorites.transfer.mergeHint') },
    { value: 'overwrite' as const, label: t('resource.favorites.transfer.overwrite'), hint: t('resource.favorites.transfer.overwriteHint') },
  ]

  return (
    <Dialog open={!!path} onClose={importing ? () => {} : onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-muted-foreground" />
          {t('resource.favorites.transfer.importTitle')}
        </DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          <FileJson className="h-4 w-4 shrink-0" />
          <span className="truncate" title={path ?? ''}>
            {t('resource.favorites.transfer.importFile', { name: fileName })}
          </span>
        </div>

        <div className="space-y-1.5">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={importing}
              onClick={() => setMode(option.value)}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60',
                mode === option.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border/60 hover:bg-accent/30',
              )}
            >
              <div
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                  mode === option.value ? 'border-primary' : 'border-muted-foreground/40',
                )}
              >
                {mode === option.value && <div className="h-2 w-2 rounded-full bg-primary" />}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium">{option.label}</div>
                <div className={cn('text-[11px]', option.value === 'overwrite' ? 'text-destructive/80' : 'text-muted-foreground')}>
                  {option.hint}
                </div>
              </div>
            </button>
          ))}
        </div>

        {error && <p className="text-destructive truncate text-sm" title={error}>{error}</p>}
      </DialogBody>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={importing}>{t('dialogs.common.cancel')}</Button>
        <Button onClick={handleImport} disabled={!path || importing}>
          <MorphActionIcon active={importing} busy={RotateCwData} rest={UploadData} className="mr-1.5 h-3.5 w-3.5" />
          {importing ? t('resource.favorites.transfer.importing') : t('resource.favorites.transfer.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
