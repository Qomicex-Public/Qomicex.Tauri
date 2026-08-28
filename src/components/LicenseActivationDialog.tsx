import { useState, useEffect } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Button } from './ui'
import { Tooltip } from './ui'
import { fetchLicenseStatus, activateLicense } from '../api/license.ts'
import type { LicenseStatus } from '../api/license.ts'
import { Check, Copy, Key, LogOut, ShieldHalf } from 'lucide-react'
import { exit } from '@tauri-apps/plugin-process'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  open: boolean
  onActivated?: () => void
  onClose?: () => void
}

export default function LicenseActivationDialog({ open, onActivated, onClose }: Props) {
  const { t } = useI18n()
  const [token, setToken] = useState('')
  const [machineCode, setMachineCode] = useState('')
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) {
      setToken('')
      setError('')
      fetchLicenseStatus().then(s => {
        setMachineCode(s.machineCode || '')
        setLicenseStatus(s)
      }).catch(() => setMachineCode(t('dialogs.license.loadFailed')))
    }
  }, [open])

  async function handleActivate() {
    if (!token.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await activateLicense(token.trim())
      if (res.success) {
        onActivated?.()
      } else {
        setError(res.error || t('dialogs.license.activateFailed'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('dialogs.license.activateFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose ?? (() => {})} closeOnBackdrop={!!onClose} closeOnEsc={!!onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>
          <ShieldHalf className="mr-2 h-4 w-4 text-muted-foreground" />
          {t('dialogs.license.title')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {licenseStatus && licenseStatus.valid && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
            <Key className="h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">{t('dialogs.license.active')}</div>
              {licenseStatus.licenseId && (
                <div className="text-xs text-muted-foreground">
                  {t('dialogs.license.id', { licenseId: licenseStatus.licenseId })}
                  {licenseStatus.expireAt && ` · ${t('dialogs.license.expireAt', { date: licenseStatus.isPermanent ? t('dialogs.license.permanent') : licenseStatus.expireAt })}`}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="rounded-lg bg-muted p-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">{t('dialogs.license.machineCode')}</div>
            <Tooltip content={copied ? t('common.copied') : t('dialogs.license.copyMachineCode')}>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                onClick={async () => {
                  if (!machineCode) return
                  await navigator.clipboard.writeText(machineCode)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </Tooltip>
          </div>
          <div className="mt-1 font-mono text-xs break-all select-all">{machineCode || t('common.loading')}</div>
        </div>
        <div className="space-y-2">
          <Label>{t('dialogs.license.tokenLabel')}</Label>
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('dialogs.license.tokenPlaceholder')}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">{t('dialogs.license.tokenHint')}</p>
        </div>
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        {onClose && (
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        )}
        {!onClose && (
          <Button variant="ghost" onClick={() => exit(0)} className="gap-1.5 text-muted-foreground">
            <LogOut className="h-3 w-3" />
            {t('dialogs.license.exitLauncher')}
          </Button>
        )}
        <Button onClick={handleActivate} disabled={!token.trim() || loading}>
          {loading ? t('dialogs.license.verifying') : t('dialogs.license.activate')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
